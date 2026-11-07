/**
 * NEXUS - Call History Repository
 * Persistência local do histórico de chamadas de voz P2P.
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
}

const STORAGE_KEY = 'nexus_call_history_v1';
const MAX_HISTORY_ITEMS = 100;

export class CallHistoryRepository {
  getHistory(): CallHistoryEntry[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.warn('[CallHistoryRepository] Erro ao ler histórico:', err);
      return [];
    }
  }

  addEntry(entry: Omit<CallHistoryEntry, 'id' | 'timestamp'> & { timestamp?: number }): CallHistoryEntry {
    try {
      const list = this.getHistory();
      const newEntry: CallHistoryEntry = {
        ...entry,
        id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        timestamp: entry.timestamp || Date.now(),
      };

      const updated = [newEntry, ...list].slice(0, MAX_HISTORY_ITEMS);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      return newEntry;
    } catch (err) {
      console.warn('[CallHistoryRepository] Erro ao salvar chamada no histórico:', err);
      return {
        ...entry,
        id: `call_${Date.now()}`,
        timestamp: Date.now(),
      };
    }
  }

  clearHistory(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      console.warn('[CallHistoryRepository] Erro ao limpar histórico:', err);
    }
  }
}

export const callHistoryRepository = new CallHistoryRepository();
