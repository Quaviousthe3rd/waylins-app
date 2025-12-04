import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'outline' | 'ghost' | 'ios';
  fullWidth?: boolean;
}

export const Button: React.FC<ButtonProps> = ({ 
  children, 
  variant = 'primary', 
  fullWidth = false, 
  className = '', 
  ...props 
}) => {
  const baseStyles = "px-6 py-3.5 rounded-full font-semibold transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed flex justify-center items-center gap-2 active:scale-95 tracking-tight";
  
  const variants = {
    primary: "bg-[#1C1C1E] text-white hover:bg-black shadow-lg shadow-black/5 border border-transparent",
    secondary: "bg-[#007AFF] text-white hover:bg-[#0066CC] shadow-lg shadow-blue-500/20 border border-transparent",
    danger: "bg-[#FF3B30] text-white hover:bg-[#D70015] shadow-lg shadow-red-500/20 border border-transparent",
    outline: "bg-transparent border border-[#C6C6C8] text-[#1C1C1E] hover:bg-white/50",
    ghost: "bg-transparent text-[#8E8E93] hover:text-[#1C1C1E] hover:bg-[#E5E5EA]",
    ios: "bg-white/80 backdrop-blur-md border border-white/20 text-[#007AFF] shadow-sm active:bg-white/50"
  };

  return (
    <button 
      className={`${baseStyles} ${variants[variant]} ${fullWidth ? 'w-full' : ''} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};