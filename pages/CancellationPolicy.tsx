import React from 'react';
import { Footer } from '../components/Footer';

export const CancellationPolicy: React.FC = () => {
  return (
    <div className="min-h-screen bg-[#F2F2F7] pb-20">
      <div className="max-w-3xl mx-auto py-12 px-6">
        <h1 className="text-4xl font-bold text-[#1C1C1E] mb-4">Cancellation Policy</h1>
        <p className="text-[#8E8E93] mb-8">Last updated: {new Date().toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
        
        <div className="bg-white rounded-2xl p-8 space-y-6 text-[#1C1C1E]">
          <section>
            <h2 className="text-2xl font-bold mb-3">Cancellation Requirements</h2>
            <p className="text-[#8E8E93] leading-relaxed mb-4">
              To cancel or reschedule your appointment, you must do so at least <strong className="text-[#1C1C1E]">24 hours in advance</strong> of your scheduled time.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">How to Cancel</h2>
            <ul className="space-y-3 text-[#8E8E93]">
              <li className="flex items-start gap-2">
                <span className="text-[#007AFF] font-bold">•</span>
                <span>Use the "My Bookings" section in the booking portal to cancel your appointment</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#007AFF] font-bold">•</span>
                <span>Contact us directly if you need assistance</span>
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">Late Cancellations & No-Shows</h2>
            <ul className="space-y-3 text-[#8E8E93]">
              <li className="flex items-start gap-2">
                <span className="text-[#007AFF] font-bold">•</span>
                <span><strong className="text-[#1C1C1E]">Less than 24 hours:</strong> If you cancel less than 24 hours before your appointment, any deposit paid may be forfeited.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#007AFF] font-bold">•</span>
                <span><strong className="text-[#1C1C1E]">No-Show:</strong> If you do not show up for your appointment without cancelling, any payment made will be forfeited, and future bookings may require full payment in advance.</span>
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">Rescheduling</h2>
            <p className="text-[#8E8E93] leading-relaxed">
              You can reschedule your appointment through the booking portal. If rescheduling more than 24 hours in advance, there is no penalty. Rescheduling within 24 hours is subject to availability and may incur a fee.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">Our Right to Cancel</h2>
            <p className="text-[#8E8E93] leading-relaxed">
              We reserve the right to cancel appointments due to unforeseen circumstances, emergencies, or operational issues. In such cases, you will be notified as soon as possible and offered a full refund or the option to reschedule.
            </p>
          </section>
        </div>
      </div>
      <Footer />
    </div>
  );
};


