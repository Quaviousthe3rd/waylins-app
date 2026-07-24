import React from 'react';

interface Props {
  children: React.ReactNode;
  // Compact fallback for wrapping a single tab/section instead of the app.
  compact?: boolean;
}

interface State {
  hasError: boolean;
}

// Catches render crashes so one broken screen never takes the whole app
// down (the app is wrapped globally, and the admin settings tab separately
// so an admin-side crash can never block client booking).
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: unknown) {
    console.error('ErrorBoundary caught render error', error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.compact) {
      return (
        <div className="p-6 bg-[#FF3B30]/10 text-[#FF3B30] rounded-2xl text-sm font-medium space-y-3">
          <div className="font-bold">This section hit a problem.</div>
          <div>The rest of the app is unaffected. Reload to try again.</div>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-[#FF3B30] text-white rounded-full text-sm font-semibold"
          >
            Reload
          </button>
        </div>
      );
    }

    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-[#F2F2F7]">
        <div className="w-full max-w-sm text-center">
          <div className="text-5xl mb-6">✂️</div>
          <h1 className="text-2xl font-bold text-[#1C1C1E] mb-2 tracking-tight">
            Something went wrong
          </h1>
          <p className="text-[#8E8E93] mb-8">
            Sorry about that — a reload usually fixes it. Your bookings and
            payments are safe.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="w-full h-14 bg-[#1C1C1E] text-white rounded-full font-semibold text-lg active:scale-95 transition-transform"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
