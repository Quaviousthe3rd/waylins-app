import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { Booking, ServiceItem, BookingStatus, PaymentStatus, Blockout } from '../types';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Calendar, List, Settings, Scissors, Clock, LogOut, Plus, Trash, Ban, Search, ChevronRight, CreditCard, RefreshCw, X, Edit2, Phone, Menu, Loader2 } from 'lucide-react';
import { format, isBefore, parseISO } from 'date-fns';
import { DEFAULT_HOURS, STORAGE_KEYS } from '../constants';
import { notify } from '../services/notifications';

// --- Admin Login ---
const AdminLogin: React.FC<{ onLogin: () => void }> = ({ onLogin }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    
    // Security: Artificial delay to prevent brute-force
    await new Promise(resolve => setTimeout(resolve, 800));

    if (api.login(password)) {
      localStorage.setItem(STORAGE_KEYS.ADMIN_SESSION, 'true');
      onLogin();
    } else {
      setError('Incorrect Passcode');
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
          <p className="text-[#8E8E93] mb-8 text-sm">Enter your passcode to continue</p>
          
          <form onSubmit={handleLogin} className="space-y-4">
             <div className="relative">
                <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="w-full p-4 bg-[#F2F2F7] rounded-xl border-none outline-none focus:ring-2 focus:ring-[#007AFF]/20 text-[#1C1C1E] text-center tracking-[0.5em] text-xl transition-all font-bold placeholder:font-normal placeholder:tracking-normal placeholder:text-base disabled:opacity-50"
                    placeholder="••••"
                    autoFocus
                    maxLength={8}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="current-password"
                    disabled={isLoading}
                />
             </div>
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

const BookingsTab: React.FC = () => {
  const [bookings, setBookings] = useState<Booking[]>(api.getBookings());
  const [filter, setFilter] = useState('');

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
        await api.updateBooking(booking.id, { status });
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
  const revenue = bookings.filter(b => b.status === BookingStatus.CONFIRMED).reduce((acc, curr) => acc + curr.amount, 0);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      
      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-5 flex flex-col justify-between bg-[#1C1C1E] text-white border-none shadow-lg shadow-black/10" noPadding>
            <div className="p-5">
                <div className="text-white/60 text-[11px] font-bold uppercase tracking-wider mb-2">Total Revenue</div>
                <div className="text-3xl font-bold tracking-tight">R{revenue}</div>
            </div>
        </Card>
        <Card className="flex flex-col justify-between" noPadding>
            <div className="p-5">
                <div className="text-[#8E8E93] text-[11px] font-bold uppercase tracking-wider mb-2">Today's Clients</div>
                <div className="text-3xl font-bold text-[#1C1C1E] tracking-tight">{todayBookings.length}</div>
            </div>
        </Card>
        <Card className="flex flex-col justify-between" noPadding>
            <div className="p-5">
                <div className="text-[#8E8E93] text-[11px] font-bold uppercase tracking-wider mb-2">Pending Payments</div>
                <div className="text-3xl font-bold text-[#FF9500] tracking-tight">{bookings.filter(b => b.paymentStatus === PaymentStatus.PENDING).length}</div>
            </div>
        </Card>
      </div>

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

// --- Main Admin Layout ---

export const AdminPortal: React.FC = () => {
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
      return localStorage.getItem(STORAGE_KEYS.ADMIN_SESSION) === 'true';
  });
  const [activeTab, setActiveTab] = useState<'bookings' | 'services' | 'settings'>('bookings');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);

  const handleLogout = () => {
      localStorage.removeItem(STORAGE_KEYS.ADMIN_SESSION);
      setIsAuthenticated(false);
  }
  
  useEffect(() => {
      if(mainRef.current) {
          mainRef.current.scrollTo({ top: 0 });
      }
  }, [activeTab]);

  const handleNavClick = (tab: 'bookings' | 'services' | 'settings') => {
      setActiveTab(tab);
      setIsSidebarOpen(false);
  };

  if (!isAuthenticated) {
    return <AdminLogin onLogin={() => setIsAuthenticated(true)} />;
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
                {activeTab === 'services' && 'Services'}
                {activeTab === 'settings' && 'Settings'}
            </h2>
        </header>
        <header className="mb-6 md:hidden">
             <h2 className="text-2xl font-bold text-[#1C1C1E] tracking-tight">
                {activeTab === 'bookings' && 'Overview'}
                {activeTab === 'services' && 'Services'}
                {activeTab === 'settings' && 'Settings'}
            </h2>
        </header>

        {activeTab === 'bookings' && <BookingsTab />}
        {activeTab === 'services' && <ServicesTab />}
        {activeTab === 'settings' && <SettingsTab />}
      </main>
    </div>
  );
};