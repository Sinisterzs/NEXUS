import React, { useMemo, useState } from 'react';
import {
  ChevronRight,
  Headphones,
  Mic,
  MicOff,
  Monitor,
  Play,
  Radio,
  Search,
  Users,
  Volume2,
  X,
} from 'lucide-react';
import {
  CommunityChannelDto,
  CommunityMemberDto,
  RoomParticipantDto,
} from '../../lib/types';
import { Avatar } from '../../components/Avatar';
import { CommunityMemberList } from '../../components/CommunityMemberList';
import { sanitizeMetricLabel } from '../../lib/streamMetrics';

export interface CommunityVoiceChannelPresence {
  channel: CommunityChannelDto;
  participants: RoomParticipantDto[];
  isConnectedHere: boolean;
}

export interface CommunityActiveStreamItem {
  key: string;
  voiceChannelId: string;
  voiceChannelName: string;
  streamerUserId: string;
  streamerName: string;
  streamerAvatarUrl?: string | null;
  resolutionLabel: string | null;
  fpsLabel: string | null;
}

export interface CommunityContextPanelProps {
  selectedChannel: CommunityChannelDto | null;
  voiceChannels: CommunityVoiceChannelPresence[];
  activeStreams: CommunityActiveStreamItem[];
  members: CommunityMemberDto[];
  currentUserId: string;
  onSelectChannel: (channelId: string) => void;
  onWatchStream: (voiceChannelId: string, streamerUserId?: string) => void;
}

interface NowLiveCardProps {
  stream: CommunityActiveStreamItem;
  isViewingRoom: boolean;
  onWatch: (voiceChannelId: string, streamerUserId?: string) => void;
}

const NowLiveCard: React.FC<NowLiveCardProps> = ({
  stream,
  isViewingRoom,
  onWatch,
}) => {
  const realQualityLabel = [
    sanitizeMetricLabel(stream.resolutionLabel),
    sanitizeMetricLabel(stream.fpsLabel),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-gradient-to-br from-[#141724] via-[#10121C] to-[#1A1019] p-2.5 space-y-2.5 overflow-hidden shadow-md">
      {/* Lightweight atmospheric dark stage (zero video decoding overhead) */}
      <div className="relative w-full aspect-[16/9] rounded-xl overflow-hidden bg-gradient-to-br from-[#161824] via-[#11131D] to-[#1D121B] border border-white/[0.07] flex items-center justify-center">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-5 inset-x-3 h-12 rounded-full bg-[#E04F64]/[0.18] blur-xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-4 h-px bg-gradient-to-r from-transparent via-[#E04F64]/30 to-transparent"
        />

        <div className="relative flex items-center justify-center">
          <span
            aria-hidden="true"
            className="absolute w-14 h-14 rounded-full border border-[#E04F64]/25"
          />
          <span
            aria-hidden="true"
            className="absolute w-[72px] h-[72px] rounded-full border border-white/[0.06]"
          />
          <Avatar
            name={stream.streamerName}
            avatarUrl={stream.streamerAvatarUrl}
            size="md"
            showStatus={false}
            shapeClassName="rounded-full ring-2 ring-white/15"
          />
        </div>

        <span className="absolute top-2 right-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#E04F64] text-white text-[9.5px] font-extrabold uppercase tracking-wider shadow-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-white" />
          LIVE
        </span>

        {realQualityLabel && (
          <span className="absolute bottom-2 left-2 inline-flex items-center px-2 py-0.5 rounded-full bg-black/55 backdrop-blur-sm border border-white/10 text-[10px] font-medium text-zinc-200 tabular-nums">
            {realQualityLabel}
          </span>
        )}
      </div>

      <div className="space-y-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <Avatar
            name={stream.streamerName}
            avatarUrl={stream.streamerAvatarUrl}
            size="xs"
            showStatus={false}
            shapeClassName="rounded-full !w-7 !h-7 ring-1 ring-white/10 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-semibold text-white truncate">
              {stream.streamerName} está transmitindo
            </p>
            <p className="text-[11px] text-zinc-400 truncate">
              Sala: {stream.voiceChannelName}
            </p>
          </div>
        </div>

        {isViewingRoom ? (
          <div className="w-full inline-flex items-center justify-center px-3 py-1.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-[11.5px] font-medium text-zinc-300">
            Visualizando sala
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onWatch(stream.voiceChannelId, stream.streamerUserId)}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#C83E52]/20 hover:bg-[#E04F64] border border-[#E04F64]/40 text-white text-[12px] font-semibold transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70"
          >
            <Play className="w-3 h-3 fill-current" />
            <span>Assistir</span>
          </button>
        )}
      </div>
    </div>
  );
};

export const CommunityContextPanel: React.FC<CommunityContextPanelProps> = ({
  selectedChannel,
  voiceChannels,
  activeStreams,
  members,
  currentUserId,
  onSelectChannel,
  onWatchStream,
}) => {
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');

  const voiceActivityByUserId = useMemo(() => {
    const map: Record<string, { channelName: string; isScreenSharing: boolean }> = {};
    for (const room of voiceChannels) {
      for (const participant of room.participants) {
        if (!map[participant.user_id] || room.isConnectedHere) {
          map[participant.user_id] = {
            channelName: room.channel.name,
            isScreenSharing: Boolean(participant.is_screen_sharing),
          };
        }
      }
    }
    return map;
  }, [voiceChannels]);

  const occupiedVoiceRooms = useMemo(
    () => voiceChannels.filter((room) => room.participants.length > 0),
    [voiceChannels]
  );

  const isVoiceSelected = selectedChannel?.channel_type === 'voice';

  const selectedVoiceRoom = useMemo(() => {
    if (!isVoiceSelected || !selectedChannel) return null;
    return (
      voiceChannels.find((room) => room.channel.id === selectedChannel.id) ?? {
        channel: selectedChannel,
        participants: [],
        isConnectedHere: false,
      }
    );
  }, [isVoiceSelected, selectedChannel, voiceChannels]);

  const otherOccupiedVoiceRooms = useMemo(() => {
    if (!isVoiceSelected || !selectedChannel) return occupiedVoiceRooms;
    return occupiedVoiceRooms.filter((room) => room.channel.id !== selectedChannel.id);
  }, [isVoiceSelected, selectedChannel, occupiedVoiceRooms]);

  const renderParticipantRows = (
    participants: RoomParticipantDto[],
    showActiveMic: boolean
  ) => (
    <div className="space-y-1.5">
      {participants.map((participant) => {
        const displayName =
          participant.display_name || participant.username || 'Usuário';
        const isSelf = participant.user_id === currentUserId;
        const isSpeaking = Boolean(participant.is_speaking && !participant.is_muted);

        return (
          <div
            key={participant.user_id}
            className="flex items-center justify-between gap-2 min-w-0 py-0.5"
          >
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <div
                className={`rounded-full shrink-0 ${
                  isSpeaking ? 'ring-2 ring-emerald-400' : ''
                }`}
              >
                <Avatar
                  name={displayName}
                  avatarUrl={participant.avatar_url}
                  size="sm"
                  showStatus={false}
                  shapeClassName="rounded-full ring-1 ring-white/[0.1]"
                />
              </div>
              <span className="text-[12.5px] font-medium text-zinc-100 truncate">
                {displayName}
                {isSelf && (
                  <span className="text-[11px] font-normal text-zinc-400"> (Você)</span>
                )}
              </span>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {participant.is_screen_sharing && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#E04F64]/20 border border-[#E04F64]/45 text-[9px] font-extrabold text-[#E04F64] uppercase tracking-wider">
                  <Monitor className="w-2.5 h-2.5" />
                  LIVE
                </span>
              )}
              {participant.is_muted ? (
                <MicOff className="w-3.5 h-3.5 text-rose-400" />
              ) : (
                showActiveMic && (
                  <Mic
                    className={`w-3.5 h-3.5 ${
                      isSpeaking ? 'text-emerald-400' : 'text-zinc-400'
                    }`}
                  />
                )
              )}
              {participant.is_deafened && (
                <Headphones className="w-3.5 h-3.5 text-rose-400" />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  const renderVoiceRoomCard = (
    room: CommunityVoiceChannelPresence,
    headingPrefix = 'Em Voz'
  ) => (
    <div
      key={room.channel.id}
      className="rounded-2xl border border-white/[0.07] bg-[#121520]/90 p-3 space-y-2.5 min-w-0"
    >
      <button
        type="button"
        onClick={() => onSelectChannel(room.channel.id)}
        className="w-full flex items-center justify-between gap-2 text-left group cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70"
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <Volume2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <span className="text-[12.5px] font-bold text-white truncate group-hover:text-[#E04F64] transition-colors">
            {headingPrefix} — {room.channel.name} ({room.participants.length})
          </span>
        </div>
        <ChevronRight className="w-3.5 h-3.5 text-zinc-500 group-hover:text-white shrink-0 transition-colors" />
      </button>

      {renderParticipantRows(room.participants, false)}
    </div>
  );

  const renderMembersSection = () => (
    <section aria-label="Membros da comunidade" className="space-y-2 min-w-0">
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <Users className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
          <h3 className="text-[12px] font-bold uppercase tracking-wider text-zinc-300 truncate">
            Membros ({members.length})
          </h3>
        </div>

        <button
          type="button"
          aria-label={isSearchOpen ? 'Fechar busca de membros' : 'Buscar membros'}
          aria-expanded={isSearchOpen}
          onClick={() => {
            setIsSearchOpen((prev) => {
              if (prev) setMemberSearch('');
              return !prev;
            });
          }}
          className={`p-1 rounded-lg transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70 ${
            isSearchOpen
              ? 'bg-[#C83E52]/20 text-[#E04F64]'
              : 'text-zinc-400 hover:text-white hover:bg-white/[0.06]'
          }`}
        >
          {isSearchOpen ? <X className="w-3.5 h-3.5" /> : <Search className="w-3.5 h-3.5" />}
        </button>
      </div>

      {isSearchOpen && (
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={memberSearch}
            onChange={(e) => setMemberSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setMemberSearch('');
                setIsSearchOpen(false);
              }
            }}
            placeholder="Filtrar membros..."
            aria-label="Filtrar membros"
            autoFocus
            className="w-full pl-8 pr-7 py-1.5 rounded-xl bg-[#131622] border border-white/[0.08] focus:border-[#E04F64]/60 text-[12px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
          />
          {memberSearch && (
            <button
              type="button"
              aria-label="Limpar busca"
              onClick={() => setMemberSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-white cursor-pointer"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      )}

      <CommunityMemberList
        members={members}
        voiceActivityByUserId={voiceActivityByUserId}
        searchQuery={memberSearch}
      />
    </section>
  );

  // Context B: Voice channel currently selected
  if (isVoiceSelected && selectedVoiceRoom) {
    const limitLabel = selectedVoiceRoom.channel.voice_user_limit
      ? `${selectedVoiceRoom.participants.length} / ${selectedVoiceRoom.channel.voice_user_limit}`
      : `${selectedVoiceRoom.participants.length}`;

    return (
      <div className="space-y-4 min-w-0">
        {/* Current Voice Room Priority Card */}
        <section
          aria-label={`Sala de Voz Atual — ${selectedVoiceRoom.channel.name}`}
          className="rounded-2xl border border-[#C83E52]/30 bg-gradient-to-br from-[#19131D] via-[#121520] to-[#0E1018] p-3 space-y-2.5 min-w-0"
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <Volume2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <h3 className="text-[12.5px] font-bold text-white truncate">
              Sala de Voz Atual — {selectedVoiceRoom.channel.name}
            </h3>
          </div>

          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border font-semibold ${
                selectedVoiceRoom.isConnectedHere
                  ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                  : 'bg-white/[0.05] border-white/[0.08] text-zinc-300'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  selectedVoiceRoom.isConnectedHere ? 'bg-emerald-400' : 'bg-zinc-400'
                }`}
              />
              {selectedVoiceRoom.isConnectedHere ? 'Conectado' : 'Visualizando sala'}
            </span>

            <span className="text-zinc-400 font-medium tabular-nums shrink-0">
              {limitLabel}
            </span>
          </div>

          {selectedVoiceRoom.participants.length === 0 ? (
            <p className="text-[12px] text-zinc-400 py-1">
              Nenhum participante conectado no momento
            </p>
          ) : (
            renderParticipantRows(selectedVoiceRoom.participants, true)
          )}
        </section>

        {/* Active Streams in Context B */}
        {activeStreams.length > 0 && (
          <section aria-label="Transmissões Ativas" className="space-y-2 min-w-0">
            <div className="flex items-center justify-between gap-2 px-1">
              <div className="flex items-center gap-1.5 min-w-0">
                <Radio className="w-3.5 h-3.5 text-[#E04F64] shrink-0" />
                <h3 className="text-[12px] font-bold uppercase tracking-wider text-zinc-200 truncate">
                  Transmissões Ativas
                </h3>
              </div>
              {activeStreams.length > 1 && (
                <span className="px-1.5 py-0.5 rounded-full bg-white/[0.07] text-[10px] font-semibold text-zinc-300 tabular-nums shrink-0">
                  {activeStreams.length}
                </span>
              )}
            </div>

            <div className="space-y-2.5">
              {activeStreams.map((stream) => (
                <NowLiveCard
                  key={stream.key}
                  stream={stream}
                  isViewingRoom={stream.voiceChannelId === selectedVoiceRoom.channel.id}
                  onWatch={onWatchStream}
                />
              ))}
            </div>
          </section>
        )}

        {/* Other Occupied Voice Rooms */}
        {otherOccupiedVoiceRooms.length > 0 && (
          <section aria-label="Outras Salas em Voz" className="space-y-2 min-w-0">
            <div className="flex items-center gap-1.5 px-1">
              <Volume2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <h3 className="text-[12px] font-bold uppercase tracking-wider text-zinc-300 truncate">
                Outras Salas em Voz
              </h3>
            </div>

            <div className="space-y-2">
              {otherOccupiedVoiceRooms.map((room) =>
                renderVoiceRoomCard(room, 'Em Voz')
              )}
            </div>
          </section>
        )}

        {renderMembersSection()}
      </div>
    );
  }

  // Context A & Context C: Text channel selected (Context C hides NOW LIVE & IN VOICE completely when inactive)
  return (
    <div className="space-y-4 min-w-0">
      {activeStreams.length > 0 && (
        <section aria-label="Ao Vivo Agora" className="space-y-2 min-w-0">
          <div className="flex items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <Radio className="w-3.5 h-3.5 text-[#E04F64] shrink-0" />
              <h3 className="text-[12px] font-bold uppercase tracking-wider text-zinc-200 truncate">
                Ao Vivo Agora
              </h3>
            </div>
            {activeStreams.length > 1 && (
              <span className="px-1.5 py-0.5 rounded-full bg-white/[0.07] text-[10px] font-semibold text-zinc-300 tabular-nums shrink-0">
                {activeStreams.length}
              </span>
            )}
          </div>

          <div className="space-y-2.5">
            {activeStreams.map((stream) => (
              <NowLiveCard
                key={stream.key}
                stream={stream}
                isViewingRoom={false}
                onWatch={onWatchStream}
              />
            ))}
          </div>
        </section>
      )}

      {occupiedVoiceRooms.length > 0 && (
        <section aria-label="Em Voz" className="space-y-2 min-w-0">
          {occupiedVoiceRooms.map((room) => renderVoiceRoomCard(room, 'Em Voz'))}
        </section>
      )}

      {renderMembersSection()}
    </div>
  );
};
