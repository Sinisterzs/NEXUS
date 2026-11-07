import { DirectConversationDto, DirectMessageDto } from '../lib/types';

class DmRepository {
  async listConversations(accountId?: string): Promise<DirectConversationDto[]> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const convs = await invoke<any[]>('dm_list_conversations', {
        accountId: accountId || null,
      });

      return convs.map((c) => ({
        id: c.id,
        other_user: {
          id: c.other_user.id,
          name: c.other_user.display_name || c.other_user.username,
          username: c.other_user.username,
          tag: c.other_user.tag,
          avatarUrl: c.other_user.avatar_url,
          status: c.other_user.status || 'offline',
          customStatus: c.other_user.custom_status,
          activity: c.other_user.activity,
          lastSeenAt: c.other_user.last_seen_at,
        },
        last_message: c.last_message || null,
        unread_count: c.unread_count || 0,
        created_at: c.created_at,
        updated_at: c.updated_at,
      }));
    } catch (err) {
      console.warn('[DmRepository] Falha ao listar conversas via Tauri:', err);
      return [];
    }
  }

  async getOrCreateConversation(
    targetUserId?: string,
    username?: string,
    accountId?: string
  ): Promise<DirectConversationDto> {
    const { invoke } = await import('@tauri-apps/api/core');
    const c = await invoke<any>('dm_get_or_create_conversation', {
      targetUserId: targetUserId || null,
      username: username || null,
      accountId: accountId || null,
    });

    return {
      id: c.id,
      other_user: {
        id: c.other_user.id,
        name: c.other_user.display_name || c.other_user.username,
        username: c.other_user.username,
        tag: c.other_user.tag,
        avatarUrl: c.other_user.avatar_url,
        status: c.other_user.status || 'offline',
        customStatus: c.other_user.custom_status,
        activity: c.other_user.activity,
        lastSeenAt: c.other_user.last_seen_at,
      },
      last_message: c.last_message || null,
      unread_count: c.unread_count || 0,
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
  }

  async getMessages(
    conversationId: string,
    limit: number = 50,
    beforeId?: string,
    accountId?: string
  ): Promise<DirectMessageDto[]> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<DirectMessageDto[]>('dm_get_messages', {
        conversationId,
        limit,
        beforeId: beforeId || null,
        accountId: accountId || null,
      });
    } catch (err) {
      console.warn('[DmRepository] Falha ao buscar histórico de mensagens:', err);
      return [];
    }
  }

  async sendMessage(
    conversationId: string,
    content: string,
    clientMessageId?: string,
    accountId?: string
  ): Promise<DirectMessageDto> {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<DirectMessageDto>('dm_send_message', {
      conversationId,
      content,
      clientMessageId: clientMessageId || null,
      accountId: accountId || null,
    });
  }

  async editMessage(messageId: string, content: string): Promise<DirectMessageDto> {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<DirectMessageDto>('dm_edit_message', {
      messageId,
      content,
    });
  }

  async deleteMessage(messageId: string): Promise<DirectMessageDto> {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<DirectMessageDto>('dm_delete_message', {
      messageId,
    });
  }

  async markRead(conversationId: string, lastReadMessageId?: string): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('dm_mark_read', {
        conversationId,
        lastReadMessageId: lastReadMessageId || null,
      });
    } catch (err) {
      console.warn('[DmRepository] Erro ao marcar leitura:', err);
    }
  }

  async cacheIncomingMessage(
    message: DirectMessageDto,
    accountId?: string
  ): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('dm_cache_incoming_message', {
        message,
        accountId: accountId || null,
      });
    } catch (err) {
      console.warn('[DmRepository] Falha ao armazenar mensagem recebida em cache:', err);
    }
  }
}

export const dmRepository = new DmRepository();
