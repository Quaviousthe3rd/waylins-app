import { 
  Booking, 
  StoreConfig, 
  BookingStatus, 
  PaymentStatus, 
  PaymentMethod,
  Blockout,
  ServiceItem,
  WorkingHours
} from '../types';
import { INITIAL_CONFIG, STORAGE_KEYS } from '../constants';
import { format, parse, addMinutes, areIntervalsOverlapping, getDay } from 'date-fns';

// --- FIREBASE IMPORTS ---
import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  onSnapshot,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
} from 'firebase/firestore';
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  Auth,
  User,
} from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';

const ADMIN_EMAIL = 'qaabilmullah@gmail.com';

// --- CONFIGURATION ---
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

// Initialize Firebase
let db: any = null;
let auth: Auth | null = null;
let currentUser: User | null = null;
let firebaseApp: any = null;

const isAdminUser = (user: User | null) => !!user && user.email === ADMIN_EMAIL;

try {
    // Only initialize if keys are present to avoid errors during setup
    if (firebaseConfig.apiKey) {
        const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
        firebaseApp = app;
        db = getFirestore(app);
        auth = getAuth(app);
        onAuthStateChanged(auth, (user) => {
            currentUser = user;
        });
        console.log("✅ Firebase Initialized Successfully");
    } else {
        console.warn("⚠️ Firebase keys are missing in services/api.ts");
    }
} catch (e) {
    console.warn("🔥 Firebase Connection Failed. Ensure you are online and configuration is correct.", e);
}

// --- STATE MANAGEMENT ---
let bookingsCache: Booking[] = [];
let configCache: StoreConfig = INITIAL_CONFIG;
let listeners: (() => void)[] = [];
let isSubscribed = false;

// --- HELPER FUNCTIONS ---
const notifyListeners = () => {
  listeners.forEach(l => {
      try { l(); } catch(e) { console.error("Listener error", e); }
  });
};

// NOTE: the old client-side Telegram sender is gone. Booking lifecycle
// messages will be owned by the C1 server-side Firestore trigger; the old
// bot token it used was revoked anyway.

// --- PAYMENT ENVIRONMENT ---
// Which Paystack environment is active, decided server-side in
// settings/paymentConfig. The public key comes from the server too, so
// switching modes never requires a client rebuild. The server validates the
// config strictly and throws on anything invalid; when that (or any other
// failure) happens the mode is 'unavailable' — the wizard shows a clean
// "online payment temporarily unavailable" state. We NEVER fall back to live.
export interface PaymentEnv {
    mode: 'test' | 'live' | 'unavailable';
    publicKey: string | null;
}

let paymentEnvPromise: Promise<PaymentEnv> | null = null;

// Server-computed quote for a service. The server (quoteService) is the
// single source of truth for pricing — the client never computes amounts.
export interface ServiceQuote {
    base: number;
    serviceFee: number;
    total: number;
}

// Result of initTransaction: the server-created Paystack transaction the
// client resumes (popup) or is redirected to. This is the ONE transaction
// being paid; the client never initializes its own.
export interface InitTransactionResult {
    reference: string;
    access_code: string | null;
    authorization_url: string;
}

const fetchPaymentEnv = async (): Promise<PaymentEnv> => {
    if (!firebaseApp) return { mode: 'unavailable', publicKey: null };
    try {
        const functions = getFunctions(firebaseApp, 'europe-west1');
        const call = httpsCallable(functions, 'getPaymentMode');
        const result: any = await call();
        const mode = result?.data?.mode;
        const publicKey = typeof result?.data?.publicKey === 'string' && result.data.publicKey.startsWith('pk_')
            ? result.data.publicKey
            : null;
        if ((mode !== 'test' && mode !== 'live') || !publicKey) {
            console.error('getPaymentMode returned an invalid environment; payments unavailable.', result?.data);
            return { mode: 'unavailable', publicKey: null };
        }
        return { mode, publicKey };
    } catch (e) {
        console.error('getPaymentMode failed; payments unavailable.', e);
        return { mode: 'unavailable', publicKey: null };
    }
};

// --- API IMPLEMENTATION ---

export const api = {
  getPaymentEnv: (): Promise<PaymentEnv> => {
      if (!paymentEnvPromise) paymentEnvPromise = fetchPaymentEnv();
      return paymentEnvPromise;
  },

  // Server-side quote for the booking wizard's price display.
  getQuote: async (serviceId: string): Promise<ServiceQuote> => {
      if (!firebaseApp) throw new Error('Database not connected.');
      const functions = getFunctions(firebaseApp, 'europe-west1');
      const call = httpsCallable(functions, 'quoteService');
      const result: any = await call({ serviceId });
      return {
          base: Number(result?.data?.base),
          serviceFee: Number(result?.data?.serviceFee),
          total: Number(result?.data?.total),
      };
  },

  // Create the payment intent + Paystack transaction server-side.
  initTransaction: async (payload: {
      serviceId: string;
      date: string;
      timeSlot: string;
      clientName: string;
      clientPhone: string;
  }): Promise<InitTransactionResult> => {
      if (!firebaseApp) throw new Error('Database not connected.');
      const functions = getFunctions(firebaseApp, 'europe-west1');
      const call = httpsCallable(functions, 'initTransaction');
      const result: any = await call(payload);
      return {
          reference: String(result?.data?.reference),
          access_code: result?.data?.access_code ?? null,
          authorization_url: String(result?.data?.authorization_url),
      };
  },

  // Move an EXISTING booking to a new date/time (server-side callable).
  // The original payment stays valid — no new charge, no Paystack call.
  rescheduleBooking: async (payload: {
      bookingId: string;
      clientPhone: string;
      newDate: string;
      newTimeSlot: string;
  }): Promise<void> => {
      if (!firebaseApp) throw new Error('Database not connected.');
      const functions = getFunctions(firebaseApp, 'europe-west1');
      const call = httpsCallable(functions, 'rescheduleBooking');
      await call(payload);
  },

  // Client cancel via callable (direct booking writes are admin-only).
  cancelBooking: async (bookingId: string, clientPhone: string): Promise<void> => {
      if (!firebaseApp) throw new Error('Database not connected.');
      const functions = getFunctions(firebaseApp, 'europe-west1');
      const call = httpsCallable(functions, 'cancelBooking');
      await call({ bookingId, clientPhone });
  },

  // Wait for the webhook-created booking to appear (paymentReference match).
  // Resolves with the booking, or null after timeoutMs. Read-only: the
  // client NEVER writes the booking — the paystackWebhook function does.
  waitForBookingByReference: (reference: string, timeoutMs: number): Promise<Booking | null> => {
      if (!db) return Promise.resolve(null);
      return new Promise((resolve) => {
          const q = query(collection(db, 'bookings'), where('paymentReference', '==', reference));
          let done = false;
          const finish = (b: Booking | null) => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              unsubscribe();
              resolve(b);
          };
          const timer = setTimeout(() => finish(null), timeoutMs);
          const unsubscribe = onSnapshot(q, (snapshot) => {
              if (!snapshot.empty) {
                  const d = snapshot.docs[0];
                  finish({ id: d.id, ...d.data() } as Booking);
              }
          }, (error) => {
              console.error('Booking confirmation listener failed:', error);
              finish(null);
          });
      });
  },

  // Initialize Real-time Listeners
  subscribe: (listener: () => void) => {
    listeners.push(listener);
    // Notify immediately to ensure component has latest state
    try {
        listener();
    } catch(e) {
        console.error("Initial listener call failed", e);
    }

    if (!isSubscribed) {
        isSubscribed = true;
        
        if (db) {
            // --- FIREBASE MODE ---
            console.log("🔌 Connecting to Live Database...");
            
            // 1. Listen to Bookings
            const bookingsRef = collection(db, 'bookings');
            
            onSnapshot(bookingsRef, (snapshot) => {
                const liveBookings = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                })) as Booking[];
                
                // Sort by date/time (newest first)
                bookingsCache = liveBookings.sort((a, b) => 
                    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
                );
                
                notifyListeners();
            }, (error) => {
                console.error("Firebase Sync Error:", error);
            });

            // 2. Listen to Config
            const configRef = doc(db, 'settings', 'storeConfig');
            onSnapshot(configRef, (doc) => {
                if (doc.exists()) {
                    configCache = doc.data() as StoreConfig;
                    // Merge defaults in case of new fields
                    configCache = {
                        services: configCache.services || INITIAL_CONFIG.services,
                        weeklyHours: configCache.weeklyHours || INITIAL_CONFIG.weeklyHours,
                        blockouts: configCache.blockouts || []
                    };
                } else {
                    // Config doc missing. Only the admin may seed it — the rules
                    // deny settings writes to everyone else, so a client-side
                    // write here would fail-loop for normal visitors.
                    if (isAdminUser(currentUser)) {
                        setDoc(configRef, INITIAL_CONFIG).catch(console.error);
                    } else {
                        configCache = INITIAL_CONFIG;
                    }
                }
                notifyListeners();
            });

        } else {
            // Error State - No Database
            console.warn("❌ Database not connected. App will function in offline mode (read-only defaults).");
        }
    }
    
    return () => {
      listeners = listeners.filter(l => l !== listener);
    };
  },

  refresh: () => {
      notifyListeners();
  },

  login: async (email: string, password: string): Promise<boolean> => {
    if (!auth) throw new Error("Authentication not available. Check Firebase configuration.");
    const cred = await signInWithEmailAndPassword(auth, email, password);
    if (cred.user.email !== ADMIN_EMAIL) {
        await signOut(auth);
        return false;
    }
    return true;
  },

  logout: async (): Promise<void> => {
    if (auth) await signOut(auth);
  },

  // Subscribe to auth state; callback receives true when the admin is signed in.
  onAuthChanged: (callback: (isAdmin: boolean) => void): (() => void) => {
    if (!auth) {
        callback(false);
        return () => {};
    }
    return onAuthStateChanged(auth, (user) => callback(isAdminUser(user)));
  },

  // --- READ OPERATIONS ---
  
  getConfig: (): StoreConfig => {
    return configCache;
  },

  getBookings: (): Booking[] => {
    return bookingsCache;
  },

  getClientBookings: (phone: string): Booking[] => {
    return bookingsCache
        .filter(b => b.clientPhone === phone)
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  },

  getAvailableSlots: (dateStr: string, durationMinutes: number, excludeBookingId?: string): string[] => {
    const config = configCache;
    const allBookings = bookingsCache;
    const dayOfWeek = getDay(new Date(dateStr));
    const hours = config.weeklyHours[dayOfWeek];

    if (!hours || hours.isClosed) return [];

    // Check specific blockouts
    const isBlockedDay = config.blockouts.some(b => {
       if(b.date !== dateStr) return false;
       // If blockout covers whole day
       if (b.startTime <= hours.start && b.endTime >= hours.end) return true;
       return false;
    });

    if (isBlockedDay) return [];

    const [startH, startM] = hours.start.split(':').map(Number);
    const [endH, endM] = hours.end.split(':').map(Number);
    
    const slots: string[] = [];
    let current = new Date(dateStr);
    current.setHours(startH, startM, 0, 0);
    
    const endTime = new Date(dateStr);
    endTime.setHours(endH, endM, 0, 0);

    // Filter relevant bookings/blockouts for this day
    const dayBookings = allBookings.filter(b => 
      b.date === dateStr && 
      b.status !== BookingStatus.CANCELLED && 
      b.id !== excludeBookingId
    );

    const dayBlockouts = config.blockouts.filter(b => b.date === dateStr);

    while (addMinutes(current, durationMinutes) <= endTime) {
       const slotStart = current;
       const slotEnd = addMinutes(current, durationMinutes);
       const slotStr = format(slotStart, 'HH:mm');

       const isOverlappingBooking = dayBookings.some(b => {
          const bStart = parse(b.timeSlot, 'HH:mm', new Date(dateStr));
          const bDuration = b.durationMinutes || 60; 
          const bEnd = addMinutes(bStart, bDuration);
          return areIntervalsOverlapping({ start: slotStart, end: slotEnd }, { start: bStart, end: bEnd });
       });

       const isOverlappingBlockout = dayBlockouts.some(b => {
          const bStart = parse(b.startTime, 'HH:mm', new Date(dateStr));
          const bEnd = parse(b.endTime, 'HH:mm', new Date(dateStr));
          return areIntervalsOverlapping({ start: slotStart, end: slotEnd }, { start: bStart, end: bEnd });
       });

       if (!isOverlappingBooking && !isOverlappingBlockout) {
           slots.push(slotStr);
       }

       current = addMinutes(current, 30);
    }
    
    return slots;
  },

  // --- WRITE OPERATIONS ---
  // NOTE: bookings are CREATED only server-side (paystackWebhook). Direct
  // updates here work only for the authenticated admin (Firestore rules);
  // clients cancel/reschedule via the callables below.

  updateBooking: async (id: string, updates: Partial<Booking>) => {
     if (db) {
         const docRef = doc(db, 'bookings', id);
         await updateDoc(docRef, updates as any);
     } else {
         throw new Error("Database not connected.");
     }
  },

  deleteBooking: async (id: string) => {
      if (db) {
          const docRef = doc(db, 'bookings', id);
          await deleteDoc(docRef);
      } else {
          throw new Error("Database not connected.");
      }
  },

  // --- CONFIG UPDATES ---

  addService: async (service: ServiceItem) => {
      if (db) {
          const currentConfig = configCache;
          const newServices = [...currentConfig.services, service];
          await updateDoc(doc(db, 'settings', 'storeConfig'), { services: newServices });
      }
  },

  updateService: async (id: string, updates: Partial<ServiceItem>) => {
      if (db) {
          const currentConfig = configCache;
          const newServices = currentConfig.services.map(s => s.id === id ? { ...s, ...updates } : s);
          await updateDoc(doc(db, 'settings', 'storeConfig'), { services: newServices });
      }
  },

  deleteService: async (id: string) => {
      if (db) {
          const currentConfig = configCache;
          const newServices = currentConfig.services.filter(s => s.id !== id);
          await updateDoc(doc(db, 'settings', 'storeConfig'), { services: newServices });
      }
  },

  updateWorkingHours: async (dayIndex: number, updates: Partial<WorkingHours>) => {
      if (db) {
          const currentConfig = configCache;
          const newHours = { ...currentConfig.weeklyHours };
          newHours[dayIndex] = { ...newHours[dayIndex], ...updates };
          await updateDoc(doc(db, 'settings', 'storeConfig'), { weeklyHours: newHours });
      }
  },

  addBlockout: async (blockout: Blockout) => {
      if (db) {
          const currentConfig = configCache;
          const newBlockouts = [...(currentConfig.blockouts || []), blockout];
          await updateDoc(doc(db, 'settings', 'storeConfig'), { blockouts: newBlockouts });
      }
  },

  removeBlockout: async (id: string) => {
      if (db) {
          const currentConfig = configCache;
          const newBlockouts = currentConfig.blockouts.filter(b => b.id !== id);
          await updateDoc(doc(db, 'settings', 'storeConfig'), { blockouts: newBlockouts });
      }
  }
};