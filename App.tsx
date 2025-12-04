import React from 'react';
import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ClientPortal } from './pages/ClientPortal';
import { AdminPortal } from './pages/AdminPortal';

const App: React.FC = () => {
  return (
    <Router>
      <div className="min-h-screen bg-[#F2F2F7] text-[#1C1C1E] font-sans selection:bg-blue-500/20 selection:text-blue-700">
        <Routes>
          <Route path="/" element={<Navigate to="/client" replace />} />
          <Route path="/client/*" element={<ClientPortal />} />
          <Route path="/admin/*" element={<AdminPortal />} />
        </Routes>
      </div>
    </Router>
  );
};

export default App;