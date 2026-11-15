import React, { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Globe,
  Hash,
  KeyRound,
  Lock,
  MessageSquare,
  Users,
} from 'lucide-react';
import { CommunityDto } from '../../lib/types';

export interface CommunityHeroBannerProps {
  community: CommunityDto;
  channelName: string;
  channelTopic?: string | null;
  channelsCount: number;
  onlineMembersCount: number;
}

const getStorageKey = (communityId: string) =>
  `nexus_hero_banner_dismissed_${communityId}`;

const readDismissedState = (communityId: string): boolean => {
  try {
    return window.localStorage.getItem(getStorageKey(communityId)) === 'true';
  } catch {
    return false;
  }
};

const writeDismissedState = (communityId: string, dismissed: boolean) => {
  try {
    if (dismissed) {
      window.localStorage.setItem(getStorageKey(communityId), 'true');
    } else {
      window.localStorage.removeItem(getStorageKey(communityId));
    }
  } catch {
    // Ignore storage quota or restricted context errors
  }
};

export const CommunityHeroBanner: React.FC<CommunityHeroBannerProps> = ({
  community,
  channelName,
  channelTopic,
  channelsCount,
  onlineMembersCount,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(() =>
    readDismissedState(community.id)
  );

  useEffect(() => {
    setIsCollapsed(readDismissedState(community.id));
  }, [community.id]);

  const handleToggleCollapse = (nextCollapsed: boolean) => {
    setIsCollapsed(nextCollapsed);
    writeDismissedState(community.id, nextCollapsed);
  };

  const trimmedTopic = channelTopic?.trim() || null;
  const descriptionText =
    community.description?.trim() ||
    `Bem-vindo(a) à comunidade ${community.name}.`;

  const nameWords = community.name.trim().split(/\s+/).filter(Boolean);
  const hasMultipleWords = nameWords.length >= 2;
  const leadingWords = hasMultipleWords ? nameWords.slice(0, -1).join(' ') : '';
  const trailingWord = hasMultipleWords
    ? nameWords[nameWords.length - 1]
    : community.name;

  const privacyMeta =
    community.privacy === 'public'
      ? { label: 'Comunidade Pública', Icon: Globe }
      : community.privacy === 'invite_only'
      ? { label: 'Somente Convite', Icon: KeyRound }
      : { label: 'Comunidade Privada', Icon: Lock };

  const PrivacyIcon = privacyMeta.Icon;

  if (isCollapsed) {
    return (
      <div className="px-4 pt-3 pb-1 flex items-center justify-between gap-3 shrink-0">
        <button
          type="button"
          onClick={() => handleToggleCollapse(false)}
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[11px] font-medium text-zinc-300 hover:text-white transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent"
        >
          <ChevronDown className="w-3.5 h-3.5 text-nexus-accent" />
          <span>Mostrar resumo de {community.name}</span>
        </button>

        {trimmedTopic && (
          <p className="text-[11px] text-zinc-400 truncate max-w-lg">
            #{channelName}: {trimmedTopic}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="px-4 pt-4 pb-1 shrink-0">
      <section
        aria-label={`Resumo da comunidade ${community.name}`}
        className="rounded-2xl border border-white/[0.09] bg-gradient-to-r from-[#121521] via-[#1A1220] to-[#2B111C] p-5 sm:p-6 relative overflow-hidden shadow-[0_14px_34px_rgba(0,0,0,0.35)]"
      >
        {/* Atmospheric architectural / geometric graphite + crimson vector art (no mascot) */}
        <div
          aria-hidden="true"
          className="pointer-events-none select-none hidden md:block absolute inset-y-0 right-0 w-[300px] overflow-hidden"
        >
          <div className="absolute -right-10 -top-10 w-64 h-64 rounded-full bg-[#E04F64]/[0.18] blur-3xl" />
          <div className="absolute right-8 bottom-0 w-44 h-24 rounded-full bg-[#C83E52]/[0.22] blur-2xl" />
          <svg
            viewBox="0 0 320 180"
            fill="none"
            className="w-full h-full object-cover opacity-90"
            preserveAspectRatio="xMaxYMid slice"
          >
            <defs>
              <linearGradient id="nexusTowerGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#E04F64" stopOpacity="0.32" />
                <stop offset="55%" stopColor="#1B1F30" stopOpacity="0.88" />
                <stop offset="100%" stopColor="#0C0E15" stopOpacity="0.96" />
              </linearGradient>
              <linearGradient id="nexusBeamGrad" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0%" stopColor="#C83E52" stopOpacity="0" />
                <stop offset="55%" stopColor="#E04F64" stopOpacity="0.45" />
                <stop offset="100%" stopColor="#E04F64" stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* Distant architectural silhouettes */}
            <path
              d="M120 180 L146 68 L174 52 L192 180 Z"
              fill="#151824"
              fillOpacity="0.72"
            />
            <path
              d="M188 180 L218 28 L244 18 L272 180 Z"
              fill="url(#nexusTowerGrad)"
              stroke="#E04F64"
              strokeOpacity="0.22"
              strokeWidth="1"
            />
            <path
              d="M254 180 L282 76 L310 62 L320 180 Z"
              fill="#141722"
              fillOpacity="0.85"
            />

            {/* Crimson angular horizon beams */}
            <path
              d="M40 156 L195 118 L320 144"
              stroke="url(#nexusBeamGrad)"
              strokeWidth="1.5"
            />
            <path
              d="M90 172 L226 132 L320 158"
              stroke="#E04F64"
              strokeOpacity="0.28"
              strokeWidth="1"
            />

            {/* Architectural geometric crest & subtle angular N motif */}
            <polygon
              points="231,42 238,42 238,112 231,112"
              fill="#E04F64"
              fillOpacity="0.32"
            />
            <path
              d="M196 124 L204 108 L216 120 L224 106 L220 128 L208 117 L200 128 Z"
              fill="#E04F64"
              fillOpacity="0.45"
            />
          </svg>
        </div>

        <div className="relative z-10 flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1 max-w-2xl">
            {/* Top: Large bicolour heading (or clean single-word title + subtle crimson monogram) */}
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-[24px] sm:text-[26px] font-extrabold tracking-tight text-white leading-tight">
                {hasMultipleWords ? (
                  <>
                    <span>{leadingWords} </span>
                    <span className="text-[#E04F64]">{trailingWord}</span>
                  </>
                ) : (
                  trailingWord
                )}
              </h2>
              {!hasMultipleWords && (
                <span
                  aria-hidden="true"
                  className="inline-flex items-center justify-center w-6 h-6 rounded-lg bg-[#E04F64]/15 border border-[#E04F64]/35 shadow-[0_0_12px_rgba(224,79,100,0.28)]"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    className="w-3.5 h-3.5"
                  >
                    <path
                      d="M4 18.5L9.2 5.5H12.4L14.9 12.6L17.9 5.5H20L15.1 18.5H12L9.4 11.1L6.4 18.5H4Z"
                      fill="#E04F64"
                    />
                  </svg>
                </span>
              )}
            </div>

            {/* Middle: Real community description */}
            <p className="text-[13px] text-white/75 mt-2 max-w-xl leading-relaxed">
              {descriptionText}
            </p>

            {trimmedTopic && (
              <div className="mt-2.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black/30 border border-white/[0.08] text-[11px] text-zinc-200 max-w-full">
                <Hash className="w-3.5 h-3.5 text-[#E04F64] shrink-0" />
                <span className="font-semibold text-white shrink-0">
                  {channelName}:
                </span>
                <span className="truncate text-zinc-300">{trimmedTopic}</span>
              </div>
            )}

            {/* Bottom: Translucent real metadata pills */}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 bg-black/35 backdrop-blur-md border border-white/10 rounded-full px-3 py-1 text-[11.5px] font-medium text-zinc-100">
                <PrivacyIcon className="w-3.5 h-3.5 text-[#E04F64]" />
                <span>{privacyMeta.label}</span>
              </span>

              <span className="inline-flex items-center gap-1.5 bg-black/35 backdrop-blur-md border border-white/10 rounded-full px-3 py-1 text-[11.5px] font-medium text-zinc-200">
                <Users className="w-3.5 h-3.5 text-zinc-300" />
                <span>
                  {community.member_count} Membros
                  {onlineMembersCount > 0 ? ` · ${onlineMembersCount} online` : ''}
                </span>
              </span>

              <span className="inline-flex items-center gap-1.5 bg-black/35 backdrop-blur-md border border-white/10 rounded-full px-3 py-1 text-[11.5px] font-medium text-zinc-200">
                <MessageSquare className="w-3.5 h-3.5 text-zinc-300" />
                <span>{channelsCount} Canais</span>
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => handleToggleCollapse(true)}
            aria-label="Recolher banner da comunidade"
            title="Recolher banner"
            className="p-1.5 rounded-lg bg-black/30 hover:bg-black/50 border border-white/10 text-zinc-300 hover:text-white transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]"
          >
            <ChevronUp className="w-4 h-4" />
          </button>
        </div>
      </section>
    </div>
  );
};
