import React, { useEffect } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';
import { callService } from '../services/CallService';
import { Avatar } from './Avatar';

export const IncomingCallToast: React.FC = () => {
  const voiceCallState = useAppStore((state) => state.voiceCallState);
  const incomingCall = useAppStore((state) => state.incomingCall);
  const setActiveTab = useAppStore((state) => state.setActiveTab);

  // Play synthesized ringtone alert while incoming call is pending
  useEffect(() => {
    if (voiceCallState !== 'incoming' || !incomingCall) return;

    let audioCtx: AudioContext | null = null;
    let ringInterval: any = null;

    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();

        const playTone = (freq1: number, freq2: number, duration: number) => {
          if (!audioCtx || audioCtx.state === 'closed') return;
          const osc1 = audioCtx.createOscillator();
          const osc2 = audioCtx.createOscillator();
          const gain = audioCtx.createGain();

          osc1.type = 'sine';
          osc2.type = 'sine';
          osc1.frequency.value = freq1;
          osc2.frequency.value = freq2;

          const now = audioCtx.currentTime;
          gain.gain.setValueAtTime(0.06, now);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

          osc1.connect(gain);
          osc2.connect(gain);
          gain.connect(audioCtx.destination);

          osc1.start(now);
          osc2.start(now);
          osc1.stop(now + duration);
          osc2.stop(now + duration);
        };

        const playDoubleRing = () => {
          playTone(440, 480, 0.4);
          setTimeout(() => {
            playTone(440, 480, 0.4);
          }, 450);
        };

        playDoubleRing();
        ringInterval = setInterval(playDoubleRing, 2600);
      }
    } catch {
      // Audio autoplay might be blocked without user gesture, continue silently
    }

    return () => {
      if (ringInterval) clearInterval(ringInterval);
      if (audioCtx && audioCtx.state !== 'closed') {
        audioCtx.close().catch(() => {});
      }
    };
  }, [voiceCallState, incomingCall]);

  if (voiceCallState !== 'incoming' || !incomingCall) {
    return null;
  }

  const callerName =
    incomingCall.caller.displayName || incomingCall.caller.username;

  const handleAccept = async () => {
    setActiveTab('calls');
    await callService.acceptCall();
  };

  const handleReject = () => {
    callService.rejectCall('Chamada recusada pelo destinatário.');
  };

  return (
    <div className="fixed bottom-6 right-6 z-[9999] animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="w-84 p-4 rounded-2xl bg-nexus-surface/95 backdrop-blur-xl border border-emerald-500/50 shadow-2xl shadow-emerald-950/50 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Avatar name={callerName} size="md" />
            <span className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-500 rounded-full animate-ping" />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-xs font-bold text-nexus-text truncate">{callerName}</h4>
            <p className="text-[11px] text-emerald-400 font-mono animate-pulse">
              Chamada de voz recebida...
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-2 border-t border-nexus-border/60">
          <button
            onClick={handleReject}
            className="flex-1 py-2 px-3 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 text-rose-400 text-xs font-semibold flex items-center justify-center gap-1.5 transition-nexus cursor-pointer"
          >
            <PhoneOff className="w-3.5 h-3.5" />
            <span>Recusar</span>
          </button>

          <button
            onClick={handleAccept}
            className="flex-1 py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition-nexus shadow-lg shadow-emerald-900/30 cursor-pointer"
          >
            <Phone className="w-3.5 h-3.5 animate-bounce" />
            <span>Atender</span>
          </button>
        </div>
      </div>
    </div>
  );
};
