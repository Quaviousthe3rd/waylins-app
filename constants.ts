import { StoreConfig, WorkingHours } from './types';

export const DEFAULT_SERVICES = [
  { id: '1', name: 'Regular Cut', price: 200, durationMinutes: 60 },
  { id: '2', name: 'Cut & Black Dye', price: 300, durationMinutes: 60 },
  { id: '3', name: 'Blade Fade & Beard Trim', price: 250, durationMinutes: 60 },
  { id: '4', name: 'Machine Cut & Scissor', price: 250, durationMinutes: 60 },
  { id: '5', name: 'Machine Cheesecob & Beard Trim', price: 100, durationMinutes: 60 },
  { id: '6', name: 'Blade Cheesecob & Beard Trim', price: 150, durationMinutes: 60 },
];

export const DEFAULT_HOURS: Record<number, WorkingHours> = {
  0: { start: '09:00', end: '15:00', isClosed: false }, // Sun
  1: { start: '09:00', end: '18:00', isClosed: false }, // Mon
  2: { start: '09:00', end: '18:00', isClosed: false }, // Tue
  3: { start: '00:00', end: '00:00', isClosed: true },  // Wed (Closed)
  4: { start: '09:00', end: '18:00', isClosed: false }, // Thu
  5: { start: '09:00', end: '18:00', isClosed: false }, // Fri
  6: { start: '09:00', end: '18:00', isClosed: false }, // Sat
};

export const STORAGE_KEYS = {
  BOOKINGS: 'waylans_bookings',
  CONFIG: 'waylans_config',
  ADMIN_SESSION: 'waylans_admin_session',
};

// Helper to seed data if empty
export const INITIAL_CONFIG: StoreConfig = {
  services: DEFAULT_SERVICES,
  weeklyHours: DEFAULT_HOURS,
  blockouts: [],
};