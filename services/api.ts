import { v4 as uuidv4 } from 'uuid';
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

const escapeHTML = (str: string) => {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (m) => {
        switch (m) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
            default: return m;
        }
    });
};

const sendTelegramNotification = async (message: string) => {
    const token = import.meta.env.VITE_TELEGRAM_BOT_TOKEN;
    const chatId = import.meta.env.VITE_TELEGRAM_CHAT_ID;
    
    if (!token || !chatId) {
        console.warn("Telegram credentials missing. Notification not sent.");
        return;
    }
    
    try {
        const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'HTML'
            })
        });

        if (!response.ok) {
            const errorBody = await response.json();
            console.error("Telegram API Error Details:", errorBody);
        }
    } catch (error) {
        console.error("Failed to send Telegram notification:", error);
    }
};

// --- PAYMENT ENVIRONMENT ---
// Which Paystack environment is active, decided server-side in
// settings/paymentConfig. The public key comes from the server too, so
// switching modes never requires a client rebuild. On any failure we fall
// back to live-with-no-key: the UI then uses the env var it always used,
// so the live path behaves exactly as before this feature existed.
export interface PaymentEnv {
    mode: 'test' | 'live';
    publicKey: string | null;
}

let paymentEnvPromise: Promise<PaymentEnv> | null = null;

const fetchPaymentEnv = async (): Promise<PaymentEnv> => {
    if (!firebaseApp) return { mode: 'live', publicKey: null };
    try {
        const functions = getFunctions(firebaseApp, 'europe-west1');
        const call = httpsCallable(functions, 'getPaymentMode');
        const result: any = await call();
        const mode = result?.data?.mode === 'test' ? 'test' : 'live';
        const publicKey = typeof result?.data?.publicKey === 'string' && result.data.publicKey.startsWith('pk_')
            ? result.data.publicKey
            : null;
        return { mode, publicKey };
    } catch (e) {
        console.error('getPaymentMode failed; defaulting to live.', e);
        return { mode: 'live', publicKey: null };
    }
};

// --- API IMPLEMENTATION ---

export const api = {
  getPaymentEnv: (): Promise<PaymentEnv> => {
      if (!paymentEnvPromise) paymentEnvPromise = fetchPaymentEnv();
      return paymentEnvPromise;
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

  createBooking: async (bookingData: Omit<Booking, 'id' | 'createdAt' | 'status'>, rescheduleId?: string): Promise<Booking> => {
     const id = uuidv4();
     const newBooking: Booking = {
         id,
         ...bookingData,
         status: BookingStatus.CONFIRMED,
         createdAt: new Date().toISOString()
     };

     if (db) {
         // Direct atomic write with specific ID
         await setDoc(doc(db, 'bookings', id), newBooking);
         
         // Send Telegram Notification
         const message = `🚨 <b>New Booking!</b>\n\n` +
             `👤 <b>Client:</b> ${escapeHTML(bookingData.clientName)}\n` +
             `📱 <b>Phone:</b> ${escapeHTML(bookingData.clientPhone)}\n` +
             `✂️ <b>Service:</b> ${escapeHTML(bookingData.serviceName)}\n` +
             `📅 <b>Date:</b> ${escapeHTML(bookingData.date)}\n` +
             `⏰ <b>Time:</b> ${escapeHTML(bookingData.timeSlot)}\n` +
             `💰 <b>Total:</b> R${bookingData.amount}\n` +
             `💳 <b>Payment:</b> ${escapeHTML(bookingData.paymentMethod)} (${escapeHTML(bookingData.paymentStatus)})`;
         
         sendTelegramNotification(message);

         return newBooking;
     } else {
         throw new Error("Database not connected. Please check internet or API Keys.");
     }
  },

  updateBooking: async (id: string, updates: Partial<Booking>) => {
     if (db) {
         const docRef = doc(db, 'bookings', id);
         await updateDoc(docRef, updates);
         
         // If status is updated (like CANCELLED) or payment updated, send a notification
         if (updates.status || updates.paymentStatus) {
             const booking = bookingsCache.find(b => b.id === id);
             const clientName = booking?.clientName || 'Unknown Client';
             
             let message = `⚠️ <b>Booking Updated</b>\n\n`;
             message += `👤 <b>Client:</b> ${escapeHTML(clientName)}\n`;
             
             if (updates.status) {
                 message += `📌 <b>Status:</b> ${updates.status}\n`;
             }
             if (updates.paymentStatus) {
                 message += `💰 <b>Payment:</b> ${updates.paymentStatus}\n`;
             }
             
             message += `\nID: <code>${id}</code>`;
             sendTelegramNotification(message);
         }
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