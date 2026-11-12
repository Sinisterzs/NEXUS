import React, { useState, useEffect, useMemo } from 'react';
import {
  X,
  Settings,
  Shield,
  Users,
  Link2,
  ScrollText,
  AlertTriangle,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Copy,
  Check,
  Ban,
  UserX,
  MessageSquareOff,
  Crown,
  LogOut,
  RefreshCw,
} from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import {
  CommunityMemberDto,
  CommunityPermissionFlag,
  CommunityPrivacy,
  CommunityRoleDto,
  CommunitySnapshotDto,
  bitmaskStrToFlags,
  flagsToBitmaskStr,
} from '../../lib/types';
import { Avatar } from '../../components/Avatar';
import {
  COMMUNITY_PERMISSION_META,
  formatDateTimePtBr,
  hasCommunityOrAdminPermission,
  isFutureTimestamp,
} from './communityUtils';

interface CommunitySettingsModalProps {
  isOpen: boolean;
  snapshot: CommunitySnapshotDto;
  initialTab?: SettingsTab;
  onClose: () => void;
}

export type SettingsTab = 'general' | 'roles' | 'members' | 'invites' | 'audit' | 'danger';

const EXPIRY_OPTIONS: { label: string; secs: number | null }[] = [
  { label: '30 minutos', secs: 1800 },
  { label: '1 hora', secs: 3600 },
  { label: '24 horas', secs: 86400 },
  { label: '7 dias', secs: 604800 },
  { label: 'Sem expiração', secs: null },
];

export const CommunitySettingsModal: React.FC<CommunitySettingsModalProps> = ({
  isOpen,
  snapshot,
  initialTab = 'general',
  onClose,
}) => {
  const currentUserId = useAppStore(
    (state) => state.onlineUser?.id || state.currentUser.id
  );
  const communityBans = useAppStore((state) => state.communityBans);
  const communityInvites = useAppStore((state) => state.communityInvites);
  const communityAuditLogs = useAppStore((state) => state.communityAuditLogs);

  const updateCommunity = useAppStore((state) => state.updateCommunity);
  const deleteCommunity = useAppStore((state) => state.deleteCommunity);
  const transferCommunityOwnership = useAppStore((state) => state.transferCommunityOwnership);
  const leaveCommunity = useAppStore((state) => state.leaveCommunity);

  const createCommunityRole = useAppStore((state) => state.createCommunityRole);
  const updateCommunityRole = useAppStore((state) => state.updateCommunityRole);
  const deleteCommunityRole = useAppStore((state) => state.deleteCommunityRole);
  const reorderCommunityRoles = useAppStore((state) => state.reorderCommunityRoles);

  const updateCommunityMember = useAppStore((state) => state.updateCommunityMember);
  const setCommunityMemberRoles = useAppStore((state) => state.setCommunityMemberRoles);
  const kickCommunityMember = useAppStore((state) => state.kickCommunityMember);
  const banCommunityMember = useAppStore((state) => state.banCommunityMember);
  const unbanCommunityMember = useAppStore((state) => state.unbanCommunityMember);
  const loadCommunityBans = useAppStore((state) => state.loadCommunityBans);
  const muteCommunityMember = useAppStore((state) => state.muteCommunityMember);

  const createCommunityInvite = useAppStore((state) => state.createCommunityInvite);
  const loadCommunityInvites = useAppStore((state) => state.loadCommunityInvites);
  const revokeCommunityInvite = useAppStore((state) => state.revokeCommunityInvite);
  const loadCommunityAuditLogs = useAppStore((state) => state.loadCommunityAuditLogs);

  const { community, roles, members } = snapshot;
  const isOwner = community.owner_id === currentUserId;
  const myMember = members.find((m) => m.user_id === currentUserId);
  const myHighestRolePos = myMember?.highest_role_position ?? 0;

  const canManageCommunity =
    isOwner || hasCommunityOrAdminPermission(community.effective_permissions, 'MANAGE_COMMUNITY');
  const canManageRoles =
    isOwner || hasCommunityOrAdminPermission(community.effective_permissions, 'MANAGE_ROLES');
  const canModerate =
    isOwner || hasCommunityOrAdminPermission(community.effective_permissions, 'MODERATE_MEMBERS');
  const canCreateInvites =
    isOwner ||
    hasCommunityOrAdminPermission(community.effective_permissions, 'CREATE_INVITES') ||
    canManageCommunity;
  const canViewAudit =
    isOwner || hasCommunityOrAdminPermission(community.effective_permissions, 'VIEW_AUDIT_LOG');

  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  // General state
  const [commName, setCommName] = useState(community.name);
  const [commDesc, setCommDesc] = useState(community.description || '');
  const [commIconUrl, setCommIconUrl] = useState(community.icon_url || '');
  const [commInitials, setCommInitials] = useState(community.initials);
  const [commIconBg, setCommIconBg] = useState(community.icon_bg || '#4f46e5');
  const [commPrivacy, setCommPrivacy] = useState<CommunityPrivacy>(
    (community.privacy as CommunityPrivacy) || 'public'
  );

  // Roles state
  const sortedRoles = useMemo(
    () => [...roles].sort((a, b) => b.position - a.position),
    [roles]
  );
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [newRoleName, setNewRoleName] = useState('');
  const [roleName, setRoleName] = useState('');
  const [roleColor, setRoleColor] = useState('#6366f1');
  const [roleHoisted, setRoleHoisted] = useState(false);
  const [roleMentionable, setRoleMentionable] = useState(true);
  const [roleFlags, setRoleFlags] = useState<CommunityPermissionFlag[]>([]);

  // Members & Moderation state
  const [memberSearch, setMemberSearch] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [memberNickname, setMemberNickname] = useState('');
  const [memberRoleIds, setMemberRoleIds] = useState<string[]>([]);
  const [modReason, setModReason] = useState('');
  const [muteMinutes, setMuteMinutes] = useState<number>(60);
  const [banDeleteHours, setBanDeleteHours] = useState<number>(0);

  // Invites state
  const [inviteMaxUses, setInviteMaxUses] = useState('');
  const [inviteExpiresSecs, setInviteExpiresSecs] = useState<number | null>(86400);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Audit logs state
  const [auditActionFilter, setAuditActionFilter] = useState('');

  // Danger zone state
  const [transferTargetId, setTransferTargetId] = useState('');
  const [transferConfirmName, setTransferConfirmName] = useState('');
  const [deleteConfirmName, setDeleteConfirmName] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setActiveTab(initialTab);
    setError(null);
    setSuccessMsg(null);
    setCommName(community.name);
    setCommDesc(community.description || '');
    setCommIconUrl(community.icon_url || '');
    setCommInitials(community.initials);
    setCommIconBg(community.icon_bg || '#4f46e5');
    setCommPrivacy((community.privacy as CommunityPrivacy) || 'public');
    setTransferConfirmName('');
    setDeleteConfirmName('');
  }, [isOpen, initialTab, community]);

  useEffect(() => {
    if (!isOpen) return;
    if (!selectedRoleId && sortedRoles.length > 0) {
      setSelectedRoleId(sortedRoles[0].id);
    }
  }, [isOpen, selectedRoleId, sortedRoles]);

  const selectedRole: CommunityRoleDto | undefined = sortedRoles.find(
    (r) => r.id === selectedRoleId
  );

  useEffect(() => {
    if (!selectedRole) return;
    setRoleName(selectedRole.name);
    setRoleColor(selectedRole.color || '#6366f1');
    setRoleHoisted(selectedRole.is_hoisted);
    setRoleMentionable(selectedRole.is_mentionable);
    setRoleFlags(
      selectedRole.permissions_flags?.length
        ? selectedRole.permissions_flags
        : bitmaskStrToFlags(selectedRole.permissions_bitmask)
    );
  }, [selectedRole]);

  const selectedMember: CommunityMemberDto | undefined = members.find(
    (m) => m.user_id === selectedMemberId
  );

  useEffect(() => {
    if (!selectedMember) return;
    setMemberNickname(selectedMember.nickname || '');
    setMemberRoleIds(selectedMember.roles.map((r) => r.id));
    setModReason('');
  }, [selectedMember]);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    if (activeTab === 'members' && canModerate) {
      loadCommunityBans(community.id).catch(() => {});
    } else if (activeTab === 'invites' && canCreateInvites) {
      loadCommunityInvites(community.id).catch(() => {});
    } else if (activeTab === 'audit' && canViewAudit) {
      loadCommunityAuditLogs(community.id, { limit: 50 }).catch(() => {});
    }
  }, [
    isOpen,
    activeTab,
    community.id,
    canModerate,
    canCreateInvites,
    canViewAudit,
    loadCommunityBans,
    loadCommunityInvites,
    loadCommunityAuditLogs,
  ]);

  if (!isOpen) return null;

  const notifySuccess = (msg: string) => {
    setSuccessMsg(msg);
    setError(null);
  };

  const handleSaveGeneral = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsBusy(true);
    setError(null);
    setSuccessMsg(null);
    try {
      await updateCommunity(community.id, {
        name: commName.trim(),
        description: commDesc.trim() || null,
        icon_url: commIconUrl.trim() || null,
        initials: commInitials.trim() || undefined,
        icon_bg: commIconBg,
        accent_color: commIconBg,
        privacy: commPrivacy,
      });
      notifySuccess('Configurações da comunidade atualizadas.');
    } catch (err: any) {
      setError(err?.message || 'Não foi possível atualizar a comunidade.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleCreateRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRoleName.trim()) return;
    setIsBusy(true);
    setError(null);
    try {
      const created = await createCommunityRole(community.id, {
        name: newRoleName.trim(),
        color: '#6366f1',
        is_mentionable: true,
      });
      setNewRoleName('');
      if (created) setSelectedRoleId(created.id);
      notifySuccess('Cargo criado.');
    } catch (err: any) {
      setError(err?.message || 'Não foi possível criar o cargo.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleSaveRole = async () => {
    if (!selectedRole) return;
    setIsBusy(true);
    setError(null);
    try {
      await updateCommunityRole(community.id, selectedRole.id, {
        name: roleName.trim(),
        color: roleColor,
        is_hoisted: roleHoisted,
        is_mentionable: roleMentionable,
        permissions_flags: roleFlags,
        permissions_bitmask: flagsToBitmaskStr(roleFlags),
      });
      notifySuccess(`Cargo "${roleName.trim()}" atualizado.`);
    } catch (err: any) {
      setError(err?.message || 'Não foi possível atualizar o cargo.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleDeleteRole = async (role: CommunityRoleDto) => {
    setIsBusy(true);
    setError(null);
    try {
      await deleteCommunityRole(community.id, role.id);
      setSelectedRoleId(null);
      notifySuccess(`Cargo "${role.name}" excluído.`);
    } catch (err: any) {
      setError(err?.message || 'Não foi possível excluir o cargo.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleMoveRole = async (index: number, direction: -1 | 1) => {
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= sortedRoles.length) return;
    const reordered = [...sortedRoles];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIdx, 0, moved);
    const items = reordered.map((r, idx) => ({
      id: r.id,
      position: reordered.length - idx,
    }));
    setIsBusy(true);
    setError(null);
    try {
      await reorderCommunityRoles(community.id, items);
    } catch (err: any) {
      setError(err?.message || 'Não foi possível reordenar cargos.');
    } finally {
      setIsBusy(false);
    }
  };

  const toggleRoleFlag = (flag: CommunityPermissionFlag) => {
    setRoleFlags((prev) =>
      prev.includes(flag) ? prev.filter((f) => f !== flag) : [...prev, flag]
    );
  };

  const handleSaveMemberRolesAndNick = async () => {
    if (!selectedMember) return;
    setIsBusy(true);
    setError(null);
    try {
      if (canManageRoles) {
        await setCommunityMemberRoles(community.id, selectedMember.user_id, memberRoleIds);
      }
      if (
        (selectedMember.nickname || '') !== memberNickname.trim() &&
        (canModerate || selectedMember.user_id === currentUserId)
      ) {
        await updateCommunityMember(community.id, selectedMember.user_id, {
          nickname: memberNickname.trim() || null,
        });
      }
      notifySuccess('Membro atualizado.');
    } catch (err: any) {
      setError(err?.message || 'Erro ao atualizar membro.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleMuteMember = async (unmute = false) => {
    if (!selectedMember) return;
    setIsBusy(true);
    setError(null);
    try {
      const untilIso = unmute
        ? null
        : new Date(Date.now() + muteMinutes * 60_000).toISOString();
      await muteCommunityMember(community.id, selectedMember.user_id, {
        reason: modReason.trim() || null,
        text_muted_until: untilIso,
      });
      notifySuccess(unmute ? 'Silenciamento removido.' : 'Membro silenciado.');
    } catch (err: any) {
      setError(err?.message || 'Erro ao silenciar membro.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleKickMember = async () => {
    if (!selectedMember) return;
    setIsBusy(true);
    setError(null);
    try {
      await kickCommunityMember(community.id, selectedMember.user_id, {
        reason: modReason.trim() || null,
      });
      setSelectedMemberId(null);
      notifySuccess('Membro expulso da comunidade.');
    } catch (err: any) {
      setError(err?.message || 'Erro ao expulsar membro.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleBanMember = async () => {
    if (!selectedMember) return;
    setIsBusy(true);
    setError(null);
    try {
      await banCommunityMember(community.id, selectedMember.user_id, {
        reason: modReason.trim() || null,
        delete_message_hours: banDeleteHours > 0 ? banDeleteHours : null,
      });
      setSelectedMemberId(null);
      await loadCommunityBans(community.id);
      notifySuccess('Membro banido da comunidade.');
    } catch (err: any) {
      setError(err?.message || 'Erro ao banir membro.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleUnban = async (userId: string) => {
    setIsBusy(true);
    setError(null);
    try {
      await unbanCommunityMember(community.id, userId);
      notifySuccess('Banimento removido.');
    } catch (err: any) {
      setError(err?.message || 'Erro ao remover banimento.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleCreateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsBusy(true);
    setError(null);
    try {
      const parsedMax = inviteMaxUses.trim() ? Number(inviteMaxUses.trim()) : null;
      await createCommunityInvite(community.id, {
        max_uses: parsedMax && parsedMax > 0 ? parsedMax : null,
        expires_in_secs: inviteExpiresSecs,
      });
      setInviteMaxUses('');
      notifySuccess('Convite gerado.');
    } catch (err: any) {
      setError(err?.message || 'Erro ao criar convite.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleCopy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      setError('Falha ao copiar para a área de transferência.');
    }
  };

  const handleTransferOwnership = async () => {
    if (!transferTargetId || transferConfirmName.trim() !== community.name) return;
    setIsBusy(true);
    setError(null);
    try {
      await transferCommunityOwnership(community.id, {
        target_user_id: transferTargetId,
        confirm_name: transferConfirmName.trim(),
      });
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Erro ao transferir propriedade.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleDeleteCommunity = async () => {
    if (deleteConfirmName.trim() !== community.name) return;
    setIsBusy(true);
    setError(null);
    try {
      await deleteCommunity(community.id, { confirm_name: deleteConfirmName.trim() });
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Erro ao excluir comunidade.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleLeaveCommunity = async () => {
    setIsBusy(true);
    setError(null);
    try {
      await leaveCommunity(community.id);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Erro ao sair da comunidade.');
    } finally {
      setIsBusy(false);
    }
  };

  const filteredMembers = members.filter((m) => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      m.username.toLowerCase().includes(q) ||
      m.display_name.toLowerCase().includes(q) ||
      (m.nickname || '').toLowerCase().includes(q)
    );
  });

  const tabs: { id: SettingsTab; label: string; icon: React.ElementType; visible: boolean }[] = [
    { id: 'general', label: 'Geral', icon: Settings, visible: true },
    { id: 'roles', label: 'Cargos', icon: Shield, visible: canManageRoles },
    {
      id: 'members',
      label: 'Membros & Moderação',
      icon: Users,
      visible: canModerate || canManageRoles,
    },
    { id: 'invites', label: 'Convites', icon: Link2, visible: canCreateInvites },
    { id: 'audit', label: 'Logs Administrativos', icon: ScrollText, visible: canViewAudit },
    { id: 'danger', label: isOwner ? 'Administração Crítica' : 'Sair', icon: AlertTriangle, visible: true },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl h-[82vh] bg-nexus-surface border border-nexus-border rounded-xl shadow-2xl overflow-hidden flex"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left Sidebar Tabs */}
        <div className="w-52 bg-nexus-panel/60 border-r border-nexus-border p-3 flex flex-col justify-between shrink-0">
          <div className="space-y-1">
            <div className="px-2.5 py-2 text-[10px] font-bold uppercase tracking-wider text-nexus-muted truncate">
              {community.name}
            </div>
            {tabs
              .filter((t) => t.visible)
              .map((t) => {
                const Icon = t.icon;
                const active = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(t.id);
                      setError(null);
                      setSuccessMsg(null);
                    }}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs font-medium text-left transition-colors cursor-pointer ${
                      active
                        ? 'bg-nexus-accent/20 text-white border border-nexus-accent/40'
                        : 'text-nexus-muted hover:text-nexus-text hover:bg-nexus-surface/60'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">{t.label}</span>
                  </button>
                );
              })}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-nexus-border text-xs text-nexus-muted hover:text-nexus-text hover:bg-nexus-surface cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
            <span>Fechar</span>
          </button>
        </div>

        {/* Right Content */}
        <div className="flex-1 flex flex-col overflow-hidden bg-nexus-bg">
          <div className="h-12 px-5 border-b border-nexus-border bg-nexus-surface/60 flex items-center justify-between shrink-0">
            <h3 className="text-sm font-bold text-nexus-text">
              {tabs.find((t) => t.id === activeTab)?.label}
            </h3>
            {isBusy && <Loader2 className="w-4 h-4 animate-spin text-nexus-accent" />}
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {error && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
                <span>{error}</span>
              </div>
            )}

            {successMsg && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
                <span>{successMsg}</span>
              </div>
            )}

            {/* TAB: GENERAL */}
            {activeTab === 'general' && (
              <form onSubmit={handleSaveGeneral} className="space-y-4 max-w-xl">
                <div>
                  <label className="block text-xs font-semibold text-nexus-text mb-1">
                    Nome da comunidade
                  </label>
                  <input
                    type="text"
                    value={commName}
                    onChange={(e) => setCommName(e.target.value)}
                    disabled={!canManageCommunity}
                    required
                    className="w-full px-3 py-2 rounded-lg bg-nexus-surface border border-nexus-border text-xs text-nexus-text disabled:opacity-60 focus:outline-none focus:border-nexus-accent"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-nexus-text mb-1">
                    Descrição
                  </label>
                  <textarea
                    value={commDesc}
                    onChange={(e) => setCommDesc(e.target.value)}
                    disabled={!canManageCommunity}
                    rows={3}
                    className="w-full px-3 py-2 rounded-lg bg-nexus-surface border border-nexus-border text-xs text-nexus-text disabled:opacity-60 focus:outline-none focus:border-nexus-accent resize-none"
                  />
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-nexus-text mb-1">
                      Iniciais
                    </label>
                    <input
                      type="text"
                      value={commInitials}
                      onChange={(e) => setCommInitials(e.target.value.toUpperCase().slice(0, 3))}
                      disabled={!canManageCommunity}
                      className="w-full px-3 py-2 rounded-lg bg-nexus-surface border border-nexus-border text-xs text-nexus-text disabled:opacity-60"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-nexus-text mb-1">
                      Cor de fundo
                    </label>
                    <input
                      type="color"
                      value={commIconBg}
                      onChange={(e) => setCommIconBg(e.target.value)}
                      disabled={!canManageCommunity}
                      className="w-full h-9 rounded-lg bg-nexus-surface border border-nexus-border cursor-pointer disabled:opacity-60"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-nexus-text mb-1">
                      Privacidade
                    </label>
                    <select
                      value={commPrivacy}
                      onChange={(e) => setCommPrivacy(e.target.value as CommunityPrivacy)}
                      disabled={!canManageCommunity}
                      className="w-full px-3 py-2 rounded-lg bg-nexus-surface border border-nexus-border text-xs text-nexus-text disabled:opacity-60"
                    >
                      <option value="public">Pública</option>
                      <option value="private">Privada</option>
                      <option value="invite_only">Somente convite</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-nexus-text mb-1">
                    URL do ícone
                  </label>
                  <input
                    type="url"
                    value={commIconUrl}
                    onChange={(e) => setCommIconUrl(e.target.value)}
                    disabled={!canManageCommunity}
                    placeholder="https://..."
                    className="w-full px-3 py-2 rounded-lg bg-nexus-surface border border-nexus-border text-xs text-nexus-text disabled:opacity-60"
                  />
                </div>

                {canManageCommunity && (
                  <div className="pt-2">
                    <button
                      type="submit"
                      disabled={isBusy || !commName.trim()}
                      className="px-4 py-2 rounded-lg text-xs font-semibold bg-nexus-accent hover:bg-nexus-accent/90 text-white disabled:opacity-50 cursor-pointer"
                    >
                      Salvar Alterações
                    </button>
                  </div>
                )}
              </form>
            )}

            {/* TAB: ROLES */}
            {activeTab === 'roles' && (
              <div className="grid grid-cols-12 gap-4">
                <div className="col-span-5 space-y-3">
                  <form onSubmit={handleCreateRole} className="flex gap-1.5">
                    <input
                      type="text"
                      value={newRoleName}
                      onChange={(e) => setNewRoleName(e.target.value)}
                      placeholder="Novo cargo..."
                      className="flex-1 px-2.5 py-1.5 rounded-lg bg-nexus-surface border border-nexus-border text-xs text-nexus-text"
                    />
                    <button
                      type="submit"
                      disabled={isBusy || !newRoleName.trim()}
                      className="px-2.5 py-1.5 rounded-lg bg-nexus-accent text-white text-xs font-semibold disabled:opacity-50 flex items-center gap-1 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Criar</span>
                    </button>
                  </form>

                  <div className="space-y-1">
                    {sortedRoles.map((role, idx) => (
                      <div
                        key={role.id}
                        className={`flex items-center justify-between gap-1 px-2.5 py-2 rounded-lg border text-xs ${
                          selectedRoleId === role.id
                            ? 'bg-nexus-panel border-nexus-accent text-white'
                            : 'bg-nexus-surface border-nexus-border text-nexus-text'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedRoleId(role.id)}
                          className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
                        >
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: role.color || '#64748b' }}
                          />
                          <span className="truncate font-medium">{role.name}</span>
                          {role.is_default && (
                            <span className="text-[10px] text-nexus-muted">(padrão)</span>
                          )}
                        </button>
                        <div className="flex items-center gap-0.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleMoveRole(idx, -1)}
                            disabled={idx === 0 || isBusy}
                            className="p-1 text-nexus-muted hover:text-nexus-text disabled:opacity-30 cursor-pointer"
                            title="Subir posição"
                          >
                            <ArrowUp className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleMoveRole(idx, 1)}
                            disabled={idx === sortedRoles.length - 1 || isBusy}
                            className="p-1 text-nexus-muted hover:text-nexus-text disabled:opacity-30 cursor-pointer"
                            title="Descer posição"
                          >
                            <ArrowDown className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="col-span-7">
                  {selectedRole ? (
                    <div className="p-4 rounded-xl bg-nexus-surface border border-nexus-border space-y-4">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-bold text-nexus-text">
                          Editar Cargo: {selectedRole.name}
                        </h4>
                        {!selectedRole.is_default && (
                          <button
                            type="button"
                            onClick={() => handleDeleteRole(selectedRole)}
                            disabled={isBusy}
                            className="text-xs text-rose-400 hover:text-rose-300 flex items-center gap-1 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Excluir</span>
                          </button>
                        )}
                      </div>

                      <div className="grid grid-cols-3 gap-2">
                        <div className="col-span-2">
                          <label className="block text-[11px] text-nexus-muted mb-1">Nome</label>
                          <input
                            type="text"
                            value={roleName}
                            onChange={(e) => setRoleName(e.target.value)}
                            disabled={selectedRole.is_default}
                            className="w-full px-2.5 py-1.5 rounded-lg bg-nexus-bg border border-nexus-border text-xs text-nexus-text disabled:opacity-60"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-nexus-muted mb-1">Cor</label>
                          <input
                            type="color"
                            value={roleColor}
                            onChange={(e) => setRoleColor(e.target.value)}
                            className="w-full h-8 rounded bg-nexus-bg border border-nexus-border cursor-pointer"
                          />
                        </div>
                      </div>

                      <div className="flex items-center gap-4 text-xs">
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={roleHoisted}
                            onChange={(e) => setRoleHoisted(e.target.checked)}
                          />
                          <span>Exibir separadamente</span>
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={roleMentionable}
                            onChange={(e) => setRoleMentionable(e.target.checked)}
                          />
                          <span>Mencionável</span>
                        </label>
                      </div>

                      <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                        <div className="text-[11px] font-semibold text-nexus-muted uppercase">
                          Permissões (63-bit)
                        </div>
                        {COMMUNITY_PERMISSION_META.map((meta) => {
                          const checked = roleFlags.includes(meta.flag);
                          return (
                            <label
                              key={meta.flag}
                              className="flex items-start gap-2.5 p-2 rounded-lg bg-nexus-bg/60 border border-nexus-border/60 cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleRoleFlag(meta.flag)}
                                className="mt-0.5 accent-nexus-accent"
                              />
                              <div>
                                <div className="text-xs font-medium text-nexus-text">
                                  {meta.label}
                                </div>
                                <div className="text-[10px] text-nexus-muted">
                                  {meta.description}
                                </div>
                              </div>
                            </label>
                          );
                        })}
                      </div>

                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={handleSaveRole}
                          disabled={isBusy || !roleName.trim()}
                          className="px-4 py-1.5 rounded-lg bg-nexus-accent text-white text-xs font-semibold disabled:opacity-50 cursor-pointer"
                        >
                          Salvar Cargo
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-nexus-muted">Selecione um cargo para editar.</p>
                  )}
                </div>
              </div>
            )}

            {/* TAB: MEMBERS & MODERATION */}
            {activeTab === 'members' && (
              <div className="space-y-6">
                <div className="grid grid-cols-12 gap-4">
                  <div className="col-span-5 space-y-2">
                    <input
                      type="text"
                      value={memberSearch}
                      onChange={(e) => setMemberSearch(e.target.value)}
                      placeholder="Buscar membro..."
                      className="w-full px-3 py-1.5 rounded-lg bg-nexus-surface border border-nexus-border text-xs text-nexus-text"
                    />
                    <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
                      {filteredMembers.map((m) => (
                        <button
                          key={m.user_id}
                          type="button"
                          onClick={() => setSelectedMemberId(m.user_id)}
                          className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border text-left text-xs cursor-pointer ${
                            selectedMemberId === m.user_id
                              ? 'bg-nexus-panel border-nexus-accent text-white'
                              : 'bg-nexus-surface border-nexus-border text-nexus-text hover:bg-nexus-panel/50'
                          }`}
                        >
                          <Avatar
                            name={m.nickname || m.display_name || m.username}
                            avatarUrl={m.avatar_url}
                            size="xs"
                            showStatus={false}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium">
                              {m.nickname || m.display_name}
                            </div>
                            <div className="text-[10px] text-nexus-muted truncate">
                              @{m.username}
                            </div>
                          </div>
                          {m.is_owner && <Crown className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="col-span-7">
                    {selectedMember ? (
                      <div className="p-4 rounded-xl bg-nexus-surface border border-nexus-border space-y-4">
                        <div className="flex items-center gap-2.5">
                          <Avatar
                            name={selectedMember.display_name || selectedMember.username}
                            avatarUrl={selectedMember.avatar_url}
                            size="sm"
                            showStatus={false}
                          />
                          <div>
                            <div className="text-xs font-bold text-nexus-text">
                              {selectedMember.display_name} (@{selectedMember.username})
                            </div>
                            <div className="text-[10px] text-nexus-muted">
                              Entrou em {formatDateTimePtBr(selectedMember.joined_at)}
                            </div>
                          </div>
                        </div>

                        <div>
                          <label className="block text-[11px] text-nexus-muted mb-1">
                            Apelido na comunidade
                          </label>
                          <input
                            type="text"
                            value={memberNickname}
                            onChange={(e) => setMemberNickname(e.target.value)}
                            placeholder="Sem apelido"
                            className="w-full px-2.5 py-1.5 rounded-lg bg-nexus-bg border border-nexus-border text-xs text-nexus-text"
                          />
                        </div>

                        {canManageRoles && (
                          <div className="space-y-1.5">
                            <div className="text-[11px] font-semibold text-nexus-muted">Cargos</div>
                            <div className="flex flex-wrap gap-1.5">
                              {sortedRoles
                                .filter((r) => !r.is_default)
                                .map((r) => {
                                  const assigned = memberRoleIds.includes(r.id);
                                  const blockedByHierarchy =
                                    !isOwner && r.position >= myHighestRolePos;
                                  return (
                                    <button
                                      key={r.id}
                                      type="button"
                                      disabled={blockedByHierarchy}
                                      onClick={() =>
                                        setMemberRoleIds((prev) =>
                                          assigned
                                            ? prev.filter((id) => id !== r.id)
                                            : [...prev, r.id]
                                        )
                                      }
                                      className={`px-2 py-1 rounded-md border text-[11px] flex items-center gap-1.5 cursor-pointer disabled:opacity-40 ${
                                        assigned
                                          ? 'bg-nexus-accent/20 border-nexus-accent text-white'
                                          : 'bg-nexus-bg border-nexus-border text-nexus-muted'
                                      }`}
                                    >
                                      <span
                                        className="w-2 h-2 rounded-full"
                                        style={{ backgroundColor: r.color || '#64748b' }}
                                      />
                                      <span>{r.name}</span>
                                    </button>
                                  );
                                })}
                            </div>
                          </div>
                        )}

                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={handleSaveMemberRolesAndNick}
                            disabled={isBusy}
                            className="px-3.5 py-1.5 rounded-lg bg-nexus-accent text-white text-xs font-semibold cursor-pointer"
                          >
                            Salvar Membro
                          </button>
                        </div>

                        {canModerate &&
                          !selectedMember.is_owner &&
                          selectedMember.user_id !== currentUserId && (
                            <div className="pt-3 border-t border-nexus-border space-y-3">
                              <div className="text-[11px] font-bold uppercase text-nexus-muted">
                                Ações de Moderação
                              </div>
                              <input
                                type="text"
                                value={modReason}
                                onChange={(e) => setModReason(e.target.value)}
                                placeholder="Motivo (opcional)"
                                className="w-full px-2.5 py-1.5 rounded-lg bg-nexus-bg border border-nexus-border text-xs text-nexus-text"
                              />

                              <div className="flex flex-wrap items-center gap-2">
                                <select
                                  value={muteMinutes}
                                  onChange={(e) => setMuteMinutes(Number(e.target.value))}
                                  className="px-2 py-1.5 rounded-lg bg-nexus-bg border border-nexus-border text-xs text-nexus-text"
                                >
                                  <option value={10}>Silenciar 10 min</option>
                                  <option value={60}>Silenciar 1 hora</option>
                                  <option value={1440}>Silenciar 24 horas</option>
                                </select>
                                <button
                                  type="button"
                                  onClick={() => handleMuteMember(false)}
                                  disabled={isBusy}
                                  className="px-2.5 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs flex items-center gap-1 cursor-pointer"
                                >
                                  <MessageSquareOff className="w-3.5 h-3.5" />
                                  <span>Silenciar</span>
                                </button>
                                {isFutureTimestamp(selectedMember.text_muted_until) && (
                                  <button
                                    type="button"
                                    onClick={() => handleMuteMember(true)}
                                    disabled={isBusy}
                                    className="px-2.5 py-1.5 rounded-lg bg-nexus-panel border border-nexus-border text-xs text-nexus-text cursor-pointer"
                                  >
                                    Remover silenciamento
                                  </button>
                                )}
                              </div>

                              <div className="flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  onClick={handleKickMember}
                                  disabled={isBusy}
                                  className="px-3 py-1.5 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-1.5 cursor-pointer"
                                >
                                  <UserX className="w-3.5 h-3.5" />
                                  <span>Expulsar</span>
                                </button>

                                <select
                                  value={banDeleteHours}
                                  onChange={(e) => setBanDeleteHours(Number(e.target.value))}
                                  className="px-2 py-1.5 rounded-lg bg-nexus-bg border border-nexus-border text-xs text-nexus-text"
                                >
                                  <option value={0}>Não apagar msgs</option>
                                  <option value={1}>Apagar última 1h</option>
                                  <option value={24}>Apagar últimas 24h</option>
                                  <option value={168}>Apagar últimos 7 dias</option>
                                </select>

                                <button
                                  type="button"
                                  onClick={handleBanMember}
                                  disabled={isBusy}
                                  className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                                >
                                  <Ban className="w-3.5 h-3.5" />
                                  <span>Banir</span>
                                </button>
                              </div>
                            </div>
                          )}
                      </div>
                    ) : (
                      <p className="text-xs text-nexus-muted">
                        Selecione um membro para gerenciar cargos ou moderar.
                      </p>
                    )}
                  </div>
                </div>

                {/* Bans List */}
                {canModerate && (
                  <div className="pt-4 border-t border-nexus-border space-y-2">
                    <h4 className="text-xs font-bold text-nexus-text">
                      Usuários Banidos ({communityBans.length})
                    </h4>
                    {communityBans.length === 0 ? (
                      <p className="text-xs text-nexus-muted">Nenhum usuário banido.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {communityBans.map((ban) => (
                          <div
                            key={ban.user_id}
                            className="flex items-center justify-between p-2.5 rounded-lg bg-nexus-surface border border-nexus-border text-xs"
                          >
                            <div>
                              <div className="font-semibold text-nexus-text">
                                {ban.display_name || ban.username || ban.user_id}
                              </div>
                              <div className="text-[11px] text-nexus-muted">
                                Motivo: {ban.reason || 'Não informado'} • Em{' '}
                                {formatDateTimePtBr(ban.created_at)}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleUnban(ban.user_id)}
                              disabled={isBusy}
                              className="px-2.5 py-1 rounded bg-nexus-panel hover:bg-nexus-bg border border-nexus-border text-nexus-text cursor-pointer"
                            >
                              Desbanir
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* TAB: INVITES */}
            {activeTab === 'invites' && (
              <div className="space-y-4">
                <form
                  onSubmit={handleCreateInvite}
                  className="p-3.5 rounded-xl bg-nexus-surface border border-nexus-border flex flex-wrap items-end gap-3"
                >
                  <div>
                    <label className="block text-[11px] text-nexus-muted mb-1">Expira em</label>
                    <select
                      value={inviteExpiresSecs === null ? 'never' : String(inviteExpiresSecs)}
                      onChange={(e) =>
                        setInviteExpiresSecs(
                          e.target.value === 'never' ? null : Number(e.target.value)
                        )
                      }
                      className="px-2.5 py-1.5 rounded-lg bg-nexus-bg border border-nexus-border text-xs text-nexus-text"
                    >
                      {EXPIRY_OPTIONS.map((opt) => (
                        <option
                          key={opt.label}
                          value={opt.secs === null ? 'never' : String(opt.secs)}
                        >
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] text-nexus-muted mb-1">
                      Máx. usos
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={inviteMaxUses}
                      onChange={(e) => setInviteMaxUses(e.target.value)}
                      placeholder="Ilimitado"
                      className="w-28 px-2.5 py-1.5 rounded-lg bg-nexus-bg border border-nexus-border text-xs text-nexus-text"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isBusy}
                    className="px-3.5 py-1.5 rounded-lg bg-nexus-accent text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Gerar Convite</span>
                  </button>
                </form>

                <div className="space-y-2">
                  {communityInvites.map((inv) => (
                    <div
                      key={inv.id}
                      className="flex items-center justify-between gap-3 p-3 rounded-lg bg-nexus-surface border border-nexus-border text-xs"
                    >
                      <div>
                        <code className="font-mono font-bold text-nexus-text">{inv.code}</code>
                        <div className="text-[11px] text-nexus-muted">
                          Usos: {inv.uses_count}
                          {inv.max_uses ? ` / ${inv.max_uses}` : ''} • Expira:{' '}
                          {inv.expires_at ? formatDateTimePtBr(inv.expires_at) : 'Nunca'}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleCopy(`nexus://invite/${inv.code}`, inv.id)}
                          className="px-2.5 py-1 rounded bg-nexus-panel border border-nexus-border text-nexus-text flex items-center gap-1 cursor-pointer"
                        >
                          {copiedKey === inv.id ? (
                            <Check className="w-3 h-3 text-emerald-400" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                          <span>Copiar</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => revokeCommunityInvite(community.id, inv.id)}
                          className="p-1.5 rounded text-nexus-muted hover:text-rose-400 cursor-pointer"
                          title="Revogar"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                  {communityInvites.length === 0 && (
                    <p className="text-xs text-nexus-muted">Nenhum convite encontrado.</p>
                  )}
                </div>
              </div>
            )}

            {/* TAB: AUDIT LOGS */}
            {activeTab === 'audit' && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={auditActionFilter}
                    onChange={(e) => setAuditActionFilter(e.target.value)}
                    placeholder="Filtrar por ação (ex.: role, ban, channel)..."
                    className="flex-1 px-3 py-1.5 rounded-lg bg-nexus-surface border border-nexus-border text-xs text-nexus-text"
                  />
                  <button
                    type="button"
                    onClick={() => loadCommunityAuditLogs(community.id, { limit: 50 })}
                    className="px-3 py-1.5 rounded-lg bg-nexus-panel border border-nexus-border text-xs text-nexus-text flex items-center gap-1.5 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Atualizar</span>
                  </button>
                </div>

                <div className="space-y-1.5">
                  {communityAuditLogs
                    .filter(
                      (log) =>
                        !auditActionFilter.trim() ||
                        log.action
                          .toLowerCase()
                          .includes(auditActionFilter.trim().toLowerCase()) ||
                        (log.actor_username || '')
                          .toLowerCase()
                          .includes(auditActionFilter.trim().toLowerCase())
                    )
                    .map((log) => (
                      <div
                        key={log.id}
                        className="p-3 rounded-lg bg-nexus-surface border border-nexus-border text-xs space-y-1"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-nexus-text">
                            {log.actor_username || log.actor_id} •{' '}
                            <code className="text-nexus-accent">{log.action}</code>
                          </span>
                          <span className="text-[11px] text-nexus-muted">
                            {formatDateTimePtBr(log.created_at)}
                          </span>
                        </div>
                        <div className="text-[11px] text-nexus-muted">
                          Alvo: {log.target_type}
                          {log.target_id ? ` (${log.target_id})` : ''}
                          {log.reason ? ` • Motivo: ${log.reason}` : ''}
                        </div>
                      </div>
                    ))}
                  {communityAuditLogs.length === 0 && (
                    <p className="text-xs text-nexus-muted">Nenhum log administrativo encontrado.</p>
                  )}
                </div>
              </div>
            )}

            {/* TAB: DANGER / LEAVE */}
            {activeTab === 'danger' && (
              <div className="space-y-5 max-w-xl">
                {!isOwner ? (
                  <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 space-y-3">
                    <h4 className="text-xs font-bold text-rose-300">Sair da Comunidade</h4>
                    <p className="text-xs text-nexus-muted">
                      Você perderá acesso aos canais de <strong>{community.name}</strong> até
                      receber um novo convite.
                    </p>
                    <button
                      type="button"
                      onClick={handleLeaveCommunity}
                      disabled={isBusy}
                      className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      <span>Sair de {community.name}</span>
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 space-y-3">
                      <h4 className="text-xs font-bold text-amber-300">
                        Transferir Propriedade
                      </h4>
                      <p className="text-xs text-nexus-muted">
                        Transfira a posse total de <strong>{community.name}</strong> para outro
                        membro. Esta ação é imediata.
                      </p>
                      <select
                        value={transferTargetId}
                        onChange={(e) => setTransferTargetId(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-nexus-surface border border-nexus-border text-xs text-nexus-text"
                      >
                        <option value="">Selecione o novo proprietário...</option>
                        {members
                          .filter((m) => m.user_id !== currentUserId)
                          .map((m) => (
                            <option key={m.user_id} value={m.user_id}>
                              {m.display_name} (@{m.username})
                            </option>
                          ))}
                      </select>
                      <input
                        type="text"
                        value={transferConfirmName}
                        onChange={(e) => setTransferConfirmName(e.target.value)}
                        placeholder={`Digite "${community.name}" para confirmar`}
                        className="w-full px-3 py-2 rounded-lg bg-nexus-surface border border-nexus-border text-xs text-nexus-text"
                      />
                      <button
                        type="button"
                        onClick={handleTransferOwnership}
                        disabled={
                          isBusy ||
                          !transferTargetId ||
                          transferConfirmName.trim() !== community.name
                        }
                        className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold disabled:opacity-50 cursor-pointer"
                      >
                        Transferir Propriedade
                      </button>
                    </div>

                    <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 space-y-3">
                      <h4 className="text-xs font-bold text-rose-300">Excluir Comunidade</h4>
                      <p className="text-xs text-nexus-muted">
                        Esta ação remove permanentemente canais, mensagens, cargos e convites de{' '}
                        <strong>{community.name}</strong>.
                      </p>
                      <input
                        type="text"
                        value={deleteConfirmName}
                        onChange={(e) => setDeleteConfirmName(e.target.value)}
                        placeholder={`Digite "${community.name}" para confirmar`}
                        className="w-full px-3 py-2 rounded-lg bg-nexus-surface border border-nexus-border text-xs text-nexus-text"
                      />
                      <button
                        type="button"
                        onClick={handleDeleteCommunity}
                        disabled={isBusy || deleteConfirmName.trim() !== community.name}
                        className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold disabled:opacity-50 cursor-pointer"
                      >
                        Excluir Comunidade Permanentemente
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
