import { resolveAvatarUrl } from '../lib/avatarUrl.ts';
export { resolveAvatarUrl } from '../lib/avatarUrl.ts';

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export interface AvatarRequestOptions {
  apiBaseUrl?: string;
  token?: string | null;
}

async function resolveApiBaseUrl(explicit?: string): Promise<string> {
  if (explicit && explicit.trim()) {
    return explicit.trim().replace(/\/+$/, '');
  }
  try {
    const { settingsRepository } = await import('../repositories/SettingsRepository');
    const repo = settingsRepository as unknown as {
      getSettings?: () => Promise<{ serverUrl?: string }>;
      load?: () => Promise<{ serverUrl?: string }>;
    };
    const settings = await (repo.getSettings?.() ?? repo.load?.());
    const configured = settings?.serverUrl;
    if (configured && configured.trim()) {
      return configured.trim().replace(/\/+$/, '');
    }
  } catch {
    // Fallback to default official API origin
  }
  return 'https://api.nexus.app';
}

async function resolveSessionToken(explicit?: string | null): Promise<string> {
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const token = await invoke<string | null>('auth_get_session_token');
    if (token && token.trim()) {
      return token.trim();
    }
  } catch {
    // Ignore when running outside Tauri
  }
  throw new Error('Sessão inválida ou expirada. Faça login novamente.');
}

export class AvatarService {
  async uploadAvatar(file: File, options: AvatarRequestOptions = {}): Promise<string> {
    if (!ALLOWED_TYPES.has(file.type)) {
      throw new Error('Formato inválido. Selecione uma imagem PNG, JPEG ou WebP.');
    }
    if (file.size <= 0 || file.size > MAX_AVATAR_BYTES) {
      throw new Error('A imagem deve ter no máximo 2 MB.');
    }

    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && !options.token) {
      const { invoke } = await import('@tauri-apps/api/core');
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      return await invoke<string>('auth_upload_avatar', {
        bytes,
        contentType: file.type,
      });
    }

    const [baseUrl, token] = await Promise.all([
      resolveApiBaseUrl(options.apiBaseUrl),
      resolveSessionToken(options.token),
    ]);

    const res = await fetch(`${baseUrl}/v1/users/me/avatar`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': file.type,
      },
      body: await file.arrayBuffer(),
    });

    if (!res.ok) {
      let message = 'Não foi possível enviar a foto de perfil.';
      try {
        const errBody = (await res.json()) as { error?: { message?: string } };
        if (errBody?.error?.message) {
          message = errBody.error.message;
        }
      } catch {
        // Keep default message
      }
      throw new Error(message);
    }

    const data = (await res.json()) as { avatar_url?: string };
    if (!data?.avatar_url) {
      throw new Error('Resposta inválida do servidor ao salvar avatar.');
    }

    return resolveAvatarUrl(data.avatar_url, baseUrl) ?? data.avatar_url;
  }

  async deleteAvatar(options: AvatarRequestOptions = {}): Promise<void> {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && !options.token) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('auth_delete_avatar');
      return;
    }

    const [baseUrl, token] = await Promise.all([
      resolveApiBaseUrl(options.apiBaseUrl),
      resolveSessionToken(options.token),
    ]);

    const res = await fetch(`${baseUrl}/v1/users/me/avatar`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      throw new Error('Não foi possível remover a foto de perfil.');
    }
  }
}

export const avatarService = new AvatarService();
