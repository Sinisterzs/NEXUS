import {
  COMMUNITY_PERMISSIONS,
  CommunityPermissionFlag,
  hasCommunityPermission,
} from '../../lib/types';

export interface PermissionMeta {
  flag: CommunityPermissionFlag;
  label: string;
  description: string;
}

export const COMMUNITY_PERMISSION_META: PermissionMeta[] = [
  {
    flag: 'ADMINISTRATOR',
    label: 'Administrador',
    description: 'Concede acesso total à comunidade e ignora restrições por canal.',
  },
  {
    flag: 'MANAGE_COMMUNITY',
    label: 'Gerenciar Comunidade',
    description: 'Permite editar nome, descrição, aparência e privacidade da comunidade.',
  },
  {
    flag: 'MANAGE_CHANNELS',
    label: 'Gerenciar Canais',
    description: 'Permite criar, editar, reordenar e excluir categorias e canais.',
  },
  {
    flag: 'MANAGE_ROLES',
    label: 'Gerenciar Cargos',
    description: 'Permite criar, editar, reordenar e atribuir cargos abaixo do seu nível.',
  },
  {
    flag: 'MODERATE_MEMBERS',
    label: 'Moderar Membros',
    description: 'Permite expulsar, banir, desbanir e silenciar membros.',
  },
  {
    flag: 'VIEW_AUDIT_LOG',
    label: 'Ver Logs Administrativos',
    description: 'Permite visualizar o registro de ações administrativas da comunidade.',
  },
  {
    flag: 'CREATE_INVITES',
    label: 'Criar Convites',
    description: 'Permite gerar links e códigos de convite para novos membros.',
  },
  {
    flag: 'VIEW_CHANNEL',
    label: 'Ver Canais',
    description: 'Permite visualizar canais públicos e ler canais autorizados.',
  },
  {
    flag: 'READ_MESSAGE_HISTORY',
    label: 'Ler Histórico de Mensagens',
    description: 'Permite carregar e visualizar mensagens anteriores nos canais.',
  },
  {
    flag: 'SEND_MESSAGES',
    label: 'Enviar Mensagens',
    description: 'Permite enviar mensagens nos canais de texto.',
  },
  {
    flag: 'MANAGE_MESSAGES',
    label: 'Gerenciar Mensagens',
    description: 'Permite excluir mensagens de outros membros e postar em canais somente leitura.',
  },
  {
    flag: 'CONNECT_VOICE',
    label: 'Conectar à Voz',
    description: 'Permite entrar em canais de voz (disponível na Fase B3).',
  },
  {
    flag: 'SPEAK',
    label: 'Falar na Voz',
    description: 'Permite transmitir áudio em canais de voz (disponível na Fase B3).',
  },
  {
    flag: 'SCREEN_SHARE',
    label: 'Compartilhar Tela',
    description: 'Permite transmitir tela em canais de voz (disponível na Fase B3).',
  },
  {
    flag: 'MUTE_MEMBERS_VOICE',
    label: 'Silenciar na Voz',
    description: 'Permite silenciar membros em canais de voz (disponível na Fase B3).',
  },
];

export function hasCommunityOrAdminPermission(
  bitmask: string | bigint | null | undefined,
  required: CommunityPermissionFlag
): boolean {
  return (
    hasCommunityPermission(bitmask, COMMUNITY_PERMISSIONS.ADMINISTRATOR) ||
    hasCommunityPermission(bitmask, COMMUNITY_PERMISSIONS[required])
  );
}

/**
 * Extracts raw invite code from a code string, `nexus://invite/CODE`, or `https://.../invite/CODE`.
 */
export function extractInviteCode(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  const invitePathMatch = trimmed.match(/\/invite\/([^/?#\s]+)/i);
  if (invitePathMatch && invitePathMatch[1]) {
    return invitePathMatch[1].trim();
  }

  const nexusProtoMatch = trimmed.match(/^nexus:\/\/invite\/([^/?#\s]+)/i);
  if (nexusProtoMatch && nexusProtoMatch[1]) {
    return nexusProtoMatch[1].trim();
  }

  return trimmed.replace(/^\/+|\/+$/g, '');
}

export function isFutureTimestamp(iso?: string | null): boolean {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return !Number.isNaN(ts) && ts > Date.now();
}

export function formatMessageTimestamp(isoDateStr: string): { time: string; dateKey: string } {
  const date = new Date(isoDateStr);
  if (Number.isNaN(date.getTime())) {
    return { time: '--:--', dateKey: 'Hoje' };
  }

  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(
    2,
    '0'
  )}`;

  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  let dateKey = 'Hoje';
  if (isYesterday) {
    dateKey = 'Ontem';
  } else if (!isToday) {
    dateKey = date.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' });
  }

  return { time, dateKey };
}

export function formatDateTimePtBr(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function deriveInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return 'NX';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}
