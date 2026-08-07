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
import { computeAvailableSlots, parseDay } from './availability';

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
  getDoc,
  getDocs,
  orderBy,
  Timestamp,
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

// Admin identity lives in settings/adminConfig.adminEmails — see firestore.rules.
// There is deliberately no email constant here: a second hardcoded address is
// exactly what this replaces.
const ADMIN_CONFIG_DOC = 'adminConfig';

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

// Is this signed-in user an admin? The rules make settings/adminConfig
// readable ONLY by admins, so the read attempt IS the test — it is the same
// allowlist the server enforces, so the UI can never disagree with the
// database. Denied read (or any failure) => not an admin. We still verify
// the email is in the returned list, so a future rules relaxation cannot
// silently widen the client gate.
const isAdminUser = async (user: User | null): Promise<boolean> => {
    if (!user || !user.email || !db) return false;
    try {
        const snap = await getDoc(doc(db, 'settings', ADMIN_CONFIG_DOC));
        if (!snap.exists()) return false;
        const emails = snap.data()?.adminEmails;
        if (!Array.isArray(emails)) return false;
        return emails
            .filter((e: unknown): e is string => typeof e === 'string')
            .map(e => e.toLowerCase())
            .includes(user.email.toLowerCase());
    } catch {
        // permission-denied is the expected path for a non-admin sign-in.
        return false;
    }
};

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
// slotClaims cache: cell id "yyyy-MM-dd_HH:mm" -> claim. Written only
// server-side; public-read (no personal data). Availability excludes any
// confirmed or held-and-unexpired cell. Advisory only — the server-side
// claim transaction is the real enforcement.
interface SlotClaim {
    bookingRef: string | null;
    bookingId: string | null;
    status: 'held' | 'confirmed';
    expiresAt: Date | null;
}
let claimsCache: Map<string, SlotClaim> = new Map();
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
// serviceFee is the flat R50 booking fee added to every service.
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

// --- LEDGER (statement view) ---
// One row per Paystack transaction, written ONLY by paystackWebhook.
// Amounts are RAND. paystackFeeActual comes from the Paystack event and may
// be null; estimatedFee is our own calculation — the UI must label which
// one it is showing, never present an estimate as fact.
//
// Money model (flat R50): charged = base + R50; ownerCut = 10% of base.
// barberNet is what Paystack's split ROUTED to the barber (computed from the
// ESTIMATED fee) and barberNetActual is what the subaccount ACTUALLY banked —
// normally the same figure, because transaction_charge is fixed at initialize
// time and cannot be revised. barberDrift is the fee estimate error, which
// with bearer "account" is absorbed entirely by the owner: ownerNet =
// ownerCut + barberDrift is what the owner actually kept. Older rows have
// these as null.
export interface LedgerRow {
    id: string;               // doc id == payment reference
    reference: string;
    status: string;           // PAID_BOOKED | REFUNDED | SLOT_TAKEN_REFUND | anomalies
    mode: 'test' | 'live';
    clientName: string | null;
    serviceName: string | null;
    date: string | null;      // booking date yyyy-MM-dd
    timeSlot: string | null;
    charged: number | null;   // gross amount the client paid (rand)
    base: number | null;      // service base price (charged - R50)
    ownerCut: number | null;  // exactly 10% of base (the entitlement)
    ownerNet: number | null;  // what the owner actually kept (cut + drift)
    paystackFeeActual: number | null;
    estimatedFee: number | null;
    barberNet: number | null;        // routed by Paystack (estimate-based)
    barberNetActual: number | null;  // actually banked by the subaccount
    barberDrift: number | null;      // estimatedFee - actualFee; owner absorbs
    refundedAmount: number | null;
    bookingId: string | null;
    createdAt: Date | null;   // transaction time (webhook processing time)
}

// What the manualSettle callable found on Paystack for a reference —
// shown to the admin BEFORE anything is written.
export interface ManualSettlePreview {
    reference: string;
    env: 'test' | 'live';
    paystackStatus: string;
    amountRand: number;
    paidAt: string | null;
    channel: string | null;
    clientName: string | null;
    clientPhone: string | null;
    serviceName: string | null;
    date: string | null;
    timeSlot: string | null;
    ledgerExists: boolean;
    pendingExists: boolean;
}

export interface ManualSettleResult {
    status: string;           // PAID_BOOKED | ALREADY_SETTLED | anomalies
    reference: string;
    bookingId: string | null;
    recoveredFromMetadata: boolean;
    amountRand: number;
    clientName: string | null;
}

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

  // Ledger rows for the statement view, queried by transaction-time range
  // (a single-field range on createdAt — no composite index required).
  // Admin-read-only by Firestore rules; non-admin callers get
  // permission-denied. Never loads the whole collection.
  getLedgerRows: async (start: Date, end: Date): Promise<LedgerRow[]> => {
      if (!db) throw new Error('Database not connected.');
      const q = query(
          collection(db, 'ledger'),
          where('createdAt', '>=', Timestamp.fromDate(start)),
          where('createdAt', '<=', Timestamp.fromDate(end)),
          orderBy('createdAt', 'desc'),
      );
      const snap = await getDocs(q);
      return snap.docs.map(d => {
          const r = d.data() as any;
          const num = (v: any): number | null =>
              typeof v === 'number' && Number.isFinite(v) ? v : null;
          return {
              id: d.id,
              reference: String(r.reference ?? d.id),
              status: String(r.status ?? 'UNKNOWN'),
              mode: r.mode === 'test' ? 'test' : 'live',
              clientName: r.clientName ? String(r.clientName) : null,
              serviceName: r.serviceName ? String(r.serviceName) : null,
              date: r.date ? String(r.date) : null,
              timeSlot: r.timeSlot ? String(r.timeSlot) : null,
              charged: num(r.charged),
              base: num(r.base),
              ownerCut: num(r.ownerCut),
              ownerNet: num(r.ownerNet),
              paystackFeeActual: num(r.paystackFeeActual),
              estimatedFee: num(r.estimatedFee),
              barberNet: num(r.barberNet),
              barberNetActual: num(r.barberNetActual),
              barberDrift: num(r.barberDrift),
              refundedAmount: num(r.refundedAmount),
              bookingId: r.bookingId ? String(r.bookingId) : null,
              createdAt: r.createdAt?.toDate ? r.createdAt.toDate() : null,
          };
      });
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

  // Admin manual settle (Phase D layer 3). Two-phase: verify first (writes
  // nothing, returns what Paystack knows), then settle on explicit confirm
  // via the same server-side settlement path as the webhook and sweep.
  manualSettleVerify: async (reference: string): Promise<ManualSettlePreview> => {
      if (!firebaseApp) throw new Error('Database not connected.');
      const functions = getFunctions(firebaseApp, 'europe-west1');
      const call = httpsCallable(functions, 'manualSettle');
      const result: any = await call({ reference, confirm: false });
      return result?.data?.preview as ManualSettlePreview;
  },

  manualSettleConfirm: async (reference: string): Promise<ManualSettleResult> => {
      if (!firebaseApp) throw new Error('Database not connected.');
      const functions = getFunctions(firebaseApp, 'europe-west1');
      const call = httpsCallable(functions, 'manualSettle');
      const result: any = await call({ reference, confirm: true });
      return result?.data?.result as ManualSettleResult;
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

            // 1b. Listen to slot claims (server-written reservation cells).
            onSnapshot(collection(db, 'slotClaims'), (snapshot) => {
                const next = new Map<string, SlotClaim>();
                snapshot.docs.forEach(d => {
                    const c = d.data() as any;
                    next.set(d.id, {
                        bookingRef: c.bookingRef ? String(c.bookingRef) : null,
                        bookingId: c.bookingId ? String(c.bookingId) : null,
                        status: c.status === 'held' ? 'held' : 'confirmed',
                        expiresAt: c.expiresAt?.toDate ? c.expiresAt.toDate() : null,
                    });
                });
                claimsCache = next;
                notifyListeners();
            }, (error) => {
                console.error('slotClaims sync error:', error);
            });

            // 2. Listen to Config
            const configRef = doc(db, 'settings', 'storeConfig');
            onSnapshot(configRef, (doc) => {
                if (doc.exists()) {
                    const raw = doc.data() as Partial<StoreConfig>;
                    // DEEP merge: weeklyHours must be merged PER DAY against
                    // defaults — a shallow merge lets a doc missing one day
                    // (e.g. only days 0-5 saved) crash every consumer of
                    // weeklyHours[6].isClosed.
                    const mergedHours: StoreConfig['weeklyHours'] = { ...INITIAL_CONFIG.weeklyHours };
                    for (let day = 0; day < 7; day++) {
                        const h = raw.weeklyHours?.[day];
                        if (h && typeof h === 'object') {
                            mergedHours[day] = { ...INITIAL_CONFIG.weeklyHours[day], ...h };
                        }
                    }
                    configCache = {
                        services: raw.services || INITIAL_CONFIG.services,
                        weeklyHours: mergedHours,
                        blockouts: raw.blockouts || []
                    };
                } else {
                    // Config doc missing. Only the admin may seed it — the rules
                    // deny settings writes to everyone else, so a client-side
                    // write here would fail-loop for normal visitors.
                    configCache = INITIAL_CONFIG;
                    isAdminUser(currentUser).then(admin => {
                        if (admin) setDoc(configRef, INITIAL_CONFIG).catch(console.error);
                    }).catch(console.error);
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
    if (!(await isAdminUser(cred.user))) {
        await signOut(auth);
        return false;
    }
    return true;
  },

  logout: async (): Promise<void> => {
    if (auth) await signOut(auth);
  },

  // Subscribe to auth state; callback receives true when an allowlisted admin
  // is signed in. The allowlist check is a Firestore read, so it is async — a
  // sequence counter drops stale answers when auth changes mid-flight (e.g.
  // sign-out landing while the previous user's lookup is still in the air).
  onAuthChanged: (callback: (isAdmin: boolean) => void): (() => void) => {
    if (!auth) {
        callback(false);
        return () => {};
    }
    let seq = 0;
    let cancelled = false;
    const unsubscribe = onAuthStateChanged(auth, (user) => {
        const mine = ++seq;
        isAdminUser(user)
            .then(admin => {
                if (!cancelled && mine === seq) callback(admin);
            })
            .catch(() => {
                if (!cancelled && mine === seq) callback(false);
            });
    });
    return () => {
        cancelled = true;
        unsubscribe();
    };
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
        .sort((a, b) => parseDay(b.date).getTime() - parseDay(a.date).getTime());
  },

  // Thin wrapper over the pure, timezone-safe implementation in
  // availability.ts (extracted so the 60-min-on-30-min-grid and mocked-TZ
  // cases can be unit tested).
  getAvailableSlots: (dateStr: string, durationMinutes: number, excludeBookingId?: string): string[] => {
    return computeAvailableSlots(
      configCache,
      bookingsCache,
      claimsCache,
      dateStr,
      durationMinutes,
      excludeBookingId
    );
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