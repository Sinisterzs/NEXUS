import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const ROOT = process.cwd();

function readSrc(relPath: string) {
  return readFile(path.join(ROOT, relPath), 'utf8');
}

test('Phase 5 & 5.1 Seção 2 (Privacidade): CommunityMemberList e StatusIndicator mascaram invisible como offline mesmo em voz/transmissão', async () => {
  const directory = await mkdtemp(path.resolve('node_modules/.nexus-phase5-members-'));
  try {
    const result = await build({
      stdin: {
        contents: `
          export { CommunityMemberList, normalizeStatus, getEffectiveStatus } from './src/components/CommunityMemberList.tsx';
          export { StatusIndicator } from './src/components/StatusIndicator.tsx';
        `,
        resolveDir: ROOT,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      write: false,
    });

    const entry = path.join(directory, 'members.mjs');
    await writeFile(entry, result.outputFiles[0].text);
    const { CommunityMemberList, StatusIndicator, normalizeStatus, getEffectiveStatus } = await import(
      pathToFileURL(entry).href
    );

    assert.equal(normalizeStatus('online'), 'online');
    assert.equal(normalizeStatus('idle'), 'idle');
    assert.equal(normalizeStatus('dnd'), 'dnd');
    assert.equal(normalizeStatus('invisible'), 'invisible');
    assert.equal(normalizeStatus('offline'), 'offline');
    assert.equal(normalizeStatus(undefined), 'offline');
    assert.equal(normalizeStatus('unknown-status'), 'offline');

    const baseMember = {
      roles: [],
      custom_status: null,
      avatar_url: null,
      nickname: null,
      text_muted_until: null,
      voice_muted_until: null,
      server_voice_muted: false,
      joined_at: '2026-01-01T00:00:00Z',
    };

    const onlineOutside = { ...baseMember, user_id: 'u-online-out', username: 'alice', display_name: 'Alice Online', status: 'online' };
    const onlineInVoice = { ...baseMember, user_id: 'u-online-in', username: 'bob', display_name: 'Bob Voz', status: 'online' };
    const idleInVoice = { ...baseMember, user_id: 'u-idle-in', username: 'carol', display_name: 'Carol Idle', status: 'idle' };
    const dndInVoice = { ...baseMember, user_id: 'u-dnd-in', username: 'dave', display_name: 'Dave DND', status: 'dnd' };
    const invisibleOutside = { ...baseMember, user_id: 'u-inv-out', username: 'eve', display_name: 'Eve Oculta Out', status: 'invisible' };
    const invisibleInVoice = { ...baseMember, user_id: 'u-inv-in', username: 'frank', display_name: 'Frank Oculto Voz', status: 'invisible' };
    const offlineInVoice = { ...baseMember, user_id: 'u-off-in', username: 'grace', display_name: 'Grace Offline Voz', status: 'offline' };

    const voiceActivity = {
      'u-online-in': { channelName: 'Geral Voz', isScreenSharing: false },
      'u-idle-in': { channelName: 'Geral Voz', isScreenSharing: false },
      'u-dnd-in': { channelName: 'Geral Voz', isScreenSharing: false },
      'u-inv-in': { channelName: 'Sala Privada', isScreenSharing: true },
      'u-off-in': { channelName: 'Sala Privada', isScreenSharing: true },
    };

    assert.equal(getEffectiveStatus(onlineOutside, voiceActivity), 'online');
    assert.equal(getEffectiveStatus(onlineInVoice, voiceActivity), 'online');
    assert.equal(getEffectiveStatus(idleInVoice, voiceActivity), 'idle');
    assert.equal(getEffectiveStatus(dndInVoice, voiceActivity), 'dnd');
    assert.equal(getEffectiveStatus(invisibleOutside, voiceActivity), 'offline');
    assert.equal(getEffectiveStatus(invisibleInVoice, voiceActivity), 'offline');
    assert.equal(getEffectiveStatus(offlineInVoice, voiceActivity), 'offline');

    const statusIndicatorHtml = renderToStaticMarkup(
      React.createElement(StatusIndicator, { status: 'invisible' })
    );
    assert.ok(statusIndicatorHtml.includes('title="Status: offline"'), 'StatusIndicator(invisible) deve renderizar title="Status: offline"');
    assert.equal(statusIndicatorHtml.includes('Status: invisible'), false, 'StatusIndicator(invisible) não pode expor Status: invisible');
    assert.equal(statusIndicatorHtml.includes('Invisível'), false, 'StatusIndicator(invisible) não pode expor rótulo Invisível');

    // Renderizar somente usuários invisível + offline ativos em voz/stream: grupo ONLINE não pode existir
    const privacyHtml = renderToStaticMarkup(
      React.createElement(CommunityMemberList, {
        members: [invisibleOutside, invisibleInVoice, offlineInVoice],
        voiceActivityByUserId: voiceActivity,
      })
    );

    assert.equal(privacyHtml.includes('Online —'), false, 'Usuário invisível/offline em voz não deve criar grupo Online');
    assert.ok(privacyHtml.includes('Offline — 3'), 'Todos os 3 usuários invisível/offline devem permanecer em Offline — 3');
    assert.ok(privacyHtml.includes('title="Status: offline"'), 'Membros invisível/offline devem renderizar title="Status: offline"');
    assert.equal(privacyHtml.includes('Status: invisible'), false, 'CommunityMemberList não pode expor Status: invisible no HTML público');
    assert.equal(privacyHtml.includes('Invisível'), false, 'CommunityMemberList não pode expor Invisível no HTML público');
    assert.ok(
      privacyHtml.includes('Transmitindo · Sala Privada'),
      'Sublabel de transmissão da sala continua visível sem promover presença para online'
    );

    // Renderizar mistura com online, idle, dnd, invisible e offline em voz
    const mixedHtml = renderToStaticMarkup(
      React.createElement(CommunityMemberList, {
        members: [onlineOutside, onlineInVoice, idleInVoice, dndInVoice, invisibleInVoice, offlineInVoice],
        voiceActivityByUserId: voiceActivity,
      })
    );

    assert.ok(mixedHtml.includes('Online — 4'), 'Apenas online/idle/dnd devem ser agrupados em Online — 4');
    assert.ok(mixedHtml.includes('Offline — 2'), 'Invisível + offline em voz devem permanecer em Offline — 2');
    assert.ok(mixedHtml.includes('title="Status: idle"'), 'Status idle em voz preservado');
    assert.ok(mixedHtml.includes('title="Status: dnd"'), 'Status dnd em voz preservado');
    assert.equal(mixedHtml.includes('Status: invisible'), false, 'Lista mista nunca deve expor Status: invisible');
    assert.equal(mixedHtml.includes('Invisível'), false, 'Lista mista nunca deve vazar rótulo Invisível');

    const offlineGroupIdx = mixedHtml.indexOf('Offline — 2');
    assert.ok(offlineGroupIdx > 0);
    const offlineSlice = mixedHtml.slice(offlineGroupIdx);
    const onlineSlice = mixedHtml.slice(0, offlineGroupIdx);
    assert.equal(onlineSlice.includes('Frank Oculto Voz'), false, 'Frank Oculto não pode estar no grupo Online');
    assert.equal(onlineSlice.includes('Grace Offline Voz'), false, 'Grace Offline não pode estar no grupo Online');
    assert.ok(offlineSlice.includes('Frank Oculto Voz'), 'Frank Oculto deve estar no grupo Offline');
    assert.ok(offlineSlice.includes('Grace Offline Voz'), 'Grace Offline deve estar no grupo Offline');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Phase 5 Seções 3, 6 e 7: FloatingCallDock respeita idle, joining, contagem mínima em voz e aria-live', async () => {
  const directory = await mkdtemp(path.resolve('node_modules/.nexus-phase5-dock-'));
  try {
    const result = await build({
      stdin: {
        contents: `
          export { FloatingCallDock } from './src/components/FloatingCallDock.tsx';
          export { useAppStore } from './src/stores/useAppStore';
        `,
        resolveDir: ROOT,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      write: false,
      plugins: [
        {
          name: 'isolated-dock-env',
          setup(builder) {
            builder.onResolve({ filter: /stores\/useAppStore(?:\.ts)?$/ }, () => ({
              path: 'store',
              namespace: 'dock-test',
            }));
            builder.onResolve({ filter: /services\/CallService(?:\.ts)?$/ }, () => ({
              path: 'call-service',
              namespace: 'dock-test',
            }));
            builder.onResolve({ filter: /services\/ScreenCaptureService(?:\.ts)?$/ }, () => ({
              path: 'screen-service',
              namespace: 'dock-test',
            }));
            builder.onResolve({ filter: /\.\/ScreenSourcePickerModal(?:\.tsx)?$/ }, () => ({
              path: 'picker-modal',
              namespace: 'dock-test',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'dock-test' }, (args) => {
              if (args.path === 'store') {
                return {
                  contents: `
                    let state;
                    export const useAppStore = (selector) => selector(state);
                    useAppStore.setTestState = (next) => { state = next; };
                    useAppStore.getState = () => state;
                  `,
                  loader: 'js',
                };
              }
              if (args.path === 'call-service') {
                return {
                  contents: 'export const callService = { toggleMute() {}, toggleDeafen() {}, endCall() {} };',
                  loader: 'js',
                };
              }
              if (args.path === 'screen-service') {
                return {
                  contents: 'export const screenCaptureService = { isNativeCaptureSupported: () => false };',
                  loader: 'js',
                };
              }
              return {
                contents: 'export const ScreenSourcePickerModal = () => null;',
                loader: 'js',
              };
            });
          },
        },
      ],
    });

    const entry = path.join(directory, 'dock.mjs');
    await writeFile(entry, result.outputFiles[0].text);
    const { FloatingCallDock, useAppStore } = await import(pathToFileURL(entry).href);

    const baseState = {
      activeTab: 'communities',
      setActiveTab() {},
      activeCommunityId: 'comm-1',
      activeChannelId: 'ch-text',
      selectCommunity: async () => {},
      selectCommunityChannel: async () => {},
      communities: [{ id: 'comm-1', name: 'Nexus' }],
      communitySnapshot: {
        community: { id: 'comm-1', name: 'Nexus' },
        channels: [
          { id: 'ch-text', name: 'geral', channel_type: 'text' },
          { id: 'ch-voice', name: 'Voz Principal', channel_type: 'voice' },
        ],
        members: [],
      },
      currentUser: { id: 'me', username: 'kel', displayName: 'Kel', avatarUrl: null },
      onlineUser: { id: 'me', username: 'kel', displayName: 'Kel', avatarUrl: null },
      voiceRoomState: 'idle',
      activeVoiceCommunityId: null,
      activeVoiceChannelId: null,
      voiceRoomParticipants: [],
      communityVoiceRooms: {},
      voiceRoomMuted: false,
      voiceRoomDeafened: false,
      voiceRoomScreenSharing: false,
      voiceRoomCanSpeak: true,
      voiceRoomCanScreenShare: true,
      voiceRoomQuality: 'auto',
      voiceRoomMetrics: null,
      voiceRoomError: null,
      nativeCaptureStatus: null,
      leaveVoiceChannel: async () => {},
      toggleVoiceRoomMute() {},
      toggleVoiceRoomDeafen() {},
      startVoiceRoomScreenShare: async () => {},
      stopVoiceRoomScreenShare: async () => {},
      voiceCallState: 'idle',
      activeCallPeer: null,
      callDurationSecs: 65,
      isMicMuted: false,
      isDeafened: false,
      isLocalSpeaking: false,
      isRemoteSpeaking: false,
      isScreenSharing: false,
      isRemoteScreenSharing: false,
      reconnectAttempt: 0,
      maxReconnectAttempts: 3,
      screenPickerTarget: null,
      openScreenSourcePicker: async () => {},
      closeScreenSourcePicker() {},
    };

    const renderDock = (overrides: Record<string, unknown>) => {
      useAppStore.setTestState({ ...baseState, ...overrides });
      return renderToStaticMarkup(React.createElement(FloatingCallDock));
    };

    // 1. Oculta em idle
    assert.equal(renderDock({}), '', 'FloatingCallDock deve retornar vazio em idle');

    // 2. Estado joining: "Conectando à sala...", aria-live="polite", sem LIVE nem "0 em Voz"
    const joiningHtml = renderDock({
      voiceRoomState: 'joining',
      activeVoiceCommunityId: 'comm-1',
      activeVoiceChannelId: 'ch-voice',
      voiceRoomScreenSharing: true,
      voiceRoomParticipants: [{ user_id: 'me', username: 'kel', display_name: 'Kel', is_screen_sharing: true }],
    });
    assert.ok(joiningHtml.includes('Conectando à sala...'));
    assert.ok(joiningHtml.includes('aria-live="polite"'));
    assert.equal(joiningHtml.includes('LIVE'), false, 'Não deve renderizar LIVE enquanto joining');
    assert.equal(joiningHtml.includes('em Voz'), false, 'Não deve renderizar contagem em Voz enquanto joining');

    // 3. Estado reconnecting com screenSharing não vaza LIVE
    const reconnectingHtml = renderDock({
      voiceRoomState: 'reconnecting',
      activeVoiceCommunityId: 'comm-1',
      activeVoiceChannelId: 'ch-voice',
      voiceRoomScreenSharing: true,
      voiceRoomParticipants: [{ user_id: 'me', username: 'kel', display_name: 'Kel', is_screen_sharing: true }],
    });
    assert.ok(reconnectingHtml.includes('Reconectando...'));
    assert.equal(reconnectingHtml.includes('LIVE'), false, 'Não deve renderizar LIVE enquanto reconnecting');

    // 4. Connected com lista de participantes ainda vazia nunca exibe "0 em Voz"
    const connectedEmptyHtml = renderDock({
      voiceRoomState: 'connected',
      activeVoiceCommunityId: 'comm-1',
      activeVoiceChannelId: 'ch-voice',
      voiceRoomParticipants: [],
    });
    assert.equal(connectedEmptyHtml.includes('0 em Voz'), false, 'Nunca deve exibir "0 em Voz" quando conectado');
    assert.ok(connectedEmptyHtml.includes('1 em Voz'), 'Contagem mínima quando conectado deve ser 1 em Voz');
    assert.ok(connectedEmptyHtml.includes('aria-live="polite"'));

    // 5. Chamada 1:1 calling e connected renderizando DockCallDuration
    const callCallingHtml = renderDock({
      activeTab: 'messages',
      voiceCallState: 'calling',
      activeCallPeer: { id: 'p2', name: 'Contato', username: 'contato' },
      isScreenSharing: true,
    });
    assert.ok(callCallingHtml.includes('Chamando...'));
    assert.equal(callCallingHtml.includes('LIVE'), false, 'Chamada 1:1 calling não deve exibir LIVE');

    const callConnectedHtml = renderDock({
      activeTab: 'messages',
      voiceCallState: 'connected',
      activeCallPeer: { id: 'p2', name: 'Contato', username: 'contato' },
      callDurationSecs: 65,
    });
    assert.ok(callConnectedHtml.includes('Conectado'));
    assert.ok(callConnectedHtml.includes('01:05'), 'DockCallDuration deve formatar 65s como 01:05');
    assert.ok(callConnectedHtml.includes('aria-live="polite"'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Phase 5 Seções 3, 4, 6, 7 e 8: Contratos de performance, acessibilidade e higiene nos componentes', async () => {
  const [
    dockSrc,
    communitiesSrc,
    contextPanelSrc,
    tooltipSrc,
    titleBarSrc,
    streamCardSrc,
    homeSrc,
    addFriendSrc,
    createJoinSrc,
    inviteSrc,
    channelManageSrc,
    settingsModalSrc,
  ] = await Promise.all([
    readSrc('src/components/FloatingCallDock.tsx'),
    readSrc('src/features/communities/CommunitiesView.tsx'),
    readSrc('src/features/communities/CommunityContextPanel.tsx'),
    readSrc('src/components/Tooltip.tsx'),
    readSrc('src/components/TitleBar.tsx'),
    readSrc('src/components/ActiveStreamCard.tsx'),
    readSrc('src/features/home/HomeView.tsx'),
    readSrc('src/features/friends/AddFriendModal.tsx'),
    readSrc('src/features/communities/CreateJoinCommunityModal.tsx'),
    readSrc('src/features/communities/InviteModal.tsx'),
    readSrc('src/features/communities/ChannelManageModal.tsx'),
    readSrc('src/features/communities/CommunitySettingsModal.tsx'),
  ]);

  // FloatingCallDock: memo, reset de cache, auto-close picker, Math.max(1,...), aria-live
  assert.match(dockSrc, /const\s+DockCallDuration\s*:\s*React\.FC\s*=\s*React\.memo\(/);
  assert.doesNotMatch(dockSrc, /FloatingCallDock[\s\S]*const\s+callDurationSecs\s*=/);
  assert.match(dockSrc, /if\s*\(\s*voiceRoomState\s*===\s*'idle'\s*\)\s*\{\s*roomNameCacheRef\.current\s*=\s*\{\}\s*;/);
  assert.match(
    dockSrc,
    /\(screenPickerTarget\s*===\s*'room'\s*&&\s*voiceRoomState\s*!==\s*'connected'\)\s*\|\|\s*\(screenPickerTarget\s*===\s*'call'\s*&&\s*voiceCallState\s*!==\s*'connected'\)/
  );
  assert.match(dockSrc, /closeScreenSourcePicker\(\)/);
  assert.match(dockSrc, /Math\.max\(1,\s*roomParticipants\.length\)/);
  assert.match(dockSrc, /aria-live="polite"/);

  // CommunitiesView: seletores primitivos, previewStream restrito a texto, sem props mortas, getEffectiveStatus e Escape seguro
  assert.match(communitiesSrc, /const\s+nativeStatsDstHeight\s*=\s*useAppStore\(/);
  assert.match(communitiesSrc, /const\s+nativeStatsTargetFps\s*=\s*useAppStore\(/);
  assert.doesNotMatch(communitiesSrc, /const\s+nativeScreenStats\s*=/);
  assert.match(communitiesSrc, /selectedChannel\?\.channel_type\s*===\s*'text'\s*\?\s*remoteStream\s*:\s*null/);
  assert.match(communitiesSrc, /const\s+status\s*=\s*getEffectiveStatus\(m\)/);
  assert.match(communitiesSrc, /group-focus-within:flex/);
  assert.match(communitiesSrc, /hasOpenCommunityModal/);
  assert.doesNotMatch(communitiesSrc, /<CommunityContextPanel[\s\S]*?voiceRoomState=/);
  assert.doesNotMatch(communitiesSrc, /<CommunityContextPanel[\s\S]*?activeVoiceChannelId=/);

  // CommunityContextPanel: sem props mortas e Escape na busca de membros
  assert.doesNotMatch(contextPanelSrc, /\bvoiceRoomState\b/);
  assert.doesNotMatch(contextPanelSrc, /\bactiveVoiceChannelId\b/);
  assert.match(contextPanelSrc, /if\s*\(\s*e\.key\s*===\s*'Escape'\s*\)\s*\{\s*e\.stopPropagation\(\)/);

  // Tooltip: useId + id={tooltipId} + Escape
  assert.match(tooltipSrc, /\buseId\(\)/);
  assert.match(tooltipSrc, /id=\{tooltipId\}/);
  assert.match(tooltipSrc, /e\.key\s*===\s*'Escape'/);

  // TitleBar: aria-label na busca + diálogo acessível no logout
  assert.match(titleBarSrc, /aria-label="Pesquisar canais, amigos ou mensagens"/);
  assert.match(titleBarSrc, /role="dialog"/);
  assert.match(titleBarSrc, /aria-modal="true"/);
  assert.match(titleBarSrc, /aria-labelledby="logout-confirm-title"/);
  assert.match(titleBarSrc, /id="logout-confirm-title"/);

  // ActiveStreamCard: motion-reduce:animate-none
  assert.match(streamCardSrc, /motion-reduce:animate-none/);

  // HomeView: Escape + clique fora + aria-expanded + aria-haspopup + aria-labels descritivos
  assert.match(homeSrc, /e\.key\s*===\s*'Escape'/);
  assert.match(homeSrc, /aria-expanded=\{openFriendMenuId\s*===\s*friend\.id\}/);
  assert.match(homeSrc, /aria-haspopup="menu"/);
  assert.match(homeSrc, /aria-label=\{`Ligar para \$\{friend\.name\}`\}/);
  assert.match(homeSrc, /aria-label=\{`Enviar mensagem para \$\{friend\.name\}`\}/);
  assert.match(homeSrc, /aria-label=\{`Mais opções para \$\{friend\.name\}`\}/);

  // Modais: role="dialog", aria-modal="true", aria-labelledby e fechamento por Escape
  for (const [name, src, labelId] of [
    ['AddFriendModal', addFriendSrc, 'add-friend-modal-title'],
    ['CreateJoinCommunityModal', createJoinSrc, 'create-join-community-modal-title'],
    ['InviteModal', inviteSrc, 'invite-modal-title'],
    ['ChannelManageModal', channelManageSrc, 'channel-manage-modal-title'],
    ['CommunitySettingsModal', settingsModalSrc, 'community-settings-modal-title'],
  ] as const) {
    assert.match(src, /role="dialog"/, `${name} deve definir role="dialog"`);
    assert.match(src, /aria-modal="true"/, `${name} deve definir aria-modal="true"`);
    assert.match(src, new RegExp(`aria-labelledby="${labelId}"`), `${name} deve definir aria-labelledby="${labelId}"`);
    assert.match(src, new RegExp(`id="${labelId}"`), `${name} deve definir id="${labelId}"`);
    assert.match(src, /e\.key\s*===\s*'Escape'/, `${name} deve tratar Escape`);
  }

  // Phase 5.1: mascaramento consistente de status invisible nos demais painéis
  const [statusIndicatorSrc, sidebarSrc, messagesSrc] = await Promise.all([
    readSrc('src/components/StatusIndicator.tsx'),
    readSrc('src/app/Sidebar.tsx'),
    readSrc('src/features/messages/MessagesView.tsx'),
  ]);
  assert.match(statusIndicatorSrc, /status === 'invisible' \? 'offline' : status/);
  assert.match(sidebarSrc, /if\s*\(\s*status\s*===\s*'offline'\s*\)\s*\{[\s\S]*?label:\s*'Offline'/);
  assert.match(sidebarSrc, /if\s*\(\s*status\s*===\s*'invisible'\s*\)\s*\{[\s\S]*?label:\s*'Invisível'/);
  assert.match(homeSrc, /maskPublicStatus/);
  assert.match(messagesSrc, /maskPublicStatus/);
});

test('Phase 5.1 Seção 1: streamMetrics e formatDetailedFps tratam {}, null, undefined, NaN, ±Infinity, negativos e zeros legítimos', async () => {
  const directory = await mkdtemp(path.resolve('node_modules/.nexus-phase51-metrics-'));
  try {
    const result = await build({
      stdin: {
        contents: `
          export * from './src/lib/streamMetrics.ts';
          export { formatDetailedFps } from './src/lib/callsLayout.ts';
        `,
        resolveDir: ROOT,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      write: false,
    });

    const entry = path.join(directory, 'metrics.mjs');
    await writeFile(entry, result.outputFiles[0].text);
    const m = await import(pathToFileURL(entry).href);

    const emptyObj: Record<string, unknown> = {};
    const invalidInputs = [emptyObj.missing, null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -60, -500];

    // 1-6: valores ausentes, {}, null, undefined, NaN, ±Infinity e negativos
    for (const bad of invalidInputs) {
      assert.equal(m.sanitizeNonNegativeMetric(bad), null, `sanitizeNonNegativeMetric deve rejeitar ${String(bad)}`);
      assert.equal(m.sanitizePositiveMetric(bad), null, `sanitizePositiveMetric deve rejeitar ${String(bad)}`);
      assert.equal(m.formatFpsMetric(bad), '—');
      assert.equal(m.formatBitrateKbpsMetric(bad), '—');
      assert.equal(m.formatBitrateMbpsFromBps(bad), '—');
      assert.equal(m.formatBitrateMbpsFromKbps(bad), '—');
      assert.equal(m.formatLatencyMsMetric(bad), '—');
      assert.equal(m.formatPercentMetric(bad), '—');
      assert.equal(m.formatCountMetric(bad, 'qdrs'), '—');
      assert.equal(m.formatSafeDurationSecs(bad), '00:00');
      assert.equal(m.formatResolutionMetric(bad, 1080), '—');
      assert.equal(m.formatResolutionMetric(1920, bad), '—');
      assert.equal(m.formatResolutionHeightLabel(bad), null);
    }

    assert.equal(m.pickFirstValidMetric([emptyObj.a, null, undefined, Number.NaN, -10, 0], { allowZero: true }), 0);
    assert.equal(m.pickFirstValidMetric([-0, 60], { allowZero: true }), 0);
    assert.equal(m.pickFirstValidMetric([0, Number.NaN, -10, 1080], { allowZero: false }), 1080);

    // 7: zero legítimo preservado onde aplicável e rejeitado em resolução
    assert.equal(m.sanitizeNonNegativeMetric(0), 0);
    assert.equal(Object.is(m.sanitizeNonNegativeMetric(-0), 0), true);
    assert.equal(m.sanitizePositiveMetric(0), null);
    assert.equal(m.formatFpsMetric(0), '0 FPS');
    assert.equal(m.formatBitrateKbpsMetric(0), '0 kbps');
    assert.equal(m.formatBitrateMbpsFromBps(0), '0.00 Mbps');
    assert.equal(m.formatBitrateMbpsFromKbps(0), '0.00 Mbps');
    assert.equal(m.formatLatencyMsMetric(0), '0 ms');
    assert.equal(m.formatPercentMetric(0), '0%');
    assert.equal(m.formatCountMetric(0, 'qdrs'), '0 qdrs');
    assert.equal(m.formatSafeDurationSecs(0), '00:00');
    assert.equal(m.formatResolutionMetric(0, 0), '—');
    assert.equal(m.formatResolutionHeightLabel(0), null);

    // 8: dados completos válidos
    assert.equal(m.formatResolutionMetric(1920, 1080), '1920x1080');
    assert.equal(m.formatResolutionHeightLabel(1080), '1080p');
    assert.equal(m.formatFpsMetric(60), '60 FPS');
    assert.equal(m.formatBitrateKbpsMetric(4500), '4500 kbps');
    assert.equal(m.formatBitrateMbpsFromBps(4_500_000), '4.50 Mbps');
    assert.equal(m.formatBitrateMbpsFromKbps(4500), '4.50 Mbps');
    assert.equal(m.formatLatencyMsMetric(24), '24 ms');
    assert.equal(m.formatPercentMetric(99), '99%');
    assert.equal(m.formatCountMetric(12, 'qdrs'), '12 qdrs');
    assert.equal(m.formatSafeDurationSecs(65), '01:05');

    // sanitizeMetricLabel
    assert.equal(m.sanitizeMetricLabel('1080p'), '1080p');
    assert.equal(m.sanitizeMetricLabel('60 FPS'), '60 FPS');
    for (const badLabel of [null, undefined, '', '   ', 'NaN', 'NaNp', 'NaN FPS', 'Infinity FPS', '-Infinity kbps', 'undefinedx1080', 'nullxnull']) {
      assert.equal(m.sanitizeMetricLabel(badLabel), null, `sanitizeMetricLabel deve rejeitar "${String(badLabel)}"`);
    }

    // formatDetailedFps
    assert.deepEqual(m.formatDetailedFps(null), { primaryLabel: '—', secondaryDetails: '', hasBreakdown: false });
    assert.deepEqual(m.formatDetailedFps({}), { primaryLabel: '—', secondaryDetails: '', hasBreakdown: false });
    assert.deepEqual(
      m.formatDetailedFps({
        effective: Number.NaN,
        captured: -1,
        sent: Number.POSITIVE_INFINITY,
        received: Number.NEGATIVE_INFINITY,
        rendered: -60,
        requested: 0,
      }),
      { primaryLabel: '—', secondaryDetails: '', hasBreakdown: false }
    );
    assert.deepEqual(
      m.formatDetailedFps({ effective: 0, captured: 0, sent: 0, requested: 0 }),
      { primaryLabel: '0 FPS', secondaryDetails: 'Cap: 0 | Env: 0', hasBreakdown: true }
    );
    assert.deepEqual(
      m.formatDetailedFps({ effective: 60, captured: 60, sent: 60, received: 59, rendered: 59, requested: 60 }),
      {
        primaryLabel: '60 FPS',
        secondaryDetails: 'Cap: 60 | Env: 60 | Rec: 59 | Rend: 59 | Ped: 60',
        hasBreakdown: true,
      }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Phase 5.1 Seção 1 (SSR): NativeScreenShareBanner nunca emite NaN ou Infinity com métricas parciais, inválidas ou zeradas', async () => {
  const directory = await mkdtemp(path.resolve('node_modules/.nexus-phase51-banner-'));
  try {
    const result = await build({
      stdin: {
        contents: `
          export { NativeScreenShareBanner } from './src/components/ScreenSourcePickerModal.tsx';
        `,
        resolveDir: ROOT,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      write: false,
      plugins: [
        {
          name: 'isolated-banner-env',
          setup(builder) {
            builder.onResolve({ filter: /stores\/useAppStore(?:\.ts)?$/ }, () => ({
              path: 'store',
              namespace: 'banner-test',
            }));
            builder.onResolve({ filter: /services\/ScreenCaptureService(?:\.ts)?$/ }, () => ({
              path: 'screen-service',
              namespace: 'banner-test',
            }));
            builder.onResolve({ filter: /^\.\/LocalScreenPreview(?:\.tsx)?$/ }, () => ({
              path: 'local-preview',
              namespace: 'banner-test',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'banner-test' }, (args) => {
              if (args.path === 'store') {
                return { contents: 'export const useAppStore = (sel) => sel({});', loader: 'js' };
              }
              if (args.path === 'screen-service') {
                return { contents: 'export const screenCaptureService = {};', loader: 'js' };
              }
              return { contents: 'export const LocalScreenPreview = () => null;', loader: 'js' };
            });
          },
        },
      ],
    });

    const entry = path.join(directory, 'banner.mjs');
    await writeFile(entry, result.outputFiles[0].text);
    const { NativeScreenShareBanner } = await import(pathToFileURL(entry).href);

    const baseStatus = {
      active: true,
      backend_used: 'DxgiMonitor',
      encoder_name: '',
      is_hardware: false,
      width: 1920,
      height: 1080,
      fps: 60,
      bitrate_bps: 6_500_000,
      app_audio_active: false,
      source_id: 'mon-1',
      preview_session_id: null,
    };

    const assertNoBadTokens = (html: string, label: string) => {
      assert.equal(/\bNaN\b/i.test(html), false, `${label}: HTML não pode conter NaN`);
      assert.equal(/\bInfinity\b/i.test(html), false, `${label}: HTML não pode conter Infinity`);
    };

    // 1. nativeScreenStats: {} (parcial)
    const partialHtml = renderToStaticMarkup(
      React.createElement(NativeScreenShareBanner, {
        status: baseStatus,
        stats: {},
      })
    );
    assertNoBadTokens(partialHtml, 'partial {}');
    assert.ok(partialHtml.includes('1920x1080'), 'Deve fazer fallback seguro de resolução via status');
    assert.ok(partialHtml.includes('Codificador SW'), 'Encoder vazio não deve renderizar " (SW)"');
    assert.ok(partialHtml.includes('—'), 'FPS/bitrate ausentes em stats {} devem usar "—"');

    // 2. Campos NaN, Infinity, -Infinity e negativos
    const invalidHtml = renderToStaticMarkup(
      React.createElement(NativeScreenShareBanner, {
        status: { ...baseStatus, width: Number.NaN, height: -1080, fps: -60, bitrate_bps: Number.NEGATIVE_INFINITY },
        stats: {
          dst_width: Number.NaN,
          dst_height: Number.POSITIVE_INFINITY,
          send_fps: Number.NaN,
          send_bitrate_kbps: -500,
          encoder_name: '   ',
          is_hardware: false,
        },
      })
    );
    assertNoBadTokens(invalidHtml, 'invalid NaN/Infinity/negative');
    assert.ok(invalidHtml.includes('Codificador SW'));
    assert.ok(invalidHtml.includes('—'));

    // 3. Zeros legítimos (send_fps: 0, send_bitrate_kbps: 0)
    const zeroHtml = renderToStaticMarkup(
      React.createElement(NativeScreenShareBanner, {
        status: baseStatus,
        stats: {
          dst_width: 1920,
          dst_height: 1080,
          send_fps: 0,
          send_bitrate_kbps: 0,
          encoder_name: 'h264_nvenc',
          is_hardware: true,
        },
      })
    );
    assertNoBadTokens(zeroHtml, 'zero metrics');
    assert.ok(zeroHtml.includes('1920x1080'));
    assert.ok(zeroHtml.includes('0 FPS'), '0 FPS legítimo deve ser preservado');
    assert.ok(zeroHtml.includes('0 kbps'), '0 kbps legítimo deve ser preservado');
    assert.ok(zeroHtml.includes('h264_nvenc (HW)'));

    // 4. Dados completos e válidos
    const completeHtml = renderToStaticMarkup(
      React.createElement(NativeScreenShareBanner, {
        status: { ...baseStatus, app_audio_active: true },
        stats: {
          dst_width: 1920,
          dst_height: 1080,
          send_fps: 60,
          send_bitrate_kbps: 6500,
          encoder_name: 'h264_nvenc',
          is_hardware: true,
          app_audio_active: true,
        },
      })
    );
    assertNoBadTokens(completeHtml, 'complete valid metrics');
    assert.ok(completeHtml.includes('1920x1080'));
    assert.ok(completeHtml.includes('60 FPS'));
    assert.ok(completeHtml.includes('6500 kbps'));
    assert.ok(completeHtml.includes('h264_nvenc (HW)'));
    assert.ok(completeHtml.includes('Áudio do app (WASAPI)'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
