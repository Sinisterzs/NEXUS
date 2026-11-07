import { DbMessage } from '../lib/types';
import { mockConversationHistory } from '../mocks';

class MessageRepository {
  private fallbackStore: Record<string, DbMessage[]> = {};

  constructor() {
    // Populate browser fallback store from mock history
    Object.entries(mockConversationHistory).forEach(([convId, msgs]) => {
      this.fallbackStore[convId] = msgs.map((m, idx) => ({
        id: m.id,
        conversation_id: convId,
        sender_id: m.authorId,
        content: m.content,
        created_at: Math.floor(Date.now() / 1000) - (msgs.length - idx) * 60,
        delivery_status: 'local_saved',
      }));
    });
  }

  async getMessages(
    conversationId: string,
    limit: number = 30,
    beforeTimestamp?: number
  ): Promise<DbMessage[]> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<DbMessage[]>('get_messages', {
        conversationId,
        limit,
        beforeTimestamp: beforeTimestamp || null,
      });
    } catch {
      // Browser preview fallback
      const all = this.fallbackStore[conversationId] || [];
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
    content: string
  ): Promise<DbMessage> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<DbMessage>('save_message', {
        conversationId,
        senderId,
        content,
      });
    } catch {
      // Browser preview fallback
      const newMsg: DbMessage = {
        id: `local_msg_${Date.now()}`,
        conversation_id: conversationId,
        sender_id: senderId,
        content,
        created_at: Math.floor(Date.now() / 1000),
        delivery_status: 'local_saved',
      };
      if (!this.fallbackStore[conversationId]) {
        this.fallbackStore[conversationId] = [];
      }
      this.fallbackStore[conversationId].push(newMsg);
      return newMsg;
    }
  }
}

export const messageRepository = new MessageRepository();
