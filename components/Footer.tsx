import React from 'react';
import { Link } from 'react-router-dom';
import { Scissors } from 'lucide-react';

export const Footer: React.FC = () => {
  return (
    <footer className="bg-white border-t border-[#E5E5EA] mt-20">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="grid md:grid-cols-4 gap-8 mb-8">
          <div>
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 bg-[#1C1C1E] rounded-lg flex items-center justify-center">
                <Scissors className="text-white" size={16} />
              </div>
              <span className="font-bold text-[#1C1C1E]">Waylin's</span>
            </div>
            <p className="text-sm text-[#8E8E93]">Premium Grooming & Professional Service</p>
          </div>
          
          <div>
            <h3 className="font-semibold text-[#1C1C1E] mb-4 text-sm uppercase tracking-wide">Services</h3>
            <ul className="space-y-2">
              <li>
                <Link to="/pricing" className="text-sm text-[#8E8E93] hover:text-[#007AFF] transition-colors">
                  Pricing
                </Link>
              </li>
              <li>
                <Link to="/client" className="text-sm text-[#8E8E93] hover:text-[#007AFF] transition-colors">
                  Book Appointment
                </Link>
              </li>
            </ul>
          </div>
          
          <div>
            <h3 className="font-semibold text-[#1C1C1E] mb-4 text-sm uppercase tracking-wide">Policies</h3>
            <ul className="space-y-2">
              <li>
                <Link to="/refund-policy" className="text-sm text-[#8E8E93] hover:text-[#007AFF] transition-colors">
                  Refund Policy
                </Link>
              </li>
              <li>
                <Link to="/cancellation-policy" className="text-sm text-[#8E8E93] hover:text-[#007AFF] transition-colors">
                  Cancellation Policy
                </Link>
              </li>
              <li>
                <Link to="/terms" className="text-sm text-[#8E8E93] hover:text-[#007AFF] transition-colors">
                  Terms of Service
                </Link>
              </li>
              <li>
                <Link to="/privacy" className="text-sm text-[#8E8E93] hover:text-[#007AFF] transition-colors">
                  Privacy Policy
                </Link>
              </li>
            </ul>
          </div>
          
          <div>
            <h3 className="font-semibold text-[#1C1C1E] mb-4 text-sm uppercase tracking-wide">Quick Links</h3>
            <ul className="space-y-2">
              <li>
                <Link to="/" className="text-sm text-[#8E8E93] hover:text-[#007AFF] transition-colors">
                  Home
                </Link>
              </li>
              <li>
                <Link to="/client" className="text-sm text-[#8E8E93] hover:text-[#007AFF] transition-colors">
                  Client Portal
                </Link>
              </li>
            </ul>
          </div>
        </div>
        
        <div className="border-t border-[#E5E5EA] pt-8 text-center">
          <p className="text-xs text-[#8E8E93]">
            © {new Date().getFullYear()} Waylin's Barbershop. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
};

