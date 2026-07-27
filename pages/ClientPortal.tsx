import React, { useState, useEffect, useRef } from 'react';
// @ts-ignore - @paystack/inline-js ships without type declarations
import PaystackPop from '@paystack/inline-js';
import { Link } from 'react-router-dom';
import { User, Calendar, Scissors, CreditCard, CheckCircle, Clock, ArrowLeft, LogOut, ChevronRight, ChevronLeft, Check, AlertCircle, RotateCcw } from 'lucide-react';
import { api, PaymentEnv, ServiceQuote } from '../services/api';
import { Client, ServiceItem, Booking, PaymentStatus, BookingStatus, Blockout } from '../types';
import { format, addDays, startOfToday, getDay } from 'date-fns';
import { parseDay } from '../services/availability';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
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
  const [availableSlots, setAvailableSlots] = useState<string[]>([]);
  const [finalBooking, setFinalBooking] = useState<Booking | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(globalError || null);
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  // Server-quoted pricing — the ONLY source of amounts shown in the wizard.
  const [quote, setQuote] = useState<ServiceQuote | null>(null);
  // Payment made; waiting for the webhook-created booking to appear.
  const [isConfirming, setIsConfirming] = useState(false);
  // Payment made but no booking appeared within the timeout.
  const [pendingReference, setPendingReference] = useState<string | null>(null);
  
  const dateScrollRef = useRef<HTMLDivElement>(null);
  const [apiTick, setApiTick] = useState(0);
  // Server-decided Paystack environment (test/live) + matching public key.
  const [paymentEnv, setPaymentEnv] = useState<PaymentEnv | null>(null);

  useEffect(() => {
    let mounted = true;
    api.getPaymentEnv().then(env => { if (mounted) setPaymentEnv(env); });
    return () => { mounted = false; };
  }, []);

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

  // Server quote for the selected service — the wizard never computes prices.
  useEffect(() => {
    setQuote(null);
    if (!selectedService) return;
    let mounted = true;
    api.getQuote(selectedService.id)
      .then(q => { if (mounted) setQuote(q); })
      .catch(e => {
        console.error('quoteService failed', e);
        if (mounted) setError('Could not load pricing. Please try again.');
      });
    return () => { mounted = false; };
  }, [selectedService]);

  const isTestMode = paymentEnv?.mode === 'test';
  // Server-side config validation failed (or getPaymentMode was unreachable):
  // show a clean "unavailable" state instead of a broken checkout.
  const isPaymentUnavailable = paymentEnv?.mode === 'unavailable';

  // Payment succeeded on the server-created transaction. The webhook writes
  // the booking; we only WAIT for it to appear (no client-side write, ever).
  const handlePaymentSuccess = async (reference: string) => {
    setIsProcessingPayment(false);
    setIsConfirming(true);
    setError(null);
    try {
      const booking = await api.waitForBookingByReference(reference, 60_000);
      if (booking) {
        setFinalBooking(booking);
        setStep(5);
        notify.success('Booking confirmed! Payment successful.');
      } else {
        setPendingReference(reference);
      }
    } finally {
      setIsConfirming(false);
    }
  };

  // Reschedule = move the EXISTING booking server-side. NO payment step,
  // NO Paystack — the original payment stays valid.
  const handleConfirmReschedule = async () => {
    if (!rescheduleBooking || !selectedDate || !selectedSlot || isLoading) return;
    setIsLoading(true);
    setError(null);
    try {
      await api.rescheduleBooking({
        bookingId: rescheduleBooking.id,
        clientPhone: client.phone,
        newDate: selectedDate,
        newTimeSlot: selectedSlot,
      });
      setFinalBooking({ ...rescheduleBooking, date: selectedDate, timeSlot: selectedSlot });
      setStep(5);
      notify.success('Appointment rescheduled. No new charge.');
      api.refresh();
    } catch (e: any) {
      console.error('rescheduleBooking failed', e);
      setError(e?.message || 'Could not reschedule. Please try again.');
      api.refresh();
    } finally {
      setIsLoading(false);
    }
  };

  const handlePaymentClose = () => {
    const message = "Payment was cancelled. Please try again to complete your booking.";
    setError(message);
    setIsProcessingPayment(false);
    notify.warning(message);
  };

  // The ONE payment path: initTransaction creates the transaction server-side
  // (server-computed amount, server reference); the popup only resumes it.
  const handlePay = async () => {
    if (!selectedService || !selectedDate || !selectedSlot || isProcessingPayment) return;
    setIsProcessingPayment(true);
    setError(null);
    try {
      const init = await api.initTransaction({
        serviceId: selectedService.id,
        date: selectedDate,
        timeSlot: selectedSlot,
        clientName: client.name,
        clientPhone: client.phone,
      });
      if (init.access_code) {
        const popup = new PaystackPop();
        popup.resumeTransaction(init.access_code, {
          onSuccess: () => handlePaymentSuccess(init.reference),
          onCancel: handlePaymentClose,
          onError: (e: any) => {
            console.error('Paystack popup error', e);
            setError('Payment failed. Please try again or use a different card.');
            setIsProcessingPayment(false);
            notify.error('Payment failed. Please try again.');
          },
        });
      } else {
        // Popup resume unavailable: pay on Paystack's hosted page instead.
        window.location.href = init.authorization_url;
      }
    } catch (e: any) {
      console.error('initTransaction failed', e);
      setError(e?.message || 'Could not start the payment. Please try again.');
      setIsProcessingPayment(false);
      api.refresh();
    }
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
                  <div className="text-xl font-semibold text-[#1C1C1E]">{format(parseDay(finalBooking.date), 'EEE, d MMMM')}</div>
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
                  {rescheduleBooking ? (
                    <div className="text-lg font-bold text-[#34C759]">No new charge</div>
                  ) : (
                    <div className="text-2xl font-bold text-[#1C1C1E]">R{finalBooking.amount}</div>
                  )}
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
                       You are rescheduling. Your booking for <strong>{format(parseDay(rescheduleBooking.date), 'MMM d')} at {rescheduleBooking.timeSlot}</strong> will be moved to the new time you pick. Your original payment stays valid — no new charge.
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
                            role="button"
                            tabIndex={0}
                            aria-label={`${service.name}, ${service.durationMinutes} minutes, R${service.price}`}
                            aria-pressed={selectedService?.id === service.id}
                            onKeyDown={e => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    setSelectedService(service);
                                }
                            }}
                            className={`p-5 cursor-pointer transition-colors flex items-center justify-between active:bg-[#F2F2F7] focus-visible:ring-2 focus-visible:ring-[#007AFF] outline-none
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
                        {quote === null ? (
                            <div className="text-2xl font-semibold tracking-tight text-white/60 animate-pulse">Loading price…</div>
                        ) : (
                            <>
                                <div className="text-4xl font-bold tracking-tight">R{quote.total}</div>
                                <div className="mt-4 flex flex-col gap-1 text-sm text-white/80">
                                    <div className="flex justify-between">
                                        <span>{selectedService.name}</span>
                                        <span>R{quote.base}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span>Booking fee (flat)</span>
                                        <span>R{quote.serviceFee}</span>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                 </Card>

                 <div className="space-y-3">
                    <label className="block text-[13px] font-semibold text-[#8E8E93] uppercase tracking-wide px-2">Payment Method</label>
                    <div className="space-y-3">
                        <div className="w-full p-4 rounded-2xl flex items-center justify-between transition-all bg-white shadow-sm border border-[#007AFF] ring-1 ring-[#007AFF]">
                            <div className="flex items-center gap-4">
                                <div className="w-10 h-10 rounded-full bg-[#007AFF]/10 flex items-center justify-center text-[#007AFF]">
                                    <CreditCard size={20} />
                                </div>
                                <div className="text-left">
                                    <div className="font-semibold text-[#1C1C1E]">Pay Online</div>
                                    <div className="text-[13px] text-[#8E8E93]">Secure payment via Paystack</div>
                                </div>
                            </div>
                            <Check size={20} className="text-[#007AFF]" />
                        </div>
                    </div>
                 </div>

                 {/* Pay button — the server (initTransaction) owns amount and reference. */}
                 {selectedService && selectedDate && selectedSlot && (
                    <div className="mt-6">
                        {pendingReference ? (
                            <div className="p-4 bg-[#FF9500]/10 text-[#FF9500] rounded-2xl flex items-start gap-3 text-sm font-medium">
                                <AlertCircle size={20} className="shrink-0 mt-0.5" />
                                <div>
                                    Payment received — confirmation is taking longer than expected.
                                    Do NOT pay again. Your booking will appear shortly; if it doesn't,
                                    contact the shop with this reference: <strong>{pendingReference}</strong>
                                </div>
                            </div>
                        ) : isConfirming ? (
                            <div className="p-4 bg-[#F2F2F7] text-[#8E8E93] rounded-2xl flex items-center gap-3 text-sm font-medium">
                                <Clock size={20} className="animate-pulse" />
                                Confirming booking...
                            </div>
                        ) : isPaymentUnavailable ? (
                            <div className="p-4 bg-[#FF3B30]/10 text-[#FF3B30] rounded-2xl flex items-start gap-3 text-sm font-medium">
                                <AlertCircle size={20} className="shrink-0 mt-0.5" />
                                <div>
                                    Online payment is temporarily unavailable.
                                    Please contact the shop to book your appointment.
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {isTestMode && (
                                    <div className="p-3 bg-[#FF9500]/10 text-[#FF9500] rounded-xl text-sm font-bold uppercase tracking-wide text-center">
                                        Test mode — no real money will be charged
                                    </div>
                                )}
                                <Button
                                    fullWidth
                                    variant="primary"
                                    className="h-14 text-lg shadow-xl"
                                    disabled={isProcessingPayment || quote === null}
                                    onClick={handlePay}
                                >
                                    {isProcessingPayment
                                        ? 'Processing...'
                                        : quote === null
                                            ? 'Loading price…'
                                            : `Pay Now (R${quote.total})`}
                                </Button>
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
                {/* Step 3's Pay button lives above, so hide this bar there */}
                {step !== 3 && (
                    <Button
                        fullWidth
                        variant="primary"
                        disabled={
                            (step === 1 && !selectedService) ||
                            (step === 2 && (!selectedDate || !selectedSlot)) ||
                            isLoading ||
                            isProcessingPayment
                        }
                        onClick={() => {
                            if(step === 1) setStep(2);
                            // Reschedule ends at step 2: confirm moves the
                            // existing booking — the payment step never runs.
                            else if(step === 2) rescheduleBooking ? handleConfirmReschedule() : setStep(3);
                        }}
                        className="shadow-xl"
                    >
                        {isLoading
                            ? 'Processing...'
                            : step === 2 && rescheduleBooking
                                ? 'Confirm Reschedule'
                                : 'Continue'}
                    </Button>
                )}
                {/* Show message when processing online payment */}
                {step === 3 && isProcessingPayment && (
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
    // In-app confirm (window.confirm is blocked in Instagram/WhatsApp
    // in-app browsers, which silently made cancelling impossible there).
    const [cancelTarget, setCancelTarget] = useState<Booking | null>(null);

    useEffect(() => {
        setBookings(api.getClientBookings(client.phone));
        const unsubscribe = api.subscribe(() => {
            setBookings(api.getClientBookings(client.phone));
        });
        return unsubscribe;
    }, [client, refresh]);

    const handleCancelConfirmed = async () => {
        if (!cancelTarget) return;
        const id = cancelTarget.id;
        setCancelTarget(null);
        try {
            // Server-side callable: direct booking writes are admin-only.
            await api.cancelBooking(id, client.phone);
            notify.success('Appointment cancelled successfully');
        } catch (e) {
            console.warn(e);
            notify.error('Failed to cancel appointment. Please try again.');
            setRefresh(r => r + 1);
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
                                                {format(parseDay(b.date), 'MMM d, yyyy')}
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
                                                <button onClick={() => setCancelTarget(b)} className="text-sm text-[#FF3B30] font-medium hover:bg-[#FF3B30]/5 px-3 py-1.5 rounded-full transition-colors">
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
            <ConfirmDialog
                open={cancelTarget !== null}
                title="Cancel appointment?"
                message={cancelTarget ? `${cancelTarget.serviceName} on ${format(parseDay(cancelTarget.date), 'MMM d')} at ${cancelTarget.timeSlot} will be cancelled.` : ''}
                confirmLabel="Cancel appointment"
                destructive
                onConfirm={handleCancelConfirmed}
                onCancel={() => setCancelTarget(null)}
            />
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