import React, { useState, useEffect } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export const WindowControls: React.FC<{ className?: string }> = ({ className = '' }) => {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    try {
      const win = getCurrentWindow();
      win.isMaximized().then(setIsMaximized).catch(() => {});

      win.onResized(async () => {
        try {
          const max = await win.isMaximized();
          setIsMaximized(max);
        } catch {}
      }).then((unsub) => {
        unlisten = unsub;
      }).catch(() => {});
    } catch {}

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const handleMinimize = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await getCurrentWindow().minimize();
    } catch (err) {
      console.warn('[WindowControls] Erro ao minimizar:', err);
    }
  };

  const handleToggleMaximize = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const win = getCurrentWindow();
      await win.toggleMaximize();
      const max = await win.isMaximized();
      setIsMaximized(max);
    } catch (err) {
      console.warn('[WindowControls] Erro ao alternar maximização:', err);
    }
  };

  const handleClose = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await getCurrentWindow().close();
    } catch (err) {
      console.warn('[WindowControls] Erro ao fechar:', err);
    }
  };

  return (
    <div
      data-tauri-drag-region="false"
      className={`flex items-center h-full select-none ${className}`}
    >
      <button
        type="button"
        onClick={handleMinimize}
        title="Minimizar"
        className="h-full px-3 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800/80 active:bg-zinc-700/60 transition-colors cursor-pointer"
      >
        <Minus className="w-3.5 h-3.5" />
      </button>

      <button
        type="button"
        onClick={handleToggleMaximize}
        title={isMaximized ? 'Restaurar' : 'Maximizar'}
        className="h-full px-3 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800/80 active:bg-zinc-700/60 transition-colors cursor-pointer"
      >
        {isMaximized ? (
          <Copy className="w-3 h-3 rotate-180" />
        ) : (
          <Square className="w-3 h-3" />
        )}
      </button>

      <button
        type="button"
        onClick={handleClose}
        title="Fechar"
        className="h-full px-3.5 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-rose-600 active:bg-rose-700 transition-colors cursor-pointer"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
