import React from 'react';
import { Footer } from '../components/Footer';

export const RefundPolicy: React.FC = () => {
  return (
    <div className="min-h-screen bg-[#F2F2F7] pb-20">
      <div className="max-w-3xl mx-auto py-12 px-6">
        <h1 className="text-4xl font-bold text-[#1C1C1E] mb-4">Refund Policy</h1>
        <p className="text-[#8E8E93] mb-8">Last updated: {new Date().toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
        
        <div className="bg-white rounded-2xl p-8 space-y-6 text-[#1C1C1E]">
          <section>
            <h2 className="text-2xl font-bold mb-3">Overview</h2>
            <p className="text-[#8E8E93] leading-relaxed">
              At Waylin's Barbershop, we strive to provide exceptional service. This refund policy outlines the circumstances under which refunds may be issued.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">Online Payments</h2>
            <ul className="space-y-3 text-[#8E8E93]">
              <li className="flex items-start gap-2">
                <span className="text-[#007AFF] font-bold">•</span>
                <span><strong className="text-[#1C1C1E]">Cancelled Appointments:</strong> If you cancel your appointment at least 24 hours in advance, you are entitled to a full refund of any online payment made.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#007AFF] font-bold">•</span>
                <span><strong className="text-[#1C1C1E]">No-Show:</strong> If you fail to show up for your appointment without cancelling, no refund will be issued.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#007AFF] font-bold">•</span>
                <span><strong className="text-[#1C1C1E]">Shop Cancellation:</strong> If we need to cancel your appointment due to unforeseen circumstances, you will receive a full refund or the option to reschedule.</span>
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">Service Satisfaction</h2>
            <p className="text-[#8E8E93] leading-relaxed mb-3">
              If you are not satisfied with the service provided, please contact us within 24 hours of your appointment. We will work with you to resolve the issue, which may include:
            </p>
            <ul className="space-y-2 text-[#8E8E93] ml-4">
              <li>• A complimentary service correction</li>
              <li>• A partial or full refund at our discretion</li>
              <li>• A credit toward a future appointment</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">Refund Processing</h2>
            <p className="text-[#8E8E93] leading-relaxed">
              Refunds for online payments will be processed back to the original payment method within 5-10 business days. For cash payments, refunds must be requested in person at the shop.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">Contact</h2>
            <p className="text-[#8E8E93] leading-relaxed">
              For refund requests or questions about this policy, please contact us through the booking portal or visit us in person.
            </p>
          </section>
        </div>
      </div>
      <Footer />
    </div>
  );
};

