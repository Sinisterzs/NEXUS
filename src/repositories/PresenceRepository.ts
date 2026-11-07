import { PresenceData, UserStatus } from '../lib/types';

export interface RawPresenceDto {
  user_id: string;
  status: string;
  preferred_status: string;
  custom_status?: string;
  activity?: string;
  allow_friend_requests: boolean;
  last_seen_at?: string;
}

function mapPresenceDto(dto: RawPresenceDto): PresenceData {
  return {
    userId: dto.user_id,
    status: dto.status,
    preferredStatus: dto.preferred_status,
    customStatus: dto.custom_status,
    activity: dto.activity,
    allowFriendRequests: dto.allow_friend_requests,
    lastSeenAt: dto.last_seen_at,
  };
}

class PresenceRepository {
  async getPresence(): Promise<PresenceData> {
    const { invoke } = await import('@tauri-apps/api/core');
    const raw = await invoke<RawPresenceDto>('friends_get_presence');
    return mapPresenceDto(raw);
  }

  async updatePresence(params: {
    status?: UserStatus;
    preferredStatus?: UserStatus;
    customStatus?: string | null;
    activity?: string | null;
    allowFriendRequests?: boolean;
  }): Promise<PresenceData> {
    const { invoke } = await import('@tauri-apps/api/core');
    const raw = await invoke<RawPresenceDto>('friends_update_presence', {
      status: params.status || null,
      preferredStatus: params.preferredStatus || null,
      customStatus: params.customStatus !== undefined ? params.customStatus : null,
      activity: params.activity !== undefined ? params.activity : null,
      allowFriendRequests: params.allowFriendRequests !== undefined ? params.allowFriendRequests : null,
    });
    return mapPresenceDto(raw);
  }
}

export const presenceRepository = new PresenceRepository();
