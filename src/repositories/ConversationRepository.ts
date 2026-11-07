import { DbConversation, DbConversationState } from '../lib/types';

class ConversationRepository {
  private currentAccountId: string = 'offline_demo';
  private localDrafts: Record<string, string> = {};
  private localReadStates: Record<string, string> = {};

  setAccountId(accountId?: string | null): void {
    const clean = accountId?.trim();
    this.currentAccountId = clean ? clean : 'offline_demo';
  }

  private resolveAccount(accountId?: string): string {
    return accountId?.trim() || this.currentAccountId || 'offline_demo';
  }

  private scopedKey(conversationId: string, accountId?: string): string {
    return `${this.resolveAccount(accountId)}:${conversationId}`;
  }

  async ensureConversation(
    id: string,
    type: 'dm' | 'channel' = 'dm',
    title: string = '',
    accountId?: string
  ): Promise<DbConversation> {
    const resolvedAcc = this.resolveAccount(accountId);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<DbConversation>('ensure_conversation', {
        id,
        conversationType: type,
        title,
        accountId: resolvedAcc,
      });
    } catch {
      return {
        id,
        type,
        title,
        updated_at: Math.floor(Date.now() / 1000),
      };
    }
  }

  async getConversations(accountId?: string): Promise<DbConversation[]> {
    const resolvedAcc = this.resolveAccount(accountId);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<DbConversation[]>('get_conversations', {
        accountId: resolvedAcc,
      });
    } catch {
      if (resolvedAcc !== 'offline_demo') {
        return [];
      }
      // Browser preview fallback for offline_demo only
      return [
        { id: 'f_01', type: 'dm', title: 'Beatriz Lima', updated_at: Date.now() },
        { id: 'f_02', type: 'dm', title: 'Lucas Rocha', updated_at: Date.now() - 3600 },
        { id: 'c2', type: 'channel', title: '#geral', updated_at: Date.now() - 1000 },
      ];
    }
  }

  async getConversationState(
    conversationId: string,
    accountId?: string
  ): Promise<DbConversationState | null> {
    const resolvedAcc = this.resolveAccount(accountId);
    const key = this.scopedKey(conversationId, resolvedAcc);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const state = await invoke<DbConversationState | null>('get_conversation_state', {
        conversationId,
        accountId: resolvedAcc,
      });
      if (state) {
        if (typeof state.draft_text === 'string') {
          this.localDrafts[key] = state.draft_text;
        }
        if (typeof state.last_read_message_id === 'string') {
          this.localReadStates[key] = state.last_read_message_id;
        }
        return state;
      }
      return {
        conversation_id: conversationId,
        draft_text: this.localDrafts[key] || '',
        last_read_message_id: this.localReadStates[key] || null,
      };
    } catch {
      return {
        conversation_id: conversationId,
        draft_text: this.localDrafts[key] || '',
        last_read_message_id: this.localReadStates[key] || null,
      };
    }
  }

  async saveDraft(
    conversationId: string,
    draftText: string,
    accountId?: string
  ): Promise<void> {
    const resolvedAcc = this.resolveAccount(accountId);
    const key = this.scopedKey(conversationId, resolvedAcc);
    this.localDrafts[key] = draftText;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('save_conversation_draft', {
        conversationId,
        draftText,
        accountId: resolvedAcc,
      });
    } catch {
      // In browser mode, scoped localDrafts handles it
    }
  }

  async markAsRead(
    conversationId: string,
    lastReadMessageId: string,
    accountId?: string
  ): Promise<void> {
    const resolvedAcc = this.resolveAccount(accountId);
    const key = this.scopedKey(conversationId, resolvedAcc);
    this.localReadStates[key] = lastReadMessageId;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('mark_conversation_read', {
        conversationId,
        lastReadMessageId,
        accountId: resolvedAcc,
      });
    } catch {
      // Browser fallback handled
    }
  }
}

export const conversationRepository = new ConversationRepository();
