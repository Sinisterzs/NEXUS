import { Friend, FriendRequest, FriendRequestsData, UserSearchResult, UserStatus } from '../lib/types';

export interface RawFriendDto {
  id: string;
  username: string;
  tag: string;
  display_name: string;
  avatar_url?: string;
  bio?: string;
  status: string;
  custom_status?: string;
  activity?: string;
  last_seen_at?: string;
}

export interface RawFriendRequestDto {
  id: string;
  user_id: string;
  username: string;
  tag: string;
  display_name: string;
  avatar_url?: string;
  status: string;
  created_at: string;
}

export interface RawFriendRequestsResponse {
  incoming: RawFriendRequestDto[];
  outgoing: RawFriendRequestDto[];
}

export interface RawUserSearchDto {
  id: string;
  username: string;
  tag: string;
  display_name: string;
  avatar_url?: string;
  is_friend: boolean;
  has_pending_request: boolean;
  is_blocked: boolean;
}

function mapFriendDto(dto: RawFriendDto): Friend {
  return {
    id: dto.id,
    name: dto.display_name || dto.username,
    username: dto.username,
    tag: dto.tag,
    avatarUrl: dto.avatar_url,
    status: (dto.status as UserStatus) || 'offline',
    customStatus: dto.custom_status,
    activity: dto.activity,
    lastSeenAt: dto.last_seen_at,
  };
}

function mapFriendRequestDto(dto: RawFriendRequestDto): FriendRequest {
  return {
    id: dto.id,
    userId: dto.user_id,
    username: dto.username,
    tag: dto.tag,
    displayName: dto.display_name,
    avatarUrl: dto.avatar_url,
    status: dto.status,
    createdAt: dto.created_at,
  };
}

function mapUserSearchDto(dto: RawUserSearchDto): UserSearchResult {
  return {
    id: dto.id,
    username: dto.username,
    tag: dto.tag,
    displayName: dto.display_name,
    avatarUrl: dto.avatar_url,
    isFriend: dto.is_friend,
    hasPendingRequest: dto.has_pending_request,
    isBlocked: dto.is_blocked,
  };
}

class FriendRepository {
  async getFriends(): Promise<Friend[]> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const raw = await invoke<RawFriendDto[]>('friends_get_list');
      return raw.map(mapFriendDto);
    } catch (err) {
      console.warn('[FriendRepository] getFriends failed or offline:', err);
      return [];
    }
  }

  async getRequests(): Promise<FriendRequestsData> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const raw = await invoke<RawFriendRequestsResponse>('friends_get_requests');
      return {
        incoming: raw.incoming.map(mapFriendRequestDto),
        outgoing: raw.outgoing.map(mapFriendRequestDto),
      };
    } catch {
      return { incoming: [], outgoing: [] };
    }
  }

  async sendRequest(target: string): Promise<FriendRequest> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const raw = await invoke<RawFriendRequestDto>('friends_send_request', { target });
      return mapFriendRequestDto(raw);
    } catch (err: any) {
      throw new Error(typeof err === 'string' ? err : err?.message || 'Falha ao enviar solicitação.');
    }
  }

  async acceptRequest(requestId: string): Promise<Friend> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const raw = await invoke<RawFriendDto>('friends_accept_request', { requestId });
      return mapFriendDto(raw);
    } catch (err: any) {
      throw new Error(typeof err === 'string' ? err : err?.message || 'Falha ao aceitar solicitação.');
    }
  }

  async rejectRequest(requestId: string): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('friends_reject_request', { requestId });
    } catch (err: any) {
      throw new Error(typeof err === 'string' ? err : err?.message || 'Falha ao recusar solicitação.');
    }
  }

  async cancelRequest(requestId: string): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('friends_cancel_request', { requestId });
    } catch (err: any) {
      throw new Error(typeof err === 'string' ? err : err?.message || 'Falha ao cancelar solicitação.');
    }
  }

  async declineRequest(requestId: string): Promise<void> {
    return this.rejectRequest(requestId);
  }

  async removeFriend(friendId: string): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('friends_remove', { friendId });
    } catch (err: any) {
      throw new Error(typeof err === 'string' ? err : err?.message || 'Falha ao remover amigo.');
    }
  }

  async blockUser(userId: string): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('friends_block_user', { userId });
    } catch (err: any) {
      throw new Error(typeof err === 'string' ? err : err?.message || 'Falha ao bloquear usuário.');
    }
  }

  async unblockUser(userId: string): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('friends_unblock_user', { userId });
    } catch (err: any) {
      throw new Error(typeof err === 'string' ? err : err?.message || 'Falha ao desbloquear usuário.');
    }
  }

  async searchUsers(query: string): Promise<UserSearchResult[]> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const raw = await invoke<RawUserSearchDto[]>('friends_search_users', { query });
      return raw.map(mapUserSearchDto);
    } catch (err: any) {
      throw new Error(typeof err === 'string' ? err : err?.message || 'Falha ao buscar usuários.');
    }
  }

  async getWsUrl(): Promise<string> {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string>('gateway_get_ws_url');
  }
}

export const friendRepository = new FriendRepository();
