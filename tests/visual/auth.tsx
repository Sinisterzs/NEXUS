// Local Vite-only visual fixture. Not an application entry point or a real sign-in.
// No backend requests, saved credentials, accounts or sessions are created here.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AuthView } from '../../src/features/auth/AuthView';
import { AuthModal } from '../../src/features/auth/AuthModal';
import { useAppStore } from '../../src/stores/useAppStore';
import { authRepository } from '../../src/repositories/AuthRepository';
import '../../src/styles/index.css';

const params = new URLSearchParams(location.search);
const outcome = params.get('outcome') || 'network';
const calls: { action: string; login?: string; username?: string; email?: string; displayName?: string; passwordLength?: number }[] = [];
const publish = () => {
  const output = document.getElementById('fixture-calls');
  if (output) output.textContent = JSON.stringify(calls);
};
const complete = async (action: string) => {
  await new Promise((resolve) => setTimeout(resolve, outcome === 'loading' ? 30000 : 450));
  if (outcome !== 'success') throw new Error('NETWORK_ERROR: Não foi possível conectar ao servidor. Tente novamente.');
  return action;
};
authRepository.takePendingResetToken = async () => params.get('token') || null;
authRepository.onDeepLinkResetToken = async () => () => {};
authRepository.requestPasswordReset = async () => {
  calls.push({ action: 'forgot' }); publish(); await complete('forgot'); return 'Solicitação recebida.';
};
authRepository.confirmPasswordReset = async () => {
  calls.push({ action: 'reset' }); publish(); await complete('reset'); return 'Senha redefinida.';
};
useAppStore.setState({
  authError: null, isGoogleLoading: false,
  loginOnline: async (login, password) => {
    calls.push({ action: 'login', login, passwordLength: password.length }); publish();
    await complete('login'); return true;
  },
  registerOnline: async (username, email, password, displayName) => {
    calls.push({ action: 'register', username, email, displayName, passwordLength: password.length }); publish();
    await complete('register'); return true;
  },
  loginGoogle: async () => {
    calls.push({ action: 'google' }); publish(); useAppStore.setState({ isGoogleLoading: true });
    try { await complete('google'); return true; }
    finally { useAppStore.setState({ isGoogleLoading: false }); }
  },
  cancelGoogleLogin: () => { useAppStore.setState({ isGoogleLoading: false, authError: null }); },
});

function Fixture() {
  const [open, setOpen] = React.useState(true);
  return <>
    {params.get('surface') === 'modal'
      ? <div style={{ background: '#090a0f', height: '100vh' }}>{!open && <button type="button" onClick={() => setOpen(true)}>Reabrir modal (simulação)</button>}<AuthModal isOpen={open} onClose={() => setOpen(false)} /></div>
      : <AuthView />}
    <output id="fixture-calls" hidden aria-hidden="true">[]</output>
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
