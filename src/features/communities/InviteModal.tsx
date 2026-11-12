import React, { useState, useEffect } from 'react';
import { X, Link2, Copy, Check, Trash2, Loader2, AlertCircle, Plus } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { CommunityDto, CommunityInviteDto } from '../../lib/types';
import { formatDateTimePtBr, hasCommunityOrAdminPermission } from './communityUtils';

interface InviteModalProps {
  isOpen: boolean;
  community: CommunityDto;
  channelId?: string | null;
  onClose: () => void;
}

const EXPIRY_OPTIONS: { label: string; secs: number | null }[] = [
  { label: '30 minutos', secs: 1800 },
  { label: '1 hora', secs: 3600 },
  { label: '24 horas', secs: 86400 },
  { label: '7 dias', secs: 604800 },
  { label: 'Sem expiração', secs: null },
];

export const InviteModal: React.FC<InviteModalProps> = ({
  isOpen,
  community,
  channelId = null,
  onClose,
}) => {
  const communityInvites = useAppStore((state) => state.communityInvites);
  const createCommunityInvite = useAppStore((state) => state.createCommunityInvite);
  const loadCommunityInvites = useAppStore((state) => state.loadCommunityInvites);
  const revokeCommunityInvite = useAppStore((state) => state.revokeCommunityInvite);

  const [maxUses, setMaxUses] = useState<string>('');
  const [expiresInSecs, setExpiresInSecs] = useState<number | null>(86400);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canCreate = hasCommunityOrAdminPermission(
    community.effective_permissions,
    'CREATE_INVITES'
  );
  const canManage = hasCommunityOrAdminPermission(
    community.effective_permissions,
    'MANAGE_COMMUNITY'
  );

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    if (canCreate || canManage) {
      setIsLoading(true);
      loadCommunityInvites(community.id)
        .catch((err: any) => setError(err?.message || 'Erro ao carregar convites.'))
        .finally(() => setIsLoading(false));
    }
  }, [isOpen, community.id, canCreate, canManage, loadCommunityInvites]);

  if (!isOpen) return null;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsCreating(true);
    setError(null);
    try {
      const parsedMaxUses = maxUses.trim() ? Number(maxUses.trim()) : null;
      await createCommunityInvite(community.id, {
        channel_id: channelId ?? null,
        max_uses: parsedMaxUses && parsedMaxUses > 0 ? parsedMaxUses : null,
        expires_in_secs: expiresInSecs,
      });
      setMaxUses('');
    } catch (err: any) {
      setError(err?.message || 'Não foi possível criar o convite.');
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      setError('Não foi possível copiar para a área de transferência.');
    }
  };

  const handleRevoke = async (invite: CommunityInviteDto) => {
    setError(null);
    try {
      await revokeCommunityInvite(community.id, invite.id);
    } catch (err: any) {
      setError(err?.message || 'Não foi possível revogar o convite.');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-nexus-surface border border-nexus-border rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-nexus-border bg-nexus-panel/50">
          <div className="flex items-center gap-2.5 min-w-0">
            <Link2 className="w-5 h-5 text-nexus-accent shrink-0" />
            <h3 className="text-sm font-bold text-nexus-text truncate">
              Convidar para {community.name}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-nexus-muted hover:text-nexus-text hover:bg-nexus-surface transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-5">
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {canCreate ? (
            <form onSubmit={handleCreate} className="space-y-3 p-3.5 rounded-lg bg-nexus-panel/50 border border-nexus-border">
              <div className="text-xs font-semibold text-nexus-text">Gerar novo convite</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-nexus-muted mb-1">Expira em</label>
                  <select
                    value={expiresInSecs === null ? 'never' : String(expiresInSecs)}
                    onChange={(e) =>
                      setExpiresInSecs(e.target.value === 'never' ? null : Number(e.target.value))
                    }
                    className="w-full px-2.5 py-1.5 rounded-lg bg-nexus-bg border border-nexus-border text-xs text-nexus-text focus:outline-none focus:border-nexus-accent"
                  >
                    {EXPIRY_OPTIONS.map((opt) => (
                      <option key={opt.label} value={opt.secs === null ? 'never' : String(opt.secs)}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-nexus-muted mb-1">
                    Limite de usos (opcional)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={maxUses}
                    onChange={(e) => setMaxUses(e.target.value)}
                    placeholder="Ilimitado"
                    className="w-full px-2.5 py-1.5 rounded-lg bg-nexus-bg border border-nexus-border text-xs text-nexus-text placeholder:text-nexus-muted focus:outline-none focus:border-nexus-accent"
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={isCreating}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-nexus-accent hover:bg-nexus-accent/90 text-white disabled:opacity-50 flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  {isCreating ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Plus className="w-3.5 h-3.5" />
                  )}
                  <span>Gerar Convite</span>
                </button>
              </div>
            </form>
          ) : (
            <p className="text-xs text-nexus-muted">
              Você não possui permissão para criar convites nesta comunidade.
            </p>
          )}

          <div className="space-y-2">
            <div className="text-xs font-semibold text-nexus-text">Convites ativos</div>
            {isLoading ? (
              <div className="flex items-center gap-2 py-4 text-xs text-nexus-muted">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Carregando convites...</span>
              </div>
            ) : communityInvites.length === 0 ? (
              <p className="text-xs text-nexus-muted py-2">Nenhum convite ativo no momento.</p>
            ) : (
              <div className="space-y-2">
                {communityInvites.map((inv) => {
                  const inviteLink = `nexus://invite/${inv.code}`;
                  const isRevoked = Boolean(inv.revoked_at);
                  return (
                    <div
                      key={inv.id}
                      className={`flex items-center justify-between gap-3 p-3 rounded-lg border border-nexus-border bg-nexus-bg/60 ${
                        isRevoked ? 'opacity-50' : ''
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <code className="text-xs font-mono font-bold text-nexus-text">
                            {inv.code}
                          </code>
                          {isRevoked && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300">
                              Revogado
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-nexus-muted mt-0.5">
                          Usos: {inv.uses_count}
                          {inv.max_uses ? ` / ${inv.max_uses}` : ' (ilimitado)'} • Expira:{' '}
                          {inv.expires_at ? formatDateTimePtBr(inv.expires_at) : 'Nunca'}
                        </p>
                      </div>

                      {!isRevoked && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleCopy(inviteLink, `link_${inv.id}`)}
                            className="px-2.5 py-1 rounded bg-nexus-panel hover:bg-nexus-surface border border-nexus-border text-[11px] text-nexus-text flex items-center gap-1 cursor-pointer"
                            title="Copiar link nexus://invite/..."
                          >
                            {copiedKey === `link_${inv.id}` ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                            <span>Link</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCopy(inv.code, `code_${inv.id}`)}
                            className="px-2 py-1 rounded bg-nexus-panel hover:bg-nexus-surface border border-nexus-border text-[11px] text-nexus-muted hover:text-nexus-text cursor-pointer"
                            title="Copiar código"
                          >
                            {copiedKey === `code_${inv.id}` ? 'Copiado' : 'Código'}
                          </button>
                          {(canManage || canCreate) && (
                            <button
                              type="button"
                              onClick={() => handleRevoke(inv)}
                              className="p-1.5 rounded text-nexus-muted hover:text-rose-400 hover:bg-rose-500/10 cursor-pointer"
                              title="Revogar convite"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
