import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { AuthPanel } from './AuthPanel';
import { NexusMark } from './AuthPrimitives';

interface AuthModalProps { isOpen: boolean; onClose: () => void; }

export function AuthModal({ isOpen, onClose }: AuthModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (isOpen && !dialog.current?.open) {
      dialog.current?.showModal();
      dialog.current?.querySelector<HTMLInputElement>('input')?.focus();
    }
    if (!isOpen && dialog.current?.open) dialog.current.close();
  }, [isOpen]);
  return <dialog className="auth-ui auth-dialog" ref={dialog} aria-label="Entrar ou criar conta no NEXUS"
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), summary, a[href], [tabindex]:not([tabindex="-1"])'
      )).filter((element) => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    }}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className="auth-dialog-bar">
      <div className="auth-titlebar-brand"><NexusMark /><strong>NEXUS</strong></div>
      <button type="button" className="auth-dialog-close" aria-label="Fechar autenticação" onClick={onClose}><X /></button>
    </header>
    <AuthPanel context="modal" enabled={isOpen} onAuthenticated={onClose} />
  </dialog>;
}
