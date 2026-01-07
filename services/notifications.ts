import toast, { Toaster } from 'react-hot-toast';

export const notify = {
  success: (message: string) => {
    toast.success(message, {
      duration: 4000,
      position: 'top-center',
      style: {
        background: '#34C759',
        color: '#fff',
        borderRadius: '12px',
        padding: '12px 16px',
        fontSize: '14px',
        fontWeight: '500',
      },
    });
  },

  error: (message: string) => {
    toast.error(message, {
      duration: 5000,
      position: 'top-center',
      style: {
        background: '#FF3B30',
        color: '#fff',
        borderRadius: '12px',
        padding: '12px 16px',
        fontSize: '14px',
        fontWeight: '500',
      },
    });
  },

  info: (message: string) => {
    toast(message, {
      duration: 4000,
      position: 'top-center',
      icon: 'ℹ️',
      style: {
        background: '#007AFF',
        color: '#fff',
        borderRadius: '12px',
        padding: '12px 16px',
        fontSize: '14px',
        fontWeight: '500',
      },
    });
  },

  warning: (message: string) => {
    toast(message, {
      duration: 4000,
      position: 'top-center',
      icon: '⚠️',
      style: {
        background: '#FF9500',
        color: '#fff',
        borderRadius: '12px',
        padding: '12px 16px',
        fontSize: '14px',
        fontWeight: '500',
      },
    });
  },
};

export { Toaster };

