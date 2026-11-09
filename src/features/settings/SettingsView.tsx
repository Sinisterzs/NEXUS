import React, { useState, useEffect, useRef } from 'react';
import {
  User,
  Palette,
  Volume2,
  Bell,
  Lock,
  Check,
  Camera,
  Mic,
  Shield,
  LogIn,
  LogOut,
  Save,
  Loader2,
  Network,
  Server,
  ExternalLink,
  RefreshCw,
  Info,
  Sparkles,
  Download,
  Copy,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  FlaskConical,
} from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { networkManager } from '../../services/NetworkManager';
import { updateService, UpdateState } from '../../services/UpdateService';
import { audioDeviceService, AudioDeviceInfo } from '../../services/AudioDeviceService';
import { callService } from '../../services/CallService';
import { Avatar } from '../../components/Avatar';
import { APP_VERSION } from '../../version';

type SettingsSection = 'profile' | 'appearance' | 'audioVideo' | 'notifications' | 'privacy' | 'network' | 'about';

export const SettingsView: React.FC = () => {
  const [activeSection, setActiveSection] = useState<SettingsSection>('profile');
  const [saveBanner, setSaveBanner] = useState(false);
  const [googleStatusMsg, setGoogleStatusMsg] = useState<{ text: string; isError: boolean } | null>(null);
  const [isGoogleProcessing, setIsGoogleProcessing] = useState(false);

  // Zustand state and updates
  const settings = useAppStore((state) => state.settings);
  const currentUser = useAppStore((state) => state.currentUser);
  const authMode = useAppStore((state) => state.authMode);
  const onlineUser = useAppStore((state) => state.onlineUser);
  const openAuthModal = useAppStore((state) => state.openAuthModal);
  const logoutOnline = useAppStore((state) => state.logoutOnline);
  const linkGoogle = useAppStore((state) => state.linkGoogle);
  const unlinkGoogle = useAppStore((state) => state.unlinkGoogle);
  const updateProfile = useAppStore((state) => state.updateProfile);
  const saveProfile = useAppStore((state) => state.saveProfile);
  const updateAppearance = useAppStore((state) => state.updateAppearance);
  const updateAudioVideo = useAppStore((state) => state.updateAudioVideo);
  const updateNotifications = useAppStore((state) => state.updateNotifications);
  const updatePrivacy = useAppStore((state) => state.updatePrivacy);
  const networkStatus = useAppStore((state) => state.networkStatus);
  const checkNetwork = useAppStore((state) => state.checkNetwork);
  const openTailscale = useAppStore((state) => state.openTailscale);
  const setServerAddress = useAppStore((state) => state.setServerAddress);
  const updateChannel = useAppStore((state) => state.updateChannel);
  const setUpdateChannel = useAppStore((state) => state.setUpdateChannel);

  // Network form state
  const [serverAddressInput, setServerAddressInput] = useState(networkStatus.server_url);
  const [isTestingServer, setIsTestingServer] = useState(false);
  const [networkTestFeedback, setNetworkTestFeedback] = useState<{ text: string; isError: boolean } | null>(null);
  const [copiedServerId, setCopiedServerId] = useState(false);
  const [showBetaConfirmModal, setShowBetaConfirmModal] = useState(false);

  const handleCopyServerId = (id: string) => {
    if (!id) return;
    navigator.clipboard.writeText(id);
    setCopiedServerId(true);
    setTimeout(() => setCopiedServerId(false), 2000);
  };

  useEffect(() => {
    setServerAddressInput(networkStatus.server_url);
  }, [networkStatus.server_url]);

  // Updater state
  const [updateState, setUpdateState] = useState<UpdateState>(updateService.getState());

  useEffect(() => {
    return updateService.addListener((newState) => {
      setUpdateState(newState);
    });
  }, []);

  // Real Audio Devices State
  const [inputDevices, setInputDevices] = useState<AudioDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDeviceInfo[]>([]);
  const [isTestingMic, setIsTestingMic] = useState(false);
  const [micVolumeLevel, setMicVolumeLevel] = useState(0);

  useEffect(() => {
    async function loadAudioDevices() {
      const dev = await audioDeviceService.getAvailableDevices();
      setInputDevices(dev.inputs);
      setOutputDevices(dev.outputs);
    }

    loadAudioDevices();
    const unsubscribe = audioDeviceService.onDeviceChange((dev) => {
      setInputDevices(dev.inputs);
      setOutputDevices(dev.outputs);
    });

    return () => unsubscribe();
  }, []);

  // Real-time Mic Testing with Native DSP & Audio Return Monitor
  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let interval: any = null;
    let monitorAudio: HTMLAudioElement | null = null;

    if (isTestingMic && activeSection === 'audioVideo') {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const deviceId = settings.audioVideo.inputDevice;
      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId: deviceId && deviceId !== 'default' ? { ideal: deviceId } : undefined,
          echoCancellation: Boolean(settings.audioVideo.echoCancellation),
          noiseSuppression: Boolean(settings.audioVideo.noiseSuppression),
          autoGainControl: true,
        },
        video: false,
      };

      const acquireTestStream = async (): Promise<MediaStream> => {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('call_set_mic_consent', { granted: true }).catch(() => {});
        } catch {}

        try {
          return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
          console.warn('[SettingsView] Falha ao testar mic com ideal deviceId, tentando fallback sem ID:', err);
          try {
            return await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: Boolean(settings.audioVideo.echoCancellation),
                noiseSuppression: Boolean(settings.audioVideo.noiseSuppression),
                autoGainControl: true,
              },
              video: false,
            });
          } catch (fallbackErr) {
            console.warn('[SettingsView] Falha no fallback com DSP, tentando áudio padrão:', fallbackErr);
            return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          }
        }
      };

      acquireTestStream()
        .then((s) => {
          if (cancelled) {
            s.getTracks().forEach((t) => {
              try {
                t.stop();
              } catch {}
            });
            return;
          }
          stream = s;

          // 1. Audio return/loopback: allows user to hear their own voice through the selected output
          let htmlMonitorOk = false;
          try {
            monitorAudio = new Audio();
            monitorAudio.srcObject = s;
            monitorAudio.volume = Math.max(0, Math.min(1, (settings.audioVideo.outputVolume ?? 100) / 100));
            if (
              typeof (monitorAudio as any).setSinkId === 'function' &&
              settings.audioVideo.outputDevice &&
              settings.audioVideo.outputDevice !== 'default'
            ) {
              (monitorAudio as any).setSinkId(settings.audioVideo.outputDevice).catch(() => {});
            }
            monitorAudio.play().catch(() => {});
            htmlMonitorOk = true;
          } catch (audioErr) {
            console.warn('[SettingsView] Falha ao iniciar retorno de áudio:', audioErr);
          }

          if (!AudioCtx) return;
          audioCtx = new AudioCtx();
          const src = audioCtx.createMediaStreamSource(s);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 256;
          src.connect(analyser);

          // Web Audio destination fallback ONLY if HTMLAudioElement failed
          if (!htmlMonitorOk) {
            try {
              const gainNode = audioCtx.createGain();
              gainNode.gain.value = Math.max(0, Math.min(1, (settings.audioVideo.outputVolume ?? 100) / 100));
              src.connect(gainNode);
              gainNode.connect(audioCtx.destination);
            } catch {}
          }

          const dataArray = new Uint8Array(128);
          interval = setInterval(() => {
            analyser.getByteFrequencyData(dataArray);
            const sum = dataArray.reduce((acc, val) => acc + val, 0);
            const avg = sum / dataArray.length;
            setMicVolumeLevel(Math.min(100, Math.round((avg / 60) * 100)));
          }, 50);
        })
        .catch((err) => {
          console.warn('[SettingsView] Falha ao testar microfone:', err);
          if (!cancelled) {
            setIsTestingMic(false);
          }
        });
    } else {
      setMicVolumeLevel(0);
    }

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      if (monitorAudio) {
        try {
          monitorAudio.pause();
        } catch {}
        monitorAudio.srcObject = null;
      }
      if (stream) {
        stream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {}
        });
      }
      if (audioCtx) (audioCtx as AudioContext).close().catch(() => {});
      if (useAppStore.getState().voiceCallState === 'idle') {
        import('@tauri-apps/api/core')
          .then(({ invoke }) => invoke('call_set_mic_consent', { granted: false }).catch(() => {}))
          .catch(() => {});
      }
    };
  }, [
    isTestingMic,
    activeSection,
    settings.audioVideo.inputDevice,
    settings.audioVideo.outputDevice,
    settings.audioVideo.outputVolume,
    settings.audioVideo.noiseSuppression,
    settings.audioVideo.echoCancellation,
  ]);

  // Profile form local state (prevents premature unpersisted state in Zustand)
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [profileForm, setProfileForm] = useState({
    displayName: settings.profile.displayName,
    username: settings.profile.username,
    customStatus: settings.profile.customStatus,
    bio: settings.profile.bio,
    avatarUrl: settings.profile.avatarUrl || currentUser.avatarUrl,
  });
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [profileFeedback, setProfileFeedback] = useState<{ text: string; isError: boolean } | null>(null);

  useEffect(() => {
    setProfileForm({
      displayName: settings.profile.displayName,
      username: settings.profile.username,
      customStatus: settings.profile.customStatus,
      bio: settings.profile.bio,
      avatarUrl: settings.profile.avatarUrl || currentUser.avatarUrl,
    });
  }, [
    settings.profile.displayName,
    settings.profile.username,
    settings.profile.customStatus,
    settings.profile.bio,
    settings.profile.avatarUrl,
    currentUser.avatarUrl,
  ]);

  const hasProfileChanges =
    profileForm.displayName !== settings.profile.displayName ||
    profileForm.username !== settings.profile.username ||
    profileForm.customStatus !== settings.profile.customStatus ||
    profileForm.bio !== settings.profile.bio ||
    profileForm.avatarUrl !== (settings.profile.avatarUrl || currentUser.avatarUrl);

  const showSaveSuccess = () => {
    setSaveBanner(true);
    setTimeout(() => setSaveBanner(false), 2000);
  };

  const handleAvatarFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      setProfileFeedback({ text: 'A imagem deve ter no máximo 5MB.', isError: true });
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      if (dataUrl) {
        setProfileForm((prev) => ({ ...prev, avatarUrl: dataUrl }));
        updateProfile({ avatarUrl: dataUrl });
        saveProfile({ avatarUrl: dataUrl });
        showSaveSuccess();
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSaveProfile = async () => {
    if (!hasProfileChanges || isSavingProfile) return;
    setIsSavingProfile(true);
    setProfileFeedback(null);
    try {
      await saveProfile(profileForm);
      setProfileFeedback({ text: 'Perfil salvo com sucesso!', isError: false });
      setTimeout(() => setProfileFeedback(null), 3500);
    } catch (err: any) {
      setProfileFeedback({
        text: err?.message || 'Falha ao salvar perfil.',
        isError: true,
      });
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleDiscardProfile = () => {
    setProfileForm({
      displayName: settings.profile.displayName,
      username: settings.profile.username,
      customStatus: settings.profile.customStatus,
      bio: settings.profile.bio,
      avatarUrl: settings.profile.avatarUrl || currentUser.avatarUrl,
    });
    setProfileFeedback(null);
  };

  const handleLinkGoogle = async () => {
    setIsGoogleProcessing(true);
    setGoogleStatusMsg(null);
    try {
      const msg = await linkGoogle();
      setGoogleStatusMsg({ text: msg || 'Conta Google vinculada com sucesso!', isError: false });
    } catch (err: any) {
      setGoogleStatusMsg({ text: err?.message || 'Falha ao vincular conta Google.', isError: true });
    } finally {
      setIsGoogleProcessing(false);
    }
  };

  const handleUnlinkGoogle = async () => {
    if (!onlineUser?.hasPassword) {
      setGoogleStatusMsg({
        text: 'Não é possível desvincular o Google pois é seu único método de acesso. Defina uma senha antes de desvincular.',
        isError: true,
      });
      return;
    }

    if (!window.confirm('Tem certeza de que deseja desvincular sua conta Google deste perfil NEXUS?')) {
      return;
    }

    setIsGoogleProcessing(true);
    setGoogleStatusMsg(null);
    try {
      await unlinkGoogle();
      setGoogleStatusMsg({ text: 'Conta Google desvinculada com sucesso.', isError: false });
    } catch (err: any) {
      setGoogleStatusMsg({ text: err?.message || 'Falha ao desvincular conta Google.', isError: true });
    } finally {
      setIsGoogleProcessing(false);
    }
  };

  return (
    <div className="flex-1 flex overflow-hidden select-none">
      {/* Settings Sections Sidebar */}
      <div className="w-56 bg-nexus-surface border-r border-nexus-border flex flex-col p-3 shrink-0">
        <h3 className="text-xs font-bold text-nexus-muted uppercase tracking-wider px-2 py-1 mb-2">
          Painel de Preferências
        </h3>

        <nav className="space-y-1">
          <button
            onClick={() => setActiveSection('profile')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-left transition-nexus ${
              activeSection === 'profile'
                ? 'bg-nexus-panel text-white font-medium border-l-2 border-nexus-accent'
                : 'text-nexus-muted hover:bg-nexus-panel/50 hover:text-nexus-text'
            }`}
          >
            <User className="w-4 h-4" />
            <span>Perfil de Usuário</span>
          </button>

          <button
            onClick={() => setActiveSection('appearance')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-left transition-nexus ${
              activeSection === 'appearance'
                ? 'bg-nexus-panel text-white font-medium border-l-2 border-nexus-accent'
                : 'text-nexus-muted hover:bg-nexus-panel/50 hover:text-nexus-text'
            }`}
          >
            <Palette className="w-4 h-4" />
            <span>Aparência & Tema</span>
          </button>

          <button
            onClick={() => setActiveSection('audioVideo')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-left transition-nexus ${
              activeSection === 'audioVideo'
                ? 'bg-nexus-panel text-white font-medium border-l-2 border-nexus-accent'
                : 'text-nexus-muted hover:bg-nexus-panel/50 hover:text-nexus-text'
            }`}
          >
            <Volume2 className="w-4 h-4" />
            <span>Áudio & Vídeo</span>
          </button>

          <button
            onClick={() => setActiveSection('notifications')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-left transition-nexus ${
              activeSection === 'notifications'
                ? 'bg-nexus-panel text-white font-medium border-l-2 border-nexus-accent'
                : 'text-nexus-muted hover:bg-nexus-panel/50 hover:text-nexus-text'
            }`}
          >
            <Bell className="w-4 h-4" />
            <span>Notificações</span>
          </button>

          <button
            onClick={() => setActiveSection('privacy')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-left transition-nexus ${
              activeSection === 'privacy'
                ? 'bg-nexus-panel text-white font-medium border-l-2 border-nexus-accent'
                : 'text-nexus-muted hover:bg-nexus-panel/50 hover:text-nexus-text'
            }`}
          >
            <Lock className="w-4 h-4" />
            <span>Privacidade & Segurança</span>
          </button>

          <button
            onClick={() => setActiveSection('network')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-left transition-nexus ${
              activeSection === 'network'
                ? 'bg-nexus-panel text-white font-medium border-l-2 border-nexus-accent'
                : 'text-nexus-muted hover:bg-nexus-panel/50 hover:text-nexus-text'
            }`}
          >
            <Network className="w-4 h-4" />
            <span>Rede Privada (Tailscale)</span>
          </button>

          <div className="pt-2 mt-2 border-t border-nexus-border/50">
            <button
              onClick={() => setActiveSection('about')}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-left transition-nexus cursor-pointer ${
                activeSection === 'about'
                  ? 'bg-nexus-panel text-white font-medium border-l-2 border-nexus-accent'
                  : 'text-nexus-muted hover:bg-nexus-panel/50 hover:text-nexus-text'
              }`}
            >
              <Info className="w-4 h-4" />
              <span>Sobre & Atualizações</span>
            </button>
          </div>
        </nav>
      </div>

      {/* Main Settings Content Area */}
      <div className="flex-1 overflow-y-auto p-6 max-w-3xl space-y-6">
        {/* Feedback Alert for local session update */}
        {saveBanner && (
          <div className="flex items-center gap-2 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-xs text-emerald-400">
            <Check className="w-4 h-4" />
            <span>Preferências atualizadas localmente para a sessão ativa!</span>
          </div>
        )}

        {/* 1. SEÇÃO PERFIL */}
        {activeSection === 'profile' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-base font-bold text-nexus-text">Perfil do Usuário</h2>
              <p className="text-xs text-nexus-muted">
                Personalize como sua identidade aparece para seus amigos e comunidades.
              </p>
            </div>

            {/* Profile Card Preview */}
            <div className="bg-nexus-surface border border-nexus-border rounded-xl p-5 relative overflow-hidden">
              <div className="h-16 bg-gradient-to-r from-nexus-panel via-nexus-surface to-nexus-panel border-b border-nexus-border -m-5 mb-4 px-5 flex items-center justify-end">
                <span className="text-[10px] font-mono text-nexus-muted px-2 py-0.5 rounded bg-nexus-surface/80 border border-nexus-border">
                  Visualização do Perfil
                </span>
              </div>

              <div className="flex items-start gap-4">
                <div className="relative">
                  <Avatar
                    name={currentUser.displayName}
                    avatarUrl={profileForm.avatarUrl || currentUser.avatarUrl}
                    status={currentUser.status}
                    size="xl"
                  />
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleAvatarFileChange}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => avatarInputRef.current?.click()}
                    title="Alterar foto de perfil"
                    className="absolute -bottom-1 -right-1 p-1.5 rounded-full bg-nexus-panel border border-nexus-border text-nexus-muted hover:text-nexus-text hover:bg-nexus-surface transition-nexus cursor-pointer shadow-sm"
                  >
                    <Camera className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold text-nexus-text">
                      {profileForm.displayName || 'Sem nome'}
                    </h3>
                    {authMode === 'authenticated' ? (
                      <span className="text-xs font-mono text-nexus-muted">
                        @{profileForm.username}
                      </span>
                    ) : (
                      settings.profile.tag && (
                        <span className="text-xs font-mono text-nexus-muted">
                          {settings.profile.tag}
                        </span>
                      )
                    )}
                  </div>
                  <p className="text-xs text-nexus-accent font-medium">
                    {profileForm.customStatus || 'Disponível no NEXUS'}
                  </p>
                  <p className="text-xs text-nexus-muted pt-1 leading-relaxed">
                    {profileForm.bio || 'Sem biografia informada.'}
                  </p>
                </div>
              </div>
            </div>

            {/* Online Account Card */}
            <div className="bg-nexus-panel/60 border border-nexus-border rounded-xl p-4 flex flex-col gap-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-nexus-surface border border-nexus-border">
                    <Shield className="w-5 h-5 text-nexus-accent" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-nexus-text">Conta NEXUS Online</span>
                      {authMode === 'authenticated' && onlineUser ? (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                          Conectado
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-amber-500/20 text-amber-300 border border-amber-500/30">
                          Modo Demonstração (SQLite Local)
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-nexus-muted mt-0.5">
                      {authMode === 'authenticated' && onlineUser
                        ? `Conectado como @${onlineUser.username} (${onlineUser.email})`
                        : 'Você está utilizando o armazenamento e contatos locais da máquina.'}
                    </p>
                  </div>
                </div>

                <div>
                  {authMode === 'authenticated' ? (
                    <button
                      onClick={() => logoutOnline()}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-nexus-surface hover:bg-rose-500/20 border border-nexus-border hover:border-rose-500/40 text-xs font-semibold text-rose-300 transition-colors cursor-pointer"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      <span>Desconectar Sessão</span>
                    </button>
                  ) : (
                    <button
                      onClick={openAuthModal}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-nexus-accent hover:bg-rose-700 text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer"
                    >
                      <LogIn className="w-3.5 h-3.5" />
                      <span>Conectar Conta Online</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Linked Accounts (Google Sign-In) */}
              {authMode === 'authenticated' && onlineUser && (
                <div className="mt-2 pt-3 border-t border-nexus-border/60 flex flex-col gap-2">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg bg-nexus-surface border border-nexus-border flex items-center justify-center shrink-0">
                        <svg className="w-4 h-4" viewBox="0 0 24 24">
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
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-nexus-text">Vínculo Google</span>
                          {onlineUser.hasGoogle ? (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                              Google conectado
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-zinc-500/20 text-zinc-400 border border-zinc-500/30 flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-zinc-500"></span>
                              Google não conectado
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-nexus-muted">
                          {onlineUser.hasGoogle
                            ? 'Você pode usar sua conta Google para entrar no Nexus.'
                            : 'Vincule sua conta Google para entrar com mais facilidade.'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {onlineUser.hasGoogle ? (
                        <button
                          type="button"
                          onClick={handleUnlinkGoogle}
                          disabled={isGoogleProcessing}
                          title={
                            !onlineUser.hasPassword
                              ? 'Você não pode desvincular seu único método de login'
                              : 'Desvincular conta Google'
                          }
                          className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer disabled:opacity-50 ${
                            !onlineUser.hasPassword
                              ? 'bg-nexus-surface border-nexus-border text-nexus-muted cursor-not-allowed opacity-60'
                              : 'bg-nexus-surface hover:bg-rose-500/20 border-nexus-border hover:border-rose-500/30 text-rose-300'
                          }`}
                        >
                          {isGoogleProcessing ? 'Processando...' : 'Desvincular'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={handleLinkGoogle}
                          disabled={isGoogleProcessing}
                          className="px-2.5 py-1.5 rounded-lg bg-nexus-surface hover:bg-nexus-panel border border-nexus-border text-xs font-medium text-nexus-text hover:text-white transition-colors cursor-pointer disabled:opacity-50"
                        >
                          {isGoogleProcessing ? 'Aguardando navegador...' : 'Vincular Google'}
                        </button>
                      )}
                    </div>
                  </div>

                  {googleStatusMsg && (
                    <div
                      className={`text-xs p-2 rounded border mt-1 ${
                        googleStatusMsg.isError
                          ? 'bg-rose-500/10 border-rose-500/20 text-rose-300'
                          : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
                      }`}
                    >
                      {googleStatusMsg.text}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Profile Edit Fields */}
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-nexus-text block mb-1">
                    Nome de Exibição
                  </label>
                  <input
                    type="text"
                    value={profileForm.displayName}
                    onChange={(e) => {
                      setProfileForm((prev) => ({ ...prev, displayName: e.target.value }));
                      setProfileFeedback(null);
                    }}
                    placeholder="Seu nome de exibição"
                    className="w-full bg-nexus-surface border border-nexus-border rounded-lg p-2 text-xs text-nexus-text focus:border-nexus-accent focus:outline-none"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-nexus-text block mb-1">
                    Nome de Usuário (Identificador)
                  </label>
                  <input
                    type="text"
                    value={profileForm.username}
                    onChange={(e) => {
                      setProfileForm((prev) => ({ ...prev, username: e.target.value }));
                      setProfileFeedback(null);
                    }}
                    placeholder="username_unico"
                    className="w-full bg-nexus-surface border border-nexus-border rounded-lg p-2 text-xs text-nexus-text focus:border-nexus-accent focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-nexus-text block mb-1">
                  Status Personalizado
                </label>
                <input
                  type="text"
                  value={profileForm.customStatus}
                  onChange={(e) => {
                    setProfileForm((prev) => ({ ...prev, customStatus: e.target.value }));
                    setProfileFeedback(null);
                  }}
                  placeholder="Ex: Em call de projeto"
                  className="w-full bg-nexus-surface border border-nexus-border rounded-lg p-2 text-xs text-nexus-text focus:border-nexus-accent focus:outline-none"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-nexus-text block mb-1">
                  Biografia
                </label>
                <textarea
                  rows={3}
                  value={profileForm.bio}
                  onChange={(e) => {
                    setProfileForm((prev) => ({ ...prev, bio: e.target.value }));
                    setProfileFeedback(null);
                  }}
                  placeholder="Conte um pouco sobre você..."
                  className="w-full bg-nexus-surface border border-nexus-border rounded-lg p-2 text-xs text-nexus-text focus:border-nexus-accent focus:outline-none resize-none"
                />
              </div>

              {/* Action Buttons for Profile Saving */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-nexus-border/60">
                <div className="min-h-[20px]">
                  {profileFeedback && (
                    <span
                      className={`text-xs font-medium ${
                        profileFeedback.isError ? 'text-rose-400' : 'text-emerald-400'
                      }`}
                    >
                      {profileFeedback.text}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 self-end sm:self-auto">
                  {hasProfileChanges && (
                    <button
                      type="button"
                      disabled={isSavingProfile}
                      onClick={handleDiscardProfile}
                      className="px-3 py-1.5 rounded-lg bg-nexus-surface hover:bg-nexus-panel border border-nexus-border text-xs font-medium text-nexus-muted hover:text-nexus-text transition-colors cursor-pointer"
                    >
                      Descartar
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={!hasProfileChanges || isSavingProfile}
                    onClick={handleSaveProfile}
                    className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-nexus-accent hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-semibold text-white shadow-sm transition-colors cursor-pointer"
                  >
                    {isSavingProfile ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Salvando...</span>
                      </>
                    ) : (
                      <>
                        <Save className="w-3.5 h-3.5" />
                        <span>Salvar Alterações</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 2. SEÇÃO APARÊNCIA */}
        {activeSection === 'appearance' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-base font-bold text-nexus-text">Aparência & Interface</h2>
              <p className="text-xs text-nexus-muted">
                Configurações visuais inspiradas na Steam e no Opera GX.
              </p>
            </div>

            {/* Theme Presets */}
            <div>
              <label className="text-xs font-semibold text-nexus-text block mb-3">
                Esquema de Cores Primário
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[
                  { id: 'nexus-dark', name: 'NEXUS Dark', desc: 'Preto & Grafite com Destaque Carmim', border: '#B8495A' },
                  { id: 'midnight-black', name: 'Midnight Steam', desc: 'Preto Puro (#0c0d10) para OLED', border: '#353943' },
                  { id: 'cyber-slate', name: 'Cyber Slate', desc: 'Grafite Frio com Acentos Opera GX', border: '#353943' },
                ].map((theme) => {
                  const isSelected = settings.appearance.theme === theme.id;
                  return (
                    <div
                      key={theme.id}
                      onClick={() => {
                        updateAppearance({ theme: theme.id as any });
                        showSaveSuccess();
                      }}
                      className={`p-3.5 rounded-xl bg-nexus-surface border cursor-pointer transition-nexus ${
                        isSelected
                          ? 'border-nexus-accent ring-1 ring-nexus-accent/50'
                          : 'border-nexus-border hover:border-nexus-border-light'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-bold text-nexus-text">{theme.name}</span>
                        {isSelected && <Check className="w-3.5 h-3.5 text-nexus-accent" />}
                      </div>
                      <p className="text-[11px] text-nexus-muted">{theme.desc}</p>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Compact Mode Toggle */}
            <div className="space-y-3">
              <label className="flex items-center justify-between p-3.5 rounded-xl bg-nexus-surface border border-nexus-border cursor-pointer hover:border-nexus-border-light transition-nexus">
                <div>
                  <p className="text-xs font-semibold text-nexus-text">Modo Compacto de Mensagens</p>
                  <p className="text-[11px] text-nexus-muted">
                    Reduz o espaçamento vertical entre mensagens consecutivas para maior densidade.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={settings.appearance.compactMode}
                  onChange={(e) => {
                    updateAppearance({ compactMode: e.target.checked });
                    showSaveSuccess();
                  }}
                  className="rounded border-nexus-border accent-nexus-accent h-4 w-4"
                />
              </label>

              {/* Font Size Selector */}
              <div className="p-3.5 rounded-xl bg-nexus-surface border border-nexus-border flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold text-nexus-text">Escala de Tipografia</p>
                  <p className="text-[11px] text-nexus-muted">Tamanho base dos textos e mensagens.</p>
                </div>
                <div className="flex items-center gap-1.5">
                  {(['sm', 'base', 'lg'] as const).map((size) => (
                    <button
                      key={size}
                      onClick={() => {
                        updateAppearance({ fontSize: size });
                        showSaveSuccess();
                      }}
                      className={`px-3 py-1 text-xs rounded border transition-nexus ${
                        settings.appearance.fontSize === size
                          ? 'bg-nexus-panel text-nexus-accent border-nexus-accent font-bold'
                          : 'bg-nexus-bg text-nexus-muted border-nexus-border hover:text-nexus-text'
                      }`}
                    >
                      {size.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 3. SEÇÃO ÁUDIO & VÍDEO */}
        {activeSection === 'audioVideo' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-base font-bold text-nexus-text">Áudio & Vídeo</h2>
              <p className="text-xs text-nexus-muted">
                Configuração dos periféricos de comunicação por voz de baixa latência.
              </p>
            </div>

            <div className="space-y-4">
              {/* Microfone Input */}
              <div className="p-4 rounded-xl bg-nexus-surface border border-nexus-border space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Mic className="w-4 h-4 text-nexus-accent" />
                    <span className="text-xs font-semibold text-nexus-text">Dispositivo de Entrada (Microfone)</span>
                  </div>
                  <button
                    onClick={() => setIsTestingMic(!isTestingMic)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-nexus cursor-pointer ${
                      isTestingMic
                        ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                        : 'bg-nexus-panel hover:bg-nexus-border text-nexus-text'
                    }`}
                  >
                    {isTestingMic ? 'Parar Teste' : 'Testar Microfone'}
                  </button>
                </div>

                <select
                  value={settings.audioVideo.inputDevice}
                  onChange={(e) => {
                    const devId = e.target.value;
                    updateAudioVideo({ inputDevice: devId });
                    callService.switchInputDevice(devId);
                    showSaveSuccess();
                  }}
                  className="w-full bg-nexus-bg border border-nexus-border rounded-lg p-2 text-xs text-nexus-text focus:outline-none cursor-pointer"
                >
                  <option value="default">Microfone Padrão do Sistema</option>
                  {inputDevices
                    .filter((d) => d.deviceId !== 'default')
                    .map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label}
                      </option>
                    ))}
                </select>

                {/* Input Sensitivity Slider & Live meter */}
                <div>
                  <div className="flex justify-between text-[11px] text-nexus-muted mb-1">
                    <span>Nível de Captação / Sensibilidade</span>
                    <span className="font-mono text-nexus-text">
                      {isTestingMic ? `${micVolumeLevel}% (Em Teste)` : `${settings.audioVideo.inputSensitivity}%`}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={settings.audioVideo.inputSensitivity}
                    onChange={(e) => {
                      updateAudioVideo({ inputSensitivity: Number(e.target.value) });
                      showSaveSuccess();
                    }}
                    className="w-full accent-nexus-accent cursor-pointer"
                  />
                  {/* Visual live sound level meter */}
                  <div className="h-2 w-full bg-nexus-bg rounded-full overflow-hidden mt-2 flex">
                    <div
                      className={`h-full transition-all duration-75 ${
                        micVolumeLevel > 75
                          ? 'bg-rose-500'
                          : micVolumeLevel > 40
                          ? 'bg-emerald-400'
                          : 'bg-emerald-600'
                      }`}
                      style={{
                        width: isTestingMic
                          ? `${micVolumeLevel}%`
                          : `${settings.audioVideo.inputSensitivity * 0.7}%`,
                      }}
                    />
                  </div>
                  {isTestingMic && (
                    <p className="text-[10px] text-emerald-400 mt-1.5 font-mono animate-pulse">
                      Retorno de áudio ativo: fale ao microfone para ouvir sua voz e testar o cancelamento de ruído em tempo real.
                    </p>
                  )}
                </div>
              </div>

              {/* Headphone Output */}
              <div className="p-4 rounded-xl bg-nexus-surface border border-nexus-border space-y-3">
                <div className="flex items-center gap-2">
                  <Volume2 className="w-4 h-4 text-nexus-accent" />
                  <span className="text-xs font-semibold text-nexus-text">Dispositivo de Saída (Fones / Alto-falantes)</span>
                </div>

                <select
                  value={settings.audioVideo.outputDevice}
                  onChange={(e) => {
                    const devId = e.target.value;
                    updateAudioVideo({ outputDevice: devId });
                    callService.switchOutputDevice(devId);
                    showSaveSuccess();
                  }}
                  className="w-full bg-nexus-bg border border-nexus-border rounded-lg p-2 text-xs text-nexus-text focus:outline-none cursor-pointer"
                >
                  <option value="default">Alto-falantes / Fones Padrão</option>
                  {outputDevices
                    .filter((d) => d.deviceId !== 'default')
                    .map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label}
                      </option>
                    ))}
                </select>

                <div>
                  <div className="flex justify-between text-[11px] text-nexus-muted mb-1">
                    <span>Volume de Saída</span>
                    <span className="font-mono text-nexus-text">{settings.audioVideo.outputVolume}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={settings.audioVideo.outputVolume}
                    onChange={(e) => {
                      updateAudioVideo({ outputVolume: Number(e.target.value) });
                      showSaveSuccess();
                    }}
                    className="w-full accent-nexus-accent cursor-pointer"
                  />
                </div>
              </div>

              {/* Noise Suppression & Echo Cancellation */}
              <div className="space-y-2">
                <label className="flex items-center justify-between p-3 rounded-xl bg-nexus-surface border border-nexus-border cursor-pointer">
                  <div>
                    <p className="text-xs font-semibold text-nexus-text">Supressão de Ruído Nativa (WebRTC DSP)</p>
                    <p className="text-[11px] text-nexus-muted">
                      Filtra ruídos de fundo contínuos (ventiladores, digitação e respiração) diretamente no pipeline Opus.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.audioVideo.noiseSuppression}
                    onChange={(e) => {
                      const next = e.target.checked;
                      updateAudioVideo({ noiseSuppression: next });
                      callService.applyAudioConstraints(next, settings.audioVideo.echoCancellation);
                      showSaveSuccess();
                    }}
                    className="rounded border-nexus-border accent-nexus-accent h-4 w-4 cursor-pointer"
                  />
                </label>

                <label className="flex items-center justify-between p-3 rounded-xl bg-nexus-surface border border-nexus-border cursor-pointer">
                  <div>
                    <p className="text-xs font-semibold text-nexus-text">Cancelamento de Eco Acústico (AEC)</p>
                    <p className="text-[11px] text-nexus-muted">
                      Impede realimentação acústica entre os fones/alto-falantes e o microfone na chamada.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.audioVideo.echoCancellation}
                    onChange={(e) => {
                      const next = e.target.checked;
                      updateAudioVideo({ echoCancellation: next });
                      callService.applyAudioConstraints(settings.audioVideo.noiseSuppression, next);
                      showSaveSuccess();
                    }}
                    className="rounded border-nexus-border accent-nexus-accent h-4 w-4 cursor-pointer"
                  />
                </label>
              </div>
            </div>
          </div>
        )}

        {/* 4. SEÇÃO NOTIFICAÇÕES */}
        {activeSection === 'notifications' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-base font-bold text-nexus-text">Notificações & Sons</h2>
              <p className="text-xs text-nexus-muted">
                Controle alertas sonoros e notificações de área de trabalho do Windows 11.
              </p>
            </div>

            <div className="space-y-3">
              <label className="flex items-center justify-between p-3.5 rounded-xl bg-nexus-surface border border-nexus-border cursor-pointer">
                <div>
                  <p className="text-xs font-semibold text-nexus-text">Notificações da Área de Trabalho</p>
                  <p className="text-[11px] text-nexus-muted">
                    Exibe toasts nativos do Windows quando você receber mensagens diretas.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={settings.notifications.desktopAlerts}
                  onChange={(e) => {
                    updateNotifications({ desktopAlerts: e.target.checked });
                    showSaveSuccess();
                  }}
                  className="rounded border-nexus-border accent-nexus-accent h-4 w-4"
                />
              </label>

              <label className="flex items-center justify-between p-3.5 rounded-xl bg-nexus-surface border border-nexus-border cursor-pointer">
                <div>
                  <p className="text-xs font-semibold text-nexus-text">Efeitos Sonoros Sutis</p>
                  <p className="text-[11px] text-nexus-muted">
                    Sons curtos para entrada/saída de salas de voz e envio de mensagens.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={settings.notifications.soundEffects}
                  onChange={(e) => {
                    updateNotifications({ soundEffects: e.target.checked });
                    showSaveSuccess();
                  }}
                  className="rounded border-nexus-border accent-nexus-accent h-4 w-4"
                />
              </label>

              <label className="flex items-center justify-between p-3.5 rounded-xl bg-nexus-surface border border-nexus-border cursor-pointer">
                <div>
                  <p className="text-xs font-semibold text-nexus-text">Apenas Menções (@)</p>
                  <p className="text-[11px] text-nexus-muted">
                    Silencia notificações em canais de comunidades exceto se você for mencionado.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={settings.notifications.mentionsOnly}
                  onChange={(e) => {
                    updateNotifications({ mentionsOnly: e.target.checked });
                    showSaveSuccess();
                  }}
                  className="rounded border-nexus-border accent-nexus-accent h-4 w-4"
                />
              </label>
            </div>
          </div>
        )}

        {/* 5. SEÇÃO PRIVACIDADE */}
        {activeSection === 'privacy' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-base font-bold text-nexus-text">Privacidade & Proteção</h2>
              <p className="text-xs text-nexus-muted">
                Controle quem pode interagir com você e quais informações são compartilhadas.
              </p>
            </div>

            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-nexus-surface border border-nexus-border space-y-2">
                <label className="text-xs font-semibold text-nexus-text block">
                  Quem pode enviar Mensagens Diretas para você
                </label>
                <select
                  value={settings.privacy.allowDmsFrom}
                  onChange={(e) => {
                    updatePrivacy({ allowDmsFrom: e.target.value as any });
                    showSaveSuccess();
                  }}
                  className="w-full bg-nexus-bg border border-nexus-border rounded-lg p-2 text-xs text-nexus-text focus:outline-none"
                >
                  <option value="friends">Apenas Amigos Adicionados</option>
                  <option value="all">Qualquer Membro de Comunidades em Comum</option>
                  <option value="none">Ninguém (Bloquear DMs)</option>
                </select>
              </div>

              <label className="flex items-center justify-between p-3.5 rounded-xl bg-nexus-surface border border-nexus-border cursor-pointer">
                <div>
                  <p className="text-xs font-semibold text-nexus-text">Exibir Jogo / Atividade Atual</p>
                  <p className="text-[11px] text-nexus-muted">
                    Mostra automaticamente o jogo ou aplicativo em execução para seus amigos.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={settings.privacy.showGameActivity}
                  onChange={(e) => {
                    updatePrivacy({ showGameActivity: e.target.checked });
                    showSaveSuccess();
                  }}
                  className="rounded border-nexus-border accent-nexus-accent h-4 w-4"
                />
              </label>

              <label className="flex items-center justify-between p-3.5 rounded-xl bg-nexus-surface border border-nexus-border cursor-pointer">
                <div>
                  <p className="text-xs font-semibold text-nexus-text">Modo Streamer</p>
                  <p className="text-[11px] text-nexus-muted">
                    Oculta emails, IDs de contas e códigos de convite na tela durante gravações.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={settings.privacy.streamerMode}
                  onChange={(e) => {
                    updatePrivacy({ streamerMode: e.target.checked });
                    showSaveSuccess();
                  }}
                  className="rounded border-nexus-border accent-nexus-accent h-4 w-4"
                />
              </label>
            </div>
          </div>
        )}

        {/* 6. SEÇÃO REDE PRIVADA (TAILSCALE) */}
        {activeSection === 'network' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-base font-bold text-nexus-text">Rede Privada & Tailscale</h2>
              <p className="text-xs text-nexus-muted">
                Conectividade segura ponto-a-ponto com o servidor NEXUS em redes distintas.
              </p>
            </div>

            {/* Tailscale Status Card */}
            <div className="bg-nexus-surface border border-nexus-border rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-nexus-border/60">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-nexus-panel border border-nexus-border flex items-center justify-center text-nexus-text">
                    <Network className="w-5 h-5 text-nexus-accent" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-nexus-text">Status do Tailscale</h3>
                    <p className="text-[11px] text-nexus-muted">Túnel WireGuard de rede privada mesh</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {networkStatus.tailscale_state === 'running' ? (
                    <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-[11px] font-semibold text-emerald-300">
                      <span className="w-2 h-2 rounded-full bg-emerald-400" />
                      Ativo & Autenticado
                    </span>
                  ) : networkStatus.tailscale_state === 'needs_login' ? (
                    <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-500/30 text-[11px] font-semibold text-amber-300">
                      <span className="w-2 h-2 rounded-full bg-amber-400" />
                      Login Necessário
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-500/15 border border-rose-500/30 text-[11px] font-semibold text-rose-300">
                      <span className="w-2 h-2 rounded-full bg-rose-400" />
                      {networkStatus.tailscale_installed ? 'Desconectado' : 'Não Instalado'}
                    </span>
                  )}
                </div>
              </div>

              {/* Status details grid */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-3 rounded-lg bg-nexus-panel/50 border border-nexus-border/60">
                  <span className="text-[10px] text-nexus-muted uppercase font-mono tracking-wider">Dispositivo Local</span>
                  <p className="text-xs font-semibold text-nexus-text mt-0.5 truncate">
                    {networkStatus.tailscale_self_name || 'Desconhecido'}
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-nexus-panel/50 border border-nexus-border/60">
                  <span className="text-[10px] text-nexus-muted uppercase font-mono tracking-wider">IP na Rede Privada</span>
                  <p className="text-xs font-semibold text-nexus-text mt-0.5 truncate font-mono">
                    {networkStatus.tailscale_ips.length > 0 ? networkStatus.tailscale_ips[0] : 'Nenhum'}
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-nexus-panel/50 border border-nexus-border/60">
                  <span className="text-[10px] text-nexus-muted uppercase font-mono tracking-wider">Resolução DNS</span>
                  <p className="text-xs font-semibold text-nexus-text mt-0.5 truncate">
                    {networkStatus.is_magic_dns ? 'MagicDNS Habilitado' : 'Endereço Direto'}
                  </p>
                </div>
              </div>

              {/* Tailscale Actions */}
              <div className="flex items-center justify-between pt-2">
                <p className="text-[11px] text-nexus-muted">
                  A autorização de novos dispositivos é realizada com segurança via Tailscale.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => openTailscale()}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-nexus-panel hover:bg-nexus-surface border border-nexus-border text-xs font-semibold text-nexus-text transition-colors cursor-pointer"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Abrir Tailscale</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => checkNetwork()}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-nexus-panel hover:bg-nexus-surface border border-nexus-border text-xs font-semibold text-nexus-text transition-colors cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Atualizar</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Nexus Server Connection Card */}
            <div className="bg-nexus-surface border border-nexus-border rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-nexus-border/60">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-nexus-panel border border-nexus-border flex items-center justify-center text-nexus-text">
                    <Server className="w-5 h-5 text-emerald-400" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-nexus-text">Conexão com Servidor NEXUS</h3>
                    <p className="text-[11px] text-nexus-muted">Serviço de backend Rust e mensageria</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {networkStatus.server_reachability === 'connected' ? (
                    <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-[11px] font-semibold text-emerald-300">
                      <span className="w-2 h-2 rounded-full bg-emerald-400" />
                      Conectado {networkStatus.server_latency_ms ? `(${networkStatus.server_latency_ms}ms)` : ''}
                    </span>
                  ) : networkStatus.server_reachability === 'needs_approval' ? (
                    <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-sky-500/15 border border-sky-500/30 text-[11px] font-semibold text-sky-300">
                      <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
                      Aguardando Aprovação
                    </span>
                  ) : networkStatus.server_reachability === 'connecting' ? (
                    <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-500/30 text-[11px] font-semibold text-amber-300">
                      <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                      Verificando...
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-500/15 border border-rose-500/30 text-[11px] font-semibold text-rose-300">
                      <span className="w-2 h-2 rounded-full bg-rose-400" />
                      {networkStatus.server_reachability === 'network_disconnected' ? 'Rede Desconectada' : 'Servidor Indisponível'}
                    </span>
                  )}
                </div>
              </div>

              {networkStatus.server_reachability === 'needs_approval' && networkStatus.pending_server_identity && (
                <div className="p-3.5 rounded-xl bg-sky-500/10 border border-sky-500/30 space-y-2">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-xs font-bold text-sky-200">Novo Servidor Localizado na Tailnet</div>
                      <div className="text-[11px] text-sky-300/80 font-mono mt-0.5">
                        ID: {networkStatus.pending_server_identity.server_id}
                      </div>
                      <div className="text-[11px] text-sky-300/80 font-mono">
                        Endpoint: {networkStatus.pending_server_identity.bound_endpoint}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        const approve = useAppStore.getState().approveServer;
                        await approve();
                      }}
                      className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs font-semibold text-white shadow transition-colors cursor-pointer"
                    >
                      Aprovar Servidor
                    </button>
                  </div>
                </div>
              )}

              {/* Server address configuration form */}
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-nexus-text mb-1">
                    Endereço do Servidor (MagicDNS ou IP Tailscale)
                  </label>
                  <p className="text-[11px] text-nexus-muted mb-2">
                    Por padrão, o NEXUS utiliza MagicDNS (<code className="text-nexus-accent">http://nexus-server:3001</code>) sem necessidade de configuração manual.
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={serverAddressInput}
                      onChange={(e) => {
                        setServerAddressInput(e.target.value);
                        setNetworkTestFeedback(null);
                      }}
                      placeholder="http://nexus-server:3001"
                      className="flex-1 bg-nexus-bg text-nexus-text text-xs px-3 py-2 rounded-lg border border-nexus-border focus:border-nexus-accent focus:outline-none font-mono"
                    />
                    <button
                      type="button"
                      disabled={isTestingServer}
                      onClick={async () => {
                        setIsTestingServer(true);
                        setNetworkTestFeedback(null);
                        try {
                          const res = await networkManager.probeServer(serverAddressInput);
                          if (res.status === 'connected') {
                            setNetworkTestFeedback({
                              text: `Conexão bem-sucedida! Latência: ${res.latency_ms}ms`,
                              isError: false,
                            });
                          } else {
                            setNetworkTestFeedback({
                              text: `Servidor não respondeu: ${res.error || 'Timeout'}`,
                              isError: true,
                            });
                          }
                        } catch (err: any) {
                          setNetworkTestFeedback({
                            text: err?.message || 'Falha ao testar conexão.',
                            isError: true,
                          });
                        } finally {
                          setIsTestingServer(false);
                        }
                      }}
                      className="px-3 py-2 rounded-lg bg-nexus-panel hover:bg-nexus-surface border border-nexus-border text-xs font-semibold text-nexus-text transition-colors cursor-pointer disabled:opacity-50"
                    >
                      {isTestingServer ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Testar Conexão'}
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await setServerAddress(serverAddressInput);
                          showSaveSuccess();
                        } catch (err: any) {
                          setNetworkTestFeedback({
                            text: err?.message || 'Falha ao salvar endereço.',
                            isError: true,
                          });
                        }
                      }}
                      className="px-3.5 py-2 rounded-lg bg-nexus-accent hover:bg-rose-700 text-xs font-semibold text-white transition-colors cursor-pointer"
                    >
                      Salvar Endereço
                    </button>
                  </div>
                </div>

                {networkTestFeedback && (
                  <div className={`p-2.5 rounded-lg text-xs font-medium ${networkTestFeedback.isError ? 'bg-rose-500/10 text-rose-300 border border-rose-500/30' : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'}`}>
                    {networkTestFeedback.text}
                  </div>
                )}
              </div>
            </div>

            {/* Cartão de Identidade Criptográfica do Servidor */}
            {(() => {
              const activeIdentity = networkStatus.verified_server_identity || networkStatus.pending_server_identity;
              const serverId = activeIdentity?.server_id || networkStatus.approved_server_id || '';
              const approvedId = networkStatus.approved_server_id;
              const isApproved = activeIdentity ? activeIdentity.is_approved : Boolean(approvedId);
              const isConnected = networkStatus.server_reachability === 'connected';
              const isNeedsApproval = networkStatus.server_reachability === 'needs_approval';

              const isMatching = Boolean(
                approvedId && activeIdentity?.server_id && approvedId === activeIdentity.server_id
              );
              const isMismatch = Boolean(
                approvedId && activeIdentity?.server_id && approvedId !== activeIdentity.server_id
              );

              const abbreviatedId = serverId
                ? serverId.length > 24
                  ? `${serverId.slice(0, 14)}...${serverId.slice(-8)}`
                  : serverId
                : 'Não identificado';

              return (
                <div className="bg-nexus-surface border border-nexus-border rounded-xl p-5 space-y-4">
                  <div className="flex items-center justify-between pb-3 border-b border-nexus-border/60">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-nexus-panel border border-nexus-border flex items-center justify-center text-nexus-text">
                        <ShieldCheck className="w-5 h-5 text-nexus-accent" />
                      </div>
                      <div>
                        <h3 className="text-xs font-bold text-nexus-text">Identidade Criptográfica do Servidor</h3>
                        <p className="text-[11px] text-nexus-muted">Assinatura digital Ed25519 & vinculação de canal (anti-relay)</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {isConnected && (isApproved || isMatching) ? (
                        <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-[11px] font-semibold text-emerald-300">
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          Identidade Verificada
                        </span>
                      ) : isNeedsApproval ? (
                        <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-sky-500/15 border border-sky-500/30 text-[11px] font-semibold text-sky-300">
                          <ShieldAlert className="w-3.5 h-3.5 text-sky-400 animate-pulse" />
                          Aguardando Aprovação
                        </span>
                      ) : isMismatch ? (
                        <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-500/15 border border-rose-500/30 text-[11px] font-semibold text-rose-300">
                          <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
                          Identidade Divergente
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-nexus-panel border border-nexus-border text-[11px] font-semibold text-nexus-muted">
                          <Shield className="w-3.5 h-3.5" />
                          {networkStatus.server_reachability === 'network_disconnected' ? 'Rede Desconectada' : 'Não Verificado'}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Detalhes da Identidade */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="p-3 rounded-lg bg-nexus-panel/50 border border-nexus-border/60 flex items-center justify-between">
                      <div className="min-w-0 pr-2">
                        <span className="text-[10px] text-nexus-muted uppercase font-mono tracking-wider block">ID do Servidor (Hash Ed25519)</span>
                        <p className="text-xs font-semibold text-nexus-text mt-0.5 font-mono truncate" title={serverId || undefined}>
                          {abbreviatedId}
                        </p>
                      </div>
                      {serverId && (
                        <button
                          type="button"
                          onClick={() => handleCopyServerId(serverId)}
                          title="Copiar ID completo do servidor"
                          className="flex items-center gap-1 px-2 py-1 rounded bg-nexus-surface hover:bg-nexus-panel border border-nexus-border text-[11px] text-nexus-muted hover:text-white transition-colors cursor-pointer shrink-0"
                        >
                          {copiedServerId ? (
                            <>
                              <Check className="w-3 h-3 text-emerald-400" />
                              <span className="text-emerald-400 text-[10px]">Copiado</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" />
                              <span className="text-[10px]">Copiar</span>
                            </>
                          )}
                        </button>
                      )}
                    </div>

                    <div className="p-3 rounded-lg bg-nexus-panel/50 border border-nexus-border/60">
                      <span className="text-[10px] text-nexus-muted uppercase font-mono tracking-wider block">Endereço Atual Conectado</span>
                      <p className="text-xs font-semibold text-nexus-text mt-0.5 truncate font-mono">
                        {activeIdentity?.bound_endpoint || networkStatus.server_url || 'Nenhum'}
                      </p>
                    </div>
                  </div>

                  {/* Status de Correspondência */}
                  <div className="p-3 rounded-lg bg-nexus-panel/30 border border-nexus-border/50 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${
                        isMatching || (isConnected && isApproved)
                          ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50'
                          : isMismatch
                          ? 'bg-rose-400'
                          : 'bg-amber-400'
                      }`} />
                      <span className="text-nexus-muted">Correspondência com backend conectado:</span>
                      <span className={`font-semibold ${
                        isMatching || (isConnected && isApproved)
                          ? 'text-emerald-300'
                          : isMismatch
                          ? 'text-rose-300'
                          : 'text-amber-300'
                      }`}>
                        {isMatching || (isConnected && isApproved)
                          ? 'Confirmada e Autêntica'
                          : isMismatch
                          ? 'Divergente da Identidade Aprovada'
                          : isNeedsApproval
                          ? 'Aguardando Aprovação do Usuário'
                          : 'Pendente de Verificação'}
                      </span>
                    </div>

                    {activeIdentity?.public_key && (
                      <div className="text-[11px] text-nexus-muted font-mono truncate" title={`Chave Pública: ${activeIdentity.public_key}`}>
                        Chave: <span className="text-nexus-text">{activeIdentity.public_key.slice(0, 8)}...{activeIdentity.public_key.slice(-6)}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* 7. SEÇÃO SOBRE & ATUALIZAÇÕES */}
        {activeSection === 'about' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-base font-bold text-nexus-text">Sobre o NEXUS</h2>
              <p className="text-xs text-nexus-muted">
                Informações da versão, seleção de canal e atualizações automáticas via GitHub Releases.
              </p>
            </div>

            <div className="bg-nexus-surface border border-nexus-border rounded-xl p-5 space-y-5">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-nexus-accent flex items-center justify-center text-white font-extrabold text-2xl shadow-lg shadow-nexus-accent/20">
                  N
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-bold text-nexus-text flex items-center gap-2">
                    NEXUS Desktop
                    <span className="text-xs px-2 py-0.5 rounded-full bg-nexus-panel border border-nexus-border text-nexus-muted font-mono font-normal">
                      v{APP_VERSION}
                    </span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded font-mono font-semibold uppercase ${
                        updateChannel === 'beta'
                          ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                          : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                      }`}
                    >
                      {updateChannel === 'beta' ? 'Canal Beta' : 'Canal Estável'}
                    </span>
                  </h3>
                  <p className="text-xs text-nexus-muted mt-0.5">
                    Comunicação desktop de alta performance em Rust e Tauri 2.
                  </p>
                </div>
              </div>

              {/* Seletor de Canal de Atualizações */}
              <div className="p-4 rounded-xl bg-nexus-panel border border-nexus-border space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FlaskConical className="w-4 h-4 text-nexus-accent" />
                    <div>
                      <h4 className="text-xs font-semibold text-nexus-text">Canal de Atualizações</h4>
                      <p className="text-[11px] text-nexus-muted">
                        Escolha entre versões estáveis homologadas ou versões experimentais prévias.
                      </p>
                    </div>
                  </div>

                  <span className="text-[11px] font-mono text-nexus-muted">
                    {updateChannel === 'beta' ? 'Beta / Nightly' : 'Stable (Padrão)'}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  {/* Opção Stable */}
                  <button
                    type="button"
                    onClick={() => {
                      if (updateChannel !== 'stable') {
                        setUpdateChannel('stable');
                      }
                    }}
                    className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between ${
                      updateChannel === 'stable'
                        ? 'bg-nexus-surface border-emerald-500/50 shadow-sm shadow-emerald-500/10'
                        : 'bg-nexus-surface/50 border-nexus-border hover:border-nexus-border/80 hover:bg-nexus-surface'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-nexus-text flex items-center gap-1.5">
                          Canal Estável (Stable)
                          {updateChannel === 'stable' && (
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                          )}
                        </span>
                        <span className="text-[10px] text-emerald-400 font-mono font-medium">Recomendado</span>
                      </div>
                      <p className="text-[11px] text-nexus-muted mt-1 leading-relaxed">
                        Recebe apenas releases estáveis e testadas. Não executa downgrades automáticos.
                      </p>
                    </div>
                    <div className="mt-3 text-[10px] font-mono text-nexus-muted/80">
                      Manifesto: latest.json
                    </div>
                  </button>

                  {/* Opção Beta / Nightly */}
                  <button
                    type="button"
                    onClick={() => {
                      if (updateChannel !== 'beta') {
                        setShowBetaConfirmModal(true);
                      }
                    }}
                    className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between ${
                      updateChannel === 'beta'
                        ? 'bg-nexus-surface border-amber-500/50 shadow-sm shadow-amber-500/10'
                        : 'bg-nexus-surface/50 border-nexus-border hover:border-nexus-border/80 hover:bg-nexus-surface'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-nexus-text flex items-center gap-1.5">
                          Canal Beta / Nightly
                          {updateChannel === 'beta' && (
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                          )}
                        </span>
                        <span className="text-[10px] text-amber-400 font-mono font-medium">Experimental</span>
                      </div>
                      <p className="text-[11px] text-nexus-muted mt-1 leading-relaxed">
                        Recebe builds automatizados com as últimas melhorias e validações em andamento.
                      </p>
                    </div>
                    <div className="mt-3 text-[10px] font-mono text-nexus-muted/80">
                      Manifesto: latest-nightly.json
                    </div>
                  </button>
                </div>
              </div>

              {/* Status de Atualização do Aplicativo */}
              <div className="p-4 rounded-xl bg-nexus-panel border border-nexus-border space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-nexus-accent" />
                    <div>
                      <span className="text-xs font-semibold text-nexus-text">Verificação de Versão</span>
                      <p className="text-[11px] text-nexus-muted">
                        Consultando canal {updateChannel === 'beta' ? 'Beta / Nightly' : 'Estável'}
                      </p>
                    </div>
                  </div>

                  <button
                    disabled={updateState.status === 'checking' || updateState.status === 'downloading' || updateState.status === 'installing'}
                    onClick={() => updateService.checkForUpdates(false, updateChannel)}
                    className="px-3 py-1.5 rounded-lg bg-nexus-surface hover:bg-nexus-surface/80 border border-nexus-border text-xs font-semibold text-nexus-text flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {updateState.status === 'checking' ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Verificando...</span>
                      </>
                    ) : (
                      <>
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Verificar Agora</span>
                      </>
                    )}
                  </button>
                </div>

                {updateState.status === 'up_to_date' && (
                  <div className="flex items-center gap-2 p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs">
                    <Check className="w-4 h-4 shrink-0" />
                    <span>
                      O NEXUS já está atualizado na versão mais recente disponível no canal{' '}
                      <strong>{updateChannel === 'beta' ? 'Beta / Nightly' : 'Estável'}</strong>!
                    </span>
                  </div>
                )}

                {updateState.status === 'downgrade_notice' && updateState.downgradeNoticeMessage && (
                  <div className="p-3 rounded-lg bg-sky-500/10 border border-sky-500/30 space-y-1.5">
                    <div className="flex items-center gap-2 text-sky-300 text-xs font-semibold">
                      <Info className="w-4 h-4 shrink-0" />
                      <span>Versão Experimental em Execução</span>
                    </div>
                    <p className="text-[11px] text-sky-200/80 leading-relaxed">
                      {updateState.downgradeNoticeMessage}
                    </p>
                  </div>
                )}

                {updateState.status === 'available' && updateState.updateInfo && (
                  <div className="p-3.5 rounded-lg bg-nexus-accent/10 border border-nexus-accent/30 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs font-bold text-white flex items-center gap-2">
                          <span>Nova versão v{updateState.updateInfo.version} disponível!</span>
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-nexus-accent text-white font-mono uppercase">
                            {updateState.updateInfo.channel || updateChannel}
                          </span>
                        </div>
                        {updateState.updateInfo.endpointUsed && (
                          <div className="text-[10px] text-nexus-muted font-mono truncate max-w-[320px] mt-0.5" title={updateState.updateInfo.endpointUsed}>
                            Endpoint: {updateState.updateInfo.endpointUsed}
                          </div>
                        )}
                      </div>
                      <button
                        onClick={() => updateService.downloadAndInstall()}
                        className="px-3.5 py-1.5 rounded-lg bg-nexus-accent hover:bg-rose-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shadow-md shadow-nexus-accent/20"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Baixar e Atualizar</span>
                      </button>
                    </div>
                    {updateState.updateInfo.body && (
                      <p className="text-[11px] text-nexus-muted font-mono whitespace-pre-wrap bg-nexus-panel/50 p-2.5 rounded-lg border border-nexus-border/60">
                        {updateState.updateInfo.body}
                      </p>
                    )}
                  </div>
                )}

                {updateState.status === 'downloading' && (
                  <div className="space-y-1.5 pt-1">
                    <div className="h-2 w-full bg-nexus-border rounded-full overflow-hidden">
                      <div
                        className="h-full bg-nexus-accent transition-all duration-300"
                        style={{ width: `${updateState.downloadProgress}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[11px] text-nexus-muted font-mono">
                      <span>Baixando atualização ({updateChannel === 'beta' ? 'Nightly' : 'Stable'})...</span>
                      <span>{updateState.downloadProgress}%</span>
                    </div>
                  </div>
                )}

                {updateState.status === 'installing' && (
                  <div className="flex items-center gap-2 text-xs text-nexus-accent font-medium">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Aplicando nova versão e reiniciando o NEXUS...</span>
                  </div>
                )}

                {updateState.status === 'error' && updateState.errorMessage && (
                  <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs">
                    {updateState.errorMessage}
                  </div>
                )}
              </div>

              <div className="pt-2 border-t border-nexus-border space-y-2 text-xs text-nexus-muted">
                <div className="flex items-center justify-between">
                  <span>Repositório Oficial:</span>
                  <a
                    href="https://github.com/Sinisterzs/NEXUS"
                    target="_blank"
                    rel="noreferrer"
                    className="text-nexus-accent hover:underline flex items-center gap-1 font-mono"
                  >
                    <span>Sinisterzs/NEXUS</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <div className="flex items-center justify-between">
                  <span>Canal Ativo:</span>
                  <span className="font-mono text-nexus-text">
                    {updateChannel === 'beta' ? 'Beta / Nightly (latest-nightly.json)' : 'Estável (latest.json)'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Assinatura Criptográfica:</span>
                  <span className="flex items-center gap-1 text-emerald-400 font-mono text-[11px]">
                    <ShieldCheck className="w-3.5 h-3.5" /> Minisign Ed25519 (Obrigatória)
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Modal de Confirmação para ativação do Canal Beta */}
        {showBetaConfirmModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-fadeIn select-none">
            <div className="relative w-full max-w-md bg-nexus-surface border border-nexus-border/80 rounded-2xl shadow-2xl p-5 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Ativar Canal Beta / Nightly?</h3>
                  <p className="text-xs text-nexus-muted mt-0.5">Atualizações experimentais e recursos antecipados</p>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-nexus-panel border border-nexus-border/70 text-xs text-nexus-muted space-y-2">
                <p>
                  As versões do canal Beta/Nightly contêm as alterações mais recentes e experimentais. Elas podem sofrer alterações frequentes e eventuais instabilidades.
                </p>
                <div className="flex items-center gap-1.5 text-emerald-400 text-[11px] font-medium pt-1">
                  <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                  <span>Todos os pacotes continuam 100% verificados com assinatura digital Minisign.</span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setShowBetaConfirmModal(false)}
                  className="px-3 py-1.5 rounded-lg bg-nexus-panel hover:bg-nexus-border/60 text-xs font-semibold text-nexus-text transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setShowBetaConfirmModal(false);
                    await setUpdateChannel('beta');
                  }}
                  className="px-3.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-xs font-semibold text-white shadow transition-colors cursor-pointer"
                >
                  Confirmar e Ativar Beta
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
