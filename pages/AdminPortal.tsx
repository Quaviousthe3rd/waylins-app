import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api, LedgerRow, ManualSettlePreview } from '../services/api';
import { Booking, ServiceItem, BookingStatus, PaymentStatus, Blockout } from '../types';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Calendar, List, Settings, Scissors, Clock, LogOut, Plus, Trash, Ban, Search, ChevronRight, ChevronDown, CreditCard, RefreshCw, X, Edit2, Phone, Menu, Loader2, AlertTriangle } from 'lucide-react';
import { format, isBefore, parseISO, startOfMonth, endOfMonth, subMonths } from 'date-fns';
import { DEFAULT_HOURS } from '../constants';
import { notify } from '../services/notifications';

// --- Admin Login ---
const AdminLogin: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const ok = await api.login(email, password);
      if (!ok) {
        setError('This account is not authorized for admin access');
        setIsLoading(false);
        setPassword('');
      }
      // On success the auth state listener in AdminPortal unlocks the portal.
    } catch (err) {
      setError('Sign in failed. Check your email and password.');
      setIsLoading(false);
      setPassword('');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F2F2F7] p-6">
      <div className="w-full max-w-sm animate-in zoom-in duration-300">
        <Card className="p-8 shadow-2xl shadow-black/5 text-center">
          <div className="w-20 h-20 bg-[#1C1C1E] rounded-[1.8rem] flex items-center justify-center mx-auto mb-6 shadow-lg shadow-black/10">
            <Settings className="text-white" size={36} />
          </div>
          <h2 className="text-2xl font-bold text-[#1C1C1E] tracking-tight mb-1">Manager Access</h2>
          <p className="text-[#8E8E93] mb-8 text-sm">Sign in with your admin account</p>

          <form onSubmit={handleLogin} className="space-y-4">
             <input
                 type="email"
                 value={email}
                 onChange={e => setEmail(e.target.value)}
                 className="w-full p-4 bg-[#F2F2F7] rounded-xl border-none outline-none focus:ring-2 focus:ring-[#007AFF]/20 text-[#1C1C1E] transition-all disabled:opacity-50"
                 placeholder="Email"
                 autoFocus
                 autoComplete="username"
                 required
                 disabled={isLoading}
             />
             <input
                 type="password"
                 value={password}
                 onChange={e => setPassword(e.target.value)}
                 className="w-full p-4 bg-[#F2F2F7] rounded-xl border-none outline-none focus:ring-2 focus:ring-[#007AFF]/20 text-[#1C1C1E] transition-all disabled:opacity-50"
                 placeholder="Password"
                 autoComplete="current-password"
                 required
                 disabled={isLoading}
             />
            {error && <p className="text-[#FF3B30] text-xs font-medium">{error}</p>}
            <Button fullWidth type="submit" variant="primary" disabled={isLoading}>
                {isLoading ? <><Loader2 className="animate-spin" size={20}/> Verifying...</> : 'Unlock'}
            </Button>
          </form>
          
          <div className="mt-8 pt-6 border-t border-[#E5E5EA]">
              <Link to="/client" className="text-xs font-semibold text-[#8E8E93] hover:text-[#1C1C1E] transition-colors">Return to Booking Portal</Link>
          </div>
        </Card>
      </div>
    </div>
  );
};

// --- Dashboard Tabs ---

const BookingsTab: React.FC<{ onOpenStatement?: () => void }> = ({ onOpenStatement }) => {
  const [bookings, setBookings] = useState<Booking[]>(api.getBookings());
  const [filter, setFilter] = useState('');
  // Honest money figures, sourced from the SAME ledger fetch + reducer the
  // Statement tab uses (deriveRow/addToTotals below) so the two screens can
  // never disagree. Test rows are excluded, refunds subtract, anomalies and
  // broken rows contribute nothing — identical rules to the Statement tab.
  const [ledgerStats, setLedgerStats] = useState<{
      collectedC: number;
      anomalyCount: number;
      paidBookingIds: Set<string>;
  } | null>(null);
  const [ledgerError, setLedgerError] = useState(false);

  useEffect(() => {
      let mounted = true;
      const now = new Date();
      api.getLedgerRows(startOfMonth(now), endOfMonth(now))
          .then(ledger => {
              if (!mounted) return;
              const live = ledger.map(deriveRow).filter(r => r.row.mode !== 'test');
              const t = zeroTotals();
              live.forEach(r => addToTotals(t, r));
              const paidBookingIds = new Set<string>();
              live.forEach(r => {
                  if (r.row.status === 'PAID_BOOKED' && r.row.bookingId) {
                      paidBookingIds.add(r.row.bookingId);
                  }
              });
              setLedgerStats({
                  // Collected = what actually arrived and stayed: barber net
                  // + owner cut (= charged minus Paystack fees), refunds
                  // already subtracted by addToTotals.
                  collectedC: t.barberNet + t.ownerCut,
                  anomalyCount: live.filter(r => r.isAnomaly).length,
                  paidBookingIds,
              });
          })
          .catch(e => {
              console.error('dashboard ledger fetch failed', e);
              if (mounted) setLedgerError(true);
          });
      return () => { mounted = false; };
  }, []);

  useEffect(() => {
      const unsubscribe = api.subscribe(() => {
          setBookings(api.getBookings());
      });
      return unsubscribe;
  }, []);

  const refreshBookings = () => {
      api.refresh();
      setBookings(api.getBookings());
  };

  const handleDelete = async (id: string) => {
      if(confirm('Permanently delete this booking record?')) {
          try {
              await api.deleteBooking(id);
          } catch (e) {
              console.warn('Delete failed or item already gone', e);
              refreshBookings();
          }
      }
  };

  const filtered = bookings.filter(b => {
    const searchTerm = filter.toLowerCase();
    return (
        b.clientName.toLowerCase().includes(searchTerm) ||
        b.clientPhone.includes(searchTerm) ||
        b.date.includes(searchTerm) ||
        b.status.toLowerCase().includes(searchTerm) ||
        b.serviceName.toLowerCase().includes(searchTerm) ||
        b.paymentStatus.toLowerCase().includes(searchTerm)
    );
  }).sort((a, b) => {
    const dateA = new Date(a.date + 'T' + a.timeSlot).getTime();
    const dateB = new Date(b.date + 'T' + b.timeSlot).getTime();
    const now = new Date().getTime();
    
    const isFutureA = dateA >= now - 3600000; 
    const isFutureB = dateB >= now - 3600000;
    
    if (isFutureA && !isFutureB) return -1; 
    if (!isFutureA && isFutureB) return 1;
    
    if (isFutureA && isFutureB) {
        return dateA - dateB; 
    } else {
        return dateB - dateA; 
    }
  });

  const updateStatus = async (booking: Booking, status: BookingStatus) => {
    try {
        await api.updateBooking(booking.id, {
            status,
            ...(status === BookingStatus.CANCELLED
                ? { cancelledBy: 'admin' as const, cancelledAt: new Date().toISOString() }
                : {}),
        });
        notify.success(`Booking ${status.toLowerCase()} successfully`);
    } catch (e) {
        console.error('Update failed', e);
        notify.error('Failed to update booking. It may have been deleted.');
    }
  };
  
  const updatePayment = async (booking: Booking, status: PaymentStatus) => {
    try {
        await api.updateBooking(booking.id, { paymentStatus: status });
        notify.success(`Payment status updated to ${status}`);
    } catch (e) {
        console.error('Update failed', e);
        notify.error('Failed to update payment status.');
    }
  };

  const today = format(new Date(), 'yyyy-MM-dd');
  const todayBookings = bookings.filter(b => b.date === today && b.status === BookingStatus.CONFIRMED);

  // OUTSTANDING: confirmed live bookings with no matching paid ledger row —
  // unpaid / pay-in-person money that has NOT been collected. Bookings paid
  // outside the current month won't be in the month-scoped ledger fetch, so
  // paymentStatus Paid/Refunded also counts as settled.
  const outstandingC = bookings
      .filter(b =>
          b.status === BookingStatus.CONFIRMED &&
          b.mode !== 'test' &&
          !ledgerStats?.paidBookingIds.has(b.id) &&
          b.paymentStatus !== PaymentStatus.PAID &&
          b.paymentStatus !== PaymentStatus.REFUNDED)
      .reduce((acc, b) => acc + Math.round((Number(b.amount) || 0) * 100), 0);

  // UPCOMING: a COUNT of future confirmed bookings — not money until it is
  // collected, so never rendered with an R prefix.
  const nowMs = Date.now();
  const upcomingCount = bookings.filter(b =>
      b.status === BookingStatus.CONFIRMED &&
      b.mode !== 'test' &&
      new Date(`${b.date}T${b.timeSlot || '00:00'}`).getTime() >= nowMs
  ).length;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">

      {/* Stats Grid — sourced from the ledger, same rules as the Statement
          tab. COLLECTED is the headline; "Total Revenue" (a sum of every
          confirmed booking's amount, paid or not) was inflated and is gone. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-5 flex flex-col justify-between bg-[#1C1C1E] text-white border-none shadow-lg shadow-black/10 col-span-2 md:col-span-1" noPadding>
            <div className="p-5">
                <div className="text-white/60 text-[11px] font-bold uppercase tracking-wider mb-2">Collected · This Month</div>
                <div className="text-3xl font-bold tracking-tight">
                    {ledgerError ? '—' : ledgerStats === null ? '…' : fmtRand(ledgerStats.collectedC)}
                </div>
                <div className="text-white/40 text-[10px] mt-1">Received after Paystack fees, refunds subtracted</div>
            </div>
        </Card>
        <Card className="flex flex-col justify-between" noPadding>
            <div className="p-5">
                <div className="text-[#8E8E93] text-[11px] font-bold uppercase tracking-wider mb-2">Outstanding</div>
                <div className="text-3xl font-bold text-[#FF9500] tracking-tight">{fmtRand(outstandingC)}</div>
                <div className="text-[#8E8E93] text-[10px] mt-1">Confirmed but not paid</div>
            </div>
        </Card>
        <Card className="flex flex-col justify-between" noPadding>
            <div className="p-5">
                <div className="text-[#8E8E93] text-[11px] font-bold uppercase tracking-wider mb-2">Upcoming</div>
                <div className="text-3xl font-bold text-[#1C1C1E] tracking-tight">{upcomingCount}</div>
                <div className="text-[#8E8E93] text-[10px] mt-1">Future confirmed bookings (count)</div>
            </div>
        </Card>
        <Card className="flex flex-col justify-between" noPadding>
            <div className="p-5">
                <div className="text-[#8E8E93] text-[11px] font-bold uppercase tracking-wider mb-2">Today's Clients</div>
                <div className="text-3xl font-bold text-[#1C1C1E] tracking-tight">{todayBookings.length}</div>
            </div>
        </Card>
      </div>

      {ledgerStats !== null && ledgerStats.anomalyCount > 0 && (
        <button
            onClick={onOpenStatement}
            className="w-full p-3 bg-[#FF3B30]/10 text-[#FF3B30] rounded-xl text-sm font-semibold flex items-center gap-2 hover:bg-[#FF3B30]/15 transition-colors"
        >
            <AlertTriangle size={16} />
            {ledgerStats.anomalyCount} payment{ledgerStats.anomalyCount === 1 ? '' : 's'} this month did not resolve cleanly and {ledgerStats.anomalyCount === 1 ? 'is' : 'are'} NOT counted as collected — review the Statement tab.
        </button>
      )}
      {ledgerError && (
        <div className="p-3 bg-[#FF9500]/10 text-[#FF9500] rounded-xl text-sm font-medium">
            Could not load the ledger — the Collected figure is unavailable (never estimated from bookings).
        </div>
      )}

      {/* Search & Action */}
      <div className="flex gap-3">
        <div className="relative flex-1">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-[#8E8E93]" size={18} />
            <input 
            type="text" 
            placeholder="Search name, phone, service or status..." 
            className="w-full pl-11 p-3.5 bg-[#E5E5EA] rounded-xl border-none outline-none focus:bg-white focus:ring-2 focus:ring-[#007AFF]/20 text-[#1C1C1E] placeholder:text-[#8E8E93] transition-all font-medium"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            />
        </div>
        <Button variant="ios" onClick={refreshBookings} className="rounded-xl w-12 p-0 flex items-center justify-center">
            <RefreshCw size={20} />
        </Button>
      </div>

      {/* Bookings List */}
      <div className="overflow-hidden rounded-2xl border border-[#C6C6C8]/30 shadow-sm bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[600px]">
              <thead className="bg-[#F2F2F7] border-b border-[#C6C6C8]/30">
                  <tr>
                  <th className="p-4 font-semibold text-[#8E8E93] uppercase tracking-wider text-[11px]">Client</th>
                  <th className="p-4 font-semibold text-[#8E8E93] uppercase tracking-wider text-[11px]">Service</th>
                  <th className="p-4 font-semibold text-[#8E8E93] uppercase tracking-wider text-[11px]">Payment</th>
                  <th className="p-4 font-semibold text-[#8E8E93] uppercase tracking-wider text-[11px]">Status</th>
                  <th className="p-4 font-semibold text-[#8E8E93] uppercase tracking-wider text-[11px] text-right">Action</th>
                  </tr>
              </thead>
              <tbody className="divide-y divide-[#C6C6C8]/30">
                  {filtered.map(b => (
                  <tr key={b.id} className="group hover:bg-[#F2F2F7] transition-colors">
                      <td className="p-4 whitespace-nowrap">
                          <div className="flex items-center gap-3">
                              <div className="w-9 h-9 rounded-full bg-[#E5E5EA] text-[#8E8E93] flex items-center justify-center font-bold text-xs">
                                  {b.clientName.substring(0,2).toUpperCase()}
                              </div>
                              <div>
                                  <div className="font-semibold text-[#1C1C1E] text-sm">{b.clientName}</div>
                                  <a href={`tel:${b.clientPhone}`} className="text-xs text-[#007AFF] hover:underline flex items-center gap-1 mt-0.5">
                                      <Phone size={10} /> {b.clientPhone}
                                  </a>
                              </div>
                          </div>
                      </td>
                      <td className="p-4 whitespace-nowrap">
                          <div className="text-sm font-medium text-[#1C1C1E]">{b.serviceName}</div>
                          <div className="text-xs text-[#8E8E93] mt-0.5">
                              {format(new Date(b.date), 'MMM d')} at {b.timeSlot}
                          </div>
                          <div className="text-[10px] text-[#8E8E93] mt-0.5">
                              {(b.durationMinutes || 60)} mins
                          </div>
                      </td>
                      <td className="p-4 whitespace-nowrap">
                          <div className="flex flex-col gap-1 items-start">
                              <div className="flex flex-col gap-0.5">
                                  <span className="font-semibold text-[#1C1C1E] text-sm">R{b.amount}</span>
                                  {b.paymentStatus === PaymentStatus.PARTIALLY_PAID && (
                                      <div className="text-[10px] text-[#8E8E93]">
                                          Paid: R{b.depositAmount.toFixed(2)} | 
                                          <span className="text-[#FF9500] font-semibold"> Balance: R{(b.amount - b.depositAmount).toFixed(2)}</span>
                                      </div>
                                  )}
                              </div>
                              <button 
                                  onClick={() => {
                                      // Toggle logic: PARTIALLY_PAID -> PAID, PAID -> NOT_PAID, NOT_PAID -> PAID
                                      let newStatus: PaymentStatus;
                                      if (b.paymentStatus === PaymentStatus.PARTIALLY_PAID) {
                                          newStatus = PaymentStatus.PAID; // Mark as fully paid when balance collected
                                      } else if (b.paymentStatus === PaymentStatus.PAID) {
                                          newStatus = PaymentStatus.NOT_PAID;
                                      } else {
                                          newStatus = PaymentStatus.PAID;
                                      }
                                      updatePayment(b, newStatus);
                                  }}
                                  className={`text-[10px] font-bold px-2 py-0.5 rounded-full border transition-all cursor-pointer
                                  ${b.paymentStatus === PaymentStatus.PAID 
                                      ? 'bg-[#34C759]/10 text-[#34C759] border-transparent hover:bg-[#34C759]/20' 
                                      : b.paymentStatus === PaymentStatus.PARTIALLY_PAID
                                      ? 'bg-[#FF9500]/10 text-[#FF9500] border-transparent hover:bg-[#FF9500]/20'
                                      : 'bg-[#FF9500]/10 text-[#FF9500] border-transparent hover:bg-[#FF9500] hover:text-white'}`}
                              >
                                  {b.paymentStatus}
                              </button>
                          </div>
                      </td>
                      <td className="p-4 whitespace-nowrap">
                          <span className={`inline-flex items-center px-2 py-1 rounded-md text-[11px] font-bold uppercase tracking-wide
                              ${b.status === BookingStatus.CONFIRMED ? 'text-[#007AFF] bg-[#007AFF]/10' : 
                              b.status === BookingStatus.CANCELLED ? 'text-[#8E8E93] bg-[#8E8E93]/10' : 'text-[#34C759] bg-[#34C759]/10'}`}>
                              {b.status}
                          </span>
                      </td>
                      <td className="p-4 text-right whitespace-nowrap">
                          <div className="flex justify-end items-center gap-1">
                            {b.status === BookingStatus.CONFIRMED && (
                                <button onClick={() => updateStatus(b, BookingStatus.CANCELLED)} className="text-[#C7C7CC] hover:text-[#FF9500] hover:bg-[#FF9500]/10 p-2 rounded-full transition-all">
                                    <Ban size={18} />
                                </button>
                            )}
                            {b.status === BookingStatus.CANCELLED && (
                                <button onClick={() => handleDelete(b.id)} className="text-[#C7C7CC] hover:text-[#FF3B30] hover:bg-[#FF3B30]/10 p-2 rounded-full transition-all">
                                    <Trash size={18} />
                                </button>
                            )}
                          </div>
                      </td>
                  </tr>
                  ))}
              </tbody>
          </table>
        </div>
        {filtered.length === 0 && <div className="p-12 text-center text-[#8E8E93] text-sm">No matching bookings.</div>}
      </div>
    </div>
  );
};

const ServicesTab: React.FC = () => {
  const [config, setConfig] = useState(api.getConfig());
  const [isEditing, setIsEditing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  
  const [formData, setFormData] = useState<{name: string, price: string, duration: string}>({
      name: '', price: '', duration: '60'
  });
  
  const [initialData, setInitialData] = useState<{name: string, price: string, duration: string} | null>(null);

  useEffect(() => {
      const unsubscribe = api.subscribe(() => {
          setConfig(api.getConfig());
      });
      return unsubscribe;
  }, []);

  const openEdit = (service: ServiceItem) => {
      const data = {
          name: service.name,
          price: service.price.toString(),
          duration: service.durationMinutes.toString()
      };
      setFormData(data);
      setInitialData(data); 
      setEditingId(service.id);
      setIsEditing(true);
  };

  const handleSave = async () => {
    try {
        const price = parseFloat(formData.price);
        const duration = parseInt(formData.duration);

        if(!formData.name || isNaN(price) || isNaN(duration)) return;
        
        if (editingId && initialData) {
            const updates: Partial<ServiceItem> = {};
            if (formData.name !== initialData.name) updates.name = formData.name;
            if (parseFloat(formData.price) !== parseFloat(initialData.price)) updates.price = price;
            if (parseInt(formData.duration) !== parseInt(initialData.duration)) updates.durationMinutes = duration;
            
            if (Object.keys(updates).length > 0) {
                await api.updateService(editingId, updates);
            }
        } else {
            await api.addService({ 
                id: Date.now().toString(), 
                name: formData.name, 
                price, 
                durationMinutes: duration 
            });
        }
        
        setIsEditing(false);
        setEditingId(null);
        setInitialData(null);
        setFormData({ name: '', price: '', duration: '60' });
        notify.success('Service saved successfully');
    } catch (e) {
        notify.error("Failed to save service. Storage might be full or item modified.");
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this service?')) return;
    try {
        await api.deleteService(id);
        notify.success('Service deleted successfully');
    } catch (e) {
        notify.error("Failed to delete service.");
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-3xl">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-xl font-bold tracking-tight text-[#1C1C1E]">Service Menu</h3>
        <Button 
            onClick={() => {
                setIsEditing(true);
                setEditingId(null);
                setInitialData(null);
                setFormData({ name: '', price: '', duration: '60' });
            }} 
            variant="ios" 
            className="rounded-full px-4 h-9 text-sm"
        >
            <Plus size={16} /> Add Service
        </Button>
      </div>
      
      {isEditing && (
        <Card className="p-5 bg-[#F2F2F7] mb-6 border border-[#C6C6C8] shadow-none">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
            <input 
              placeholder="Service Name" 
              className="p-3 bg-white rounded-xl border-none shadow-sm outline-none focus:ring-2 focus:ring-[#007AFF]/20 text-sm"
              value={formData.name}
              onChange={e => setFormData({...formData, name: e.target.value})}
            />
            <input 
              type="number"
              placeholder="Price (R)" 
              className="p-3 bg-white rounded-xl border-none shadow-sm outline-none focus:ring-2 focus:ring-[#007AFF]/20 text-sm"
              value={formData.price}
              onChange={e => setFormData({...formData, price: e.target.value})}
            />
            <input 
              type="number"
              placeholder="Minutes" 
              className="p-3 bg-white rounded-xl border-none shadow-sm outline-none focus:ring-2 focus:ring-[#007AFF]/20 text-sm"
              value={formData.duration}
              onChange={e => setFormData({...formData, duration: e.target.value})}
            />
          </div>
          <div className="flex gap-3">
            <Button 
                onClick={handleSave} 
                variant="primary" 
                className="h-10 text-sm"
                disabled={!formData.name || !formData.price}
            >
                {editingId ? 'Update' : 'Save'}
            </Button>
            <Button variant="ghost" onClick={() => setIsEditing(false)} className="h-10 text-sm">Cancel</Button>
          </div>
        </Card>
      )}

      <div className="bg-white rounded-2xl shadow-sm border border-[#C6C6C8]/30 overflow-hidden divide-y divide-[#C6C6C8]/30">
        {config.services.map(s => (
          <div key={s.id} className="p-4 flex justify-between items-center hover:bg-[#F2F2F7] transition-colors group">
            <div className="flex items-center gap-4 cursor-pointer flex-1" onClick={() => openEdit(s)}>
                <div className="w-10 h-10 bg-[#E5E5EA] text-[#8E8E93] rounded-lg flex items-center justify-center">
                    <Scissors size={18} />
                </div>
                <div>
                    <div className="font-semibold text-[#1C1C1E]">{s.name}</div>
                    <div className="text-xs text-[#8E8E93] font-medium">{s.durationMinutes} mins</div>
                </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="font-semibold text-[#1C1C1E] mr-2">R{s.price}</div>
              <button onClick={() => openEdit(s)} className="text-[#C7C7CC] hover:text-[#007AFF] transition-colors p-2">
                  <Edit2 size={18}/>
              </button>
              <button onClick={() => handleDelete(s.id)} className="text-[#C7C7CC] hover:text-[#FF3B30] transition-colors p-2">
                  <Trash size={18}/>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const SettingsTab: React.FC = () => {
    const [config, setConfig] = useState(api.getConfig());
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const [error, setError] = useState<string|null>(null);
    
    const [newBlockout, setNewBlockout] = useState({ date: '', startTime: '09:00', endTime: '17:00', reason: 'Holiday' });

    useEffect(() => {
        const unsubscribe = api.subscribe(() => {
            setConfig(api.getConfig());
        });
        return unsubscribe;
    }, []);

    const toggleDay = async (dayIndex: number) => {
        try {
            const hours = config.weeklyHours[dayIndex] || DEFAULT_HOURS[dayIndex];
            await api.updateWorkingHours(dayIndex, { isClosed: !hours.isClosed });
            notify.success('Working hours updated');
        } catch (e) {
            notify.error("Failed to update hours.");
        }
    }

    const updateHours = async (dayIndex: number, field: 'start' | 'end', value: string) => {
        setError(null);
        try {
            const currentDay = config.weeklyHours[dayIndex] || DEFAULT_HOURS[dayIndex];
            
            if (field === 'end' && value <= currentDay.start) {
                setError('End time must be after start time');
                return; 
            }
            if (field === 'start' && value >= currentDay.end) {
                setError('Start time must be before end time');
                return;
            }

            await api.updateWorkingHours(dayIndex, { [field]: value });
            notify.success('Working hours updated');
        } catch (e) {
            notify.error("Failed to update hours.");
        }
    };

    const addBlockout = async () => {
        if(!newBlockout.date) return;
        if(newBlockout.endTime <= newBlockout.startTime) {
            setError('Blockout end time must be after start time');
            return;
        }
        try {
            await api.addBlockout({
                id: Date.now().toString(),
                ...newBlockout
            });
            
            setNewBlockout({ date: '', startTime: '09:00', endTime: '17:00', reason: 'Holiday' });
            setError(null);
            notify.success('Blockout added successfully');
        } catch (e) {
            notify.error("Failed to save blockout.");
        }
    };

    const removeBlockout = async (id: string) => {
        try {
            await api.removeBlockout(id);
            notify.success('Blockout deleted successfully');
        } catch (e) {
            notify.error("Failed to delete blockout.");
        }
    };

    return (
        <div className="max-w-2xl space-y-10 animate-in fade-in duration-500 pb-20">
            {/* Weekly Hours Section */}
            <div>
                <h3 className="text-lg font-bold mb-4 tracking-tight text-[#8E8E93] uppercase text-xs ml-4">Shop Schedule</h3>
                {error && <div className="mb-4 p-3 bg-red-50 text-red-500 rounded-lg text-sm font-medium">{error}</div>}
                <div className="bg-white rounded-2xl shadow-sm border border-[#C6C6C8]/30 overflow-hidden divide-y divide-[#C6C6C8]/30">
                    {days.map((day, idx) => {
                        const hours = config.weeklyHours[idx];
                        return (
                            <div key={idx} className="p-4 flex items-center justify-between">
                                <span className="font-medium text-[#1C1C1E] text-sm">{day}</span>
                                <div className="flex items-center gap-4">
                                    {!hours.isClosed && (
                                        <div className="flex items-center gap-2">
                                            <input 
                                                type="time" 
                                                value={hours.start} 
                                                onChange={(e) => updateHours(idx, 'start', e.target.value)}
                                                className="bg-[#F2F2F7] rounded-lg px-2 py-1 text-sm font-medium text-[#1C1C1E] border-none outline-none focus:ring-2 focus:ring-[#007AFF]/20"
                                            />
                                            <span className="text-[#8E8E93] text-xs">to</span>
                                            <input 
                                                type="time" 
                                                value={hours.end} 
                                                onChange={(e) => updateHours(idx, 'end', e.target.value)}
                                                className="bg-[#F2F2F7] rounded-lg px-2 py-1 text-sm font-medium text-[#1C1C1E] border-none outline-none focus:ring-2 focus:ring-[#007AFF]/20"
                                            />
                                        </div>
                                    )}
                                    <button 
                                        onClick={() => toggleDay(idx)}
                                        className={`w-14 h-8 rounded-full relative transition-colors duration-200 ease-in-out ${!hours.isClosed ? 'bg-[#34C759]' : 'bg-[#E5E5EA]'}`}
                                    >
                                        <span className={`absolute top-1 left-1 w-6 h-6 bg-white rounded-full shadow-sm transition-transform duration-200 ${!hours.isClosed ? 'translate-x-6' : 'translate-x-0'}`} />
                                    </button>
                                </div>
                            </div>
                        )
                    })}
                </div>
            </div>

            {/* Blockouts Section */}
            <div>
                 <h3 className="text-lg font-bold mb-4 tracking-tight text-[#8E8E93] uppercase text-xs ml-4">Block Dates / Time Off</h3>
                 <Card className="p-5 bg-[#F2F2F7] mb-4 border border-[#C6C6C8] shadow-none">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                        <input 
                            type="date"
                            className="p-3 bg-white rounded-xl border-none shadow-sm outline-none text-sm w-full"
                            value={newBlockout.date}
                            onChange={e => setNewBlockout({...newBlockout, date: e.target.value})}
                        />
                         <input 
                            type="text"
                            placeholder="Reason (e.g. Lunch)"
                            className="p-3 bg-white rounded-xl border-none shadow-sm outline-none text-sm w-full"
                            value={newBlockout.reason}
                            onChange={e => setNewBlockout({...newBlockout, reason: e.target.value})}
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-3 mb-4">
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-bold uppercase text-[#8E8E93] ml-1">Start</label>
                            <input 
                                type="time"
                                className="p-3 bg-white rounded-xl border-none shadow-sm outline-none text-sm w-full"
                                value={newBlockout.startTime}
                                onChange={e => setNewBlockout({...newBlockout, startTime: e.target.value})}
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-bold uppercase text-[#8E8E93] ml-1">End</label>
                            <input 
                                type="time"
                                className="p-3 bg-white rounded-xl border-none shadow-sm outline-none text-sm w-full"
                                value={newBlockout.endTime}
                                onChange={e => setNewBlockout({...newBlockout, endTime: e.target.value})}
                            />
                        </div>
                    </div>
                    <Button onClick={addBlockout} variant="primary" className="h-10 text-sm w-full" disabled={!newBlockout.date}>Block Time</Button>
                 </Card>
                 
                 {config.blockouts && config.blockouts.length > 0 && (
                     <div className="bg-white rounded-2xl shadow-sm border border-[#C6C6C8]/30 overflow-hidden divide-y divide-[#C6C6C8]/30">
                         {config.blockouts.map(block => (
                             <div key={block.id} className="p-4 flex items-center justify-between">
                                 <div>
                                     <div className="font-bold text-sm text-[#1C1C1E]">{format(new Date(block.date), 'MMM d, yyyy')}</div>
                                     <div className="text-xs text-[#8E8E93] mt-0.5">{block.startTime} - {block.endTime} • {block.reason}</div>
                                 </div>
                                 <button onClick={() => removeBlockout(block.id)} className="text-[#C7C7CC] hover:text-[#FF3B30] p-2">
                                     <X size={18} />
                                 </button>
                             </div>
                         ))}
                     </div>
                 )}
            </div>
        </div>
    )
}

// --- Statement Tab ---
// The barber's itemised truth: every ledger row (one per Paystack
// transaction) traceable to a named client and a specific haircut, with
// totals that reconcile against the bank's batched Paystack settlements.
// All arithmetic is done in integer CENTS; rand floats never touch a sum.

const ANOMALY_STATUSES = new Set([
    'UNMATCHED_PAYMENT',
    'AMOUNT_MISMATCH',
    'ORPHANED_PAYMENT',
    'MODE_MISMATCH',
    'SLOT_TAKEN_REFUND',
]);

const toCents = (rand: number | null): number | null =>
    rand === null ? null : Math.round(rand * 100);
const fmtRand = (cents: number): string => `R${(cents / 100).toFixed(2)}`;

interface StatementRow {
    row: LedgerRow;
    chargedC: number | null;
    feeC: number | null;
    feeIsActual: boolean;      // false = ESTIMATED fee shown — labelled in UI
    ownerCutC: number | null;  // derived: charged - fee - barberNet
    barberNetC: number | null;
    isAnomaly: boolean;
    // A PAID/REFUNDED row whose components don't decompose to the charged
    // amount. Flagged visually, never silently hidden.
    broken: boolean;
}

interface Totals { charged: number; fees: number; ownerCut: number; barberNet: number; }
const zeroTotals = (): Totals => ({ charged: 0, fees: 0, ownerCut: 0, barberNet: 0 });

const deriveRow = (row: LedgerRow): StatementRow => {
    const chargedC = toCents(row.charged);
    const feeIsActual = row.paystackFeeActual !== null;
    const feeC = toCents(row.paystackFeeActual ?? row.estimatedFee);
    const barberNetC = toCents(row.barberNet);
    const ownerCutC =
        chargedC !== null && feeC !== null && barberNetC !== null
            ? chargedC - feeC - barberNetC
            : null;
    const isAnomaly = ANOMALY_STATUSES.has(row.status);
    const broken =
        !isAnomaly &&
        (chargedC === null || feeC === null || barberNetC === null ||
         ownerCutC === null || ownerCutC < 0 ||
         feeC + ownerCutC + barberNetC !== chargedC);
    return { row, chargedC, feeC, feeIsActual, ownerCutC, barberNetC, isAnomaly, broken };
};

// REFUNDED rows are shown but SUBTRACTED from totals; anomaly and broken
// rows contribute nothing (their money did not resolve cleanly). Test rows
// never reach this function.
const addToTotals = (t: Totals, r: StatementRow): void => {
    if (r.isAnomaly || r.broken) return;
    const sign = r.row.status === 'REFUNDED' ? -1 : r.row.status === 'PAID_BOOKED' ? 1 : 0;
    if (sign === 0) return;
    t.charged += sign * (r.chargedC ?? 0);
    t.fees += sign * (r.feeC ?? 0);
    t.ownerCut += sign * (r.ownerCutC ?? 0);
    t.barberNet += sign * (r.barberNetC ?? 0);
};

// --- Manual settle (Phase D layer 3) ---
// The human escape hatch when both the webhook and the reconciliation sweep
// fail. Two-phase on purpose: Verify shows exactly what Paystack has for
// the reference BEFORE anything is written; only an explicit Settle click
// writes, via the same server-side settlement path as the webhook.
const ManualSettleCard: React.FC<{ onSettled: () => void }> = ({ onSettled }) => {
    const [reference, setReference] = useState('');
    const [preview, setPreview] = useState<ManualSettlePreview | null>(null);
    const [busy, setBusy] = useState<'verify' | 'settle' | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [outcome, setOutcome] = useState<string | null>(null);

    const reset = () => { setPreview(null); setError(null); setOutcome(null); };

    const verify = async () => {
        reset();
        setBusy('verify');
        try {
            setPreview(await api.manualSettleVerify(reference.trim()));
        } catch (e: any) {
            setError(e?.message || 'Verification failed.');
        } finally {
            setBusy(null);
        }
    };

    const settle = async () => {
        setBusy('settle');
        setError(null);
        try {
            const result = await api.manualSettleConfirm(reference.trim());
            setOutcome(result.status);
            setPreview(null);
            if (result.status !== 'ALREADY_SETTLED') onSettled();
        } catch (e: any) {
            setError(e?.message || 'Settlement failed.');
        } finally {
            setBusy(null);
        }
    };

    return (
        <Card className="p-5 space-y-3">
            <div className="text-[13px] font-bold text-[#8E8E93] uppercase tracking-widest">
                Manual settle — escape hatch
            </div>
            <p className="text-[12px] text-[#8E8E93]">
                If a customer paid but no booking appeared and the automatic sweep has not fixed it,
                paste the Paystack reference here. Verify shows what Paystack has before anything is written.
            </p>
            <div className="flex flex-wrap gap-2">
                <input
                    value={reference}
                    onChange={e => { setReference(e.target.value); reset(); }}
                    placeholder="e.g. WAYLINS-1753…"
                    className="flex-1 min-w-[220px] p-2.5 bg-[#F2F2F7] rounded-xl text-sm font-mono"
                />
                <Button onClick={verify} disabled={!reference.trim() || busy !== null}>
                    {busy === 'verify' ? <Loader2 className="animate-spin" size={16} /> : 'Verify'}
                </Button>
            </div>
            {error && <div className="text-sm font-medium text-[#FF3B30]">{error}</div>}
            {outcome && (
                <div className={`text-sm font-semibold ${outcome === 'PAID_BOOKED' ? 'text-[#34C759]' : 'text-[#FF9500]'}`}>
                    {outcome === 'PAID_BOOKED' && 'Settled — booking created and ledger row written.'}
                    {outcome === 'ALREADY_SETTLED' && 'Nothing to do — a ledger row already exists for this reference.'}
                    {outcome !== 'PAID_BOOKED' && outcome !== 'ALREADY_SETTLED' &&
                        `Settled as ${outcome.replace(/_/g, ' ')} — see the Needs attention section.`}
                </div>
            )}
            {preview && (
                <div className="p-4 bg-[#F2F2F7] rounded-xl space-y-2 text-sm">
                    <div className="font-bold text-[#1C1C1E] flex items-center gap-2 flex-wrap">
                        Paystack found: R{preview.amountRand.toFixed(2)} · {preview.paystackStatus}
                        {preview.env === 'test' && (
                            <span className="px-1.5 py-0.5 rounded bg-[#AF52DE]/15 text-[#AF52DE] text-[10px] font-bold uppercase">Test — not real money</span>
                        )}
                    </div>
                    <div className="text-[#8E8E93]">
                        {preview.clientName ? `${preview.clientName} (${preview.clientPhone ?? '?'})` : 'No client metadata'}
                        {preview.serviceName ? ` · ${preview.serviceName}` : ''}
                        {preview.date ? ` · ${preview.date} at ${preview.timeSlot ?? '?'}` : ''}
                        {preview.paidAt ? ` · paid ${preview.paidAt}` : ''}
                    </div>
                    {preview.ledgerExists ? (
                        <div className="font-semibold text-[#34C759]">Already settled — a ledger row exists. Nothing to do.</div>
                    ) : (
                        <>
                            <div className="text-[12px] text-[#8E8E93]">
                                No ledger row exists for this reference.
                                {preview.pendingExists
                                    ? ' The original booking intent is still stored — settling will use it.'
                                    : ' The booking intent is gone — settling will rebuild the booking from Paystack metadata if possible.'}
                            </div>
                            {preview.paystackStatus === 'success' ? (
                                <Button onClick={settle} disabled={busy !== null}>
                                    {busy === 'settle' ? <Loader2 className="animate-spin" size={16} /> : 'Settle this payment'}
                                </Button>
                            ) : (
                                <div className="font-semibold text-[#FF3B30]">Not a successful charge — cannot be settled.</div>
                            )}
                        </>
                    )}
                </div>
            )}
        </Card>
    );
};

const StatementTab: React.FC = () => {
    const [rows, setRows] = useState<StatementRow[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [range, setRange] = useState<'this' | 'last' | 'custom'>('this');
    const [customStart, setCustomStart] = useState(format(startOfMonth(new Date()), 'yyyy-MM-dd'));
    const [customEnd, setCustomEnd] = useState(format(new Date(), 'yyyy-MM-dd'));
    const [showTest, setShowTest] = useState(false);
    const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
    // Bumped after a manual settle so the freshly written row appears.
    const [reloadKey, setReloadKey] = useState(0);

    const [start, end] = ((): [Date, Date] => {
        const now = new Date();
        if (range === 'this') return [startOfMonth(now), endOfMonth(now)];
        if (range === 'last') {
            const lm = subMonths(now, 1);
            return [startOfMonth(lm), endOfMonth(lm)];
        }
        const s = parseISO(customStart);
        const e = parseISO(customEnd);
        e.setHours(23, 59, 59, 999);
        return [s, e];
    })();

    useEffect(() => {
        let mounted = true;
        setIsLoading(true);
        setLoadError(null);
        api.getLedgerRows(start, end)
            .then(ledger => {
                if (!mounted) return;
                const derived = ledger.map(deriveRow);
                setRows(derived);
                // Most recent day open by default.
                const first = derived.find(r => r.row.createdAt);
                setOpenGroups(first?.row.createdAt
                    ? new Set([format(first.row.createdAt, 'yyyy-MM-dd')])
                    : new Set());
            })
            .catch(e => {
                console.error('ledger query failed', e);
                if (mounted) setLoadError('Could not load the ledger. Check your connection and try again.');
            })
            .finally(() => { if (mounted) setIsLoading(false); });
    }, [range, customStart, customEnd, reloadKey]);

    const visible = rows.filter(r => showTest || r.row.mode !== 'test');
    // Test rows are excluded from ALL totals unconditionally — visibility is
    // a debugging aid, never money.
    const liveRows = rows.filter(r => r.row.mode !== 'test');
    const anomalies = visible.filter(r => r.isAnomaly);
    const listed = visible.filter(r => !r.isAnomaly);

    const grandTotals = zeroTotals();
    liveRows.forEach(r => addToTotals(grandTotals, r));

    // Group by calendar day of the TRANSACTION — Paystack settlement data is
    // not recorded yet (stated in the UI). Keys sort desc (query is desc).
    const groups = new Map<string, StatementRow[]>();
    listed.forEach(r => {
        const key = r.row.createdAt ? format(r.row.createdAt, 'yyyy-MM-dd') : 'Unknown date';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
    });

    const toggleGroup = (key: string) => {
        setOpenGroups(prev => {
            const next = new Set(prev);
            next.has(key) ? next.delete(key) : next.add(key);
            return next;
        });
    };

    const statusBadge = (r: StatementRow) => {
        const s = r.row.status;
        const cls =
            s === 'PAID_BOOKED' ? 'bg-[#34C759]/10 text-[#34C759]'
            : s === 'REFUNDED' ? 'bg-[#FF9500]/15 text-[#FF9500]'
            : 'bg-[#FF3B30]/10 text-[#FF3B30]';
        return <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${cls}`}>{s.replace(/_/g, ' ')}</span>;
    };

    const totalsStrip = (t: Totals, label: string) => (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            {[
                ['Charged', t.charged],
                ['Paystack fees', t.fees],
                ['Owner cut', t.ownerCut],
                ['Barber net', t.barberNet],
            ].map(([name, cents]) => (
                <div key={String(name)} className="bg-[#F2F2F7] rounded-xl p-3">
                    <div className="text-[10px] font-bold text-[#8E8E93] uppercase tracking-widest">{name} · {label}</div>
                    <div className={`text-lg font-bold ${Number(cents) < 0 ? 'text-[#FF3B30]' : 'text-[#1C1C1E]'}`}>{fmtRand(Number(cents))}</div>
                </div>
            ))}
        </div>
    );

    const renderRow = (r: StatementRow) => (
        <div key={r.row.id} className={`p-4 text-sm ${r.broken ? 'bg-[#FF3B30]/5 border-l-4 border-[#FF3B30]' : ''} ${r.row.status === 'REFUNDED' ? 'bg-[#FF9500]/5' : ''}`}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                    <div className="font-semibold text-[#1C1C1E] flex items-center gap-2">
                        {r.row.clientName || <span className="text-[#8E8E93] italic">Unknown client</span>}
                        {r.row.mode === 'test' && (
                            <span className="px-1.5 py-0.5 rounded bg-[#AF52DE]/15 text-[#AF52DE] text-[10px] font-bold uppercase">Test — not real money</span>
                        )}
                        {statusBadge(r)}
                    </div>
                    <div className="text-[#8E8E93]">
                        {r.row.serviceName || '—'}{r.row.date ? ` · ${r.row.date} at ${r.row.timeSlot ?? '?'}` : ''}
                    </div>
                    <div className="text-[11px] text-[#8E8E93] font-mono mt-1">{r.row.reference}</div>
                </div>
                <div className="text-right">
                    <div className={`text-lg font-bold ${r.row.status === 'REFUNDED' ? 'text-[#FF9500] line-through' : 'text-[#1C1C1E]'}`}>
                        {r.chargedC !== null ? fmtRand(r.chargedC) : '—'}
                    </div>
                    {r.row.status === 'REFUNDED' && (
                        <div className="text-[11px] font-bold text-[#FF9500]">REFUNDED — subtracted from totals</div>
                    )}
                </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-[#8E8E93]">
                <span>Fee: {r.feeC !== null ? fmtRand(r.feeC) : '—'} <em className="not-italic font-semibold">({r.feeIsActual ? 'actual' : 'ESTIMATED'})</em></span>
                <span>Owner cut: {r.ownerCutC !== null ? fmtRand(r.ownerCutC) : '—'}</span>
                <span>Barber net: {r.barberNetC !== null ? fmtRand(r.barberNetC) : '—'}</span>
            </div>
            {r.broken && (
                <div className="mt-2 text-[12px] font-semibold text-[#FF3B30] flex items-center gap-1.5">
                    <AlertTriangle size={14} /> Components do not sum to the charged amount — excluded from totals. Reconcile manually.
                </div>
            )}
        </div>
    );

    if (isLoading) {
        return <div className="flex items-center justify-center py-20"><Loader2 className="animate-spin text-[#8E8E93]" size={28} /></div>;
    }
    if (loadError) {
        return <Card className="p-6 text-sm text-[#FF3B30] font-medium">{loadError}</Card>;
    }

    return (
        <div className="space-y-5 max-w-3xl">
            {/* Filters */}
            <div className="flex flex-wrap items-center gap-2">
                {([['this', 'This month'], ['last', 'Last month'], ['custom', 'Custom']] as const).map(([k, label]) => (
                    <button
                        key={k}
                        onClick={() => setRange(k)}
                        className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors ${range === k ? 'bg-[#1C1C1E] text-white' : 'bg-white text-[#8E8E93] hover:text-[#1C1C1E]'}`}
                    >{label}</button>
                ))}
                {range === 'custom' && (
                    <div className="flex items-center gap-2">
                        <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} className="p-2 bg-white rounded-xl text-sm" />
                        <span className="text-[#8E8E93]">–</span>
                        <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)} className="p-2 bg-white rounded-xl text-sm" />
                    </div>
                )}
                <label className="ml-auto flex items-center gap-2 text-sm font-medium text-[#8E8E93] cursor-pointer select-none">
                    <input type="checkbox" checked={showTest} onChange={e => setShowTest(e.target.checked)} className="accent-[#AF52DE]" />
                    Show test rows
                </label>
            </div>

            {showTest && (
                <div className="p-3 bg-[#AF52DE]/10 text-[#AF52DE] rounded-xl text-sm font-semibold">
                    Test rows visible (purple badges). They are NEVER included in any total.
                </div>
            )}

            <div className="text-[12px] text-[#8E8E93]">
                Grouped by <strong>transaction day</strong> — Paystack settlement dates are not recorded yet, so
                reconcile a bank deposit against the day(s) it covers (Paystack settles next business day).
            </div>

            {/* Needs attention */}
            {anomalies.length > 0 && (
                <Card noPadding className="border-2 border-[#FF3B30]/40 overflow-hidden">
                    <div className="p-4 bg-[#FF3B30]/10 flex items-center gap-2 font-bold text-[#FF3B30]">
                        <AlertTriangle size={18} /> Needs attention — money that did not resolve cleanly
                    </div>
                    <div className="divide-y divide-[#E5E5EA]">{anomalies.map(renderRow)}</div>
                </Card>
            )}

            {/* Grand total for the period (live rows only) */}
            <Card className="p-5 space-y-3">
                <div className="text-[13px] font-bold text-[#8E8E93] uppercase tracking-widest">
                    Period total · {format(start, 'd MMM')} – {format(end, 'd MMM yyyy')} · live money only
                </div>
                {totalsStrip(grandTotals, 'period')}
            </Card>

            {/* Day groups */}
            {groups.size === 0 ? (
                <Card className="p-10 text-center">
                    <CreditCard className="mx-auto mb-4 text-[#C7C7CC]" size={40} />
                    <div className="font-semibold text-[#1C1C1E] mb-1">No transactions in this period</div>
                    <p className="text-sm text-[#8E8E93] max-w-sm mx-auto">
                        Every paid online booking will appear here automatically, itemised per client,
                        so the batched Paystack deposits in the bank can be reconciled line by line.
                        {!showTest && ' (Test-mode transactions are hidden — use the toggle above to inspect them.)'}
                    </p>
                </Card>
            ) : (
                Array.from(groups.entries()).map(([day, groupRows]) => {
                    const groupTotals = zeroTotals();
                    groupRows.filter(r => r.row.mode !== 'test').forEach(r => addToTotals(groupTotals, r));
                    const open = openGroups.has(day);
                    return (
                        <Card key={day} noPadding className="overflow-hidden">
                            <button onClick={() => toggleGroup(day)} className="w-full p-4 flex items-center justify-between hover:bg-[#F2F2F7]/50 transition-colors">
                                <div className="flex items-center gap-3">
                                    {open ? <ChevronDown size={18} className="text-[#8E8E93]" /> : <ChevronRight size={18} className="text-[#8E8E93]" />}
                                    <div className="text-left">
                                        <div className="font-bold text-[#1C1C1E]">
                                            {day === 'Unknown date' ? day : format(parseISO(day), 'EEEE, d MMMM yyyy')}
                                        </div>
                                        <div className="text-[12px] text-[#8E8E93]">{groupRows.length} transaction{groupRows.length === 1 ? '' : 's'}</div>
                                    </div>
                                </div>
                                <div className="text-right text-sm">
                                    <div className="font-bold text-[#1C1C1E]">{fmtRand(groupTotals.charged)}</div>
                                    <div className="text-[11px] text-[#8E8E93]">barber net {fmtRand(groupTotals.barberNet)}</div>
                                </div>
                            </button>
                            {open && (
                                <>
                                    <div className="divide-y divide-[#E5E5EA] border-t border-[#E5E5EA]">
                                        {groupRows.map(renderRow)}
                                    </div>
                                    <div className="p-4 border-t border-[#E5E5EA] bg-[#F2F2F7]/40">
                                        {totalsStrip(groupTotals, 'day')}
                                    </div>
                                </>
                            )}
                        </Card>
                    );
                })
            )}

            {/* Manual settle escape hatch */}
            <ManualSettleCard onSettled={() => setReloadKey(k => k + 1)} />
        </div>
    );
};

// --- Main Admin Layout ---

export const AdminPortal: React.FC = () => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [activeTab, setActiveTab] = useState<'bookings' | 'statement' | 'services' | 'settings'>('bookings');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
      const unsubscribe = api.onAuthChanged((isAdmin) => {
          setIsAuthenticated(isAdmin);
          setAuthChecked(true);
      });
      return unsubscribe;
  }, []);

  const handleLogout = () => {
      api.logout().catch(console.error);
  }

  useEffect(() => {
      if(mainRef.current) {
          mainRef.current.scrollTo({ top: 0 });
      }
  }, [activeTab]);

  const handleNavClick = (tab: 'bookings' | 'statement' | 'services' | 'settings') => {
      setActiveTab(tab);
      setIsSidebarOpen(false);
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F2F2F7]">
        <Loader2 className="animate-spin text-[#8E8E93]" size={32} />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <AdminLogin />;
  }

  return (
    <div className="min-h-screen bg-[#F2F2F7] flex flex-col md:flex-row font-sans text-[#1C1C1E] overflow-hidden">
      
      {/* Mobile Header */}
      <div className="md:hidden bg-white/80 backdrop-blur-md border-b border-[#C6C6C8]/30 p-4 flex items-center justify-between sticky top-0 z-30">
          <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-[#1C1C1E] rounded-lg flex items-center justify-center shadow-sm">
                    <Scissors className="text-white" size={16} />
                </div>
                <h1 className="font-bold text-base tracking-tight">Waylin's <span className="text-[#8E8E93] font-normal text-xs">Manager</span></h1>
          </div>
          <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="p-2 text-[#1C1C1E]">
              {isSidebarOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
      </div>

      {/* Mobile Sidebar Backdrop */}
      {isSidebarOpen && (
        <div 
            className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm md:hidden animate-in fade-in duration-300"
            onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`
          fixed inset-y-0 left-0 z-50 w-64 bg-white shadow-2xl md:shadow-none md:bg-white/70 md:backdrop-blur-xl md:static md:w-72 md:h-screen md:flex flex-col border-r border-[#C6C6C8]/30 transition-transform duration-300 ease-in-out
          ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
         <button onClick={() => setIsSidebarOpen(false)} className="absolute top-4 right-4 p-2 md:hidden text-[#8E8E93] hover:text-[#1C1C1E]">
             <X size={20} />
         </button>

         <div className="p-6 md:pt-10 h-full flex flex-col">
            <div className="hidden md:flex items-center gap-3 mb-10 px-2">
                <div className="w-9 h-9 bg-[#1C1C1E] rounded-xl flex items-center justify-center shadow-sm">
                    <Scissors className="text-white" size={18} />
                </div>
                <h1 className="font-bold text-lg tracking-tight">Waylin's<span className="text-[#8E8E93] font-normal block text-xs">Manager</span></h1>
            </div>

            <nav className="space-y-1 mt-8 md:mt-0">
                <button 
                onClick={() => handleNavClick('bookings')}
                className={`w-full flex items-center gap-3 p-3 rounded-xl font-medium transition-all duration-200 text-sm ${activeTab === 'bookings' ? 'bg-[#E5E5EA] text-[#1C1C1E]' : 'text-[#8E8E93] hover:text-[#1C1C1E] hover:bg-[#E5E5EA]/50'}`}
                >
                <Calendar size={18} /> Bookings
                </button>
                <button
                onClick={() => handleNavClick('statement')}
                className={`w-full flex items-center gap-3 p-3 rounded-xl font-medium transition-all duration-200 text-sm ${activeTab === 'statement' ? 'bg-[#E5E5EA] text-[#1C1C1E]' : 'text-[#8E8E93] hover:text-[#1C1C1E] hover:bg-[#E5E5EA]/50'}`}
                >
                <CreditCard size={18} /> Statement
                </button>
                <button
                onClick={() => handleNavClick('services')}
                className={`w-full flex items-center gap-3 p-3 rounded-xl font-medium transition-all duration-200 text-sm ${activeTab === 'services' ? 'bg-[#E5E5EA] text-[#1C1C1E]' : 'text-[#8E8E93] hover:text-[#1C1C1E] hover:bg-[#E5E5EA]/50'}`}
                >
                <List size={18} /> Services
                </button>
                <button 
                onClick={() => handleNavClick('settings')}
                className={`w-full flex items-center gap-3 p-3 rounded-xl font-medium transition-all duration-200 text-sm ${activeTab === 'settings' ? 'bg-[#E5E5EA] text-[#1C1C1E]' : 'text-[#8E8E93] hover:text-[#1C1C1E] hover:bg-[#E5E5EA]/50'}`}
                >
                <Settings size={18} /> Settings
                </button>
            </nav>

            <div className="mt-auto pt-6 border-t border-[#C6C6C8]/30">
                <button onClick={handleLogout} className="flex items-center gap-3 text-[#FF3B30] font-medium transition-colors text-sm hover:bg-[#FF3B30]/5 w-full p-2 rounded-lg">
                    <LogOut size={16} /> Sign Out
                </button>
            </div>
         </div>
      </aside>

      {/* Main Content */}
      <main ref={mainRef} className="flex-1 p-6 md:p-10 overflow-y-auto h-[calc(100vh-60px)] md:h-screen">
        <header className="mb-8 hidden md:block">
            <h2 className="text-3xl font-bold text-[#1C1C1E] tracking-tight mb-1">
                {activeTab === 'bookings' && 'Overview'}
                {activeTab === 'statement' && 'Statement'}
                {activeTab === 'services' && 'Services'}
                {activeTab === 'settings' && 'Settings'}
            </h2>
        </header>
        <header className="mb-6 md:hidden">
             <h2 className="text-2xl font-bold text-[#1C1C1E] tracking-tight">
                {activeTab === 'bookings' && 'Overview'}
                {activeTab === 'statement' && 'Statement'}
                {activeTab === 'services' && 'Services'}
                {activeTab === 'settings' && 'Settings'}
            </h2>
        </header>

        {activeTab === 'bookings' && <BookingsTab onOpenStatement={() => setActiveTab('statement')} />}
        {activeTab === 'statement' && <StatementTab />}
        {activeTab === 'services' && <ServicesTab />}
        {activeTab === 'settings' && <SettingsTab />}
      </main>
    </div>
  );
};