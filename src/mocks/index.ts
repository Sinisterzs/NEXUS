import {
  Community,
  Friend,
  DirectMessageSummary,
  UserProfile,
  ChatMessage,
  CallParticipant,
  AppSettings,
} from '../lib/types';

export const mockCurrentUser: UserProfile = {
  id: 'usr_me',
  username: 'Alex Vance',
  displayName: 'Alex Vance',
  tag: '#1337',
  status: 'online',
  customStatus: 'Compilando Rust 1.99 no Windows 11',
  bio: 'Engenheiro de Sistemas & Entusiasta de Desktop de Alta Performance. NEXUS Developer.',
  activity: {
    type: 'coding',
    name: 'NEXUS Desktop',
    details: 'Fase 1.2: Interface Completa',
  },
};

export const mockFriends: Friend[] = [];

export const mockCommunities: Community[] = [];

export const mockDirectMessages: DirectMessageSummary[] = [];

export const mockConversationHistory: Record<string, ChatMessage[]> = {};

export const mockCommunityMessages: Record<string, ChatMessage[]> = {};

export const mockCallParticipants: CallParticipant[] = [];

export function getInitialTheme(): 'nexus-dark' | 'midnight-black' | 'cyber-slate' {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const saved = window.localStorage.getItem('nexus_theme');
      if (saved === 'midnight-black' || saved === 'cyber-slate' || saved === 'nexus-dark') {
        return saved;
      }
    } catch {}
  }
  return 'nexus-dark';
}

export const initialAppSettings: AppSettings = {
  profile: {
    displayName: 'Alex Vance',
    username: 'alexvance',
    tag: '#1337',
    bio: 'Engenheiro de Sistemas & Entusiasta de Desktop de Alta Performance. Desenvolvedor do NEXUS.',
    customStatus: 'Compilando Rust 1.99 no Windows 11',
  },
  appearance: {
    theme: getInitialTheme(),
    compactMode: false,
    fontSize: 'base',
  },
  audioVideo: {
    inputDevice: 'default',
    outputDevice: 'default',
    inputSensitivity: 78,
    outputVolume: 85,
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
    screenShareQuality: 'auto',
    participantVolumes: {},
    callStageSplitRatio: 65,
    cameraDevice: 'default',
  },
  notifications: {
    desktopAlerts: true,
    soundEffects: true,
    mentionsOnly: false,
    dndMode: false,
  },
  privacy: {
    allowDmsFrom: 'friends',
    showGameActivity: true,
    streamerMode: false,
  },
};
