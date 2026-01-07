import React from 'react';
import { Scissors, Clock } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { api } from '../services/api';
import { Footer } from '../components/Footer';

export const Pricing: React.FC = () => {
  const config = api.getConfig();

  return (
    <div className="min-h-screen bg-[#F2F2F7] pb-20">
      <div className="max-w-4xl mx-auto py-12 px-6">
        <h1 className="text-4xl font-bold text-[#1C1C1E] mb-2 text-center">Pricing</h1>
        <p className="text-[#8E8E93] text-center mb-12">Transparent pricing for all our services</p>
        
        <div className="space-y-4">
          {config.services.map(service => (
            <Card key={service.id} className="p-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-[#007AFF]/10 rounded-xl flex items-center justify-center">
                    <Scissors className="text-[#007AFF]" size={20} />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-[#1C1C1E]">{service.name}</h3>
                    <div className="flex items-center gap-2 text-[#8E8E93] text-sm mt-1">
                      <Clock size={14} />
                      <span>{service.durationMinutes} minutes</span>
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-3xl font-bold text-[#1C1C1E]">R{service.price}</p>
                </div>
              </div>
            </Card>
          ))}
        </div>

        <div className="mt-12 p-6 bg-white rounded-2xl">
          <h2 className="text-xl font-bold text-[#1C1C1E] mb-4">Payment Options</h2>
          <ul className="space-y-2 text-[#8E8E93]">
            <li>• Pay online securely via Paystack (full payment or 50% deposit)</li>
            <li>• Pay cash at the shop on arrival</li>
            <li>• All prices are in South African Rand (ZAR)</li>
          </ul>
        </div>
      </div>
      <Footer />
    </div>
  );
};

