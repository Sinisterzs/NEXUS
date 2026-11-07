import { DbMessage } from '../lib/types';
import { mockConversationHistory } from '../mocks';

class MessageRepository {
  private currentAccountId: string = 'offline_demo';
  private fallbackStore: Record<string, DbMessage[]> = {};

  constructor() {
    // Populate browser fallback store strictly under `offline_demo:` prefix
    Object.entries(mockConversationHistory).forEach(([convId, msgs]) => {
      this.fallbackStore[`offline_demo:${convId}`] = msgs.map((m, idx) => ({
        id: m.id,
        conversation_id: convId,
        sender_id: m.authorId,
        content: m.content,
        created_at: Math.floor(Date.now() / 1000) - (msgs.length - idx) * 60,
        delivery_status: 'local_saved',
      }));
    });
  }

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

  async getMessages(
    conversationId: string,
    limit: number = 30,
    beforeTimestamp?: number,
    accountId?: string
  ): Promise<DbMessage[]> {
    const resolvedAcc = this.resolveAccount(accountId);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<DbMessage[]>('get_messages', {
        conversationId,
        limit,
        beforeTimestamp: beforeTimestamp || null,
        accountId: resolvedAcc,
      });
    } catch {
      const all = this.fallbackStore[this.scopedKey(conversationId, resolvedAcc)] || [];
      if (beforeTimestamp) {
        return all
          .filter((m) => m.created_at < beforeTimestamp)
          .slice(-limit);
      }
      return all.slice(-limit);
    }
  }

  async saveMessage(
    conversationId: string,
    senderId: string,
    content: string,
    accountId?: string
  ): Promise<DbMessage> {
    const resolvedAcc = this.resolveAccount(accountId);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<DbMessage>('save_message', {
        conversationId,
        senderId,
        content,
        accountId: resolvedAcc,
      });
    } catch {
      const newMsg: DbMessage = {
        id: `local_msg_${resolvedAcc}_${Date.now()}`,
        conversation_id: conversationId,
        sender_id: senderId,
        content,
        created_at: Math.floor(Date.now() / 1000),
        delivery_status: 'local_saved',
      };
      const key = this.scopedKey(conversationId, resolvedAcc);
      if (!this.fallbackStore[key]) {
        this.fallbackStore[key] = [];
      }
      this.fallbackStore[key].push(newMsg);
      return newMsg;
    }
  }
}

export const messageRepository = new MessageRepository();
