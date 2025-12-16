export enum PaymentMethod {
  CASH = 'Cash at Shop',
  ONLINE = 'Online (Paystack)'
}

export enum PaymentStatus {
  PAID = 'Paid',
  PENDING = 'Pending',
  NOT_PAID = 'Not Paid',
  REFUNDED = 'Refunded'
}

export enum BookingStatus {
  CONFIRMED = 'Confirmed',
  CANCELLED = 'Cancelled',
  COMPLETED = 'Completed'
}

export interface ServiceItem {
  id: string;
  name: string;
  price: number;
  durationMinutes: number;
}

export interface Client {
  name: string;
  phone: string;
}

export interface Booking {
  id: string;
  clientName: string;
  clientPhone: string;
  date: string; // ISO string YYYY-MM-DD
  timeSlot: string; // HH:mm
  serviceId: string;
  serviceName: string;
  durationMinutes: number; // Added duration
  amount: number;
  depositAmount: number;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  status: BookingStatus;
  createdAt: string;
  paymentReference?: string; // Paystack transaction reference
  transactionId?: string; // Paystack transaction ID
}

export interface WorkingHours {
  start: string; // HH:mm
  end: string; // HH:mm
  isClosed: boolean;
}

export interface Blockout {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  reason: string;
}

export interface StoreConfig {
  services: ServiceItem[];
  weeklyHours: Record<number, WorkingHours>; // 0 = Sunday, 1 = Monday, etc.
  blockouts: Blockout[];
}