import React from 'react';
import { Footer } from '../components/Footer';

export const TermsOfService: React.FC = () => {
  return (
    <div className="min-h-screen bg-[#F2F2F7] pb-20">
      <div className="max-w-3xl mx-auto py-12 px-6">
        <h1 className="text-4xl font-bold text-[#1C1C1E] mb-4">Terms of Service</h1>
        <p className="text-[#8E8E93] mb-8">Last updated: {new Date().toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
        
        <div className="bg-white rounded-2xl p-8 space-y-6 text-[#1C1C1E]">
          <section>
            <h2 className="text-2xl font-bold mb-3">Agreement to Terms</h2>
            <p className="text-[#8E8E93] leading-relaxed">
              By accessing and using Waylin's Barbershop booking system, you agree to be bound by these Terms of Service. If you do not agree, please do not use our services.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">Booking Services</h2>
            <ul className="space-y-3 text-[#8E8E93]">
              <li className="flex items-start gap-2">
                <span className="text-[#007AFF] font-bold">•</span>
                <span>Bookings are subject to availability and our operating hours</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#007AFF] font-bold">•</span>
                <span>You must provide accurate contact information when booking</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#007AFF] font-bold">•</span>
                <span>We reserve the right to refuse service to anyone</span>
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">Payment Terms</h2>
            <ul className="space-y-3 text-[#8E8E93]">
              <li className="flex items-start gap-2">
                <span className="text-[#007AFF] font-bold">•</span>
                <span>Payment can be made online via Paystack or in cash at the shop</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#007AFF] font-bold">•</span>
                <span>All prices are in South African Rand (ZAR) and are subject to change without notice</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#007AFF] font-bold">•</span>
                <span>Online payments are processed securely through Paystack</span>
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">Liability</h2>
            <p className="text-[#8E8E93] leading-relaxed">
              Waylin's Barbershop is not liable for any indirect, incidental, or consequential damages arising from the use of our services. Our total liability is limited to the amount paid for the specific service in question.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">User Conduct</h2>
            <p className="text-[#8E8E93] leading-relaxed mb-3">
              Users agree to:
            </p>
            <ul className="space-y-2 text-[#8E8E93] ml-4">
              <li>• Use the booking system only for lawful purposes</li>
              <li>• Not attempt to interfere with or disrupt the booking system</li>
              <li>• Provide accurate and truthful information</li>
              <li>• Respect our staff and other customers</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">Modifications</h2>
            <p className="text-[#8E8E93] leading-relaxed">
              We reserve the right to modify these terms at any time. Continued use of our services after changes constitutes acceptance of the new terms.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3">Contact</h2>
            <p className="text-[#8E8E93] leading-relaxed">
              For questions about these terms, please contact us through the booking portal.
            </p>
          </section>
        </div>
      </div>
      <Footer />
    </div>
  );
};

