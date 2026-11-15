import React, { useEffect, useRef } from 'react';
import { Monitor, Play, Volume2 } from 'lucide-react';
import { Avatar } from './Avatar';
import { sanitizeMetricLabel } from '../lib/streamMetrics';

export interface ActiveStreamCardProps {
  streamerName: string;
  streamerAvatarUrl?: string | null;
  streamerUserId: string;
  voiceChannelId: string;
  voiceChannelName: string;
  previewStream?: MediaStream | null;
  resolutionLabel?: string | null;
  fpsLabel?: string | null;
  isWatching?: boolean;
  onWatch: (voiceChannelId: string, streamerUserId: string) => void;
}

export const ActiveStreamCard: React.FC<ActiveStreamCardProps> = ({
  streamerName,
  streamerAvatarUrl,
  streamerUserId,
  voiceChannelId,
  voiceChannelName,
  previewStream,
  resolutionLabel,
  fpsLabel,
  isWatching = false,
  onWatch,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    if (previewStream) {
      el.srcObject = previewStream;
    } else {
      el.srcObject = null;
    }

    return () => {
      el.srcObject = null;
    };
  }, [previewStream]);

  const cleanResolution = sanitizeMetricLabel(resolutionLabel);
  const cleanFps = sanitizeMetricLabel(fpsLabel);

  return (
    <div className="w-full min-w-0 rounded-2xl border border-white/[0.1] bg-gradient-to-br from-[#151824]/95 via-[#11131D]/95 to-[#1B121C]/95 p-3 flex flex-col @md:flex-row items-stretch gap-4 max-w-[540px] shadow-[0_14px_34px_rgba(0,0,0,0.45)]">
      {/* Left: Video preview or atmospheric dark broadcast stage */}
      <div className="relative w-full @md:w-[228px] aspect-[16/10] rounded-xl overflow-hidden bg-[#090A0F] border border-white/[0.08] shrink-0 flex items-center justify-center">
        {previewStream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="relative w-full h-full bg-gradient-to-br from-[#161926] via-[#0E1018] to-[#190F17] flex items-center justify-center p-3 overflow-hidden">
            {/* Subtle atmospheric horizon glow */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -bottom-6 inset-x-4 h-16 rounded-full bg-[#E04F64]/[0.16] blur-xl"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-5 h-px bg-gradient-to-r from-transparent via-[#E04F64]/25 to-transparent"
            />

            {/* Centered streamer avatar with discrete broadcast rings */}
            <div className="relative flex items-center justify-center">
              <span
                aria-hidden="true"
                className="absolute w-16 h-16 rounded-full border border-[#E04F64]/25"
              />
              <span
                aria-hidden="true"
                className="absolute w-20 h-20 rounded-full border border-white/[0.06]"
              />
              <Avatar
                name={streamerName}
                avatarUrl={streamerAvatarUrl}
                size="md"
                showStatus={false}
                shapeClassName="rounded-full ring-2 ring-white/15"
              />
              <span className="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-[#161923] border border-white/[0.14] flex items-center justify-center text-[#E04F64] shadow-sm">
                <Monitor className="w-2.5 h-2.5" />
              </span>
            </div>
          </div>
        )}

        <span className="absolute top-2.5 left-2.5 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#E04F64] text-white text-[10px] font-extrabold tracking-wider uppercase shadow-[0_2px_10px_rgba(224,79,100,0.45)]">
          <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse motion-reduce:animate-none" />
          LIVE
        </span>
      </div>

      {/* Right: Stream metadata & Watch button */}
      <div className="flex-1 min-w-0 flex flex-col justify-between gap-3 py-0.5">
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-center gap-2 text-[14px] font-bold text-white">
            <Monitor className="w-4 h-4 text-[#E04F64] shrink-0" />
            <span className="truncate">Transmissão de {streamerName}</span>
          </div>

          <div className="flex items-center gap-1.5 text-[12px] text-zinc-400">
            <Volume2 className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
            <span className="truncate">{voiceChannelName}</span>
          </div>

          <div className="pt-0.5 flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black/30 border border-white/[0.07] text-[11.5px] font-medium text-zinc-200">
              <span className="w-2 h-2 rounded-full bg-[#E04F64] shrink-0" />
              <span>Ao vivo</span>
              {cleanResolution && <span className="text-zinc-300">· {cleanResolution}</span>}
              {cleanFps && <span className="text-zinc-300">· {cleanFps}</span>}
            </span>
          </div>
        </div>

        <div>
          <button
            type="button"
            onClick={() => onWatch(voiceChannelId, streamerUserId)}
            className="inline-flex items-center justify-center gap-2 w-full px-4 py-2 rounded-xl bg-white/[0.08] hover:bg-[#E04F64] text-white border border-white/[0.12] hover:border-[#E04F64] text-xs font-semibold transition-all cursor-pointer shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>{isWatching ? 'Ver Transmissão' : 'Assistir'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
