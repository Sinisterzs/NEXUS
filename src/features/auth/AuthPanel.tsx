import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Mail, User } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { mapGoogleAuthError, isAccountRecoveryCandidateError } from '../../lib/authErrorMapping';
import { authRepository } from '../../repositories/AuthRepository';
import { PasswordRecoveryView } from './PasswordRecoveryView';
import { AuthConsentPreview, AuthField, AuthProgress, GoogleIcon, NexusMark, PasswordRequirements } from './AuthPrimitives';
import './auth.css';

interface AuthPanelProps {
  context?: 'view' | 'modal';
  enabled?: boolean;
  onAuthenticated?: () => void;
}

export function AuthPanel({ context = 'view', enabled = true, onAuthenticated }: AuthPanelProps) {
  const panelId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const legalTrigger = useRef<HTMLButtonElement | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});
  const [legalDocument, setLegalDocument] = useState<string | null>(null);
  const legalRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { clearTimeout(closeTimer.current); }, []);
  useEffect(() => { if (!enabled) clearTimeout(closeTimer.current); }, [enabled]);
  useEffect(() => { if (legalDocument) legalRef.current?.focus(); }, [legalDocument]);
  const finish = (kind: 'login' | 'register' | 'google') => {
    if (onAuthenticated) closeTimer.current = setTimeout(onAuthenticated, kind === 'login' ? 500 : 600);
  };
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [loginInput, setLoginInput] = useState('');
  const [password, setPassword] = useState('');

  // Register fields
  const [regUsername, setRegUsername] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regDisplayName, setRegDisplayName] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirmPassword, setRegConfirmPassword] = useState('');

  const [isLoading, setIsLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recoveryInitialToken, setRecoveryInitialToken] = useState('');
  const [offerRecovery, setOfferRecovery] = useState(false);

  const loginOnline = useAppStore((state) => state.loginOnline);
  const registerOnline = useAppStore((state) => state.registerOnline);
  const loginGoogle = useAppStore((state) => state.loginGoogle);
  const cancelGoogleLogin = useAppStore((state) => state.cancelGoogleLogin);
  const isGoogleLoading = useAppStore((state) => state.isGoogleLoading);
  const authError = useAppStore((state) => state.authError);
  const clearAuthError = useAppStore((state) => state.clearAuthError);
  const ui30ReauthRequired = useAppStore((state) => state.ui30ReauthRequired);


  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let unlisten: (() => void) | undefined;

    const applyDeepLinkToken = (token: string) => {
      if (!active || !token) return;
      setLocalError(null);
      setSuccessMessage(null);
      setOfferRecovery(false);
      clearAuthError();
      setRecoveryInitialToken(token);
      setRecoveryMode(true);
    };

    authRepository.takePendingResetToken().then((pending) => {
      if (pending) applyDeepLinkToken(pending);
    });

    authRepository.onDeepLinkResetToken((incoming) => {
      applyDeepLinkToken(incoming);
    }).then((fn) => {
      if (active) {
        unlisten = fn;
      } else {
        fn();
      }
    });

    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, [enabled, clearAuthError]);

  const handleTabChange = (newTab: 'login' | 'register') => {
    setTab(newTab);
    setFieldErrors({});
    setLocalError(null);
    setSuccessMessage(null);
    setOfferRecovery(false);
    setRecoveryInitialToken('');
    setRecoveryMode(false);
    clearAuthError();
  };

  const openRecovery = () => {
    setLocalError(null);
    setSuccessMessage(null);
    setOfferRecovery(false);
    setRecoveryInitialToken('');
    clearAuthError();
    setRecoveryMode(true);
    setFieldErrors({});
  };

  const closeRecovery = () => {
    setRecoveryMode(false);
    setRecoveryInitialToken('');
    setTab('login');
    setPassword('');
    setLocalError(null);
    setSuccessMessage(null);
    setOfferRecovery(false);
    clearAuthError();
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading || isGoogleLoading) return;
    setLocalError(null);
    setSuccessMessage(null);
    setFieldErrors({});

    if (!loginInput.trim() || !password) {
      setLocalError('Por favor, preencha o login e a senha.');
      setFieldErrors({ login: !loginInput.trim() ? 'Informe seu e-mail ou nome de usuário.' : undefined, password: !password ? 'Informe sua senha.' : undefined });
      return;
    }

    setIsLoading(true);
    try {
      const success = await loginOnline(loginInput.trim(), password);
      if (success) {
        setSuccessMessage('Login efetuado com sucesso! Abrindo NEXUS...');
        finish('login');
      }
    } catch (err: any) {
      setLocalError(err?.message || 'Falha ao autenticar.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading || isGoogleLoading) return;
    setLocalError(null);
    setSuccessMessage(null);
    setFieldErrors({});

    if (!regUsername.trim()) {
      setLocalError('Informe um nome de usuário.');
      setFieldErrors({ username: 'Informe um nome de usuário.' });
      return;
    }
    if (regUsername.trim().length < 3) {
      setLocalError('O nome de usuário deve ter no mínimo 3 caracteres.');
      setFieldErrors({ username: 'O nome de usuário deve ter no mínimo 3 caracteres.' });
      return;
    }
    if (!regEmail.trim() || !regEmail.includes('@')) {
      setLocalError('Informe um e-mail válido.');
      setFieldErrors({ email: 'Informe um e-mail válido.' });
      return;
    }
    if (regPassword.length < 8) {
      setLocalError('A senha deve ter no mínimo 8 caracteres.');
      setFieldErrors({ regPassword: 'A senha deve ter no mínimo 8 caracteres.' });
      return;
    }
    if (regPassword !== regConfirmPassword) {
      setLocalError('As senhas digitadas não coincidem.');
      setFieldErrors({ confirmation: 'As senhas digitadas não coincidem.' });
      return;
    }

    setIsLoading(true);
    try {
      const success = await registerOnline(
        regUsername.trim(),
        regEmail.trim().toLowerCase(),
        regPassword,
        regDisplayName.trim() || undefined
      );
      if (success) {
        setSuccessMessage(null);
        finish('register');
      }
    } catch (err: any) {
      setLocalError(err?.message || 'Falha ao registrar conta.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    if (isLoading || isGoogleLoading) return;
    setLocalError(null);
    setSuccessMessage(null);
    setOfferRecovery(false);
    clearAuthError();

    try {
      const success = await loginGoogle();
      if (success) {
        setSuccessMessage('Autenticado com o Google com sucesso!');
        finish('google');
      }
    } catch (err: any) {
      setLocalError(mapGoogleAuthError(err, context));
      setOfferRecovery(isAccountRecoveryCandidateError(err));
    }
  };

  const currentError = localError || authError;
  const busy = isLoading || isGoogleLoading;
  useEffect(() => { if (enabled) headingRef.current?.focus(); }, [enabled, tab, recoveryMode]);
  useEffect(() => {
    if (enabled && currentError) {
      const invalid = errorRef.current?.closest('.auth-panel')?.querySelector<HTMLInputElement>('[aria-invalid="true"]');
      (invalid || errorRef.current)?.focus();
    }
  }, [enabled, currentError, fieldErrors]);
  const legalLink = (name: string) => <button type="button" className="auth-link" onClick={(event) => {
    legalTrigger.current = event.currentTarget;
    setLegalDocument(name);
  }}>{name}</button>;

  // Preserve the previous modal lifecycle: fields and recovery secrets unmount on close.
  if (!enabled) return null;

  return <div className="auth-shell">
    <aside className="auth-brand" aria-label="NEXUS — Seu espaço. Sua conexão.">
      <NexusMark className="auth-brand-mark" />
      <h2>NEXUS</h2><p>Seu espaço. Sua conexão.</p>
      <small>CONEXÕES QUE APROXIMAM</small>
    </aside>
    <section className={`auth-panel ${!recoveryMode && tab === 'register' ? 'auth-register' : ''}`} aria-labelledby={`${panelId}-heading`}>
      <div className="auth-heading">
        <span className="auth-eyebrow">{recoveryMode ? 'VAMOS RECOMEÇAR' : tab === 'login' ? 'SEU PRÓXIMO ENCONTRO COMEÇA AQUI' : 'BEM-VINDO AO NEXUS'}</span>
        <h1 id={`${panelId}-heading`} ref={headingRef} tabIndex={-1}>{recoveryMode ? 'Recupere sua conta' : tab === 'login' ? 'Bem-vindo de volta' : 'Crie sua conta'}</h1>
        <p>{recoveryMode ? 'Volte a se conectar com a sua comunidade.' : tab === 'login' ? 'Entre na sua conta para continuar' : 'Sua comunidade começa aqui'}</p>
      </div>
      <AuthProgress message={!recoveryMode && busy ? (isGoogleLoading ? 'Aguardando autorização no navegador...' : tab === 'login' ? 'Autenticando...' : 'Criando conta...') : ''} />
      {recoveryMode ? <PasswordRecoveryView onBackToLogin={closeRecovery} initialEmail={loginInput}
        initialStep={recoveryInitialToken ? 'reset_password' : 'forgot_request'} initialToken={recoveryInitialToken} /> : <>
        {currentError && <div className="auth-notice" role="alert" tabIndex={-1} ref={errorRef}>
          <AlertCircle aria-hidden="true" /><div>{currentError}
            {offerRecovery && <button type="button" className="auth-link" onClick={openRecovery}>Esqueceu sua senha?</button>}
          </div>
        </div>}
        {successMessage && <div className="auth-notice success" role="status"><CheckCircle2 aria-hidden="true" /><span>{successMessage}</span></div>}
        {ui30ReauthRequired && !successMessage && (
          <div className="auth-notice" role="status">
            <span><strong>Bem-vindo ao novo NEXUS</strong> — Atualizamos sua experiência. Entre novamente para continuar de onde parou.</span>
          </div>
        )}
        {tab === 'login' ? <form onSubmit={handleLoginSubmit} className="auth-form" aria-busy={busy}>
          <AuthField label="E-mail ou nome de usuário" icon={<Mail />} value={loginInput} autoComplete="username" name="login"
            onChange={(e) => setLoginInput(e.target.value)} placeholder="seu@email.com ou seu_usuario" required error={fieldErrors.login} />
          <AuthField label="Senha" type="password" value={password} name="password" autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)} placeholder="Sua senha" required error={fieldErrors.password} />
          <div className="auth-forgot"><button type="button" className="auth-link" onClick={openRecovery}>Esqueceu sua senha?</button></div>
          <button type="submit" className="auth-primary" disabled={busy}>{isLoading && <Loader2 className="animate-spin" aria-hidden="true" />}{isLoading ? 'Autenticando...' : 'Entrar no NEXUS'}</button>
        </form> : <form onSubmit={handleRegisterSubmit} className="auth-form" aria-busy={busy}>
          <AuthField label="Nome de usuário" icon={<User />} value={regUsername} name="username" autoComplete="username" required
            onChange={(e) => setRegUsername(context === 'view' ? e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') : e.target.value)}
            placeholder="Como você quer ser conhecido?" error={fieldErrors.username} />
          <AuthField label="E-mail" type="email" icon={<Mail />} value={regEmail} name="email" autoComplete="email" required
            onChange={(e) => setRegEmail(e.target.value)} placeholder="seu@email.com" error={fieldErrors.email} />
          <details className="auth-display-name"><summary>Adicionar nome de exibição (opcional)</summary>
            <AuthField label="Nome de exibição" icon={<User />} value={regDisplayName} name="displayName" autoComplete="nickname"
              onChange={(e) => setRegDisplayName(e.target.value)} placeholder="Como você deseja ser visto" />
          </details>
          <AuthField label="Senha" type="password" value={regPassword} name="newPassword" autoComplete="new-password" required
            onChange={(e) => setRegPassword(e.target.value)} placeholder="Crie uma senha" error={fieldErrors.regPassword} />
          <AuthField label="Confirmar senha" type="password" value={regConfirmPassword} name="confirmPassword" autoComplete="new-password" required
            onChange={(e) => setRegConfirmPassword(e.target.value)} placeholder="Digite a senha novamente" error={fieldErrors.confirmation} />
          <PasswordRequirements password={regPassword} confirmation={regConfirmPassword} />
          <AuthConsentPreview legalLink={legalLink} />
          <button type="submit" className="auth-primary" disabled={busy}>{isLoading && <Loader2 className="animate-spin" aria-hidden="true" />}{isLoading ? 'Criando conta...' : 'Criar minha conta'}</button>
        </form>}
        <div className="auth-separator" aria-hidden="true">OU</div>
        <button type="button" className="auth-google" disabled={busy} onClick={handleGoogleSignIn}>
          {isGoogleLoading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <GoogleIcon />}
          <span>{isGoogleLoading ? 'Aguardando autorização no navegador...' : 'Continuar com Google'}</span>
        </button>
        {isGoogleLoading && <div className="auth-cancel-google"><button type="button" className="auth-link" onClick={() => cancelGoogleLogin()}>Cancelar login Google</button></div>}
        <p className="auth-switch">{tab === 'login' ? 'Ainda não tem conta?' : 'Já tem uma conta?'}
          <button type="button" className="auth-link" onClick={() => handleTabChange(tab === 'login' ? 'register' : 'login')}>{tab === 'login' ? 'Criar conta' : 'Entrar'}</button>
        </p>
      </>}
      <footer className="auth-legal">{legalLink('Termos de Uso')}<span aria-hidden="true">•</span>{legalLink('Política de Privacidade')}</footer>
      {legalDocument && <div className="auth-legal-preview" role="region" aria-label={legalDocument} ref={legalRef} tabIndex={-1}>
        <h2>{legalDocument}</h2><p>Este documento ainda está em preparação. Não há um texto disponível para aceite nesta versão.</p>
        <button type="button" className="auth-link" onClick={() => { setLegalDocument(null); legalTrigger.current?.focus(); }}>Fechar aviso</button>
      </div>}
    </section>
  </div>;
}

