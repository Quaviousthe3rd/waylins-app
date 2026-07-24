import React from 'react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// In-app replacement for window.confirm(), which is silently blocked in the
// in-app browsers of Instagram / WhatsApp / Facebook — customers opening the
// booking link from those apps could never cancel an appointment.
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  destructive = false,
  onConfirm,
  onCancel,
}) => {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/40 animate-in fade-in duration-300"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-xs bg-white rounded-3xl p-6 shadow-2xl animate-in zoom-in duration-300"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="font-bold text-lg text-[#1C1C1E] mb-1 tracking-tight">{title}</h3>
        <p className="text-sm text-[#8E8E93] mb-5">{message}</p>
        <div className="flex flex-col gap-2">
          <button
            onClick={onConfirm}
            autoFocus
            className={`w-full h-11 rounded-full font-semibold text-sm text-white active:scale-95 transition-transform ${destructive ? 'bg-[#FF3B30]' : 'bg-[#1C1C1E]'}`}
          >
            {confirmLabel}
          </button>
          <button
            onClick={onCancel}
            className="w-full h-11 rounded-full font-semibold text-sm text-[#1C1C1E] bg-[#F2F2F7] active:scale-95 transition-transform"
          >
            Keep it
          </button>
        </div>
      </div>
    </div>
  );
};
