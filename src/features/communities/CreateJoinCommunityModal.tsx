import React, { useState, useEffect } from 'react';
import {
  X,
  Plus,
  Link2,
  Users,
  Globe,
  Lock,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Search,
} from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { CommunityPrivacy, InvitePreviewDto } from '../../lib/types';
import { deriveInitials, extractInviteCode, formatDateTimePtBr } from './communityUtils';

interface CreateJoinCommunityModalProps {
  isOpen: boolean;
  initialTab?: 'create' | 'join';
  onClose: () => void;
  onSuccess?: () => void;
}

const ICON_BG_PRESETS = [
  '#4f46e5',
  '#0284c7',
  '#059669',
  '#d97706',
  '#e11d48',
  '#7c3aed',
  '#334155',
];

export const CreateJoinCommunityModal: React.FC<CreateJoinCommunityModalProps> = ({
  isOpen,
  initialTab = 'create',
  onClose,
  onSuccess,
}) => {
  const createCommunity = useAppStore((state) => state.createCommunity);
  const previewCommunityInvite = useAppStore((state) => state.previewCommunityInvite);
  const acceptCommunityInvite = useAppStore((state) => state.acceptCommunityInvite);

  const [tab, setTab] = useState<'create' | 'join'>(initialTab);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Create form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [iconUrl, setIconUrl] = useState('');
  const [initials, setInitials] = useState('');
  const [iconBg, setIconBg] = useState(ICON_BG_PRESETS[0]);
  const [privacy, setPrivacy] = useState<CommunityPrivacy>('public');

  // Join form state
  const [inviteInput, setInviteInput] = useState('');
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [preview, setPreview] = useState<InvitePreviewDto | null>(null);

  useEffect(() => {
    if (isOpen) {
      setTab(initialTab);
      setError(null);
      setPreview(null);
    }
  }, [isOpen, initialTab]);

  if (!isOpen) return null;

  const computedInitials = initials.trim() || deriveInitials(name);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName.length < 2) {
      setError('O nome da comunidade deve ter pelo menos 2 caracteres.');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      await createCommunity({
        name: trimmedName,
        description: description.trim() || null,
        icon_url: iconUrl.trim() || null,
        initials: computedInitials,
        icon_bg: iconBg,
        accent_color: iconBg,
        privacy,
      });
      setName('');
      setDescription('');
      setIconUrl('');
      setInitials('');
      onSuccess?.();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Não foi possível criar a comunidade.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePreviewInvite = async () => {
    const code = extractInviteCode(inviteInput);
    if (!code) {
      setError('Informe um código ou link de convite válido.');
      return;
    }

    setIsPreviewing(true);
    setError(null);
    setPreview(null);
    try {
      const res = await previewCommunityInvite(code);
      setPreview(res);
    } catch (err: any) {
      setError(err?.message || 'Convite inválido ou expirado.');
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleAcceptInvite = async () => {
    const code = extractInviteCode(inviteInput);
    if (!code) {
      setError('Informe um código ou link de convite válido.');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      await acceptCommunityInvite(code);
      setInviteInput('');
      setPreview(null);
      onSuccess?.();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Não foi possível entrar na comunidade.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-nexus-surface border border-nexus-border rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-nexus-border bg-nexus-panel/50">
          <div className="flex items-center gap-2.5">
            <Users className="w-5 h-5 text-nexus-accent" />
            <h3 className="text-sm font-bold text-nexus-text">Comunidades NEXUS</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-nexus-muted hover:text-nexus-text hover:bg-nexus-surface transition-colors cursor-pointer"
            title="Fechar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-5 pt-3 border-b border-nexus-border/60 bg-nexus-bg/50 text-xs">
          <button
            type="button"
            onClick={() => {
              setTab('create');
              setError(null);
            }}
            className={`pb-2.5 px-3 font-medium border-b-2 transition-colors flex items-center gap-2 cursor-pointer ${
              tab === 'create'
                ? 'border-nexus-accent text-nexus-text font-bold'
                : 'border-transparent text-nexus-muted hover:text-nexus-text'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Criar Comunidade</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setTab('join');
              setError(null);
            }}
            className={`pb-2.5 px-3 font-medium border-b-2 transition-colors flex items-center gap-2 cursor-pointer ${
              tab === 'join'
                ? 'border-nexus-accent text-nexus-text font-bold'
                : 'border-transparent text-nexus-muted hover:text-nexus-text'
            }`}
          >
            <Link2 className="w-3.5 h-3.5" />
            <span>Entrar por Convite</span>
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto space-y-4">
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {tab === 'create' ? (
            <form onSubmit={handleCreate} className="space-y-4">
              {/* Preview badge */}
              <div className="flex items-center gap-3 p-3 rounded-lg bg-nexus-panel/60 border border-nexus-border">
                {iconUrl.trim() ? (
                  <img
                    src={iconUrl.trim()}
                    alt={name || 'Ícone'}
                    className="w-11 h-11 rounded-xl object-cover shrink-0 bg-nexus-bg"
                  />
                ) : (
                  <div
                    className="w-11 h-11 rounded-xl flex items-center justify-center text-sm font-bold text-white shrink-0"
                    style={{ backgroundColor: iconBg }}
                  >
                    {computedInitials}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-nexus-text truncate">
                    {name.trim() || 'Nova Comunidade'}
                  </p>
                  <p className="text-xs text-nexus-muted truncate">
                    {privacy === 'public' ? 'Comunidade Pública' : 'Comunidade Privada'}
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-nexus-text mb-1.5">
                  Nome da comunidade *
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ex.: Esquadrão Tático"
                  maxLength={80}
                  required
                  className="w-full px-3 py-2 rounded-lg bg-nexus-bg border border-nexus-border text-xs text-nexus-text placeholder:text-nexus-muted focus:outline-none focus:border-nexus-accent"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-nexus-text mb-1.5">
                  Descrição
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Descreva o propósito da comunidade..."
                  rows={2}
                  maxLength={300}
                  className="w-full px-3 py-2 rounded-lg bg-nexus-bg border border-nexus-border text-xs text-nexus-text placeholder:text-nexus-muted focus:outline-none focus:border-nexus-accent resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-nexus-text mb-1.5">
                    Iniciais
                  </label>
                  <input
                    type="text"
                    value={initials}
                    onChange={(e) => setInitials(e.target.value.toUpperCase().slice(0, 3))}
                    placeholder={deriveInitials(name)}
                    maxLength={3}
                    className="w-full px-3 py-2 rounded-lg bg-nexus-bg border border-nexus-border text-xs text-nexus-text placeholder:text-nexus-muted focus:outline-none focus:border-nexus-accent"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-nexus-text mb-1.5">
                    URL do ícone (opcional)
                  </label>
                  <input
                    type="url"
                    value={iconUrl}
                    onChange={(e) => setIconUrl(e.target.value)}
                    placeholder="https://..."
                    className="w-full px-3 py-2 rounded-lg bg-nexus-bg border border-nexus-border text-xs text-nexus-text placeholder:text-nexus-muted focus:outline-none focus:border-nexus-accent"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-nexus-text mb-1.5">
                  Cor do ícone
                </label>
                <div className="flex items-center gap-2 flex-wrap">
                  {ICON_BG_PRESETS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setIconBg(color)}
                      className={`w-6 h-6 rounded-md border-2 transition-transform cursor-pointer ${
                        iconBg === color ? 'border-white scale-110' : 'border-transparent'
                      }`}
                      style={{ backgroundColor: color }}
                      aria-label={`Selecionar cor ${color}`}
                    />
                  ))}
                  <input
                    type="color"
                    value={iconBg}
                    onChange={(e) => setIconBg(e.target.value)}
                    className="w-7 h-7 rounded bg-transparent border border-nexus-border cursor-pointer"
                    title="Cor personalizada"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-nexus-text mb-1.5">
                  Visibilidade
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setPrivacy('public')}
                    className={`flex items-center gap-2 p-2.5 rounded-lg border text-left text-xs transition-colors cursor-pointer ${
                      privacy === 'public'
                        ? 'border-nexus-accent bg-nexus-accent/15 text-nexus-text'
                        : 'border-nexus-border bg-nexus-bg text-nexus-muted hover:text-nexus-text'
                    }`}
                  >
                    <Globe className="w-4 h-4 shrink-0" />
                    <div>
                      <div className="font-semibold">Pública</div>
                      <div className="text-[10px] opacity-80">Visível para descoberta</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPrivacy('private')}
                    className={`flex items-center gap-2 p-2.5 rounded-lg border text-left text-xs transition-colors cursor-pointer ${
                      privacy === 'private'
                        ? 'border-nexus-accent bg-nexus-accent/15 text-nexus-text'
                        : 'border-nexus-border bg-nexus-bg text-nexus-muted hover:text-nexus-text'
                    }`}
                  >
                    <Lock className="w-4 h-4 shrink-0" />
                    <div>
                      <div className="font-semibold">Privada</div>
                      <div className="text-[10px] opacity-80">Acesso apenas por convite</div>
                    </div>
                  </button>
                </div>
              </div>

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
                  disabled={isSubmitting || name.trim().length < 2}
                  className="px-4 py-2 rounded-lg text-xs font-semibold bg-nexus-accent hover:bg-nexus-accent/90 text-white disabled:opacity-50 flex items-center gap-2 transition-colors cursor-pointer"
                >
                  {isSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>Criar Comunidade</span>
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-nexus-text mb-1.5">
                  Código ou link de convite
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={inviteInput}
                    onChange={(e) => {
                      setInviteInput(e.target.value);
                      setPreview(null);
                      setError(null);
                    }}
                    placeholder="Ex.: aB3x9K ou nexus://invite/aB3x9K"
                    className="flex-1 px-3 py-2 rounded-lg bg-nexus-bg border border-nexus-border text-xs text-nexus-text placeholder:text-nexus-muted focus:outline-none focus:border-nexus-accent"
                  />
                  <button
                    type="button"
                    onClick={handlePreviewInvite}
                    disabled={isPreviewing || !inviteInput.trim()}
                    className="px-3 py-2 rounded-lg text-xs font-semibold bg-nexus-panel hover:bg-nexus-bg border border-nexus-border text-nexus-text disabled:opacity-50 flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    {isPreviewing ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Search className="w-3.5 h-3.5" />
                    )}
                    <span>Pré-visualizar</span>
                  </button>
                </div>
                <p className="text-[11px] text-nexus-muted mt-1.5">
                  Aceita códigos diretos, links <code className="text-nexus-text">nexus://invite/...</code> ou{' '}
                  <code className="text-nexus-text">https://.../invite/...</code>.
                </p>
              </div>

              {preview && (
                <div className="p-4 rounded-xl bg-nexus-panel/70 border border-nexus-border space-y-3">
                  <div className="flex items-center gap-3">
                    {preview.community_icon_url ? (
                      <img
                        src={preview.community_icon_url}
                        alt={preview.community_name}
                        className="w-12 h-12 rounded-xl object-cover shrink-0"
                      />
                    ) : (
                      <div
                        className="w-12 h-12 rounded-xl flex items-center justify-center text-sm font-bold text-white shrink-0"
                        style={{ backgroundColor: preview.community_icon_bg || '#4f46e5' }}
                      >
                        {preview.community_initials}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-bold text-nexus-text truncate">
                          {preview.community_name}
                        </h4>
                        {preview.is_valid ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                        ) : (
                          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                        )}
                      </div>
                      <p className="text-xs text-nexus-muted">
                        {preview.member_count} {preview.member_count === 1 ? 'membro' : 'membros'} •{' '}
                        {preview.community_privacy === 'public' ? 'Pública' : 'Privada'}
                      </p>
                    </div>
                  </div>

                  {preview.community_description && (
                    <p className="text-xs text-nexus-muted leading-relaxed">
                      {preview.community_description}
                    </p>
                  )}

                  {preview.expires_at && (
                    <p className="text-[11px] text-nexus-muted">
                      Expira em: {formatDateTimePtBr(preview.expires_at)}
                    </p>
                  )}

                  {!preview.is_valid && (
                    <p className="text-xs text-rose-400 font-medium">
                      Este convite expirou ou foi revogado.
                    </p>
                  )}
                </div>
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
                  type="button"
                  onClick={handleAcceptInvite}
                  disabled={
                    isSubmitting ||
                    !extractInviteCode(inviteInput) ||
                    (preview !== null && !preview.is_valid)
                  }
                  className="px-4 py-2 rounded-lg text-xs font-semibold bg-nexus-accent hover:bg-nexus-accent/90 text-white disabled:opacity-50 flex items-center gap-2 transition-colors cursor-pointer"
                >
                  {isSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>Entrar na Comunidade</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
