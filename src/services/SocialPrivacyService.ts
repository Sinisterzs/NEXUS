export type DmPolicy = 'friends_only' | 'friends_and_community' | 'nobody';
export type FriendRequestPolicy = 'everyone' | 'community_only' | 'nobody';
export type PrivateCallPolicy = 'friends_only' | 'nobody';

export interface UserPrivacyPreferences {
  user_id: string;
  dm_policy: DmPolicy;
  friend_request_policy: FriendRequestPolicy;
  private_call_policy: PrivateCallPolicy;
  updated_at: string | null;
}

export interface DmMessageRequestDto {
  id: string;
  conversation_id: string;
  sender_id: string;
  recipient_id: string;
  status: 'pending' | 'accepted' | 'declined';
  created_at: string;
  responded_at: string | null;
  cooldown_until: string | null;
}

export class SocialPrivacyApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'SocialPrivacyApiError';
    this.status = status;
  }
}

export class SocialPrivacyService {
  async getPreferences(
    baseUrl: string,
    sessionToken: string,
    signal?: AbortSignal,
  ): Promise<UserPrivacyPreferences> {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/users/me/privacy`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      cache: 'no-store',
      signal,
    });
    if (!res.ok) {
      throw new SocialPrivacyApiError(res.status, 'Não foi possível carregar as preferências.');
    }
    return (await res.json()) as UserPrivacyPreferences;
  }

  async updatePreferences(
    baseUrl: string,
    sessionToken: string,
    payload: {
      dm_policy: DmPolicy;
      friend_request_policy: FriendRequestPolicy;
      private_call_policy: PrivateCallPolicy;
    },
  ): Promise<UserPrivacyPreferences> {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/users/me/privacy`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new SocialPrivacyApiError(res.status, 'Não foi possível salvar as preferências.');
    }
    return (await res.json()) as UserPrivacyPreferences;
  }

  async listDmRequests(
    baseUrl: string,
    sessionToken: string,
    signal?: AbortSignal,
  ): Promise<DmMessageRequestDto[]> {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/dm/requests`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      cache: 'no-store',
      signal,
    });
    if (!res.ok) {
      throw new SocialPrivacyApiError(res.status, 'Não foi possível carregar as solicitações.');
    }
    return (await res.json()) as DmMessageRequestDto[];
  }

  async acceptDmRequest(
    baseUrl: string,
    sessionToken: string,
    requestId: string,
  ): Promise<DmMessageRequestDto> {
    const res = await fetch(
      `${baseUrl.replace(/\/+$/, '')}/v1/dm/requests/${encodeURIComponent(requestId)}/accept`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      },
    );
    if (!res.ok) {
      throw new SocialPrivacyApiError(res.status, 'Não foi possível aceitar a solicitação.');
    }
    return (await res.json()) as DmMessageRequestDto;
  }

  async declineDmRequest(
    baseUrl: string,
    sessionToken: string,
    requestId: string,
  ): Promise<DmMessageRequestDto> {
    const res = await fetch(
      `${baseUrl.replace(/\/+$/, '')}/v1/dm/requests/${encodeURIComponent(requestId)}/decline`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      },
    );
    if (!res.ok) {
      throw new SocialPrivacyApiError(res.status, 'Não foi possível recusar a solicitação.');
    }
    return (await res.json()) as DmMessageRequestDto;
  }
}

export const socialPrivacyService = new SocialPrivacyService();
