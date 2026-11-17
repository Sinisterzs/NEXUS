import { WindowControls } from '../../components/WindowControls';
import { APP_VERSION } from '../../version';
import { AuthPanel } from './AuthPanel';
import { NexusMark } from './AuthPrimitives';

export const AuthView = () => <div className="auth-ui auth-window">
  <header className="auth-titlebar" data-tauri-drag-region>
    <div className="auth-titlebar-brand"><NexusMark /><strong>NEXUS</strong><span className="auth-version">v{APP_VERSION}</span></div>
    <WindowControls />
  </header>
  <main className="auth-stage"><AuthPanel /></main>
</div>;
