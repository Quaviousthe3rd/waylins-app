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

// --- CONFIGURATION ---
const firebaseConfig = {
  apiKey: "AIzaSyDok2PkDt8jzgU5sd8y1s1K8c7Yn5sxH4M",
  authDomain: "waylans-barbershop-app.firebaseapp.com",
  projectId: "waylans-barbershop-app",
  storageBucket: "waylans-barbershop-app.firebasestorage.app",
  messagingSenderId: "272816108990",
  appId: "1:272816108990:web:b40828bbe71fa2589fb5ef"
};

// Initialize Firebase
let db: any = null;

try {
    // Only initialize if keys are present to avoid errors during setup
    if (firebaseConfig.apiKey) {
        const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
        db = getFirestore(app);
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

// --- API IMPLEMENTATION ---

export const api = {
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
                    // Initialize DB if empty
                    setDoc(configRef, INITIAL_CONFIG).catch(console.error);
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

  login: (password: string): boolean => {
    return password === '1234';
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
         return newBooking;
     } else {
         throw new Error("Database not connected. Please check internet or API Keys.");
     }
  },

  updateBooking: async (id: string, updates: Partial<Booking>) => {
     if (db) {
         const docRef = doc(db, 'bookings', id);
         await updateDoc(docRef, updates);
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