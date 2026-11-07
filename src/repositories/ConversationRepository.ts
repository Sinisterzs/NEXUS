import { DbConversation, DbConversationState } from '../lib/types';

class ConversationRepository {
  private localDrafts: Record<string, string> = {};
  private localReadStates: Record<string, string> = {};

  async ensureConversation(
    id: string,
    type: 'dm' | 'channel' = 'dm',
    title: string = ''
  ): Promise<DbConversation> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<DbConversation>('ensure_conversation', {
        id,
        conversationType: type,
        title,
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

  async getConversations(): Promise<DbConversation[]> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<DbConversation[]>('get_conversations');
    } catch {
      // Browser preview fallback
      return [
        { id: 'f_01', type: 'dm', title: 'Beatriz Lima', updated_at: Date.now() },
        { id: 'f_02', type: 'dm', title: 'Lucas Rocha', updated_at: Date.now() - 3600 },
        { id: 'c2', type: 'channel', title: '#geral', updated_at: Date.now() - 1000 },
      ];
    }
  }

  async getConversationState(conversationId: string): Promise<DbConversationState | null> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<DbConversationState | null>('get_conversation_state', {
        conversationId,
      });
    } catch {
      // Browser preview fallback
      return {
        conversation_id: conversationId,
        draft_text: this.localDrafts[conversationId] || '',
        last_read_message_id: this.localReadStates[conversationId] || null,
      };
    }
  }

  async saveDraft(conversationId: string, draftText: string): Promise<void> {
    this.localDrafts[conversationId] = draftText;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('save_conversation_draft', {
        conversationId,
        draftText,
      });
    } catch {
      // In browser mode, localDrafts handles it
    }
  }

  async markAsRead(conversationId: string, lastReadMessageId: string): Promise<void> {
    this.localReadStates[conversationId] = lastReadMessageId;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('mark_conversation_read', {
        conversationId,
        lastReadMessageId,
      });
    } catch {
      // Browser fallback handled
    }
  }
}

export const conversationRepository = new ConversationRepository();
