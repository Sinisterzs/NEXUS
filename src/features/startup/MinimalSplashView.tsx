import { useEffect, useState } from 'react';
import { NexusMark } from '../auth/AuthPrimitives';
import { WindowControls } from '../../components/WindowControls';

export function MinimalSplashView() {
  const [showConnecting, setShowConnecting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowConnecting(true), 1200);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="relative flex flex-col items-center justify-center h-screen w-screen bg-black text-zinc-100 select-none">
      <div
        data-tauri-drag-region
        className="absolute top-0 left-0 right-0 h-9 flex items-center justify-end px-3 z-50"
      >
        <WindowControls />
      </div>

      <div className="flex flex-col items-center gap-4">
        <div className="w-16 h-16 flex items-center justify-center animate-pulse motion-reduce:animate-none">
          <NexusMark />
        </div>
        {showConnecting && (
          <p className="text-xs text-zinc-400 tracking-wide" role="status" aria-live="polite">
            Conectando...
          </p>
        )}
      </div>
    </div>
  );
}
