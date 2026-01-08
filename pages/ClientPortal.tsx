import React, { useState, useEffect, useRef } from 'react';
import { PaystackButton } from 'react-paystack';
import { Link } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { User, Calendar, Scissors, CreditCard, CheckCircle, Clock, ArrowLeft, LogOut, ChevronRight, ChevronLeft, MapPin, Check, AlertCircle, RotateCcw } from 'lucide-react';
import { api } from '../services/api';
import { Client, ServiceItem, Booking, PaymentMethod, PaymentStatus, BookingStatus, Blockout } from '../types';
import { format, addDays, startOfToday, getDay } from 'date-fns';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { notify } from '../services/notifications';
import { Footer } from '../components/Footer';

// --- Sub-Components for Wizard Steps ---

const LoginStep: React.FC<{ onComplete: (client: Client) => void }> = ({ onComplete }) => {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (name.trim() && phone.trim()) {
      let cleanPhone = phone.replace(/\D/g, '');
      
      if (cleanPhone.startsWith('27') && cleanPhone.length === 11) {
          cleanPhone = '0' + cleanPhone.substring(2);
      } 
      else if (cleanPhone.startsWith('270') && cleanPhone.length === 12) {
          cleanPhone = cleanPhone.substring(2);
      }

      const isValidPhone = /^0\d{9}$/.test(cleanPhone) && cleanPhone !== '0000000000';
      
      if (!isValidPhone) {
          setError("Please enter a valid 10-digit SA mobile number (e.g. 0821234567)");
          return;
      }

      const client = { name: name.trim(), phone: cleanPhone };
      localStorage.setItem('waylins_client', JSON.stringify(client));
      onComplete(client);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-[#F2F2F7]">
      <div className="w-full max-w-md animate-in fade-in zoom-in duration-500">
        <div className="text-center mb-12">
          <div className="w-24 h-24 bg-[#1C1C1E] rounded-[2.5rem] flex items-center justify-center mx-auto mb-8 shadow-2xl shadow-black/10">
            <Scissors className="text-white w-10 h-10" strokeWidth={1.5} />
          </div>
          <h1 className="text-3xl font-bold text-[#1C1C1E] mb-2 tracking-tight">Waylin's</h1>
          <p className="text-[#8E8E93] font-medium">Premium Grooming</p>
        </div>
        
        <Card className="shadow-[0_20px_40px_rgba(0,0,0,0.05)]">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-4">
              <div>
                <label className="block text-[11px] font-bold text-[#8E8E93] uppercase tracking-widest mb-2 ml-2">Full Name</label>
                <input
                  required
                  autoComplete="name"
                  type="text"
                  className="w-full p-4 bg-[#F2F2F7] rounded-2xl border-none focus:ring-2 focus:ring-[#007AFF]/30 outline-none transition-all placeholder:text-[#AEAEB2] text-[#1C1C1E] font-medium text-lg"
                  placeholder="John Doe"
                  value={name}
                  onChange={e => setName(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-[#8E8E93] uppercase tracking-widest mb-2 ml-2">Phone Number</label>
                <input
                  required
                  autoComplete="tel"
                  type="tel"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  className={`w-full p-4 bg-[#F2F2F7] rounded-2xl border-none focus:ring-2 focus:ring-[#007AFF]/30 outline-none transition-all placeholder:text-[#AEAEB2] text-[#1C1C1E] font-medium text-lg ${error ? 'ring-2 ring-red-500/50 bg-red-50 text-red-900' : ''}`}
                  placeholder="082 123 4567"
                  value={phone}
                  onChange={e => {
                      setPhone(e.target.value);
                      if(error) setError('');
                  }}
                />
                {error && (
                    <div className="flex items-center gap-1.5 mt-2 ml-2 text-red-500 text-xs font-medium animate-in slide-in-from-top-2">
                        <AlertCircle size={12} /> {error}
                    </div>
                )}
              </div>
            </div>
            <Button fullWidth type="submit" variant="primary" className="h-14 text-lg">Continue</Button>
          </form>
        </Card>
        
        <div className="mt-10 text-center">
          <Link to="/admin" className="inline-flex items-center gap-2 text-xs font-semibold text-[#007AFF] hover:text-[#0051A8] transition-colors py-2 px-4">
             Staff Login
          </Link>
        </div>
      </div>
      <Footer />
    </div>
  );
};

interface BookingWizardProps {
    client: Client;
    onLogout: () => void;
    onViewBookings: () => void;
    preselectedService?: ServiceItem | null;
    rescheduleBooking?: Booking | null;
    onBookingComplete?: () => void;
    globalError?: string | null;
}

const BookingWizard: React.FC<BookingWizardProps> = ({ 
  client, 
  onLogout, 
  onViewBookings, 
  preselectedService, 
  rescheduleBooking,
  onBookingComplete,
  globalError 
}) => {
  const [step, setStep] = useState<1|2|3|4|5>(preselectedService ? 2 : 1);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [selectedSlot, setSelectedSlot] = useState<string>('');
  const [selectedService, setSelectedService] = useState<ServiceItem | null>(preselectedService || null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null);
  const [depositOption, setDepositOption] = useState<'full' | 'deposit' | null>(null);
  const [availableSlots, setAvailableSlots] = useState<string[]>([]);
  const [finalBooking, setFinalBooking] = useState<Booking | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(globalError || null);
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  
  const dateScrollRef = useRef<HTMLDivElement>(null);
  const [apiTick, setApiTick] = useState(0);

  useEffect(() => {
    const unsubscribe = api.subscribe(() => {
      setApiTick(t => t + 1);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
      if(globalError) setError(globalError);
  }, [globalError]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [step]);

  const scrollDates = (direction: 'left' | 'right') => {
      if (dateScrollRef.current) {
          const scrollAmount = 200;
          dateScrollRef.current.scrollBy({
              left: direction === 'left' ? -scrollAmount : scrollAmount,
              behavior: 'smooth'
          });
      }
  };

  const config = api.getConfig();
  const upcomingDays = Array.from({ length: 14 }, (_, i) => {
    const date = addDays(startOfToday(), i);
    const dateStr = format(date, 'yyyy-MM-dd');
    const dayOfWeek = getDay(date);
    const hours = config.weeklyHours[dayOfWeek];
    
    let isClosed = !hours || hours.isClosed;

    const blockouts = config.blockouts || [];
    if (!isClosed && hours && blockouts.length > 0) {
        const dayBlockouts = blockouts.filter(b => b.date === dateStr);
        if (dayBlockouts.length > 0) {
            const [openH, openM] = hours.start.split(':').map(Number);
            const [closeH, closeM] = hours.end.split(':').map(Number);
            const shopOpenMins = openH * 60 + openM;
            const shopCloseMins = closeH * 60 + closeM;

            const hasFullDayBlockout = dayBlockouts.some(b => {
                if (!b.startTime || !b.endTime) return false;
                const [bStartH, bStartM] = b.startTime.split(':').map(Number);
                const [bEndH, bEndM] = b.endTime.split(':').map(Number);
                const bStartMins = bStartH * 60 + bStartM;
                const bEndMins = bEndH * 60 + bEndM;
                return bStartMins <= shopOpenMins && bEndMins >= shopCloseMins;
            });

            if (hasFullDayBlockout) {
                isClosed = true;
            }
        }
    }
    
    return {
      dateStr,
      displayDay: format(date, 'EEE'),
      displayDate: format(date, 'd MMM'),
      isClosed
    };
  });

  useEffect(() => {
    if (selectedDate && selectedService) {
      const slots = api.getAvailableSlots(selectedDate, selectedService.durationMinutes, rescheduleBooking?.id);
      setAvailableSlots(slots);
      
      if (selectedSlot && !slots.includes(selectedSlot)) {
          setSelectedSlot('');
          setError('The slot you selected was just booked by someone else.');
      }
    }
  }, [selectedDate, selectedService, rescheduleBooking, apiTick]);

  // Default to online payment when entering payment step
  useEffect(() => {
    if (!paymentMethod) {
      setPaymentMethod(PaymentMethod.ONLINE);
    }
    if (!depositOption) {
      setDepositOption('full');
    }
  }, [paymentMethod, depositOption]);

  // Handle online payment - create booking after successful payment
  const handlePaymentSuccess = async (response: any) => {
    if (!selectedService || !selectedDate || !selectedSlot || !paymentMethod || !depositOption) return;
    
    setIsProcessingPayment(true);
    setError(null);
    
    try {
      const total = selectedService.price;
      const deposit = depositOption === 'deposit' ? total / 2 : total;
      
      // Determine payment status based on deposit amount
      const paymentStatus = depositOption === 'deposit' 
        ? PaymentStatus.PARTIALLY_PAID
        : PaymentStatus.PAID;
      
      // Create booking with payment details after successful payment
      const booking = await api.createBooking({
        clientName: client.name,
        clientPhone: client.phone,
        date: selectedDate,
        timeSlot: selectedSlot,
        serviceId: selectedService.id,
        serviceName: selectedService.name,
        durationMinutes: selectedService.durationMinutes,
        amount: total,
        depositAmount: deposit,
        paymentMethod: paymentMethod,
        paymentStatus: paymentStatus,
        paymentReference: response.reference,
        transactionId: response.transaction || response.trxref
      }, rescheduleBooking?.id);

      // Async Cancel old booking if rescheduling
      if (rescheduleBooking) {
        try {
            await api.updateBooking(rescheduleBooking.id, { status: BookingStatus.CANCELLED });
        } catch (e) {
            console.warn("Could not auto-cancel old booking during reschedule", e);
        }
      }
      
      setFinalBooking(booking);
      setStep(5);
      const paymentMessage = depositOption === 'deposit' 
        ? 'Booking confirmed! 50% deposit paid successfully.'
        : 'Booking confirmed! Full payment successful.';
      notify.success(paymentMessage);
    } catch (e: any) {
      api.refresh(); 
      
      // Payment succeeded but booking creation failed - critical error
      const errorMessage = e.message && e.message.includes('Database not connected')
        ? `Payment successful (Ref: ${response.reference}) but booking failed. Please contact support with this reference.`
        : `Payment successful (Ref: ${response.reference}) but booking failed. Please contact support.`;
      
      setError(errorMessage);
      notify.error(errorMessage);
    } finally {
      setIsProcessingPayment(false);
    }
  };

  const handlePaymentClose = () => {
    const message = "Payment was cancelled. Please try again or select 'Pay at Shop'.";
    setError(message);
    setIsProcessingPayment(false);
    notify.warning(message);
  };

  const handlePaymentError = (error: any) => {
    console.error("Payment error:", error);
    const message = "Payment failed. Please try again or select 'Pay at Shop'.";
    setError(message);
    setIsProcessingPayment(false);
    notify.error(message);
  };

  // Paystack requires an email; synthesize from phone digits (no user email input).
  const phoneDigits = client.phone.replace(/\D/g, '') || '0000000000';
  const paystackEmail = `${phoneDigits}@example.com`; // still phone-based, satisfies email format
  
  // Get and validate split code
  const rawSplitCode = import.meta.env.VITE_PAYSTACK_SPLIT_CODE?.trim();
  const paystackSplitCode = rawSplitCode && rawSplitCode.startsWith('SPL_') 
    ? rawSplitCode 
    : rawSplitCode || undefined;

  // Debug logging for Paystack configuration (remove after verification)
  useEffect(() => {
    if (paymentMethod === PaymentMethod.ONLINE) {
      console.log('=== Paystack Configuration Debug ===');
      console.log('Public Key:', import.meta.env.VITE_PAYSTACK_PUBLIC_KEY ? `${import.meta.env.VITE_PAYSTACK_PUBLIC_KEY.substring(0, 20)}...` : 'MISSING');
      console.log('Raw Split Code:', rawSplitCode || 'NOT SET');
      console.log('Validated Split Code:', paystackSplitCode || 'NOT SET');
      console.log('Split Code Length:', paystackSplitCode?.length || 0);
      console.log('Split Code Type:', typeof paystackSplitCode);
      if (rawSplitCode && !rawSplitCode.startsWith('SPL_')) {
        console.warn('⚠️ WARNING: Split code does not start with "SPL_". Format should be: SPL_xxxxxxxxxx');
      }
      console.log('===================================');
    }
  }, [paymentMethod, paystackSplitCode, rawSplitCode]);

  // Handle cash (pay at shop) bookings - creates booking without online payment
  const handleCashBooking = async () => {
    if (!selectedService || !selectedDate || !selectedSlot) return;

    setIsLoading(true);
    setError(null);

    try {
      const total = selectedService.price;
      // For cash payments, we treat everything as payable at the shop
      const deposit = 0;

      const booking = await api.createBooking({
        clientName: client.name,
        clientPhone: client.phone,
        date: selectedDate,
        timeSlot: selectedSlot,
        serviceId: selectedService.id,
        serviceName: selectedService.name,
        durationMinutes: selectedService.durationMinutes,
        amount: total,
        depositAmount: deposit,
        paymentMethod: PaymentMethod.CASH,
        paymentStatus: PaymentStatus.NOT_PAID,
        paymentReference: undefined,
        transactionId: undefined
      }, rescheduleBooking?.id);

      if (rescheduleBooking) {
        try {
          await api.updateBooking(rescheduleBooking.id, { status: BookingStatus.CANCELLED });
        } catch (e) {
          console.warn("Could not auto-cancel old booking during reschedule (cash flow)", e);
        }
      }

      setFinalBooking(booking);
      setStep(5);
      const message = rescheduleBooking 
        ? 'Booking rescheduled successfully! Please pay at the shop.'
        : 'Booking confirmed! Please pay at the shop.';
      notify.success(message);
    } catch (e: any) {
      console.error(e);
      let errorMessage: string;
      if (e.message && e.message.includes('Database not connected')) {
        errorMessage = 'Unable to create booking at the moment. Please try again later or contact the shop.';
      } else {
        errorMessage = 'Something went wrong while creating your booking. Please try again.';
      }
      setError(errorMessage);
      notify.error(errorMessage);
      api.refresh();
    } finally {
      setIsLoading(false);
    }
  };

  // Main handleBook - routes to cash or online payment flow
  const handleBook = () => {
    if (!selectedService || !selectedDate || !selectedSlot || !paymentMethod || !depositOption) return;
    
    // For cash payments, create booking immediately
    if (paymentMethod === PaymentMethod.CASH) {
      handleCashBooking();
    }
    // For online payments, PaystackButton will trigger payment, then handlePaymentSuccess will create booking
    // So we don't do anything here - the PaystackButton handles it
  };

  // Success Screen
  if (step === 5 && finalBooking) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-[#F2F2F7]">
        <div className="w-full max-w-md text-center animate-in zoom-in duration-500">
          <div className="w-24 h-24 bg-[#34C759] text-white rounded-full flex items-center justify-center mx-auto mb-8 shadow-xl shadow-[#34C759]/30">
            <Check strokeWidth={3} size={40} />
          </div>
          <h2 className="text-3xl font-bold text-[#1C1C1E] mb-2 tracking-tight">Confirmed</h2>
          <p className="text-[#8E8E93] mb-10 text-lg">
              {rescheduleBooking ? 'Your appointment has been rescheduled.' : 'Your appointment is booked.'}
          </p>

          <Card className="mb-8 text-left relative overflow-hidden shadow-lg" noPadding>
            <div className="p-6 bg-white">
              <div className="flex justify-between items-center pb-4 border-b border-[#E5E5EA]">
                <div>
                  <div className="text-[11px] font-bold text-[#8E8E93] uppercase tracking-widest mb-1">Time</div>
                  <div className="text-xl font-semibold text-[#1C1C1E]">{format(new Date(finalBooking.date), 'EEE, d MMMM')}</div>
                  <div className="text-lg text-[#007AFF]">{finalBooking.timeSlot}</div>
                </div>
                <div className="text-right">
                   <div className="text-[11px] font-bold text-[#8E8E93] uppercase tracking-widest mb-1">Service</div>
                   <div className="font-semibold text-[#1C1C1E]">{finalBooking.serviceName}</div>
                </div>
              </div>
              
              <div className="flex justify-between items-end pt-4">
                <div>
                  <div className="text-[11px] font-bold text-[#8E8E93] uppercase tracking-widest mb-1">Status</div>
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide ${finalBooking.paymentStatus === PaymentStatus.NOT_PAID || finalBooking.paymentStatus === PaymentStatus.PARTIALLY_PAID ? 'bg-[#FF9500]/10 text-[#FF9500]' : 'bg-[#34C759]/10 text-[#34C759]'}`}>
                    {finalBooking.paymentStatus}
                  </span>
                </div>
                <div className="text-right">
                  <div className="text-[11px] font-bold text-[#8E8E93] uppercase tracking-widest mb-1">Total</div>
                  <div className="text-2xl font-bold text-[#1C1C1E]">R{finalBooking.amount}</div>
                </div>
              </div>
            </div>
          </Card>

          <div className="flex flex-col gap-3">
               <Button variant="secondary" fullWidth onClick={() => {
                   if(onBookingComplete) onBookingComplete();
                   onViewBookings();
               }}>View My Bookings</Button>
              <Button variant="ghost" fullWidth onClick={() => {
                  if(onBookingComplete) onBookingComplete();
                  setStep(1);
                  setSelectedDate('');
                  setSelectedSlot('');
                  setFinalBooking(null);
                  setSelectedService(null);
              }}>Book Another Appointment</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F2F2F7] pb-36">
       {/* Sticky Header */}
       <div className="sticky top-0 z-30 bg-[#F2F2F7]/80 backdrop-blur-xl border-b border-[#000000]/5 px-6 py-4">
         <div className="max-w-lg mx-auto flex items-center justify-between">
            <div className="flex items-center gap-4">
                {step > 1 && (
                    <button 
                        onClick={() => setStep(step - 1 as any)}
                        className="flex items-center gap-1 text-[#007AFF] font-medium active:opacity-50 transition-opacity"
                    >
                        <ChevronLeft size={22} /> Back
                    </button>
                )}
                {step === 1 && (
                    <h2 className="font-bold text-2xl tracking-tight text-[#1C1C1E]">
                        {rescheduleBooking ? 'Reschedule' : 'New Booking'}
                    </h2>
                )}
                {step === 2 && selectedService && (
                    <h2 className="font-bold text-xl tracking-tight text-[#1C1C1E] truncate max-w-[180px]">{selectedService.name}</h2>
                )}
            </div>
            <button onClick={onLogout} className="w-8 h-8 rounded-full bg-[#E5E5EA] flex items-center justify-center text-[#8E8E93] hover:text-[#FF3B30] transition-colors">
                <LogOut size={14}/>
            </button>
         </div>
       </div>

       <div className="max-w-lg mx-auto p-6">
           
           {error && (
               <div className="mb-6 p-4 bg-[#FF3B30]/10 text-[#FF3B30] rounded-2xl flex items-center gap-3 text-sm font-medium animate-in slide-in-from-top-2">
                   <AlertCircle size={20} />
                   {error}
               </div>
           )}
           
           {rescheduleBooking && step < 5 && (
               <div className="mb-6 p-4 bg-[#007AFF]/10 text-[#007AFF] rounded-2xl flex items-start gap-3 text-sm font-medium animate-in slide-in-from-top-2">
                   <RotateCcw size={20} className="shrink-0 mt-0.5"/>
                   <div>
                       You are rescheduling. Your previous booking for <strong>{format(new Date(rescheduleBooking.date), 'MMM d')} at {rescheduleBooking.timeSlot}</strong> will be cancelled when you confirm this new booking.
                   </div>
               </div>
           )}

           {/* Step 1: Service Selection */}
           {step === 1 && (
             <div className="animate-in slide-in-from-right-8 duration-500 space-y-2">
                <label className="block text-[13px] font-semibold text-[#8E8E93] uppercase tracking-wide px-2">Select Service</label>
                <Card noPadding className="divide-y divide-[#E5E5EA]">
                    {config.services.map((service) => (
                        <div 
                            key={service.id} 
                            onClick={() => setSelectedService(service)}
                            className={`p-5 cursor-pointer transition-colors flex items-center justify-between active:bg-[#F2F2F7]
                                ${selectedService?.id === service.id ? 'bg-[#F2F2F7]' : 'bg-white'}`}
                        >
                            <div className="flex-1">
                                <div className="flex items-center gap-2 mb-0.5">
                                    <h3 className="font-semibold text-[17px] text-[#1C1C1E] tracking-tight">
                                        {service.name}
                                    </h3>
                                </div>
                                <div className="text-[15px] text-[#8E8E93]">
                                    {service.durationMinutes} min • R{service.price}
                                </div>
                            </div>
                            {selectedService?.id === service.id && <Check size={20} className="text-[#007AFF]" strokeWidth={2.5} />}
                        </div>
                    ))}
                </Card>
             </div>
           )}

           {/* Step 2: Date & Time Selection */}
           {step === 2 && selectedService && (
             <div className="space-y-8 animate-in slide-in-from-right-8 duration-500">
                <div className="space-y-3">
                    <div className="flex items-center justify-between px-2">
                         <label className="text-[13px] font-semibold text-[#8E8E93] uppercase tracking-wide">Select Date</label>
                         
                         <div className="hidden md:flex gap-2">
                             <button 
                                onClick={() => scrollDates('left')}
                                className="w-7 h-7 rounded-full bg-[#E5E5EA] flex items-center justify-center hover:bg-[#D1D1D6] transition-colors text-[#1C1C1E]"
                             >
                                 <ChevronLeft size={16} />
                             </button>
                             <button 
                                onClick={() => scrollDates('right')}
                                className="w-7 h-7 rounded-full bg-[#E5E5EA] flex items-center justify-center hover:bg-[#D1D1D6] transition-colors text-[#1C1C1E]"
                             >
                                 <ChevronRight size={16} />
                             </button>
                         </div>
                    </div>
                    
                    <div 
                        ref={dateScrollRef}
                        className="flex gap-3 overflow-x-auto pb-4 -mx-6 px-6 no-scrollbar snap-x scroll-smooth"
                    >
                        {upcomingDays.map(d => (
                            <button
                                key={d.dateStr}
                                disabled={d.isClosed}
                                onClick={() => {
                                    setSelectedDate(d.dateStr);
                                    setSelectedSlot('');
                                }}
                                className={`snap-start flex-shrink-0 w-[4.5rem] h-20 rounded-2xl flex flex-col items-center justify-center gap-0.5 transition-all duration-300
                                    ${d.isClosed ? 'opacity-50 grayscale cursor-not-allowed bg-[#F2F2F7] border border-transparent' : 
                                      selectedDate === d.dateStr 
                                        ? 'bg-[#007AFF] text-white shadow-lg shadow-[#007AFF]/30 scale-105' 
                                        : 'bg-white text-[#8E8E93] shadow-[0_2px_10px_rgba(0,0,0,0.03)]'}`}
                            >
                                <span className={`text-[11px] font-bold uppercase tracking-wide ${selectedDate === d.dateStr ? 'text-white/80' : ''}`}>{d.displayDay}</span>
                                {d.isClosed ? (
                                    <span className="text-[10px] font-bold text-[#FF3B30] uppercase">Closed</span>
                                ) : (
                                    <span className="text-xl font-semibold tracking-tight">{d.displayDate.split(' ')[0]}</span>
                                )}
                            </button>
                        ))}
                    </div>
                </div>

                {selectedDate && (
                    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                        <label className="block text-[13px] font-semibold text-[#8E8E93] uppercase tracking-wide mb-3 px-2">Available Time</label>
                        {availableSlots.length === 0 ? (
                            <div className="py-12 text-center bg-white rounded-3xl shadow-sm">
                                <div className="w-12 h-12 bg-[#F2F2F7] rounded-full flex items-center justify-center mx-auto mb-3">
                                    <Clock className="text-[#C7C7CC]" size={20} />
                                </div>
                                <p className="text-[#8E8E93] font-medium">No slots available for {selectedService.durationMinutes} min service.</p>
                            </div>
                        ) : (
                            <div className="grid grid-cols-3 gap-3">
                                {availableSlots.map(slot => (
                                    <button
                                        key={slot}
                                        onClick={() => setSelectedSlot(slot)}
                                        className={`py-3 rounded-xl text-sm font-semibold transition-all duration-200 border
                                            ${selectedSlot === slot 
                                                ? 'bg-[#1C1C1E] text-white border-transparent shadow-md scale-[1.02]' 
                                                : 'bg-white text-[#1C1C1E] border-transparent hover:bg-[#F2F2F7] shadow-[0_2px_8px_rgba(0,0,0,0.02)]'}`}
                                    >
                                        {slot}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
             </div>
           )}

           {/* Step 3: Payment Options */}
           {step === 3 && selectedService && (
            <div className="space-y-8 animate-in slide-in-from-right-8 duration-500">
                 
                 <Card className="p-6 bg-gradient-to-br from-[#1C1C1E] to-[#2C2C2E] text-white border-none shadow-xl relative overflow-hidden">
                    <div className="relative z-10">
                        <div className="text-white/60 text-xs font-bold uppercase tracking-widest mb-1">Total to Pay</div>
                        <div className="text-4xl font-bold tracking-tight">R{selectedService.price}</div>
                        <div className="mt-6 flex items-center gap-2 text-white/80 text-sm font-medium bg-white/10 w-fit px-3 py-1.5 rounded-full backdrop-blur-md">
                            <Scissors size={14} />
                            {selectedService.name}
                        </div>
                    </div>
                 </Card>

                 {/* Deposit Options */}
                 <div className="space-y-3">
                    <label className="block text-[13px] font-semibold text-[#8E8E93] uppercase tracking-wide px-2">Payment Amount</label>
                    <div className="grid grid-cols-2 gap-3">
                        <button
                            onClick={() => setDepositOption('deposit')}
                            className={`p-4 rounded-2xl border transition-all text-left ${depositOption === 'deposit' ? 'border-[#007AFF] ring-1 ring-[#007AFF] bg-white shadow-sm' : 'border-transparent bg-white shadow-sm hover:bg-[#F2F2F7]'}`}
                        >
                            <div className="text-[13px] font-bold text-[#8E8E93] uppercase tracking-wide mb-1">Pay Deposit</div>
                            <div className="text-xl font-bold text-[#1C1C1E]">50% (R{(selectedService.price / 2).toFixed(2)})</div>
                            <div className="text-[12px] text-[#8E8E93] mt-1">Secure your booking now</div>
                        </button>
                        <button
                            onClick={() => setDepositOption('full')}
                            className={`p-4 rounded-2xl border transition-all text-left ${depositOption === 'full' ? 'border-[#007AFF] ring-1 ring-[#007AFF] bg-white shadow-sm' : 'border-transparent bg-white shadow-sm hover:bg-[#F2F2F7]'}`}
                        >
                            <div className="text-[13px] font-bold text-[#8E8E93] uppercase tracking-wide mb-1">Pay Full</div>
                            <div className="text-xl font-bold text-[#1C1C1E]">R{selectedService.price.toFixed(2)}</div>
                            <div className="text-[12px] text-[#8E8E93] mt-1">No balance on arrival</div>
                        </button>
                    </div>
                 </div>

                 <div className="space-y-3">
                    <label className="block text-[13px] font-semibold text-[#8E8E93] uppercase tracking-wide px-2">Payment Method</label>
                    <div className="space-y-3">
                        <button
                            onClick={() => setPaymentMethod(PaymentMethod.ONLINE)}
                            className={`w-full p-4 rounded-2xl flex items-center justify-between transition-all bg-white shadow-sm border ${paymentMethod === PaymentMethod.ONLINE ? 'border-[#007AFF] ring-1 ring-[#007AFF]' : 'border-transparent'}`}
                        >
                            <div className="flex items-center gap-4">
                                <div className="w-10 h-10 rounded-full bg-[#007AFF]/10 flex items-center justify-center text-[#007AFF]">
                                    <CreditCard size={20} />
                                </div>
                                <div className="text-left">
                                    <div className="font-semibold text-[#1C1C1E]">Pay Online</div>
                                    <div className="text-[13px] text-[#8E8E93]">Secure payment via Paystack</div>
                                </div>
                            </div>
                            {paymentMethod === PaymentMethod.ONLINE && <Check size={20} className="text-[#007AFF]" />}
                        </button>
                    </div>
                 </div>

                 {/* Paystack Payment Button - Only show when online payment is selected */}
                 {paymentMethod === PaymentMethod.ONLINE && selectedService && selectedDate && selectedSlot && depositOption && (
                    <div className="mt-6">
                        {!import.meta.env.VITE_PAYSTACK_PUBLIC_KEY ? (
                            <div className="p-4 bg-[#FF9500]/10 text-[#FF9500] rounded-2xl flex items-center gap-3 text-sm font-medium">
                                <AlertCircle size={20} />
                                Payment system not configured. Please contact support or select 'Pay at Shop'.
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {paymentMethod === PaymentMethod.ONLINE && rawSplitCode && !rawSplitCode.startsWith('SPL_') && (
                                    <div className="p-3 bg-[#FF3B30]/10 text-[#FF3B30] rounded-xl text-sm font-medium">
                                        <AlertCircle size={16} className="inline mr-2" />
                                        Invalid split code format. Split code must start with "SPL_". Current value: "{rawSplitCode.substring(0, 20)}..."
                                    </div>
                                )}
                                {paymentMethod === PaymentMethod.ONLINE && !paystackSplitCode && !rawSplitCode && (
                                    <div className="p-3 bg-[#FF9500]/10 text-[#FF9500] rounded-xl text-sm font-medium">
                                        Warning: No Paystack split code set. Add VITE_PAYSTACK_SPLIT_CODE to enable revenue split.
                                    </div>
                                )}
                                <div className="[&>button]:w-full [&>button]:h-14 [&>button]:bg-[#007AFF] [&>button]:text-white [&>button]:rounded-full [&>button]:font-semibold [&>button]:text-lg [&>button]:shadow-xl [&>button]:hover:bg-[#0066CC] [&>button]:transition-all [&>button]:disabled:opacity-50 [&>button]:disabled:cursor-not-allowed">
                                    <PaystackButton
                                        publicKey={import.meta.env.VITE_PAYSTACK_PUBLIC_KEY}
                                        email={paystackEmail} // synthesized from phone to satisfy email format
                                        amount={Math.round((depositOption === 'deposit' ? selectedService.price * 0.5 : selectedService.price) * 100)} // cents
                                        currency="ZAR"
                                        reference={`WAYLINS-${Date.now()}-${uuidv4().substring(0, 8)}`}
                                        metadata={{ phone: phoneDigits } as any}
                                        split_code={paystackSplitCode || undefined}
                                        text={
                                          isProcessingPayment
                                            ? "Processing..."
                                            : rescheduleBooking
                                              ? `Pay & Reschedule (R${depositOption === 'deposit' ? selectedService.price / 2 : selectedService.price})`
                                              : `Pay Now (R${depositOption === 'deposit' ? selectedService.price / 2 : selectedService.price})`
                                        }
                                        onSuccess={handlePaymentSuccess}
                                        onClose={handlePaymentClose}
                                        disabled={isProcessingPayment}
                                    />
                                </div>
                                {isProcessingPayment && (
                                    <div className="text-center text-sm text-[#8E8E93] font-medium">
                                        Processing payment...
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                 )}
            </div>
           )}
       </div>

       {/* Floating Glass Action Bar */}
       <div className="fixed bottom-0 left-0 right-0 z-40">
         {/* Gradient fade for content below */}
         <div className="h-12 bg-gradient-to-t from-[#F2F2F7] to-transparent pointer-events-none" />
         <div className="bg-[#F2F2F7]/80 backdrop-blur-xl border-t border-[#000000]/10 p-4 pb-8">
             <div className="max-w-lg mx-auto">
                {/* For Step 3 with online payment, PaystackButton is shown above, so hide this button */}
                {!(step === 3 && paymentMethod === PaymentMethod.ONLINE) && (
                    <Button 
                        fullWidth 
                        variant={step === 3 ? 'secondary' : 'primary'}
                        disabled={
                            (step === 1 && !selectedService) || 
                            (step === 2 && (!selectedDate || !selectedSlot)) ||
                            (step === 3 && (!paymentMethod || !depositOption)) ||
                            isLoading ||
                            isProcessingPayment
                        }
                        onClick={() => {
                            if(step === 1) setStep(2);
                            else if(step === 2) setStep(3);
                            else if(step === 3) handleBook();
                        }}
                        className="shadow-xl"
                    >
                        {isLoading ? 'Processing...' : (step === 3 ? (rescheduleBooking ? 'Confirm & Reschedule' : 'Confirm Booking') : 'Continue')}
                    </Button>
                )}
                {/* Show message when processing online payment */}
                {step === 3 && paymentMethod === PaymentMethod.ONLINE && isProcessingPayment && (
                    <div className="text-center text-sm text-[#8E8E93] font-medium py-2">
                        Processing payment...
                    </div>
                )}
             </div>
         </div>
       </div>
    </div>
  );
};

const MyBookings: React.FC<{ client: Client, onBack: () => void, onReschedule: (booking: Booking) => void }> = ({ client, onBack, onReschedule }) => {
    const [bookings, setBookings] = useState<Booking[]>([]);
    const [refresh, setRefresh] = useState(0);

    useEffect(() => {
        setBookings(api.getClientBookings(client.phone));
        const unsubscribe = api.subscribe(() => {
            setBookings(api.getClientBookings(client.phone));
        });
        return unsubscribe;
    }, [client, refresh]);

    const handleCancel = async (id: string) => {
        if(confirm('Cancel this appointment?')) {
            try {
                await api.updateBooking(id, { status: BookingStatus.CANCELLED });
                notify.success('Appointment cancelled successfully');
            } catch (e) {
                console.warn(e);
                notify.error('Failed to cancel appointment. Please try again.');
                setRefresh(r => r + 1); 
            }
        }
    }

    return (
        <div className="min-h-screen bg-[#F2F2F7] p-6">
            <div className="max-w-lg mx-auto animate-in slide-in-from-right-8 duration-500">
                <div className="flex items-center gap-2 mb-8">
                    <button onClick={onBack} className="flex items-center gap-1 text-[#007AFF] font-medium active:opacity-50 transition-opacity pr-4">
                        <ChevronLeft size={22} /> Back
                    </button>
                    <h2 className="text-2xl font-bold tracking-tight text-[#1C1C1E]">My Bookings</h2>
                </div>
                
                {bookings.length === 0 ? (
                    <div className="text-center mt-32 opacity-50">
                         <Calendar className="mx-auto mb-4 text-[#8E8E93]" size={48} strokeWidth={1} />
                         <h3 className="text-lg font-semibold text-[#1C1C1E]">No bookings</h3>
                         <p className="text-[#8E8E93]">Your appointments will appear here.</p>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {bookings.map(b => (
                            <Card key={b.id} className="relative overflow-hidden group" noPadding>
                                <div className="p-5">
                                    <div className="flex justify-between items-start mb-3">
                                        <div>
                                            <div className="text-[11px] font-bold text-[#8E8E93] uppercase tracking-wide mb-1">
                                                {format(new Date(b.date), 'MMM d, yyyy')}
                                            </div>
                                            <div className="font-semibold text-xl text-[#1C1C1E] tracking-tight">{b.serviceName}</div>
                                            <div className="text-[#007AFF] font-medium mt-0.5">{b.timeSlot} ({(b.durationMinutes || 60)} min)</div>
                                        </div>
                                        <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide
                                            ${b.status === BookingStatus.CONFIRMED ? 'bg-[#34C759]/10 text-[#34C759]' : 
                                              b.status === BookingStatus.CANCELLED ? 'bg-[#8E8E93]/10 text-[#8E8E93]' : 'bg-[#34C759]/10 text-[#34C759]'}`}>
                                            {b.status}
                                        </span>
                                    </div>
                                    <div className="flex justify-between items-center mt-4 pt-4 border-t border-[#E5E5EA]">
                                        <div className="flex items-center gap-2 text-sm font-medium text-[#8E8E93]">
                                            <span className="text-[#1C1C1E]">R{b.amount}</span>
                                            <span>•</span>
                                            <span className={b.paymentStatus === PaymentStatus.NOT_PAID || b.paymentStatus === PaymentStatus.PARTIALLY_PAID ? 'text-[#FF9500]' : 'text-[#34C759]'}>{b.paymentStatus}</span>
                                        </div>
                                        {b.status !== BookingStatus.CANCELLED && (
                                            <div className="flex gap-2">
                                                <button onClick={() => onReschedule(b)} className="text-sm text-[#007AFF] font-medium hover:bg-[#007AFF]/5 px-3 py-1.5 rounded-full transition-colors flex items-center gap-1">
                                                    Reschedule
                                                </button>
                                                <button onClick={() => handleCancel(b.id)} className="text-sm text-[#FF3B30] font-medium hover:bg-[#FF3B30]/5 px-3 py-1.5 rounded-full transition-colors">
                                                    Cancel
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </Card>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

export const ClientPortal: React.FC = () => {
  const [client, setClient] = useState<Client | null>(null);
  const [view, setView] = useState<'wizard' | 'bookings'>('wizard');
  const [preselectedService, setPreselectedService] = useState<ServiceItem | null>(null);
  const [rescheduleBooking, setRescheduleBooking] = useState<Booking | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);

  useEffect(() => {
      const stored = localStorage.getItem('waylins_client');
      if (stored) {
          setClient(JSON.parse(stored));
      }
  }, []);

  const handleLogout = () => {
      localStorage.removeItem('waylins_client');
      setClient(null);
      setView('wizard');
      setPreselectedService(null);
      setRescheduleBooking(null);
      setGlobalError(null);
  }

  const handleReschedule = (booking: Booking) => {
      const config = api.getConfig();
      const service = config.services.find(s => s.id === booking.serviceId);
      
      if (service) {
          setPreselectedService(service);
          setRescheduleBooking(booking); 
          setView('wizard');
          setGlobalError(null);
      } else {
          setPreselectedService(null);
          setRescheduleBooking(null);
          setView('wizard');
          setGlobalError("The service for that booking is no longer available.");
      }
  };

  const handleBookingComplete = () => {
      setPreselectedService(null); 
      setRescheduleBooking(null); 
      setGlobalError(null);
  };

  if (!client) {
    return <LoginStep onComplete={setClient} />;
  }

  if (view === 'bookings') {
      return <MyBookings client={client} onBack={() => setView('wizard')} onReschedule={handleReschedule} />
  }

  return (
    <>
        <BookingWizard 
            key={preselectedService?.id || 'default'} 
            client={client} 
            onLogout={handleLogout} 
            onViewBookings={() => setView('bookings')}
            preselectedService={preselectedService}
            rescheduleBooking={rescheduleBooking}
            onBookingComplete={handleBookingComplete}
            globalError={globalError}
        />
        <div className="fixed top-5 right-5 z-40">
            <button 
                onClick={() => setView('bookings')}
                className="bg-white/90 backdrop-blur-md p-2.5 pr-4 rounded-full shadow-[0_8px_16px_rgba(0,0,0,0.1)] border border-white/20 text-[13px] font-semibold flex items-center gap-2 text-[#1C1C1E] hover:scale-105 transition-transform"
            >
                <div className="w-7 h-7 bg-[#1C1C1E] rounded-full flex items-center justify-center text-white">
                    <User size={14} /> 
                </div>
                My Bookings
            </button>
        </div>
    </>
  );
};