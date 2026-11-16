import React, { useId, useState } from 'react';
import { Check, Eye, EyeOff, Info, Lock, Minus } from 'lucide-react';
import { checkNewPassword, RESET_MIN_PASSWORD_LENGTH } from '../../lib/passwordRecovery';

export const NexusMark = ({ className = '' }: { className?: string }) => (
  <svg viewBox="0 0 180 170" className={className} fill="none" aria-hidden="true">
    <path d="M12 160 40 16 140 115 170 2 140 160 58 75Z" fill="#d52d50" />
    <path d="m40 16 18 59-46 85Z" fill="#f23b60" />
    <path d="m40 16 100 99v45L58 75Z" fill="#ba2342" />
    <path d="m140 115 30-113-9 79-21 79Z" fill="#ed3458" />
  </svg>
);

interface AuthFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  icon?: React.ReactNode;
  error?: string;
  hint?: React.ReactNode;
}

export function AuthProgress({ message }: { message: string }) {
  return <span className="auth-sr-status" role="status" aria-live="polite" aria-atomic="true">{message}</span>;
}

export function AuthField({ label, icon, error, hint, id, type = 'text', className = '', ...input }: AuthFieldProps) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === 'password';
  const description = [error || hint ? `${inputId}-hint` : '', input['aria-describedby']].filter(Boolean).join(' ') || undefined;
  return <div className="auth-field">
    <label htmlFor={inputId}>{label}</label>
    <div className={`auth-input-wrap ${error ? 'has-error' : ''}`}>
      <span className="auth-input-icon" aria-hidden="true">{icon || (isPassword ? <Lock /> : null)}</span>
      <input {...input} id={inputId} type={isPassword && revealed ? 'text' : type}
        className={className} aria-invalid={error ? true : undefined} aria-describedby={description} />
      {isPassword && <button type="button" className="auth-reveal" aria-label={`${revealed ? 'Ocultar' : 'Mostrar'} ${label.toLowerCase()}`}
        aria-pressed={revealed} onClick={() => setRevealed((value) => !value)}>
        {revealed ? <EyeOff /> : <Eye />}
      </button>}
    </div>
    {(error || hint) && <p id={`${inputId}-hint`} className={error ? 'auth-field-error' : 'auth-field-hint'}>{error || hint}</p>}
  </div>;
}

export function PasswordRequirements({ password, confirmation }: { password: string; confirmation: string }) {
  const checks = checkNewPassword(password, confirmation);
  return <ul className="auth-password-rules" aria-label="Requisitos da senha">
    <li data-met={checks.minLength}>{checks.minLength ? <Check /> : <Minus />}<span>Mínimo de {RESET_MIN_PASSWORD_LENGTH} caracteres</span></li>
    <li data-met={checks.matches}>{checks.matches ? <Check /> : <Minus />}<span>As senhas coincidem</span></li>
  </ul>;
}

// Visual preview only. These choices never change registration eligibility or payloads.
export function AuthConsentPreview({ legalLink }: { legalLink: (name: string) => React.ReactNode }) {
  const id = useId();
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAcknowledged, setPrivacyAcknowledged] = useState(false);
  return <div className="auth-consents" aria-describedby={`${id}-note`}>
    <div className="auth-age-notice"><Info aria-hidden="true" /><span>Idade mínima: 16 anos</span></div>
    <label className="auth-check"><input type="checkbox" checked={ageConfirmed} onChange={(e) => setAgeConfirmed(e.target.checked)} /><span>Confirmo que tenho 16 anos ou mais</span></label>
    <div className="auth-check"><input id={`${id}-terms`} type="checkbox" checked={termsAccepted} onChange={(e) => setTermsAccepted(e.target.checked)}
      aria-label="Li e aceito os Termos de Uso" aria-describedby={`${id}-note`} />
      <div><label htmlFor={`${id}-terms`}>Li e aceito os </label>{legalLink('Termos de Uso')}</div>
    </div>
    <div className="auth-check"><input id={`${id}-privacy`} type="checkbox" checked={privacyAcknowledged} onChange={(e) => setPrivacyAcknowledged(e.target.checked)}
      aria-label="Li e estou ciente da Política de Privacidade" aria-describedby={`${id}-note`} />
      <div><label htmlFor={`${id}-privacy`}>Li e estou ciente da </label>{legalLink('Política de Privacidade')}</div>
    </div>
    <p id={`${id}-note`} className="auth-consent-note">Prévia de consentimento: o registro definitivo no servidor será ativado na etapa final. Estas opções ainda não condicionam o cadastro.</p>
  </div>;
}

export const GoogleIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true">
  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
</svg>;
