import React from 'react';
import { Link } from 'react-router-dom';
import { Scissors, MapPin, Phone, Clock } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Footer } from '../components/Footer';

export const HomePage: React.FC = () => {
  return (
    <div className="min-h-screen bg-[#F2F2F7]">
      {/* Hero Section */}
      <div className="bg-gradient-to-br from-[#1C1C1E] to-[#2C2C2E] text-white py-20 px-6">
        <div className="max-w-4xl mx-auto text-center flex flex-col items-center">
          <div className="w-24 h-24 bg-white/10 backdrop-blur-md rounded-[2.5rem] flex items-center justify-center mb-8 shadow-2xl">
            <Scissors className="text-white w-12 h-12" strokeWidth={1.5} />
          </div>
          <h1 className="text-5xl md:text-6xl font-bold mb-4 tracking-tight">Waylin's Barbershop</h1>
          <p className="text-xl text-white/80 mb-8">Premium Grooming & Professional Service</p>
          <div className="flex justify-center">
            <Link to="/client">
              <button className="bg-[#007AFF] text-white font-bold text-lg px-10 py-5 rounded-full shadow-2xl shadow-[#007AFF]/40 hover:bg-[#0051A8] hover:shadow-[#007AFF]/60 transition-all duration-300 transform hover:scale-105 active:scale-95 border-2 border-white/20">
                Book Appointment
              </button>
            </Link>
          </div>
        </div>
      </div>

      {/* Contact Info */}
      <div className="bg-white py-12 px-6">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-2xl font-bold text-center mb-8 text-[#1C1C1E]">Visit Us</h2>
          <div className="grid md:grid-cols-3 gap-6 text-center">
            <div className="flex flex-col items-center">
              <MapPin className="w-8 h-8 text-[#007AFF] mb-3" />
              <p className="text-[#8E8E93] text-sm mb-1">Location</p>
              <p className="font-semibold text-[#1C1C1E]">206 Mathews Meyiwa Road, Durban</p>
            </div>
            <div className="flex flex-col items-center">
              <Phone className="w-8 h-8 text-[#007AFF] mb-3" />
              <p className="text-[#8E8E93] text-sm mb-1">Contact</p>
              <p className="font-semibold text-[#1C1C1E]">Book Online</p>
            </div>
            <div className="flex flex-col items-center">
              <Clock className="w-8 h-8 text-[#007AFF] mb-3" />
              <p className="text-[#8E8E93] text-sm mb-1">Hours</p>
              <p className="font-semibold text-[#1C1C1E]">Mon-Sat: 9AM-6PM</p>
              <p className="font-semibold text-[#1C1C1E]">Sun: 9AM-3PM</p>
            </div>
          </div>
        </div>
      </div>
      <Footer />
    </div>
  );
};

