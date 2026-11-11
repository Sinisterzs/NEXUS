import React, { useState } from 'react';
import {
  Mail,
  Lock,
  KeyRound,
  AlertCircle,
  Loader2,
  ShieldCheck,
  Info,
  Check,
  X,
} from 'lucide-react';
import { authRepository } from '../../repositories/AuthRepository';
import { isResetTokenInvalidError, mapPasswordResetError } from '../../lib/authErrorMapping';
import {
  NEUTRAL_RESET_NOTICE,
  RESET_SUCCESS_NOTICE,
  RESET_MIN_PASSWORD_LENGTH,
  checkNewPassword,
  extractResetToken,
  isValidRecoveryEmail,
  nextRecoveryStep,
  validateResetForm,
  type RecoveryStep,
} from '../../lib/passwordRecovery';

interface PasswordRecoveryViewProps {
  /** Returns to the login form (parent resets its own state). */
  onBackToLogin: () => void;
  /** Optional e-mail to pre-fill (e.g. typed on the login form). */
  initialEmail?: string;
  /** Start directly at the reset screen (user already owns a code). */
  initialStep?: RecoveryStep;
}

const inputClass =
  'w-full bg-nexus-panel text-nexus-text text-xs pl-9 pr-3 py-2 rounded-xl border border-nexus-border hover:border-nexus-muted/50 focus:border-nexus-accent focus:outline-none transition-colors';
const labelClass = 'block text-[11px] font-medium text-nexus-muted mb-1';
const primaryBtn =
  'w-full mt-2 py-2.5 px-4 rounded-xl bg-nexus-accent hover:bg-nexus-accent-hover active:scale-[0.99] text-white text-xs font-bold shadow-md shadow-nexus-accent/20 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50';
const linkBtn =
  'text-[11px] text-nexus-muted hover:text-nexus-accent underline transition-colors cursor-pointer';

const Rule: React.FC<{ ok: boolean; children: React.ReactNode }> = ({ ok, children }) => (
  <li className={`flex items-center gap-1.5 ${ok ? 'text-emerald-400' : 'text-nexus-muted'}`}>
    {ok ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
    <span>{children}</span>
  </li>
);

export const PasswordRecoveryView: React.FC<PasswordRecoveryViewProps> = ({
  onBackToLogin,
  initialEmail = '',
  initialStep = 'forgot_request',
}) => {
  const [step, setStep] = useState<RecoveryStep>(initialStep);
  const [email, setEmail] = useState(initialEmail.includes('@') ? initialEmail.trim() : '');
  const [token, setToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenExpired, setTokenExpired] = useState(false);
  const [showNeutralNotice, setShowNeutralNotice] = useState(false);

  const clearSecrets = () => {
    setToken('');
    setNewPassword('');
    setConfirmPassword('');
  };

  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!isValidRecoveryEmail(email)) {
      setError('Informe um e-mail válido.');
      return;
    }
    setIsLoading(true);
    try {
      await authRepository.requestPasswordReset(email.trim());
      // Neutral by design: same outcome whether or not the e-mail exists.
      setShowNeutralNotice(true);
      setTokenExpired(false);
      setStep((s) => nextRecoveryStep(s, 'requested'));
    } catch (err) {
      setError(mapPasswordResetError(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleHaveCode = () => {
    setError(null);
    setShowNeutralNotice(false);
    setStep((s) => nextRecoveryStep(s, 'haveCode'));
  };

  const handleTokenChange = (value: string) => {
    // Extract immediately so a pasted link/URL is never retained in state.
    setToken(extractResetToken(value));
    setTokenExpired(false);
    setError(null);
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const validation = validateResetForm(token, newPassword, confirmPassword);
    if (validation) {
      setError(validation);
      return;
    }
    setIsLoading(true);
    try {
      await authRepository.confirmPasswordReset(token, newPassword);
      clearSecrets();
      setStep((s) => nextRecoveryStep(s, 'succeeded'));
    } catch (err) {
      if (isResetTokenInvalidError(err)) {
        setTokenExpired(true);
        setToken('');
      }
      setError(mapPasswordResetError(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRequestNewCode = () => {
    clearSecrets();
    setError(null);
    setTokenExpired(false);
    setShowNeutralNotice(false);
    setStep((s) => nextRecoveryStep(s, 'needNewCode'));
  };

  const handleBack = () => {
    clearSecrets();
    onBackToLogin();
  };

  const checks = checkNewPassword(newPassword, confirmPassword);

  const errorBanner = error && (
    <div
      role="alert"
      className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2.5"
    >
      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
      <div className="flex-1 leading-relaxed">
        <span>{error}</span>
        {tokenExpired && (
          <button
            type="button"
            onClick={handleRequestNewCode}
            className="block mt-1.5 font-semibold text-rose-200 hover:text-white underline cursor-pointer"
          >
            Solicitar novo código
          </button>
        )}
      </div>
    </div>
  );

  // ── Screen 3: success ──────────────────────────────────────────────────
  if (step === 'reset_success') {
    return (
      <div className="space-y-4 text-center" data-recovery-step="reset_success">
        <div className="mx-auto w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
          <ShieldCheck className="w-6 h-6 text-emerald-400" />
        </div>
        <h3 className="text-sm font-bold text-nexus-text">Senha redefinida</h3>
        <p className="text-xs text-nexus-muted leading-relaxed">{RESET_SUCCESS_NOTICE}</p>
        <button type="button" onClick={handleBack} className={primaryBtn}>
          Fazer login com a nova senha
        </button>
      </div>
    );
  }

  // ── Screen 2: neutral confirmation + reset ─────────────────────────────
  if (step === 'reset_password') {
    return (
      <div data-recovery-step="reset_password">
        {showNeutralNotice && (
          <div className="mb-4 p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-200 text-xs flex items-start gap-2.5">
            <Info className="w-4 h-4 shrink-0 mt-0.5 text-blue-400" />
            <span className="flex-1 leading-relaxed">{NEUTRAL_RESET_NOTICE}</span>
          </div>
        )}
        {errorBanner}
        <form onSubmit={handleReset} className="space-y-3.5" autoComplete="off">
          <div>
            <label className={labelClass}>Código ou link de recuperação</label>
            <div className="relative">
              <KeyRound className="w-3.5 h-3.5 absolute left-3 top-3 text-nexus-muted pointer-events-none" />
              <input
                type="password"
                value={token}
                onChange={(e) => handleTokenChange(e.target.value)}
                onPaste={(e) => {
                  const pasted = e.clipboardData.getData('text');
                  e.preventDefault();
                  handleTokenChange(pasted);
                }}
                placeholder="Cole o código ou o link recebido por e-mail"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className={`${inputClass} font-mono`}
              />
            </div>
            <p className="mt-1 text-[10px] text-nexus-muted/80">
              Você pode colar o link completo; apenas o código é mantido.
            </p>
          </div>

          <div>
            <label className={labelClass}>Nova Senha</label>
            <div className="relative">
              <Lock className="w-3.5 h-3.5 absolute left-3 top-3 text-nexus-muted pointer-events-none" />
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>Confirmar Nova Senha</label>
            <div className="relative">
              <Lock className="w-3.5 h-3.5 absolute left-3 top-3 text-nexus-muted pointer-events-none" />
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                className={inputClass}
              />
            </div>
          </div>

          <ul className="text-[10px] space-y-0.5" aria-label="Requisitos da senha">
            <Rule ok={checks.minLength}>Mínimo de {RESET_MIN_PASSWORD_LENGTH} caracteres</Rule>
            <Rule ok={checks.matches}>As senhas coincidem</Rule>
          </ul>

          <button type="submit" disabled={isLoading} className={primaryBtn}>
            {isLoading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Redefinindo...</span>
              </>
            ) : (
              <span>Redefinir senha</span>
            )}
          </button>
        </form>

        <div className="mt-3 flex items-center justify-between">
          <button type="button" onClick={handleRequestNewCode} className={linkBtn}>
            Solicitar novo código
          </button>
          <button type="button" onClick={handleBack} className={linkBtn}>
            Voltar ao login
          </button>
        </div>
      </div>
    );
  }

  // ── Screen 1: request by e-mail ────────────────────────────────────────
  return (
    <div data-recovery-step="forgot_request">
      <p className="text-xs text-nexus-muted leading-relaxed mb-4">
        Informe o e-mail da sua conta. Se ele estiver cadastrado, enviaremos um código de uso único.
      </p>
      {errorBanner}
      <form onSubmit={handleRequest} className="space-y-3.5">
        <div>
          <label className={labelClass}>E-mail</label>
          <div className="relative">
            <Mail className="w-3.5 h-3.5 absolute left-3 top-3 text-nexus-muted pointer-events-none" />
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seu.email@exemplo.com"
              className={inputClass}
            />
          </div>
        </div>

        <button type="submit" disabled={isLoading} className={primaryBtn}>
          {isLoading ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Enviando...</span>
            </>
          ) : (
            <span>Enviar instruções de recuperação</span>
          )}
        </button>
      </form>

      <div className="mt-3 flex items-center justify-between">
        <button type="button" onClick={handleHaveCode} className={linkBtn}>
          Já possui um código de recuperação?
        </button>
        <button type="button" onClick={handleBack} className={linkBtn}>
          Voltar ao login
        </button>
      </div>
    </div>
  );
};
