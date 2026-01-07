import React from 'react';
import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import { ClientPortal } from './pages/ClientPortal';
import { AdminPortal } from './pages/AdminPortal';
import { HomePage } from './pages/HomePage';
import { Pricing } from './pages/Pricing';
import { RefundPolicy } from './pages/RefundPolicy';
import { CancellationPolicy } from './pages/CancellationPolicy';
import { TermsOfService } from './pages/TermsOfService';
import { PrivacyPolicy } from './pages/PrivacyPolicy';
import { Toaster } from './services/notifications';

const App: React.FC = () => {
  return (
    <Router>
      <div className="min-h-screen bg-[#F2F2F7] text-[#1C1C1E] font-sans selection:bg-blue-500/20 selection:text-blue-700">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/client/*" element={<ClientPortal />} />
          <Route path="/admin/*" element={<AdminPortal />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/refund-policy" element={<RefundPolicy />} />
          <Route path="/cancellation-policy" element={<CancellationPolicy />} />
          <Route path="/terms" element={<TermsOfService />} />
          <Route path="/privacy" element={<PrivacyPolicy />} />
        </Routes>
        <Toaster />
      </div>
    </Router>
  );
};

export default App;