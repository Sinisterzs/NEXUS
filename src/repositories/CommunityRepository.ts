import type {
  AcceptInviteResponse,
  AuditLogsQueryPayload,
  BanMemberPayload,
  ChannelMessageDto,
  ChannelMessagesPageDto,
  ChannelPermissionOverwriteDto,
  ChannelReadStateDto,
  CommunityAuditLogDto,
  CommunityBanDto,
  CommunityCategoryDto,
  CommunityChannelDto,
  CommunityDto,
  CommunityInviteDto,
  CommunityMemberDto,
  CommunityMemberMuteDto,
  CommunityRoleDto,
  CommunitySnapshotDto,
  CreateCategoryPayload,
  CreateChannelPayload,
  CreateCommunityPayload,
  CreateInvitePayload,
  CreateRolePayload,
  DeleteCommunityPayload,
  InvitePreviewDto,
  KickMemberPayload,
  MuteMemberPayload,
  OverwriteTargetType,
  ReorderCategoryItem,
  ReorderChannelItem,
  ReorderRoleItem,
  SendChannelMessagePayload,
  TransferOwnershipPayload,
  UpdateCategoryPayload,
  UpdateChannelPayload,
  UpdateCommunityPayload,
  UpdateMemberPayload,
  UpdateRolePayload,
  UpsertChannelOverwritePayload,
} from '../lib/types';

function getTestHttpConfig(): { apiBase: string; token: string } | null {
  if (typeof window === 'undefined') return null;
  // In normal Tauri runtime, always use invoke exclusively
  if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    return null;
  }
  try {
    const apiBase = window.localStorage?.getItem('nexus_test_api_base')?.trim();
    const token = window.localStorage?.getItem('nexus_test_token')?.trim();
    if (apiBase && token) {
      return { apiBase: apiBase.replace(/\/+$/, ''), token };
    }
  } catch {
    // Ignore storage access errors
  }
  return null;
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const anyErr = err as Record<string, unknown>;
    if (typeof anyErr.message === 'string' && anyErr.message) return anyErr.message;
    if (typeof anyErr.error === 'string' && anyErr.error) return anyErr.error;
    if (anyErr.error && typeof anyErr.error === 'object') {
      const nested = anyErr.error as Record<string, unknown>;
      if (typeof nested.message === 'string' && nested.message) return nested.message;
    }
  }
  return fallback;
}

async function httpFallback<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const cfg = getTestHttpConfig();
  if (!cfg) {
    throw new Error('Runtime Tauri indisponível para operação de comunidade.');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.token}`,
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${cfg.apiBase}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let errBody: unknown = null;
    try {
      errBody = await res.json();
    } catch {
      errBody = await res.text().catch(() => null);
    }
    const msg = extractErrorMessage(errBody, `HTTP ${res.status}`);
    throw new Error(`[HTTP ${res.status}] ${msg}`);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

async function callCommand<T>(
  command: string,
  args: Record<string, unknown>,
  httpSpec: { method: string; path: string; body?: unknown }
): Promise<T> {
  const testCfg = getTestHttpConfig();
  if (testCfg) {
    return httpFallback<T>(httpSpec.method, httpSpec.path, httpSpec.body);
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(command, args);
  } catch (err) {
    throw new Error(extractErrorMessage(err, `Falha no comando ${command}`));
  }
}

function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      sp.set(k, String(v));
    }
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

class CommunityRepository {
  // ==========================================
  // Communities
  // ==========================================

  async listCommunities(): Promise<CommunityDto[]> {
    return callCommand<CommunityDto[]>('community_list', {}, {
      method: 'GET',
      path: '/v1/communities',
    });
  }

  async createCommunity(payload: CreateCommunityPayload): Promise<CommunityDto> {
    return callCommand<CommunityDto>(
      'community_create',
      { payload },
      { method: 'POST', path: '/v1/communities', body: payload }
    );
  }

  async getSnapshot(communityId: string): Promise<CommunitySnapshotDto> {
    return callCommand<CommunitySnapshotDto>(
      'community_get_snapshot',
      { communityId },
      { method: 'GET', path: `/v1/communities/${encodeURIComponent(communityId)}` }
    );
  }

  async updateCommunity(
    communityId: string,
    payload: UpdateCommunityPayload
  ): Promise<CommunityDto> {
    return callCommand<CommunityDto>(
      'community_update',
      { communityId, payload },
      {
        method: 'PATCH',
        path: `/v1/communities/${encodeURIComponent(communityId)}`,
        body: payload,
      }
    );
  }

  async deleteCommunity(
    communityId: string,
    payload: DeleteCommunityPayload
  ): Promise<void> {
    return callCommand<void>(
      'community_delete',
      { communityId, payload },
      {
        method: 'DELETE',
        path: `/v1/communities/${encodeURIComponent(communityId)}`,
        body: payload,
      }
    );
  }

  async transferOwnership(
    communityId: string,
    payload: TransferOwnershipPayload
  ): Promise<CommunityDto> {
    return callCommand<CommunityDto>(
      'community_transfer_ownership',
      { communityId, payload },
      {
        method: 'POST',
        path: `/v1/communities/${encodeURIComponent(communityId)}/transfer-ownership`,
        body: payload,
      }
    );
  }

  async leaveCommunity(communityId: string): Promise<void> {
    return callCommand<void>(
      'community_leave',
      { communityId },
      {
        method: 'POST',
        path: `/v1/communities/${encodeURIComponent(communityId)}/leave`,
      }
    );
  }

  // ==========================================
  // Categories
  // ==========================================

  async createCategory(
    communityId: string,
    payload: CreateCategoryPayload
  ): Promise<CommunityCategoryDto> {
    return callCommand<CommunityCategoryDto>(
      'community_create_category',
      { communityId, payload },
      {
        method: 'POST',
        path: `/v1/communities/${encodeURIComponent(communityId)}/categories`,
        body: payload,
      }
    );
  }

  async updateCategory(
    communityId: string,
    categoryId: string,
    payload: UpdateCategoryPayload
  ): Promise<CommunityCategoryDto> {
    return callCommand<CommunityCategoryDto>(
      'community_update_category',
      { communityId, categoryId, payload },
      {
        method: 'PATCH',
        path: `/v1/communities/${encodeURIComponent(communityId)}/categories/${encodeURIComponent(categoryId)}`,
        body: payload,
      }
    );
  }

  async deleteCategory(communityId: string, categoryId: string): Promise<void> {
    return callCommand<void>(
      'community_delete_category',
      { communityId, categoryId },
      {
        method: 'DELETE',
        path: `/v1/communities/${encodeURIComponent(communityId)}/categories/${encodeURIComponent(categoryId)}`,
      }
    );
  }

  async reorderCategories(
    communityId: string,
    items: ReorderCategoryItem[]
  ): Promise<CommunityCategoryDto[]> {
    const payload = { items };
    return callCommand<CommunityCategoryDto[]>(
      'community_reorder_categories',
      { communityId, payload },
      {
        method: 'PUT',
        path: `/v1/communities/${encodeURIComponent(communityId)}/categories/reorder`,
        body: payload,
      }
    );
  }

  // ==========================================
  // Channels & Overwrites
  // ==========================================

  async createChannel(
    communityId: string,
    payload: CreateChannelPayload
  ): Promise<CommunityChannelDto> {
    return callCommand<CommunityChannelDto>(
      'community_create_channel',
      { communityId, payload },
      {
        method: 'POST',
        path: `/v1/communities/${encodeURIComponent(communityId)}/channels`,
        body: payload,
      }
    );
  }

  async updateChannel(
    communityId: string,
    channelId: string,
    payload: UpdateChannelPayload
  ): Promise<CommunityChannelDto> {
    return callCommand<CommunityChannelDto>(
      'community_update_channel',
      { communityId, channelId, payload },
      {
        method: 'PATCH',
        path: `/v1/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}`,
        body: payload,
      }
    );
  }

  async deleteChannel(communityId: string, channelId: string): Promise<void> {
    return callCommand<void>(
      'community_delete_channel',
      { communityId, channelId },
      {
        method: 'DELETE',
        path: `/v1/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}`,
      }
    );
  }

  async reorderChannels(
    communityId: string,
    items: ReorderChannelItem[]
  ): Promise<CommunityChannelDto[]> {
    const payload = { items };
    return callCommand<CommunityChannelDto[]>(
      'community_reorder_channels',
      { communityId, payload },
      {
        method: 'PUT',
        path: `/v1/communities/${encodeURIComponent(communityId)}/channels/reorder`,
        body: payload,
      }
    );
  }

  async listChannelOverwrites(
    communityId: string,
    channelId: string
  ): Promise<ChannelPermissionOverwriteDto[]> {
    return callCommand<ChannelPermissionOverwriteDto[]>(
      'community_list_channel_overwrites',
      { communityId, channelId },
      {
        method: 'GET',
        path: `/v1/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/overwrites`,
      }
    );
  }

  async upsertChannelOverwrite(
    communityId: string,
    channelId: string,
    payload: UpsertChannelOverwritePayload
  ): Promise<ChannelPermissionOverwriteDto> {
    return callCommand<ChannelPermissionOverwriteDto>(
      'community_upsert_channel_overwrite',
      { communityId, channelId, payload },
      {
        method: 'PUT',
        path: `/v1/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/overwrites`,
        body: payload,
      }
    );
  }

  async deleteChannelOverwrite(
    communityId: string,
    channelId: string,
    targetType: OverwriteTargetType | string,
    targetId: string
  ): Promise<void> {
    return callCommand<void>(
      'community_delete_channel_overwrite',
      { communityId, channelId, targetType, targetId },
      {
        method: 'DELETE',
        path: `/v1/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/overwrites/${encodeURIComponent(targetType)}/${encodeURIComponent(targetId)}`,
      }
    );
  }

  // ==========================================
  // Channel Messages & Read State
  // ==========================================

  async listChannelMessages(
    communityId: string,
    channelId: string,
    before?: string,
    limit: number = 50
  ): Promise<ChannelMessagesPageDto> {
    const qs = buildQuery({ before, limit });
    return callCommand<ChannelMessagesPageDto>(
      'community_list_channel_messages',
      { communityId, channelId, before: before ?? null, limit },
      {
        method: 'GET',
        path: `/v1/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/messages${qs}`,
      }
    );
  }

  async sendChannelMessage(
    communityId: string,
    channelId: string,
    payload: SendChannelMessagePayload
  ): Promise<ChannelMessageDto> {
    return callCommand<ChannelMessageDto>(
      'community_send_channel_message',
      { communityId, channelId, payload },
      {
        method: 'POST',
        path: `/v1/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/messages`,
        body: payload,
      }
    );
  }

  async editChannelMessage(
    communityId: string,
    channelId: string,
    messageId: string,
    content: string
  ): Promise<ChannelMessageDto> {
    const payload = { content };
    return callCommand<ChannelMessageDto>(
      'community_edit_channel_message',
      { communityId, channelId, messageId, payload },
      {
        method: 'PATCH',
        path: `/v1/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
        body: payload,
      }
    );
  }

  async deleteChannelMessage(
    communityId: string,
    channelId: string,
    messageId: string
  ): Promise<ChannelMessageDto | void> {
    return callCommand<ChannelMessageDto | void>(
      'community_delete_channel_message',
      { communityId, channelId, messageId },
      {
        method: 'DELETE',
        path: `/v1/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      }
    );
  }

  async markChannelRead(
    communityId: string,
    channelId: string,
    lastReadMessageId?: string | null
  ): Promise<ChannelReadStateDto> {
    const payload = { last_read_message_id: lastReadMessageId ?? null };
    return callCommand<ChannelReadStateDto>(
      'community_mark_channel_read',
      { communityId, channelId, lastReadMessageId: lastReadMessageId ?? null },
      {
        method: 'POST',
        path: `/v1/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/read`,
        body: payload,
      }
    );
  }

  // ==========================================
  // Roles
  // ==========================================

  async listRoles(communityId: string): Promise<CommunityRoleDto[]> {
    return callCommand<CommunityRoleDto[]>(
      'community_list_roles',
      { communityId },
      {
        method: 'GET',
        path: `/v1/communities/${encodeURIComponent(communityId)}/roles`,
      }
    );
  }

  async createRole(
    communityId: string,
    payload: CreateRolePayload
  ): Promise<CommunityRoleDto> {
    return callCommand<CommunityRoleDto>(
      'community_create_role',
      { communityId, payload },
      {
        method: 'POST',
        path: `/v1/communities/${encodeURIComponent(communityId)}/roles`,
        body: payload,
      }
    );
  }

  async updateRole(
    communityId: string,
    roleId: string,
    payload: UpdateRolePayload
  ): Promise<CommunityRoleDto> {
    return callCommand<CommunityRoleDto>(
      'community_update_role',
      { communityId, roleId, payload },
      {
        method: 'PATCH',
        path: `/v1/communities/${encodeURIComponent(communityId)}/roles/${encodeURIComponent(roleId)}`,
        body: payload,
      }
    );
  }

  async deleteRole(communityId: string, roleId: string): Promise<void> {
    return callCommand<void>(
      'community_delete_role',
      { communityId, roleId },
      {
        method: 'DELETE',
        path: `/v1/communities/${encodeURIComponent(communityId)}/roles/${encodeURIComponent(roleId)}`,
      }
    );
  }

  async reorderRoles(
    communityId: string,
    items: ReorderRoleItem[]
  ): Promise<CommunityRoleDto[]> {
    const payload = { items };
    return callCommand<CommunityRoleDto[]>(
      'community_reorder_roles',
      { communityId, payload },
      {
        method: 'PUT',
        path: `/v1/communities/${encodeURIComponent(communityId)}/roles/reorder`,
        body: payload,
      }
    );
  }

  // ==========================================
  // Members & Member Roles
  // ==========================================

  async listMembers(communityId: string): Promise<CommunityMemberDto[]> {
    return callCommand<CommunityMemberDto[]>(
      'community_list_members',
      { communityId },
      {
        method: 'GET',
        path: `/v1/communities/${encodeURIComponent(communityId)}/members`,
      }
    );
  }

  async updateMember(
    communityId: string,
    userId: string,
    payload: UpdateMemberPayload
  ): Promise<CommunityMemberDto> {
    return callCommand<CommunityMemberDto>(
      'community_update_member',
      { communityId, userId, payload },
      {
        method: 'PATCH',
        path: `/v1/communities/${encodeURIComponent(communityId)}/members/${encodeURIComponent(userId)}`,
        body: payload,
      }
    );
  }

  async setMemberRoles(
    communityId: string,
    userId: string,
    roleIds: string[]
  ): Promise<CommunityMemberDto> {
    const payload = { role_ids: roleIds };
    return callCommand<CommunityMemberDto>(
      'community_set_member_roles',
      { communityId, userId, roleIds },
      {
        method: 'PUT',
        path: `/v1/communities/${encodeURIComponent(communityId)}/members/${encodeURIComponent(userId)}/roles`,
        body: payload,
      }
    );
  }

  async addMemberRole(
    communityId: string,
    userId: string,
    roleId: string
  ): Promise<CommunityMemberDto> {
    return callCommand<CommunityMemberDto>(
      'community_add_member_role',
      { communityId, userId, roleId },
      {
        method: 'POST',
        path: `/v1/communities/${encodeURIComponent(communityId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
      }
    );
  }

  async removeMemberRole(
    communityId: string,
    userId: string,
    roleId: string
  ): Promise<CommunityMemberDto> {
    return callCommand<CommunityMemberDto>(
      'community_remove_member_role',
      { communityId, userId, roleId },
      {
        method: 'DELETE',
        path: `/v1/communities/${encodeURIComponent(communityId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
      }
    );
  }

  // ==========================================
  // Moderation & Audit Logs
  // ==========================================

  async kickMember(
    communityId: string,
    userId: string,
    payload: KickMemberPayload = {}
  ): Promise<void> {
    return callCommand<void>(
      'community_kick_member',
      { communityId, userId, reason: payload.reason ?? null },
      {
        method: 'POST',
        path: `/v1/communities/${encodeURIComponent(communityId)}/members/${encodeURIComponent(userId)}/kick`,
        body: payload,
      }
    );
  }

  async banMember(
    communityId: string,
    userId: string,
    payload: BanMemberPayload = {}
  ): Promise<CommunityBanDto> {
    return callCommand<CommunityBanDto>(
      'community_ban_member',
      { communityId, userId, payload },
      {
        method: 'POST',
        path: `/v1/communities/${encodeURIComponent(communityId)}/members/${encodeURIComponent(userId)}/ban`,
        body: payload,
      }
    );
  }

  async unbanMember(communityId: string, userId: string): Promise<void> {
    return callCommand<void>(
      'community_unban_member',
      { communityId, userId },
      {
        method: 'DELETE',
        path: `/v1/communities/${encodeURIComponent(communityId)}/bans/${encodeURIComponent(userId)}`,
      }
    );
  }

  async listBans(communityId: string): Promise<CommunityBanDto[]> {
    return callCommand<CommunityBanDto[]>(
      'community_list_bans',
      { communityId },
      {
        method: 'GET',
        path: `/v1/communities/${encodeURIComponent(communityId)}/bans`,
      }
    );
  }

  async muteMember(
    communityId: string,
    userId: string,
    payload: MuteMemberPayload
  ): Promise<CommunityMemberMuteDto> {
    return callCommand<CommunityMemberMuteDto>(
      'community_mute_member',
      { communityId, userId, payload },
      {
        method: 'PUT',
        path: `/v1/communities/${encodeURIComponent(communityId)}/members/${encodeURIComponent(userId)}/mute`,
        body: payload,
      }
    );
  }

  async listAuditLogs(
    communityId: string,
    query: AuditLogsQueryPayload = {}
  ): Promise<CommunityAuditLogDto[]> {
    const qs = buildQuery({
      action: query.action,
      actor_id: query.actor_id,
      before: query.before,
      limit: query.limit,
    });
    return callCommand<CommunityAuditLogDto[]>(
      'community_list_audit_logs',
      {
        communityId,
        action: query.action ?? null,
        actorId: query.actor_id ?? null,
        before: query.before ?? null,
        limit: query.limit ?? null,
      },
      {
        method: 'GET',
        path: `/v1/communities/${encodeURIComponent(communityId)}/audit-logs${qs}`,
      }
    );
  }

  // ==========================================
  // Invites
  // ==========================================

  async createInvite(
    communityId: string,
    payload: CreateInvitePayload = {}
  ): Promise<CommunityInviteDto> {
    return callCommand<CommunityInviteDto>(
      'community_create_invite',
      { communityId, payload },
      {
        method: 'POST',
        path: `/v1/communities/${encodeURIComponent(communityId)}/invites`,
        body: payload,
      }
    );
  }

  async listInvites(communityId: string): Promise<CommunityInviteDto[]> {
    return callCommand<CommunityInviteDto[]>(
      'community_list_invites',
      { communityId },
      {
        method: 'GET',
        path: `/v1/communities/${encodeURIComponent(communityId)}/invites`,
      }
    );
  }

  async revokeInvite(communityId: string, inviteId: string): Promise<void> {
    return callCommand<void>(
      'community_revoke_invite',
      { communityId, inviteId },
      {
        method: 'DELETE',
        path: `/v1/communities/${encodeURIComponent(communityId)}/invites/${encodeURIComponent(inviteId)}`,
      }
    );
  }

  async getInvitePreview(code: string): Promise<InvitePreviewDto> {
    const cleanCode = code.trim();
    return callCommand<InvitePreviewDto>(
      'community_get_invite_preview',
      { code: cleanCode },
      {
        method: 'GET',
        path: `/v1/invites/${encodeURIComponent(cleanCode)}`,
      }
    );
  }

  async acceptInvite(code: string): Promise<AcceptInviteResponse> {
    const cleanCode = code.trim();
    return callCommand<AcceptInviteResponse>(
      'community_accept_invite',
      { code: cleanCode },
      {
        method: 'POST',
        path: `/v1/invites/${encodeURIComponent(cleanCode)}/accept`,
      }
    );
  }
}

export const communityRepository = new CommunityRepository();
