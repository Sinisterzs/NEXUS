/**
 * NEXUS - Call History Repository
 * Persistência local do histórico de chamadas de voz P2P isolada por conta (`accountId`).
 */

export interface CallHistoryEntry {
  id: string;
  peerId: string;
  peerName: string;
  peerUsername: string;
  peerAvatarUrl?: string;
  direction: 'outgoing' | 'incoming';
  status: 'completed' | 'missed' | 'rejected' | 'canceled';
  durationSecs: number;
  timestamp: number; // Unix ms
  accountId?: string;
}

const STORAGE_KEY_PREFIX = 'nexus_call_history_v1';
const MAX_HISTORY_ITEMS = 100;
const MAX_AVATAR_URL_LEN = 2048;

function sanitizeAvatarUrl(url?: string): string | undefined {
  if (!url || typeof url !== 'string') return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  // Prevent large Base64 data URIs from exhausting localStorage quota
  if (trimmed.startsWith('data:') || trimmed.length > MAX_AVATAR_URL_LEN) {
    return undefined;
  }
  return trimmed;
}

export class CallHistoryRepository {
  private currentAccountId: string = 'offline_demo';

  setAccountId(accountId?: string | null): void {
    const clean = accountId?.trim();
    this.currentAccountId = clean ? clean : 'offline_demo';
  }

  getAccountId(): string {
    return this.currentAccountId;
  }

  private getStorageKey(accountId?: string): string {
    const clean = accountId?.trim() || this.currentAccountId || 'offline_demo';
    return `${STORAGE_KEY_PREFIX}:${clean}`;
  }

  getHistory(accountId?: string): CallHistoryEntry[] {
    try {
      const key = this.getStorageKey(accountId);
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.warn('[CallHistoryRepository] Erro ao ler histórico:', err);
      return [];
    }
  }

  addEntry(
    entry: Omit<CallHistoryEntry, 'id' | 'timestamp'> & { timestamp?: number },
    accountId?: string
  ): CallHistoryEntry {
    const resolvedAccount = accountId?.trim() || entry.accountId?.trim() || this.currentAccountId;
    const sanitizedEntry = {
      ...entry,
      peerAvatarUrl: sanitizeAvatarUrl(entry.peerAvatarUrl),
      accountId: resolvedAccount,
    };

    try {
      const list = this.getHistory(resolvedAccount);
      const newEntry: CallHistoryEntry = {
        ...sanitizedEntry,
        id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        timestamp: entry.timestamp || Date.now(),
      };

      const updated = [newEntry, ...list].slice(0, MAX_HISTORY_ITEMS);
      localStorage.setItem(this.getStorageKey(resolvedAccount), JSON.stringify(updated));
      return newEntry;
    } catch (err) {
      console.warn('[CallHistoryRepository] Erro ao salvar chamada no histórico:', err);
      return {
        ...sanitizedEntry,
        id: `call_${Date.now()}`,
        timestamp: Date.now(),
      };
    }
  }

  clearHistory(accountId?: string): void {
    try {
      localStorage.removeItem(this.getStorageKey(accountId));
    } catch (err) {
      console.warn('[CallHistoryRepository] Erro ao limpar histórico:', err);
    }
  }
}

export const callHistoryRepository = new CallHistoryRepository();
