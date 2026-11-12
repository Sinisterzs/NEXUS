import React, { useState, useEffect } from 'react';
import {
  X,
  Hash,
  Volume2,
  FolderPlus,
  Lock,
  Shield,
  Trash2,
  Loader2,
  AlertCircle,
  Check,
  Minus,
} from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import {
  ChannelPermissionOverwriteDto,
  CommunityCategoryDto,
  CommunityChannelDto,
  CommunityChannelType,
  CommunityMemberDto,
  CommunityPermissionFlag,
  CommunityRoleDto,
  OverwriteTargetType,
  flagsToBitmaskStr,
} from '../../lib/types';
import {
  COMMUNITY_PERMISSION_META,
  hasCommunityOrAdminPermission,
} from './communityUtils';

export type ChannelManageMode =
  | { kind: 'create_category' }
  | { kind: 'edit_category'; category: CommunityCategoryDto }
  | { kind: 'create_channel'; defaultCategoryId?: string | null; defaultType?: CommunityChannelType }
  | { kind: 'edit_channel'; channel: CommunityChannelDto };

interface ChannelManageModalProps {
  isOpen: boolean;
  mode: ChannelManageMode | null;
  communityId: string;
  effectivePermissions: string;
  categories: CommunityCategoryDto[];
  roles: CommunityRoleDto[];
  members: CommunityMemberDto[];
  onClose: () => void;
}

type TriState = 'allow' | 'neutral' | 'deny';

export const ChannelManageModal: React.FC<ChannelManageModalProps> = ({
  isOpen,
  mode,
  communityId,
  effectivePermissions,
  categories,
  roles,
  members,
  onClose,
}) => {
  const createCommunityCategory = useAppStore((state) => state.createCommunityCategory);
  const updateCommunityCategory = useAppStore((state) => state.updateCommunityCategory);
  const createCommunityChannel = useAppStore((state) => state.createCommunityChannel);
  const updateCommunityChannel = useAppStore((state) => state.updateCommunityChannel);
  const listChannelOverwrites = useAppStore((state) => state.listChannelOverwrites);
  const upsertChannelOverwrite = useAppStore((state) => state.upsertChannelOverwrite);
  const deleteChannelOverwrite = useAppStore((state) => state.deleteChannelOverwrite);

  const [tab, setTab] = useState<'general' | 'overwrites'>('general');
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [categoryId, setCategoryId] = useState<string>('');
  const [channelType, setChannelType] = useState<CommunityChannelType>('text');
  const [isPrivate, setIsPrivate] = useState(false);
  const [isReadOnly, setIsReadOnly] = useState(false);

  // Overwrites state
  const [overwrites, setOverwrites] = useState<ChannelPermissionOverwriteDto[]>([]);
  const [isLoadingOverwrites, setIsLoadingOverwrites] = useState(false);
  const [selectedTargetKey, setSelectedTargetKey] = useState<string>('');
  const [flagStates, setFlagStates] = useState<Record<string, TriState>>({});

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canManageOverwrites =
    hasCommunityOrAdminPermission(effectivePermissions, 'MANAGE_ROLES') ||
    hasCommunityOrAdminPermission(effectivePermissions, 'MANAGE_CHANNELS');

  useEffect(() => {
    if (!isOpen || !mode) return;
    setError(null);
    setTab('general');

    if (mode.kind === 'create_category') {
      setName('');
    } else if (mode.kind === 'edit_category') {
      setName(mode.category.name);
    } else if (mode.kind === 'create_channel') {
      setName('');
      setTopic('');
      setCategoryId(mode.defaultCategoryId ?? '');
      setChannelType(mode.defaultType ?? 'text');
      setIsPrivate(false);
      setIsReadOnly(false);
    } else if (mode.kind === 'edit_channel') {
      setName(mode.channel.name);
      setTopic(mode.channel.topic || '');
      setCategoryId(mode.channel.category_id || '');
      setChannelType(
        mode.channel.channel_type === 'voice' ? 'voice' : 'text'
      );
      setIsPrivate(mode.channel.is_private);
      setIsReadOnly(mode.channel.is_read_only);
      setOverwrites(mode.channel.overwrites || []);

      if (canManageOverwrites) {
        setIsLoadingOverwrites(true);
        listChannelOverwrites(communityId, mode.channel.id)
          .then((list) => setOverwrites(list))
          .catch((err: any) =>
            setError(err?.message || 'Erro ao carregar permissões do canal.')
          )
          .finally(() => setIsLoadingOverwrites(false));
      }
    }
  }, [isOpen, mode, communityId, canManageOverwrites, listChannelOverwrites]);

  useEffect(() => {
    if (!selectedTargetKey) {
      if (roles.length > 0) {
        setSelectedTargetKey(`role:${roles[0].id}`);
      } else if (members.length > 0) {
        setSelectedTargetKey(`user:${members[0].user_id}`);
      }
      return;
    }

    const [targetType, targetId] = selectedTargetKey.split(':');
    const existing = overwrites.find(
      (ow) => ow.target_type === targetType && ow.target_id === targetId
    );
    const next: Record<string, TriState> = {};
    for (const meta of COMMUNITY_PERMISSION_META) {
      if (existing?.allow_flags?.includes(meta.flag)) {
        next[meta.flag] = 'allow';
      } else if (existing?.deny_flags?.includes(meta.flag)) {
        next[meta.flag] = 'deny';
      } else {
        next[meta.flag] = 'neutral';
      }
    }
    setFlagStates(next);
  }, [selectedTargetKey, overwrites, roles, members]);

  if (!isOpen || !mode) return null;

  const isCategory = mode.kind === 'create_category' || mode.kind === 'edit_category';
  const isEditingChannel = mode.kind === 'edit_channel';

  const handleSubmitGeneral = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('O nome é obrigatório.');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      if (mode.kind === 'create_category') {
        await createCommunityCategory(communityId, { name: trimmedName });
      } else if (mode.kind === 'edit_category') {
        await updateCommunityCategory(communityId, mode.category.id, { name: trimmedName });
      } else if (mode.kind === 'create_channel') {
        await createCommunityChannel(communityId, {
          name: trimmedName,
          channel_type: channelType,
          category_id: categoryId || null,
          topic: topic.trim() || null,
          is_private: isPrivate,
          is_read_only: isReadOnly,
        });
      } else if (mode.kind === 'edit_channel') {
        await updateCommunityChannel(communityId, mode.channel.id, {
          name: trimmedName,
          category_id: categoryId || null,
          topic: topic.trim() || null,
          is_private: isPrivate,
          is_read_only: isReadOnly,
        });
      }
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Erro ao salvar alterações.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSaveOverwrite = async () => {
    if (!isEditingChannel || !selectedTargetKey) return;
    const [targetType, targetId] = selectedTargetKey.split(':') as [OverwriteTargetType, string];
    const allowFlags: CommunityPermissionFlag[] = [];
    const denyFlags: CommunityPermissionFlag[] = [];

    for (const meta of COMMUNITY_PERMISSION_META) {
      const state = flagStates[meta.flag] || 'neutral';
      if (state === 'allow') allowFlags.push(meta.flag);
      else if (state === 'deny') denyFlags.push(meta.flag);
    }

    setIsSubmitting(true);
    setError(null);
    try {
      const saved = await upsertChannelOverwrite(communityId, mode.channel.id, {
        target_type: targetType,
        target_id: targetId,
        allow_flags: allowFlags,
        allow_bitmask: flagsToBitmaskStr(allowFlags),
        deny_flags: denyFlags,
        deny_bitmask: flagsToBitmaskStr(denyFlags),
      });
      if (saved) {
        setOverwrites((prev) => [
          ...prev.filter((o) => !(o.target_type === targetType && o.target_id === targetId)),
          saved,
        ]);
      }
    } catch (err: any) {
      setError(err?.message || 'Erro ao salvar sobrescrita de permissão.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteOverwrite = async () => {
    if (!isEditingChannel || !selectedTargetKey) return;
    const [targetType, targetId] = selectedTargetKey.split(':');
    setIsSubmitting(true);
    setError(null);
    try {
      await deleteChannelOverwrite(communityId, mode.channel.id, targetType, targetId);
      setOverwrites((prev) =>
        prev.filter((o) => !(o.target_type === targetType && o.target_id === targetId))
      );
    } catch (err: any) {
      setError(err?.message || 'Erro ao remover sobrescrita.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const modalTitle =
    mode.kind === 'create_category'
      ? 'Nova Categoria'
      : mode.kind === 'edit_category'
      ? `Editar Categoria: ${mode.category.name}`
      : mode.kind === 'create_channel'
      ? 'Novo Canal'
      : `Editar Canal: #${mode.channel.name}`;

  const [selectedTargetType, selectedTargetId] = selectedTargetKey.split(':');
  const hasExistingOverwrite = overwrites.some(
    (o) => o.target_type === selectedTargetType && o.target_id === selectedTargetId
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-nexus-surface border border-nexus-border rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-nexus-border bg-nexus-panel/50">
          <div className="flex items-center gap-2.5 min-w-0">
            {isCategory ? (
              <FolderPlus className="w-5 h-5 text-nexus-accent shrink-0" />
            ) : channelType === 'voice' ? (
              <Volume2 className="w-5 h-5 text-emerald-400 shrink-0" />
            ) : (
              <Hash className="w-5 h-5 text-nexus-accent shrink-0" />
            )}
            <h3 className="text-sm font-bold text-nexus-text truncate">{modalTitle}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-nexus-muted hover:text-nexus-text hover:bg-nexus-surface transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {isEditingChannel && canManageOverwrites && (
          <div className="flex items-center gap-1 px-5 pt-3 border-b border-nexus-border/60 bg-nexus-bg/50 text-xs">
            <button
              type="button"
              onClick={() => setTab('general')}
              className={`pb-2.5 px-3 font-medium border-b-2 transition-colors cursor-pointer ${
                tab === 'general'
                  ? 'border-nexus-accent text-nexus-text font-bold'
                  : 'border-transparent text-nexus-muted hover:text-nexus-text'
              }`}
            >
              Geral
            </button>
            <button
              type="button"
              onClick={() => setTab('overwrites')}
              className={`pb-2.5 px-3 font-medium border-b-2 transition-colors flex items-center gap-1.5 cursor-pointer ${
                tab === 'overwrites'
                  ? 'border-nexus-accent text-nexus-text font-bold'
                  : 'border-transparent text-nexus-muted hover:text-nexus-text'
              }`}
            >
              <Shield className="w-3.5 h-3.5" />
              <span>Permissões do Canal ({overwrites.length})</span>
            </button>
          </div>
        )}

        <div className="p-5 overflow-y-auto space-y-4">
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {tab === 'general' ? (
            <form onSubmit={handleSubmitGeneral} className="space-y-4">
              {mode.kind === 'create_channel' && (
                <div>
                  <label className="block text-xs font-semibold text-nexus-text mb-1.5">
                    Tipo de canal
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setChannelType('text')}
                      className={`flex items-center gap-2 p-2.5 rounded-lg border text-xs text-left cursor-pointer ${
                        channelType === 'text'
                          ? 'border-nexus-accent bg-nexus-accent/15 text-nexus-text'
                          : 'border-nexus-border bg-nexus-bg text-nexus-muted'
                      }`}
                    >
                      <Hash className="w-4 h-4 shrink-0" />
                      <div>
                        <div className="font-semibold">Texto</div>
                        <div className="text-[10px] opacity-80">Mensagens e histórico</div>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setChannelType('voice')}
                      className={`flex items-center gap-2 p-2.5 rounded-lg border text-xs text-left cursor-pointer ${
                        channelType === 'voice'
                          ? 'border-nexus-accent bg-nexus-accent/15 text-nexus-text'
                          : 'border-nexus-border bg-nexus-bg text-nexus-muted'
                      }`}
                    >
                      <Volume2 className="w-4 h-4 shrink-0 text-emerald-400" />
                      <div>
                        <div className="font-semibold">Voz</div>
                        <div className="text-[10px] opacity-80">Disponível na Fase B3</div>
                      </div>
                    </button>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-nexus-text mb-1.5">
                  Nome *
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={isCategory ? 'Ex.: Geral' : 'Ex.: bate-papo'}
                  maxLength={64}
                  required
                  className="w-full px-3 py-2 rounded-lg bg-nexus-bg border border-nexus-border text-xs text-nexus-text placeholder:text-nexus-muted focus:outline-none focus:border-nexus-accent"
                />
              </div>

              {!isCategory && (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-nexus-text mb-1.5">
                      Categoria
                    </label>
                    <select
                      value={categoryId}
                      onChange={(e) => setCategoryId(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-nexus-bg border border-nexus-border text-xs text-nexus-text focus:outline-none focus:border-nexus-accent"
                    >
                      <option value="">Sem categoria</option>
                      {[...categories]
                        .sort((a, b) => a.position - b.position)
                        .map((cat) => (
                          <option key={cat.id} value={cat.id}>
                            {cat.name}
                          </option>
                        ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-nexus-text mb-1.5">
                      Tópico (opcional)
                    </label>
                    <input
                      type="text"
                      value={topic}
                      onChange={(e) => setTopic(e.target.value)}
                      placeholder="Assunto ou regras do canal..."
                      maxLength={200}
                      className="w-full px-3 py-2 rounded-lg bg-nexus-bg border border-nexus-border text-xs text-nexus-text placeholder:text-nexus-muted focus:outline-none focus:border-nexus-accent"
                    />
                  </div>

                  <div className="space-y-2 pt-1">
                    <label className="flex items-center justify-between p-2.5 rounded-lg bg-nexus-bg/70 border border-nexus-border cursor-pointer">
                      <div className="flex items-center gap-2">
                        <Lock className="w-4 h-4 text-nexus-muted" />
                        <div>
                          <div className="text-xs font-semibold text-nexus-text">Canal privado</div>
                          <div className="text-[11px] text-nexus-muted">
                            Apenas cargos ou membros autorizados podem visualizar.
                          </div>
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={isPrivate}
                        onChange={(e) => setIsPrivate(e.target.checked)}
                        className="accent-nexus-accent"
                      />
                    </label>

                    <label className="flex items-center justify-between p-2.5 rounded-lg bg-nexus-bg/70 border border-nexus-border cursor-pointer">
                      <div className="flex items-center gap-2">
                        <Shield className="w-4 h-4 text-nexus-muted" />
                        <div>
                          <div className="text-xs font-semibold text-nexus-text">
                            Canal somente leitura
                          </div>
                          <div className="text-[11px] text-nexus-muted">
                            Somente moderadores/administradores podem enviar mensagens.
                          </div>
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={isReadOnly}
                        onChange={(e) => setIsReadOnly(e.target.checked)}
                        className="accent-nexus-accent"
                      />
                    </label>
                  </div>
                </>
              )}

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-nexus-border">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3.5 py-2 rounded-lg text-xs font-medium text-nexus-muted hover:text-nexus-text hover:bg-nexus-panel transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !name.trim()}
                  className="px-4 py-2 rounded-lg text-xs font-semibold bg-nexus-accent hover:bg-nexus-accent/90 text-white disabled:opacity-50 flex items-center gap-2 transition-colors cursor-pointer"
                >
                  {isSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>Salvar</span>
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              {isLoadingOverwrites ? (
                <div className="flex items-center gap-2 py-6 text-xs text-nexus-muted">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Carregando sobrescritas...</span>
                </div>
              ) : (
                <>
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <label className="block text-xs font-semibold text-nexus-text mb-1">
                        Cargo ou Membro
                      </label>
                      <select
                        value={selectedTargetKey}
                        onChange={(e) => setSelectedTargetKey(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-nexus-bg border border-nexus-border text-xs text-nexus-text focus:outline-none focus:border-nexus-accent"
                      >
                        <optgroup label="Cargos">
                          {[...roles]
                            .sort((a, b) => b.position - a.position)
                            .map((r) => (
                              <option key={r.id} value={`role:${r.id}`}>
                                Cargo: {r.name}
                              </option>
                            ))}
                        </optgroup>
                        <optgroup label="Membros">
                          {members.map((m) => (
                            <option key={m.user_id} value={`user:${m.user_id}`}>
                              Membro: {m.nickname || m.display_name || m.username}
                            </option>
                          ))}
                        </optgroup>
                      </select>
                    </div>
                    {hasExistingOverwrite && (
                      <button
                        type="button"
                        onClick={handleDeleteOverwrite}
                        disabled={isSubmitting}
                        className="px-3 py-2 rounded-lg border border-rose-500/30 text-rose-400 hover:bg-rose-500/10 text-xs flex items-center gap-1 cursor-pointer"
                        title="Remover sobrescrita deste alvo"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Remover</span>
                      </button>
                    )}
                  </div>

                  <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                    {COMMUNITY_PERMISSION_META.filter((m) => m.flag !== 'ADMINISTRATOR').map(
                      (meta) => {
                        const current = flagStates[meta.flag] || 'neutral';
                        return (
                          <div
                            key={meta.flag}
                            className="flex items-center justify-between gap-3 p-2 rounded-lg bg-nexus-bg/60 border border-nexus-border/70"
                          >
                            <div className="min-w-0">
                              <div className="text-xs font-medium text-nexus-text">
                                {meta.label}
                              </div>
                              <div className="text-[10px] text-nexus-muted truncate">
                                {meta.description}
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() =>
                                  setFlagStates((prev) => ({ ...prev, [meta.flag]: 'deny' }))
                                }
                                className={`p-1.5 rounded border text-xs cursor-pointer ${
                                  current === 'deny'
                                    ? 'bg-rose-500/20 border-rose-500 text-rose-400'
                                    : 'border-nexus-border text-nexus-muted hover:text-nexus-text'
                                }`}
                                title="Negar"
                              >
                                <X className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setFlagStates((prev) => ({ ...prev, [meta.flag]: 'neutral' }))
                                }
                                className={`p-1.5 rounded border text-xs cursor-pointer ${
                                  current === 'neutral'
                                    ? 'bg-nexus-panel border-nexus-muted text-nexus-text'
                                    : 'border-nexus-border text-nexus-muted hover:text-nexus-text'
                                }`}
                                title="Herdar"
                              >
                                <Minus className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setFlagStates((prev) => ({ ...prev, [meta.flag]: 'allow' }))
                                }
                                className={`p-1.5 rounded border text-xs cursor-pointer ${
                                  current === 'allow'
                                    ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400'
                                    : 'border-nexus-border text-nexus-muted hover:text-nexus-text'
                                }`}
                                title="Permitir"
                              >
                                <Check className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        );
                      }
                    )}
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-nexus-border">
                    <button
                      type="button"
                      onClick={onClose}
                      className="px-3.5 py-2 rounded-lg text-xs font-medium text-nexus-muted hover:text-nexus-text hover:bg-nexus-panel cursor-pointer"
                    >
                      Fechar
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveOverwrite}
                      disabled={isSubmitting || !selectedTargetKey}
                      className="px-4 py-2 rounded-lg text-xs font-semibold bg-nexus-accent hover:bg-nexus-accent/90 text-white disabled:opacity-50 flex items-center gap-2 cursor-pointer"
                    >
                      {isSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      <span>Salvar Permissões</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
