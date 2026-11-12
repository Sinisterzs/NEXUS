import React from 'react';
import { Crown, MicOff, MessageSquareOff, Shield } from 'lucide-react';
import { CommunityMemberDto, UserStatus } from '../lib/types';
import { Avatar } from './Avatar';
import { StatusIndicator } from './StatusIndicator';
import { Tooltip } from './Tooltip';
import { cn } from '../lib/utils';

export interface CommunityMemberListProps {
  members: CommunityMemberDto[];
  cardBackground?: string;
  className?: string;
  emptyMessage?: string;
  onMemberClick?: (member: CommunityMemberDto) => void;
}

function normalizeStatus(status?: string | null): UserStatus {
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

function isFutureIso(iso?: string | null): boolean {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return !Number.isNaN(ts) && ts > Date.now();
}

export const CommunityMemberList: React.FC<CommunityMemberListProps> = ({
  members,
  cardBackground,
  className,
  emptyMessage = 'Nenhum membro encontrado.',
  onMemberClick,
}) => {
  if (members.length === 0) {
    return (
      <div className={cn('px-3 py-6 text-center text-xs text-nexus-muted', className)}>
        {emptyMessage}
      </div>
    );
  }

  const onlineMembers = members.filter((m) => {
    const st = normalizeStatus(m.status);
    return st === 'online' || st === 'idle' || st === 'dnd';
  });

  const offlineMembers = members.filter((m) => {
    const st = normalizeStatus(m.status);
    return st === 'offline' || st === 'invisible';
  });

  const renderGroup = (title: string, groupMembers: CommunityMemberDto[], isOfflineGroup = false) => {
    if (groupMembers.length === 0) return null;

    return (
      <div className="space-y-1">
        <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-nexus-muted">
          {title} — {groupMembers.length}
        </div>
        <div className="space-y-1">
          {groupMembers.map((member) => {
            const displayName = member.nickname || member.display_name || member.username;
            const status = normalizeStatus(member.status);
            const sortedRoles = [...member.roles].sort((a, b) => b.position - a.position);
            const topRole = sortedRoles.find((r) => Boolean(r.color)) || sortedRoles[0];
            const isTextMuted = isFutureIso(member.text_muted_until);
            const isVoiceMuted = member.server_voice_muted || isFutureIso(member.voice_muted_until);
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
                  'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg border border-transparent text-left transition-colors',
                  onMemberClick
                    ? 'hover:bg-nexus-panel/70 hover:border-nexus-border/60 cursor-pointer'
                    : 'hover:bg-nexus-panel/40',
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
                  />
                  <StatusIndicator
                    status={status}
                    size="sm"
                    className="absolute -bottom-0.5 -right-0.5"
                  />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="text-xs font-medium truncate"
                      style={topRole?.color ? { color: topRole.color } : undefined}
                    >
                      {displayName}
                    </span>

                    {member.is_owner && (
                      <Tooltip content="Proprietário da comunidade" position="top">
                        <Crown className="w-3 h-3 text-amber-400 shrink-0" />
                      </Tooltip>
                    )}

                    {!member.is_owner && sortedRoles.length > 0 && (
                      <Tooltip
                        content={sortedRoles.map((r) => r.name).join(', ')}
                        position="top"
                      >
                        <Shield
                          className="w-3 h-3 shrink-0 text-nexus-muted"
                          style={topRole?.color ? { color: topRole.color } : undefined}
                        />
                      </Tooltip>
                    )}
                  </div>

                  {member.custom_status ? (
                    <p className="text-[10px] text-nexus-muted truncate">{member.custom_status}</p>
                  ) : topRole ? (
                    <p className="text-[10px] text-nexus-muted truncate">{topRole.name}</p>
                  ) : null}
                </div>

                {(isTextMuted || isVoiceMuted) && (
                  <div className="flex items-center gap-1 shrink-0 text-rose-400">
                    {isTextMuted && (
                      <Tooltip content="Silenciado no texto" position="left">
                        <MessageSquareOff className="w-3 h-3" />
                      </Tooltip>
                    )}
                    {isVoiceMuted && (
                      <Tooltip content="Silenciado na voz" position="left">
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
