import React from 'react';

export const Card: React.FC<{ children: React.ReactNode; className?: string; noPadding?: boolean }> = ({ children, className = '', noPadding = false }) => {
  return (
    <div className={`bg-white rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.03)] overflow-hidden border border-white/50 ${noPadding ? '' : 'p-6'} ${className}`}>
      {children}
    </div>
  );
};