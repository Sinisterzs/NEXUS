import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { CommunityDto } from '../../lib/types';
import { Tooltip } from '../../components/Tooltip';
import { Badge } from '../../components/Badge';
import { cn } from '../../lib/utils';

export interface CommunityServerRailProps {
  communities: CommunityDto[];
  selectedCommunityId: string | null;
  onSelectCommunity: (communityId: string) => void;
  onOpenCreateJoinModal: () => void;
}

export const CommunityServerRail: React.FC<CommunityServerRailProps> = ({
  communities,
  selectedCommunityId,
  onSelectCommunity,
  onOpenCreateJoinModal,
}) => {
  const [brokenIconIds, setBrokenIconIds] = useState<Record<string, boolean>>({});

  return (
    <aside
      aria-label="Servidores de comunidades"
      className="w-[58px] my-2 ml-1.5 rounded-2xl bg-[#0C0E15]/95 border border-white/[0.06] py-3 gap-2.5 shadow-xl flex flex-col items-center shrink-0 select-none z-10"
    >
      <div className="flex-1 w-full overflow-y-auto no-scrollbar [&::-webkit-scrollbar]:hidden [scrollbar-width:none] flex flex-col items-center gap-2.5 px-1.5 py-0.5">
        {communities.map((comm) => {
          const isSelected = comm.id === selectedCommunityId;
          const unreadCount = comm.unread_count ?? 0;
          const fallbackInitials =
            comm.initials?.trim() || comm.name.slice(0, 2).toUpperCase();
          const showIconImage = Boolean(comm.icon_url && !brokenIconIds[comm.id]);

          return (
            <div
              key={comm.id}
              className="relative w-full flex items-center justify-center group"
            >
              <span
                aria-hidden="true"
                className={cn(
                  'absolute -left-1.5 rounded-r-full transition-all duration-150',
                  isSelected
                    ? 'h-6 w-1 bg-[#E04F64] shadow-[0_0_10px_rgba(224,79,100,0.65)]'
                    : 'h-0 w-1 bg-zinc-300/75 group-hover:h-3'
                )}
              />

              <Tooltip content={comm.name} position="right" portal>
                <button
                  type="button"
                  onClick={() => onSelectCommunity(comm.id)}
                  aria-label={comm.name}
                  aria-pressed={isSelected}
                  className={cn(
                    'relative w-10 h-10 rounded-full flex items-center justify-center transition-all duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]',
                    isSelected
                      ? 'ring-2 ring-[#E04F64] shadow-[0_0_18px_rgba(224,79,100,0.42)]'
                      : 'border border-white/[0.08] hover:border-white/25 hover:scale-105'
                  )}
                >
                  <div className="w-full h-full rounded-full overflow-hidden flex items-center justify-center bg-[#0D0F17]">
                    {showIconImage ? (
                      <img
                        src={comm.icon_url!}
                        alt={comm.name}
                        onError={() =>
                          setBrokenIconIds((prev) => ({ ...prev, [comm.id]: true }))
                        }
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="relative w-full h-full flex items-center justify-center rounded-full bg-gradient-to-br from-[#281520] via-[#151824] to-[#0D0F17] ring-1 ring-inset ring-white/[0.08]">
                        {comm.icon_bg && (
                          <span
                            aria-hidden="true"
                            className="absolute inset-0 rounded-full opacity-20"
                            style={{
                              background: `radial-gradient(circle at 30% 25%, ${comm.icon_bg}, transparent 72%)`,
                            }}
                          />
                        )}
                        <span className="relative z-10 text-xs font-extrabold text-white tracking-tight">
                          {fallbackInitials}
                        </span>
                      </span>
                    )}
                  </div>

                  {unreadCount > 0 && (
                    <Badge
                      count={unreadCount}
                      className="absolute -top-1 -right-1 z-10"
                    />
                  )}
                </button>
              </Tooltip>
            </div>
          );
        })}
      </div>

      <div className="w-7 h-[1px] bg-white/[0.08] shrink-0" />

      <Tooltip content="Criar ou entrar em comunidade" position="right" portal>
        <button
          type="button"
          onClick={onOpenCreateJoinModal}
          aria-label="Criar ou entrar em comunidade"
          className="w-10 h-10 rounded-full bg-[#121520] hover:bg-nexus-accent/15 border border-white/[0.08] hover:border-[#E04F64]/50 text-zinc-400 hover:text-[#E04F64] hover:scale-105 flex items-center justify-center transition-all duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]"
        >
          <Plus className="w-4.5 h-4.5" />
        </button>
      </Tooltip>
    </aside>
  );
};
