import React, { useState } from 'react';
import { X, Lock, Mail, User, Shield, AlertCircle, Loader2, Sparkles, CheckCircle2 } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const GoogleIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg className={className} viewBox="0 0 24 24">
    <path
      fill="#4285F4"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
    />
    <path
      fill="#34A853"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
    />
    <path
      fill="#FBBC05"
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
    />
    <path
      fill="#EA4335"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
    />
  </svg>
);

export const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose }) => {
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

  const loginOnline = useAppStore((state) => state.loginOnline);
  const registerOnline = useAppStore((state) => state.registerOnline);
  const loginGoogle = useAppStore((state) => state.loginGoogle);
  const cancelGoogleLogin = useAppStore((state) => state.cancelGoogleLogin);
  const isGoogleLoading = useAppStore((state) => state.isGoogleLoading);
  const authError = useAppStore((state) => state.authError);
  const clearAuthError = useAppStore((state) => state.clearAuthError);

  if (!isOpen) return null;

  const handleTabChange = (newTab: 'login' | 'register') => {
    setTab(newTab);
    setLocalError(null);
    setSuccessMessage(null);
    clearAuthError();
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setSuccessMessage(null);

    if (!loginInput.trim() || !password) {
      setLocalError('Por favor, preencha o login e a senha.');
      return;
    }

    setIsLoading(true);
    try {
      const success = await loginOnline(loginInput.trim(), password);
      if (success) {
        setSuccessMessage('Login efetuado com sucesso!');
        setTimeout(() => {
          onClose();
        }, 500);
      }
    } catch (err: any) {
      setLocalError(err?.message || 'Falha ao autenticar.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setSuccessMessage(null);

    if (!regUsername.trim()) {
      setLocalError('Informe um nome de usuário.');
      return;
    }
    if (regUsername.trim().length < 3) {
      setLocalError('O nome de usuário deve ter no mínimo 3 caracteres.');
      return;
    }
    if (!regEmail.trim() || !regEmail.includes('@')) {
      setLocalError('Informe um e-mail válido.');
      return;
    }
    if (regPassword.length < 8) {
      setLocalError('A senha deve ter no mínimo 8 caracteres.');
      return;
    }
    if (regPassword !== regConfirmPassword) {
      setLocalError('As senhas digitadas não coincidem.');
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
        setSuccessMessage('Conta criada com sucesso! Conectando...');
        setTimeout(() => {
          onClose();
        }, 600);
      }
    } catch (err: any) {
      setLocalError(err?.message || 'Falha ao registrar conta.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setLocalError(null);
    setSuccessMessage(null);
    clearAuthError();

    try {
      const success = await loginGoogle();
      if (success) {
        setSuccessMessage('Autenticado com o Google com sucesso!');
        setTimeout(() => {
          onClose();
        }, 600);
      }
    } catch (err: any) {
      const msg = err?.message || 'Falha ao autenticar com o Google.';
      if (msg.includes('ACCOUNT_CONFLICT_EMAIL_EXISTS')) {
        setLocalError(
          'Já existe uma conta cadastrada com este e-mail no NEXUS. Por segurança, faça login com sua senha abaixo e vincule sua conta Google nas Configurações.'
        );
      } else {
        setLocalError(msg);
      }
    }
  };

  const currentError = localError || authError;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-fadeIn select-none">
      <div className="relative w-full max-w-md bg-nexus-surface border border-nexus-border/80 rounded-2xl shadow-2xl shadow-black/80 overflow-hidden flex flex-col">
        {/* Header decoration */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-nexus-accent via-nexus-accent-hover to-nexus-accent" />

        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-lg text-nexus-muted hover:text-nexus-text hover:bg-nexus-panel transition-colors"
          title="Fechar"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Modal Top Brand */}
        <div className="p-6 pb-4 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-nexus-panel border border-nexus-border/80 mb-3 shadow-inner">
            <span className="text-xl font-black text-nexus-accent tracking-tighter">N</span>
          </div>
          <h2 className="text-lg font-bold text-nexus-text tracking-wide">
            {tab === 'login' ? 'Conectar ao NEXUS' : 'Criar Conta no NEXUS'}
          </h2>
          <p className="text-xs text-nexus-muted mt-1">
            {tab === 'login'
              ? 'Acesse seus canais, perfil e comunidades online'
              : 'Registre sua identidade definitiva no ecossistema'}
          </p>

          {/* Tab Selector */}
          <div className="flex bg-nexus-panel p-1 rounded-xl mt-5 border border-nexus-border/60">
            <button
              type="button"
              onClick={() => handleTabChange('login')}
              className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                tab === 'login'
                  ? 'bg-nexus-surface text-nexus-text shadow-sm border border-nexus-border/40'
                  : 'text-nexus-muted hover:text-nexus-text'
              }`}
            >
              Entrar
            </button>
            <button
              type="button"
              onClick={() => handleTabChange('register')}
              className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                tab === 'register'
                  ? 'bg-nexus-surface text-nexus-text shadow-sm border border-nexus-border/40'
                  : 'text-nexus-muted hover:text-nexus-text'
              }`}
            >
              Cadastrar
            </button>
          </div>
        </div>

        {/* Form Body */}
        <div className="px-6 pb-6 flex-1">
          {currentError && (
            <div className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-start gap-2.5 text-xs text-rose-300 animate-slideDown">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="flex-1 leading-relaxed">{currentError}</div>
            </div>
          )}

          {successMessage && (
            <div className="mb-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-start gap-2.5 text-xs text-emerald-300">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <div className="flex-1">{successMessage}</div>
            </div>
          )}

          {/* Google Sign-In Button */}
          <div className="space-y-3 mb-4">
            <button
              type="button"
              disabled={isLoading || isGoogleLoading}
              onClick={handleGoogleSignIn}
              className="w-full py-2.5 px-4 rounded-xl bg-nexus-panel hover:bg-nexus-panel/80 active:scale-[0.99] border border-nexus-border/80 hover:border-nexus-muted/50 text-nexus-text text-xs font-semibold shadow-sm transition-all flex items-center justify-center gap-2.5 cursor-pointer disabled:opacity-50"
            >
              {isGoogleLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-nexus-accent" />
                  <span>Aguardando autorização no navegador...</span>
                </>
              ) : (
                <>
                  <GoogleIcon className="w-4 h-4" />
                  <span>Continuar com o Google</span>
                </>
              )}
            </button>

            {/* Waiting for Browser banner with cancel button */}
            {isGoogleLoading && (
              <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs text-blue-200 flex flex-col gap-2 animate-fadeIn">
                <div className="flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400 shrink-0" />
                  <span className="font-medium">Navegador aberto para autenticação</span>
                </div>
                <p className="text-[11px] text-blue-300/80 leading-relaxed">
                  Autorize a conta no navegador padrão. O NEXUS concluirá o login automaticamente via porta segura local.
                </p>
                <button
                  type="button"
                  onClick={() => cancelGoogleLogin()}
                  className="self-end text-[11px] font-semibold text-rose-400 hover:text-rose-300 underline cursor-pointer"
                >
                  Cancelar login Google
                </button>
              </div>
            )}

            <div className="relative my-4 flex items-center justify-center">
              <div className="border-t border-nexus-border/80 w-full absolute" />
              <span className="bg-nexus-surface px-3 text-[10px] font-medium text-nexus-muted relative uppercase tracking-wider">
                ou com credenciais NEXUS
              </span>
            </div>
          </div>

          {tab === 'login' ? (
            <form onSubmit={handleLoginSubmit} className="space-y-3.5">
              <div>
                <label className="block text-[11px] font-medium text-nexus-muted mb-1.5">
                  Usuário ou E-mail
                </label>
                <div className="relative">
                  <User className="w-4 h-4 absolute left-3 top-2.5 text-nexus-muted pointer-events-none" />
                  <input
                    type="text"
                    required
                    value={loginInput}
                    onChange={(e) => setLoginInput(e.target.value)}
                    placeholder="ex: alice ou alice@nexus.chat"
                    autoFocus
                    className="w-full bg-nexus-panel text-nexus-text text-xs pl-9 pr-3 py-2 rounded-xl border border-nexus-border hover:border-nexus-muted/50 focus:border-nexus-accent focus:outline-none transition-colors"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-nexus-muted mb-1.5">
                  Senha
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 absolute left-3 top-2.5 text-nexus-muted pointer-events-none" />
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="w-full bg-nexus-panel text-nexus-text text-xs pl-9 pr-3 py-2 rounded-xl border border-nexus-border hover:border-nexus-muted/50 focus:border-nexus-accent focus:outline-none transition-colors"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading || isGoogleLoading}
                className="w-full mt-2 py-2.5 px-4 rounded-xl bg-nexus-accent hover:bg-nexus-accent-hover active:scale-[0.99] text-white text-xs font-bold shadow-md shadow-nexus-accent/20 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Autenticando...</span>
                  </>
                ) : (
                  <>
                    <Shield className="w-3.5 h-3.5" />
                    <span>Entrar no NEXUS</span>
                  </>
                )}
              </button>
            </form>
          ) : (
            <form onSubmit={handleRegisterSubmit} className="space-y-3">
              <div>
                <label className="block text-[11px] font-medium text-nexus-muted mb-1">
                  Nome de Usuário (único)
                </label>
                <div className="relative">
                  <User className="w-4 h-4 absolute left-3 top-2.5 text-nexus-muted pointer-events-none" />
                  <input
                    type="text"
                    required
                    value={regUsername}
                    onChange={(e) => setRegUsername(e.target.value)}
                    placeholder="ex: cyber_ninja"
                    className="w-full bg-nexus-panel text-nexus-text text-xs pl-9 pr-3 py-2 rounded-xl border border-nexus-border hover:border-nexus-muted/50 focus:border-nexus-accent focus:outline-none transition-colors"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-nexus-muted mb-1">
                  E-mail
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 absolute left-3 top-2.5 text-nexus-muted pointer-events-none" />
                  <input
                    type="email"
                    required
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    placeholder="voce@exemplo.com"
                    className="w-full bg-nexus-panel text-nexus-text text-xs pl-9 pr-3 py-2 rounded-xl border border-nexus-border hover:border-nexus-muted/50 focus:border-nexus-accent focus:outline-none transition-colors"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-nexus-muted mb-1">
                  Nome de Exibição (opcional)
                </label>
                <div className="relative">
                  <Sparkles className="w-4 h-4 absolute left-3 top-2.5 text-nexus-muted pointer-events-none" />
                  <input
                    type="text"
                    value={regDisplayName}
                    onChange={(e) => setRegDisplayName(e.target.value)}
                    placeholder="Como amigos verão você"
                    className="w-full bg-nexus-panel text-nexus-text text-xs pl-9 pr-3 py-2 rounded-xl border border-nexus-border hover:border-nexus-muted/50 focus:border-nexus-accent focus:outline-none transition-colors"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-medium text-nexus-muted mb-1">
                    Senha (mín. 8)
                  </label>
                  <input
                    type="password"
                    required
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full bg-nexus-panel text-nexus-text text-xs px-3 py-2 rounded-xl border border-nexus-border hover:border-nexus-muted/50 focus:border-nexus-accent focus:outline-none transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-nexus-muted mb-1">
                    Confirmar Senha
                  </label>
                  <input
                    type="password"
                    required
                    value={regConfirmPassword}
                    onChange={(e) => setRegConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full bg-nexus-panel text-nexus-text text-xs px-3 py-2 rounded-xl border border-nexus-border hover:border-nexus-muted/50 focus:border-nexus-accent focus:outline-none transition-colors"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading || isGoogleLoading}
                className="w-full mt-2 py-2.5 px-4 rounded-xl bg-nexus-accent hover:bg-nexus-accent-hover active:scale-[0.99] text-white text-xs font-bold shadow-md shadow-nexus-accent/20 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Criando conta...</span>
                  </>
                ) : (
                  <>
                    <Shield className="w-3.5 h-3.5" />
                    <span>Cadastrar Conta</span>
                  </>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
