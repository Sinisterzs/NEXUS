import { DiagnosticsRuntime } from './components/DiagnosticsRuntime';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app/App';
import './styles/index.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
    <DiagnosticsRuntime />
  </React.StrictMode>
);
