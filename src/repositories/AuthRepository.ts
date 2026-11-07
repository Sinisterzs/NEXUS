import { AuthUserProfile } from '../lib/types';

export function normalizeAuthUser(raw: any): AuthUserProfile {
  if (!raw) return raw;
  return {
    id: String(raw.id || ''),
    username: String(raw.username || ''),
    email: String(raw.email || ''),
    displayName: String(raw.displayName || raw.display_name || raw.username || ''),
    avatarUrl: raw.avatarUrl || raw.avatar_url || undefined,
    bio: raw.bio !== undefined ? raw.bio : undefined,
    status: raw.status || 'online',
    customStatus: raw.customStatus || raw.custom_status || '',
    activity: raw.activity || undefined,
    hasPassword: raw.hasPassword !== undefined ? Boolean(raw.hasPassword) : Boolean(raw.has_password),
    hasGoogle: raw.hasGoogle !== undefined ? Boolean(raw.hasGoogle) : Boolean(raw.has_google),
    createdAt: String(raw.createdAt || raw.created_at || new Date().toISOString()),
  };
}

class AuthRepository {
  async register(
    username: string,
    email: string,
    password: string,
    displayName?: string
  ): Promise<AuthUserProfile> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<AuthUserProfile>('auth_register', {
        username,
        email,
        password,
        displayName: displayName || null,
      });
      return normalizeAuthUser(res);
    } catch (err: any) {
      throw new Error(typeof err === 'string' ? err : err?.message || 'Falha ao registrar conta');
    }
  }

  async login(login: string, password: string): Promise<AuthUserProfile> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<AuthUserProfile>('auth_login', {
        login,
        password,
      });
      return normalizeAuthUser(res);
    } catch (err: any) {
      throw new Error(typeof err === 'string' ? err : err?.message || 'Credenciais inválidas');
    }
  }

  async logout(): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('auth_logout');
    } catch (err) {
      console.warn('[AuthRepository] Logout notice:', err);
    }
  }

  async hasStoredSession(): Promise<boolean> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<boolean>('auth_has_stored_session');
    } catch {
      return false;
    }
  }

  async restoreSession(): Promise<{ user: AuthUserProfile | null; isOffline: boolean; hasStoredToken: boolean }> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const rawUser = await invoke<AuthUserProfile | null>('auth_restore_session');
      const user = rawUser ? normalizeAuthUser(rawUser) : null;
      return { user, isOffline: false, hasStoredToken: user !== null };
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || '';
      if (msg.includes('NETWORK_ERROR') || msg.includes('Servidor indisponível')) {
        return { user: null, isOffline: true, hasStoredToken: true };
      }
      return { user: null, isOffline: false, hasStoredToken: false };
    }
  }

  async checkBackend(): Promise<boolean> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<boolean>('auth_check_backend');
    } catch {
      return false;
    }
  }

  async loginGoogle(): Promise<AuthUserProfile> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<AuthUserProfile>('auth_login_google');
      return normalizeAuthUser(res);
    } catch (err: any) {
      throw new Error(typeof err === 'string' ? err : err?.message || 'Falha ao autenticar com o Google');
    }
  }

  async linkGoogle(): Promise<string> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<string>('auth_link_google');
    } catch (err: any) {
      throw new Error(typeof err === 'string' ? err : err?.message || 'Falha ao vincular conta Google');
    }
  }

  async unlinkGoogle(): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('auth_unlink_google');
    } catch (err: any) {
      throw new Error(typeof err === 'string' ? err : err?.message || 'Falha ao desvincular conta Google');
    }
  }

  async getMe(): Promise<AuthUserProfile | null> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const raw = await invoke<AuthUserProfile | null>('auth_get_me');
      return raw ? normalizeAuthUser(raw) : null;
    } catch (err: any) {
      console.warn('[AuthRepository] Failed to fetch profile from get_me:', err);
      return null;
    }
  }

  async updateProfile(updates: {
    username?: string;
    displayName?: string;
    bio?: string;
    customStatus?: string;
  }): Promise<AuthUserProfile> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<AuthUserProfile>('auth_update_profile', {
        username: updates.username || null,
        displayName: updates.displayName || null,
        bio: updates.bio !== undefined ? updates.bio : null,
        customStatus: updates.customStatus !== undefined ? updates.customStatus : null,
      });
      return normalizeAuthUser(res);
    } catch (err: any) {
      throw new Error(typeof err === 'string' ? err : err?.message || 'Falha ao atualizar perfil');
    }
  }

  async cancelGoogleLogin(): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('auth_cancel_google_login');
    } catch {
      // Ignored
    }
  }
}

export const authRepository = new AuthRepository();
