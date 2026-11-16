export const UI30_REAUTH_KEY = 'ui30_reauth_v1_completed';

export class Ui30ReauthService {
  needsReauth(): boolean {
    try {
      if (typeof globalThis.localStorage === 'undefined') return false;
      return globalThis.localStorage.getItem(UI30_REAUTH_KEY) !== 'true';
    } catch {
      return false;
    }
  }

  markCompleted(): void {
    try {
      if (typeof globalThis.localStorage === 'undefined') return;
      globalThis.localStorage.setItem(UI30_REAUTH_KEY, 'true');
    } catch {
      // Ignore storage quota/availability errors without blocking login
    }
  }
}

export const ui30ReauthService = new Ui30ReauthService();
