import React, { useEffect, useState } from 'react';
import { AlertCircle, Info, KeyRound, Loader2, Mail, ShieldCheck } from 'lucide-react';
import { authRepository } from '../../repositories/AuthRepository';
import { isResetTokenInvalidError, mapPasswordResetError } from '../../lib/authErrorMapping';
import { NEUTRAL_RESET_NOTICE, RESET_SUCCESS_NOTICE, extractResetToken, isValidRecoveryEmail,
  nextRecoveryStep, validateResetForm, type RecoveryStep } from '../../lib/passwordRecovery';
import { AuthField, AuthProgress, PasswordRequirements } from './AuthPrimitives';

interface PasswordRecoveryViewProps {
  onBackToLogin: () => void;
  initialEmail?: string;
  initialStep?: RecoveryStep;
  initialToken?: string;
}
export const PasswordRecoveryView: React.FC<PasswordRecoveryViewProps> = ({
  onBackToLogin,
  initialEmail = '',
  initialStep = 'forgot_request',
  initialToken = '',
}) => {
  const cleanedInitialToken = extractResetToken(initialToken);
  const [step, setStep] = useState<RecoveryStep>(
    cleanedInitialToken ? 'reset_password' : initialStep
  );
  const [email, setEmail] = useState(initialEmail.includes('@') ? initialEmail.trim() : '');
  const [token, setToken] = useState(cleanedInitialToken);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenExpired, setTokenExpired] = useState(false);
  const [showNeutralNotice, setShowNeutralNotice] = useState(false);

  useEffect(() => {
    const incoming = extractResetToken(initialToken);
    if (incoming) {
      setToken(incoming);
      setStep('reset_password');
      setTokenExpired(false);
      setError(null);
    }
  }, [initialToken]);

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

  const errorBanner = error && <div className="auth-notice" role="alert">
    <AlertCircle aria-hidden="true" /><div>{error}{tokenExpired && <button type="button" onClick={handleRequestNewCode} className="auth-link">Solicitar novo código</button>}</div>
  </div>;

  if (step === 'reset_success') return <div className="auth-recovery-success" data-recovery-step="reset_success" role="status">
    <ShieldCheck aria-hidden="true" /><h2>Senha redefinida</h2>
    <p>{RESET_SUCCESS_NOTICE}</p>
    <button type="button" onClick={handleBack} className="auth-primary">Fazer login com a nova senha</button>
  </div>;

  if (step === 'reset_password') return <div data-recovery-step="reset_password">
    <AuthProgress message={isLoading ? 'Redefinindo...' : ''} />
    {showNeutralNotice && <div className="auth-notice neutral" role="status"><Info aria-hidden="true" /><span>{NEUTRAL_RESET_NOTICE}</span></div>}
    {errorBanner}
    <form onSubmit={handleReset} className="auth-form" autoComplete="off" aria-busy={isLoading}>
      <AuthField label="Código ou link de recuperação" icon={<KeyRound />} type="password" value={token}
        onChange={(e) => handleTokenChange(e.target.value)}
        onPaste={(e) => { const pasted = e.clipboardData.getData('text'); e.preventDefault(); handleTokenChange(pasted); }}
        placeholder="Cole o código ou link recebido" autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off"
        hint="Você pode colar o link completo; apenas o código é mantido." />
      <AuthField label="Nova Senha" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Crie uma nova senha" autoComplete="new-password" />
      <AuthField label="Confirmar Nova Senha" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Digite a nova senha novamente" autoComplete="new-password" />
      <PasswordRequirements password={newPassword} confirmation={confirmPassword} />
      <button type="submit" disabled={isLoading} className="auth-primary">{isLoading && <Loader2 className="animate-spin" aria-hidden="true" />}{isLoading ? 'Redefinindo...' : 'Redefinir senha'}</button>
    </form>
    <div className="auth-recovery-actions">
      <button type="button" onClick={handleRequestNewCode} className="auth-link">Solicitar novo código</button>
      <button type="button" onClick={handleBack} className="auth-link">Voltar ao login</button>
    </div>
  </div>;

  return <div className="auth-recovery" data-recovery-step="forgot_request">
    <AuthProgress message={isLoading ? 'Enviando...' : ''} />
    <p>Informe o e-mail da sua conta. Se ele estiver cadastrado, enviaremos um código de uso único.</p>
    {errorBanner}
    <form onSubmit={handleRequest} className="auth-form" aria-busy={isLoading}>
      <AuthField label="E-mail" type="email" icon={<Mail />} required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="seu@email.com" autoComplete="email" />
      <button type="submit" disabled={isLoading} className="auth-primary">{isLoading && <Loader2 className="animate-spin" aria-hidden="true" />}{isLoading ? 'Enviando...' : 'Enviar instruções de recuperação'}</button>
    </form>
    <div className="auth-recovery-actions">
      <button type="button" onClick={handleHaveCode} className="auth-link">Já possui um código de recuperação?</button>
      <button type="button" onClick={handleBack} className="auth-link">Voltar ao login</button>
    </div>
  </div>;
};
