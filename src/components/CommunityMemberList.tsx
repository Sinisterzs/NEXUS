import React from 'react';
import { Crown, MicOff, MessageSquareOff, Shield } from 'lucide-react';
import { CommunityMemberDto, UserStatus } from '../lib/types';
import { Avatar } from './Avatar';
import { StatusIndicator } from './StatusIndicator';
import { Tooltip } from './Tooltip';
import { cn } from '../lib/utils';

export interface MemberVoiceActivity {
  channelName: string;
  isScreenSharing: boolean;
}

export interface CommunityMemberListProps {
  members: CommunityMemberDto[];
  cardBackground?: string;
  className?: string;
  emptyMessage?: string;
  onMemberClick?: (member: CommunityMemberDto) => void;
  voiceActivityByUserId?: Record<string, MemberVoiceActivity>;
  searchQuery?: string;
}

/** Normaliza qualquer string de status para um `UserStatus` válido (padrão `'offline'`). */
export function normalizeStatus(status?: string | null): UserStatus {
  switch (status) {
    case 'online':
    case 'idle':
    case 'dnd':
    case 'invisible':
    case 'offline':
      return status;
    default:
      return 'offline';
  }
}

/**
 * Preserva estritamente o status de presença pública do membro sem promover
 * usuários `'offline'` ou `'invisible'` para `'online'` por atividade em sala de voz,
 * e mascara `'invisible'` como `'offline'` para outros membros.
 */
export function getEffectiveStatus(
  member: Pick<CommunityMemberDto, 'status'>,
  _voiceActivityByUserId?: Record<string, MemberVoiceActivity>
): 'online' | 'idle' | 'dnd' | 'offline' {
  const normalized = normalizeStatus(member.status);
  return normalized === 'invisible' ? 'offline' : normalized;
}

function isFutureIso(iso?: string | null): boolean {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return !Number.isNaN(ts) && ts > Date.now();
}

export const CommunityMemberList: React.FC<CommunityMemberListProps> = ({
  members,
  cardBackground,
  className,
  emptyMessage,
  onMemberClick,
  voiceActivityByUserId,
  searchQuery,
}) => {
  const normalizedQuery = searchQuery?.trim().toLowerCase() ?? '';

  const filteredMembers = normalizedQuery
    ? members.filter((member) => {
        const fields = [
          member.nickname,
          member.display_name,
          member.username,
          member.custom_status,
          ...member.roles.map((role) => role.name),
        ];
        return fields.some(
          (field) => typeof field === 'string' && field.toLowerCase().includes(normalizedQuery)
        );
      })
    : members;

  if (filteredMembers.length === 0) {
    const resolvedEmptyMessage =
      emptyMessage ??
      (normalizedQuery ? 'Nenhum membro correspondente.' : 'Nenhum membro encontrado.');
    return (
      <div className={cn('px-3 py-6 text-center text-[13px] text-zinc-400', className)}>
        {resolvedEmptyMessage}
      </div>
    );
  }

  const onlineMembers = filteredMembers.filter((m) => {
    const st = getEffectiveStatus(m, voiceActivityByUserId);
    return st === 'online' || st === 'idle' || st === 'dnd';
  });

  const offlineMembers = filteredMembers.filter((m) => {
    const st = getEffectiveStatus(m, voiceActivityByUserId);
    return st === 'offline';
  });

  const renderGroup = (title: string, groupMembers: CommunityMemberDto[], isOfflineGroup = false) => {
    if (groupMembers.length === 0) return null;

    return (
      <div className="space-y-1">
        <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          {title} — {groupMembers.length}
        </div>
        <div className="space-y-1">
          {groupMembers.map((member) => {
            const displayName = member.nickname || member.display_name || member.username;
            const status = getEffectiveStatus(member, voiceActivityByUserId);
            const sortedRoles = [...member.roles].sort((a, b) => b.position - a.position);
            const topRole = sortedRoles.find((r) => Boolean(r.color)) || sortedRoles[0];
            const isTextMuted = isFutureIso(member.text_muted_until);
            const isVoiceMuted = member.server_voice_muted || isFutureIso(member.voice_muted_until);
            const voiceActivity = voiceActivityByUserId?.[member.user_id];
            const Tag = onMemberClick ? 'button' : 'div';

            return (
              <Tag
                key={member.user_id}
                {...(onMemberClick
                  ? {
                      type: 'button' as const,
                      onClick: () => onMemberClick(member),
                    }
                  : {})}
                className={cn(
                  'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl border border-transparent text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70',
                  onMemberClick
                    ? 'hover:bg-white/[0.05] hover:border-white/[0.06] cursor-pointer'
                    : 'hover:bg-white/[0.04]',
                  isOfflineGroup && 'opacity-70'
                )}
                style={cardBackground ? { background: cardBackground } : undefined}
              >
                <div className="relative shrink-0">
                  <Avatar
                    name={displayName}
                    avatarUrl={member.avatar_url}
                    size="sm"
                    showStatus={false}
                    shapeClassName="rounded-full ring-1 ring-white/[0.08]"
                  />
                  <StatusIndicator
                    status={status}
                    size="sm"
                    className="absolute -bottom-0.5 -right-0.5 ring-2 ring-[#0E1018]"
                  />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="text-[13px] font-medium text-zinc-100 truncate"
                      style={topRole?.color ? { color: topRole.color } : undefined}
                    >
                      {displayName}
                    </span>

                    {member.is_owner && (
                      <Tooltip content="Proprietário da comunidade" position="top" portal>
                        <Crown className="w-3 h-3 text-amber-400 shrink-0" />
                      </Tooltip>
                    )}

                    {!member.is_owner && sortedRoles.length > 0 && (
                      <Tooltip
                        content={sortedRoles.map((r) => r.name).join(', ')}
                        position="top"
                        portal
                      >
                        <Shield
                          className="w-3 h-3 shrink-0 text-zinc-400"
                          style={topRole?.color ? { color: topRole.color } : undefined}
                        />
                      </Tooltip>
                    )}
                  </div>

                  {voiceActivity ? (
                    voiceActivity.isScreenSharing ? (
                      <p className="text-[11px] font-medium text-[#E04F64] truncate flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#E04F64] shrink-0" />
                        <span className="truncate">
                          Transmitindo · {voiceActivity.channelName}
                        </span>
                      </p>
                    ) : (
                      <p className="text-[11px] font-medium text-emerald-400 truncate flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                        <span className="truncate">Em voz · {voiceActivity.channelName}</span>
                      </p>
                    )
                  ) : member.custom_status ? (
                    <p className="text-[11px] text-zinc-400 truncate">{member.custom_status}</p>
                  ) : topRole ? (
                    <p className="text-[11px] text-zinc-400 truncate">{topRole.name}</p>
                  ) : null}
                </div>

                {(isTextMuted || isVoiceMuted) && (
                  <div className="flex items-center gap-1 shrink-0 text-rose-400">
                    {isTextMuted && (
                      <Tooltip content="Silenciado no texto" position="left" portal>
                        <MessageSquareOff className="w-3 h-3" />
                      </Tooltip>
                    )}
                    {isVoiceMuted && (
                      <Tooltip content="Silenciado na voz" position="left" portal>
                        <MicOff className="w-3 h-3" />
                      </Tooltip>
                    )}
                  </div>
                )}
              </Tag>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className={cn('space-y-4', className)}>
      {renderGroup('Online', onlineMembers, false)}
      {renderGroup('Offline', offlineMembers, true)}
    </div>
  );
};
