import React from 'react';
import { Footer } from '../components/Footer';

export const PrivacyPolicy: React.FC = () => {
  return (
    <div className="min-h-screen bg-[#F2F2F7] pb-20">
      <div className="max-w-3xl mx-auto py-12 px-6">
        <h1 className="text-4xl font-bold text-[#1C1C1E] mb-4">Privacy Policy</h1>
        <p className="text-[#8E8E93] mb-8">Last updated: {new Date().toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
        
        <div className="bg-white rounded-2xl p-8 space-y-6 text-[#1C1C1E]">
          <section>
            <h2 className="text-2xl font-bold mb-3">Information We Collect</h2>
            <p className="text-[#8E8E93] leading-relaxed mb-3">
              When you book an appointment, we collect:
            </p>
            <ul className="space-y-2 text-[#8E8E93] ml-4">
              <li>• Your name</li>
              <li>• Your phone number</li>
              <li>• Booking details (date, time, service)</li>
              <li>• Payment information (processed securely through Paystack)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">How We Use Your Information</h2>
            <ul className="space-y-3 text-[#8E8E93]">
              <li className="flex items-start gap-2">
                <span className="text-[#007AFF] font-bold">•</span>
                <span>To process and manage your bookings</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#007AFF] font-bold">•</span>
                <span>To send appointment reminders and updates</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#007AFF] font-bold">•</span>
                <span>To process payments</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#007AFF] font-bold">•</span>
                <span>To improve our services</span>
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">Data Storage</h2>
            <p className="text-[#8E8E93] leading-relaxed">
              Your booking information is stored locally in your browser and may be stored in our database for operational purposes. We take reasonable measures to protect your personal information.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">Payment Information</h2>
            <p className="text-[#8E8E93] leading-relaxed">
              Payment processing is handled securely by Paystack. We do not store your full payment card details. Paystack's privacy policy applies to payment transactions.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">Data Sharing</h2>
            <p className="text-[#8E8E93] leading-relaxed">
              We do not sell, trade, or rent your personal information to third parties. We may share information only as necessary to provide our services (e.g., with payment processors).
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">Your Rights</h2>
            <p className="text-[#8E8E93] leading-relaxed mb-3">
              You have the right to:
            </p>
            <ul className="space-y-2 text-[#8E8E93] ml-4">
              <li>• Access your personal information</li>
              <li>• Request correction of inaccurate data</li>
              <li>• Request deletion of your data</li>
              <li>• Opt out of communications</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">Contact</h2>
            <p className="text-[#8E8E93] leading-relaxed">
              For privacy concerns or requests, please contact us through the booking portal.
            </p>
          </section>
        </div>
      </div>
      <Footer />
    </div>
  );
};

