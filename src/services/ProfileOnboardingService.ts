const ONBOARDING_PREFIX = 'nexus_profile_onboarding_pending:';

export class ProfileOnboardingService {
  isPending(userId: string): boolean {
    if (!userId) return false;
    try {
      if (typeof globalThis.localStorage === 'undefined') return false;
      return globalThis.localStorage.getItem(`${ONBOARDING_PREFIX}${userId}`) === 'true';
    } catch {
      return false;
    }
  }

  markPending(userId: string): void {
    if (!userId) return;
    try {
      if (typeof globalThis.localStorage === 'undefined') return;
      globalThis.localStorage.setItem(`${ONBOARDING_PREFIX}${userId}`, 'true');
    } catch {
      // Ignore storage errors so account access is never blocked
    }
  }

  clearPending(userId: string): void {
    if (!userId) return;
    try {
      if (typeof globalThis.localStorage === 'undefined') return;
      globalThis.localStorage.removeItem(`${ONBOARDING_PREFIX}${userId}`);
    } catch {
      // Ignore storage errors
    }
  }
}

export const profileOnboardingService = new ProfileOnboardingService();
