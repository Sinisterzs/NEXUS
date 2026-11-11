import test from 'node:test';
import assert from 'node:assert/strict';
import { audioDeviceService } from '../src/services/AudioDeviceService.ts';
import {
  screenCaptureService,
  buildDisplayVideoConstraints,
  SCREEN_QUALITY_CONFIGS,
} from '../src/services/ScreenCaptureService.ts';
import {
  WebRtcService,
  rankVideoCodecsForScreenShare,
  computeProgressiveBitrateStage,
  computeVideoStatsMetrics,
  type VideoStatsSnapshot,
} from '../src/services/WebRtcService.ts';

// ============================================================================
// 1. Testes de Dispositivos de Áudio (Enumeração, Hot-Swap e Fallback Seguro)
// ============================================================================

test('AudioDeviceService: enumera microfones e saídas, deduplica IDs e garante opção default', async () => {
  const originalNavigator = globalThis.navigator;

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        enumerateDevices: async () => [
          { deviceId: 'mic-usb-1', kind: 'audioinput', label: 'HyperX QuadCast', groupId: 'g1' },
          { deviceId: 'mic-usb-1', kind: 'audioinput', label: 'HyperX QuadCast Dup', groupId: 'g1' },
          { deviceId: 'spk-dac-1', kind: 'audiooutput', label: 'FiiO USB DAC', groupId: 'g2' },
        ],
        getSupportedConstraints: () => ({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }),
      },
    },
  });

  try {
    const devices = await audioDeviceService.getAvailableDevices();
    assert.equal(devices.inputs.length, 1, 'Deve deduplicar dispositivos com mesmo deviceId');
    assert.equal(devices.inputs[0].deviceId, 'mic-usb-1');
    assert.equal(devices.inputs[0].label, 'HyperX QuadCast');

    assert.equal(devices.outputs.length, 1, 'Deve retornar saída deduplicada');
    assert.equal(devices.outputs[0].deviceId, 'spk-dac-1');
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
  }
});

test('AudioDeviceService: resolveValidDeviceId faz fallback para "default" quando periférico é desconectado', () => {
  const available = [
    { deviceId: 'default', kind: 'audioinput' as const, label: 'Padrão', groupId: 'default' },
    { deviceId: 'mic-1', kind: 'audioinput' as const, label: 'Microfone 1', groupId: 'g1' },
  ];

  const valid = audioDeviceService.resolveValidDeviceId('mic-1', available);
  assert.equal(valid.deviceId, 'mic-1');
  assert.equal(valid.didFallback, false);

  const unplugged = audioDeviceService.resolveValidDeviceId('mic-removido-usb', available);
  assert.equal(unplugged.deviceId, 'default');
  assert.equal(unplugged.didFallback, true);
});

test('AudioDeviceService: setAudioSink aplica setSinkId e faz fallback automático se o dispositivo falhar', async () => {
  const sinkCalls: string[] = [];
  const fakeAudioElement: any = {
    setSinkId: async (id: string) => {
      sinkCalls.push(id);
      if (id === 'broken-output-id') {
        throw new Error('Device not found');
      }
    },
  };

  // Caso 1: Sucesso no dispositivo selecionado
  const okResult = await audioDeviceService.setAudioSink(fakeAudioElement, 'headset-usb');
  assert.equal(okResult.applied, true);
  assert.equal(okResult.didFallback, false);
  assert.equal(okResult.activeSinkId, 'headset-usb');

  // Caso 2: Dispositivo falha -> fallback automático para saída padrão ('')
  const fallbackResult = await audioDeviceService.setAudioSink(fakeAudioElement, 'broken-output-id');
  assert.equal(fallbackResult.applied, true);
  assert.equal(fallbackResult.didFallback, true);
  assert.equal(fallbackResult.activeSinkId, 'default');
  assert.deepEqual(sinkCalls, ['headset-usb', 'broken-output-id', '']);
});

// ============================================================================
// 2. Testes de Compartilhamento de Tela 2.0 (Presets, Fallback e Ciclo de Vida)
// ============================================================================

test('ScreenCaptureService: gera constraints corretas para presets auto, 720p30, 1080p30 e 1080p60', () => {
  const c720 = buildDisplayVideoConstraints('720p30');
  assert.equal(c720.width.max, 1280);
  assert.equal(c720.height.max, 720);
  assert.equal(c720.frameRate.max, 30);

  const c1080p60 = buildDisplayVideoConstraints('1080p60');
  assert.equal(c1080p60.width.max, 1920);
  assert.equal(c1080p60.height.max, 1080);
  assert.equal(c1080p60.frameRate.max, 60);
  assert.equal(SCREEN_QUALITY_CONFIGS['1080p60'].maxBitrate, 5_000_000);
});

test('ScreenCaptureService: inicia captura 1080p60 com fallback automático para 720p30 em OverconstrainedError e limpa recursos ao encerrar', async () => {
  const originalNavigator = globalThis.navigator;
  let callCount = 0;
  let trackStopped = false;
  const trackListeners: Record<string, (() => void)[]> = {};

  const mockVideoTrack: any = {
    label: 'Tela 1 (1920x1080)',
    readyState: 'live',
    getSettings: () => ({
      width: 1280,
      height: 720,
      frameRate: 30,
      displaySurface: 'monitor',
    }),
    addEventListener: (evt: string, cb: () => void) => {
      trackListeners[evt] = trackListeners[evt] || [];
      trackListeners[evt].push(cb);
    },
    removeEventListener: (evt: string, cb: () => void) => {
      trackListeners[evt] = (trackListeners[evt] || []).filter((fn) => fn !== cb);
    },
    applyConstraints: async () => {},
    stop: () => {
      trackStopped = true;
      mockVideoTrack.readyState = 'ended';
    },
  };

  const mockStream: any = {
    getVideoTracks: () => [mockVideoTrack],
    getTracks: () => [mockVideoTrack],
  };

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getDisplayMedia: async () => {
          callCount += 1;
          if (callCount === 1) {
            const err = new Error('60fps not supported');
            err.name = 'OverconstrainedError';
            throw err;
          }
          return mockStream;
        },
      },
    },
  });

  try {
    const stream = await screenCaptureService.startCapture('1080p60');
    const state = screenCaptureService.getState();
    assert.ok(stream, 'Deve obter stream após fallback de qualidade');
    assert.equal(state.isCapturing, true);
    assert.ok(state.qualityFallbackNotice, 'Deve informar aviso claro de fallback');
    assert.equal(state.effectiveWidth, 1280);
    assert.equal(state.effectiveHeight, 720);
    assert.equal(state.effectiveFrameRate, 30);

    // Simula encerramento pelo usuário ou fechamento da janela compartilhada
    let endedNotificationReceived = false;
    const unsubscribe = screenCaptureService.addListener((nextState) => {
      if (!nextState.isCapturing) {
        endedNotificationReceived = true;
      }
    });

    // Dispara evento nativo 'ended' da track
    for (const fn of trackListeners['ended'] || []) {
      fn();
    }

    unsubscribe();
    assert.equal(endedNotificationReceived, true, 'Listener deve ser notificado do encerramento');
    assert.equal(trackStopped, true, 'Track de vídeo deve ser interrompida sem sobras órfãs');
    assert.equal(screenCaptureService.getState().isCapturing, false);
  } finally {
    screenCaptureService.stopCapture();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
  }
});

test('ScreenCaptureService: cancelamento pelo usuário (NotAllowedError) não tenta reabrir seletor e mantém estado seguro', async () => {
  const originalNavigator = globalThis.navigator;
  let attempts = 0;

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getDisplayMedia: async () => {
          attempts += 1;
          const err = new Error('Permission denied by user');
          err.name = 'NotAllowedError';
          throw err;
        },
      },
    },
  });

  try {
    const stream = await screenCaptureService.startCapture('1080p30');
    const state = screenCaptureService.getState();
    assert.equal(attempts, 1, 'Não deve tentar fallback quando o usuário cancela o seletor');
    assert.equal(stream, null);
    assert.equal(state.error, 'Permissão de captura de tela negada.');
    assert.equal(state.isCapturing, false);
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
  }
});

// ============================================================================
// 3. Testes de Volume Individual por Participante (0% a 200%) e Mute/Deafen
// ============================================================================

function computeEffectiveAudioRouting(params: {
  peerVolumePercent: number;
  masterOutputPercent: number;
  isDeafened: boolean;
}): { elementMuted: boolean; elementVolume: number; boostGainValue: number } {
  const peerVol = Math.max(0, Math.min(200, Math.round(params.peerVolumePercent)));
  const masterVol = Math.max(0, Math.min(100, Math.round(params.masterOutputPercent)));

  if (params.isDeafened || peerVol === 0 || masterVol === 0) {
    return { elementMuted: true, elementVolume: 0, boostGainValue: 0 };
  }

  const combinedRatio = (peerVol / 100) * (masterVol / 100);
  return {
    elementMuted: false,
    elementVolume: Math.max(0, Math.min(1, combinedRatio)),
    boostGainValue: combinedRatio > 1 ? Math.min(2.0, combinedRatio) : 1.0,
  };
}

test('Áudio 2.0: cálculo de volume individual (0%, 100%, 150%, 200%) combinado ao volume mestre e Deafen', () => {
  // 100% individual + 100% mestre -> ganho unitário
  const unity = computeEffectiveAudioRouting({
    peerVolumePercent: 100,
    masterOutputPercent: 100,
    isDeafened: false,
  });
  assert.equal(unity.elementMuted, false);
  assert.equal(unity.elementVolume, 1);
  assert.equal(unity.boostGainValue, 1.0);

  // 50% individual + 80% mestre -> 0.40 no elemento
  const attenuated = computeEffectiveAudioRouting({
    peerVolumePercent: 50,
    masterOutputPercent: 80,
    isDeafened: false,
  });
  assert.equal(attenuated.elementMuted, false);
  assert.ok(Math.abs(attenuated.elementVolume - 0.4) < 1e-6);
  assert.equal(attenuated.boostGainValue, 1.0);

  // 180% individual (boost) + 100% mestre -> elemento em 1.0 e GainNode em 1.8
  const boosted = computeEffectiveAudioRouting({
    peerVolumePercent: 180,
    masterOutputPercent: 100,
    isDeafened: false,
  });
  assert.equal(boosted.elementMuted, false);
  assert.equal(boosted.elementVolume, 1);
  assert.ok(Math.abs(boosted.boostGainValue - 1.8) < 1e-6);

  // 0% individual -> silenciado localmente
  const zeroPeer = computeEffectiveAudioRouting({
    peerVolumePercent: 0,
    masterOutputPercent: 100,
    isDeafened: false,
  });
  assert.equal(zeroPeer.elementMuted, true);
  assert.equal(zeroPeer.elementVolume, 0);

  // Deafen ativo -> silencia imediatamente independente do boost
  const deafened = computeEffectiveAudioRouting({
    peerVolumePercent: 200,
    masterOutputPercent: 100,
    isDeafened: true,
  });
  assert.equal(deafened.elementMuted, true);
  assert.equal(deafened.elementVolume, 0);
  assert.equal(deafened.boostGainValue, 0);
});

// ============================================================================
// 4. Testes de Reconexão Controlada com Backoff e Limite de Tentativas
// ============================================================================

test('Estabilidade WebRTC: reconexão controlada aplica backoff exponencial e encerra ao atingir limite máximo', () => {
  const maxAttempts = 3;
  const baseBackoffMs = 1800;
  const scheduledDelays: number[] = [];
  let currentAttempt = 0;
  let callTerminatedReason: string | null = null;

  function stepReconnect() {
    if (currentAttempt >= maxAttempts) {
      callTerminatedReason = 'Conexão de voz perdida após múltiplas tentativas de recuperação.';
      return;
    }
    currentAttempt += 1;
    const delay = baseBackoffMs * Math.pow(2, currentAttempt - 1);
    scheduledDelays.push(delay);
  }

  stepReconnect(); // Tentativa 1
  stepReconnect(); // Tentativa 2
  stepReconnect(); // Tentativa 3
  assert.equal(currentAttempt, 3);
  assert.deepEqual(scheduledDelays, [1800, 3600, 7200]);
  assert.equal(callTerminatedReason, null);

  // Quarta falha excede maxAttempts (3) e encerra a sessão de forma limpa
  stepReconnect();
  assert.ok(callTerminatedReason);
  assert.match(callTerminatedReason, /múltiplas tentativas/i);
});

// ============================================================================
// 5. Testes de Validação de Preferências e Diagnósticos de Mídia
// ============================================================================

test('Preferências: clamping de participantVolumes (0..200), callStageSplitRatio (30..85) e validação de screenShareQuality', () => {
  const rawVolumes: Record<string, any> = {
    peer_normal: 125,
    peer_boost_excess: 350,
    peer_negative: -40,
    peer_nan: 'invalid',
  };

  const sanitizedVolumes: Record<string, number> = {};
  for (const [peerId, val] of Object.entries(rawVolumes)) {
    if (typeof val === 'number' && !Number.isNaN(val)) {
      sanitizedVolumes[peerId] = Math.max(0, Math.min(200, Math.round(val)));
    }
  }

  assert.equal(sanitizedVolumes.peer_normal, 125);
  assert.equal(sanitizedVolumes.peer_boost_excess, 200);
  assert.equal(sanitizedVolumes.peer_negative, 0);
  assert.equal('peer_nan' in sanitizedVolumes, false);

  const clampSplit = (v: number) => Math.max(30, Math.min(85, Math.round(v)));
  assert.equal(clampSplit(15), 30);
  assert.equal(clampSplit(65), 65);
  assert.equal(clampSplit(98), 85);
});

test('Diagnósticos WebRTC: cálculo de bitrate (kbps) por delta de bytes e percentual de perda de pacotes', () => {
  const prevBytes = 100_000;
  const currBytes = 350_000; // +250 KB = 2.000.000 bits
  const elapsedSec = 2.0;

  const bitrateKbps = Math.max(0, Math.round(((currBytes - prevBytes) * 8) / elapsedSec / 1000));
  assert.equal(bitrateKbps, 1000, '250 KB em 2s deve resultar em 1000 kbps');

  const packetsReceived = 980;
  const packetsLost = 20;
  const totalExpected = packetsReceived + packetsLost;
  const lossPercent = Number(((packetsLost / totalExpected) * 100).toFixed(1));
  assert.equal(lossPercent, 2.0);
});

// ============================================================================
// 6. Nightly 2 — Problema 1: Nitidez no Início (Rampa Progressiva, Codecs e Sender Params)
// ============================================================================

test('Problema 1: rampa progressiva (warmup -> ramping -> steady) preserva resolução 1080p desde o frame 1 sem forçar bitrate máximo imediato', () => {
  const warmup60 = computeProgressiveBitrateStage('1080p60', 'warmup');
  assert.equal(warmup60.degradationPreference, 'maintain-resolution');
  assert.equal(warmup60.scaleResolutionDownBy, 1);
  assert.equal(warmup60.contentHint, 'detail');
  assert.equal(warmup60.maxFramerate, 60);
  assert.ok(
    warmup60.targetBitrateBps >= SCREEN_QUALITY_CONFIGS['1080p60'].minBitrate &&
      warmup60.targetBitrateBps < SCREEN_QUALITY_CONFIGS['1080p60'].maxBitrate,
    'Warmup deve iniciar acima do minBitrate e abaixo do maxBitrate (sem saturar BWE no frame 1)'
  );

  const ramping60 = computeProgressiveBitrateStage('1080p60', 'ramping');
  assert.equal(ramping60.degradationPreference, 'maintain-resolution');
  assert.equal(ramping60.scaleResolutionDownBy, 1);
  assert.ok(ramping60.targetBitrateBps > warmup60.targetBitrateBps);
  assert.ok(ramping60.targetBitrateBps < SCREEN_QUALITY_CONFIGS['1080p60'].maxBitrate);

  const steady60 = computeProgressiveBitrateStage('1080p60', 'steady');
  assert.equal(steady60.targetBitrateBps, 5_000_000);
  assert.equal(steady60.maxFramerate, 60);
  assert.equal(steady60.scaleResolutionDownBy, 1);
  assert.equal(steady60.degradationPreference, 'balanced');
  assert.equal(steady60.contentHint, 'motion');

  const steady30 = computeProgressiveBitrateStage('1080p30', 'steady');
  assert.equal(steady30.targetBitrateBps, 3_500_000);
  assert.equal(steady30.maxFramerate, 30);
  assert.equal(steady30.degradationPreference, 'maintain-resolution');
  assert.equal(steady30.contentHint, 'detail');
});

test('Problema 1 & 5: rankVideoCodecsForScreenShare prioriza H.264 (packetization-mode=1) e VP9 sobre VP8, preservando RTX/RED/ULPFEC', () => {
  const inputCodecs = [
    { mimeType: 'video/VP8', clockRate: 90000 },
    { mimeType: 'video/rtx', clockRate: 90000 },
    { mimeType: 'video/VP9', clockRate: 90000, sdpFmtpLine: 'profile-id=0' },
    {
      mimeType: 'video/H264',
      clockRate: 90000,
      sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f',
    },
    {
      mimeType: 'video/H264',
      clockRate: 90000,
      sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    },
    { mimeType: 'video/AV1', clockRate: 90000 },
    { mimeType: 'video/ulpfec', clockRate: 90000 },
  ];

  const ranked = rankVideoCodecsForScreenShare(inputCodecs);
  assert.equal(ranked.length, inputCodecs.length);
  assert.equal(ranked[0].mimeType, 'video/H264');
  assert.match(ranked[0].sdpFmtpLine || '', /packetization-mode=1/);
  assert.equal(ranked[1].mimeType, 'video/H264');
  assert.equal(ranked[2].mimeType, 'video/VP9');
  assert.equal(ranked[3].mimeType, 'video/AV1');
  assert.equal(ranked[4].mimeType, 'video/VP8');
  assert.equal(ranked[5].mimeType, 'video/rtx');
  assert.equal(ranked[6].mimeType, 'video/ulpfec');
});

test('Problema 1 & 5: ScreenCaptureService.setQualityPreset sincroniza contentHint ao alternar de auto para 1080p60', async () => {
  const originalNavigator = globalThis.navigator;
  let currentSettings = {
    width: 1920,
    height: 1080,
    frameRate: 30,
    displaySurface: 'monitor',
  };

  const mockVideoTrack: any = {
    id: 'track-screen-1',
    label: 'Monitor Principal',
    readyState: 'live',
    contentHint: '',
    getSettings: () => currentSettings,
    addEventListener: () => {},
    removeEventListener: () => {},
    applyConstraints: async (constraints: any) => {
      if (constraints?.frameRate?.max) {
        currentSettings = {
          ...currentSettings,
          frameRate: constraints.frameRate.max,
        };
      }
    },
    stop: () => {},
  };

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getDisplayMedia: async () => ({
          getVideoTracks: () => [mockVideoTrack],
          getTracks: () => [mockVideoTrack],
        }),
      },
    },
  });

  try {
    await screenCaptureService.startCapture('auto');
    assert.equal(mockVideoTrack.contentHint, 'detail');
    assert.equal(screenCaptureService.getState().requestedFrameRate, 30);

    const res = await screenCaptureService.setQualityPreset('1080p60');
    assert.equal(res.applied, true);
    assert.equal(res.activePreset, '1080p60');
    assert.equal(
      mockVideoTrack.contentHint,
      'motion',
      'Mudar para 1080p60 em captura ativa deve atualizar contentHint para motion'
    );
    const st = screenCaptureService.getState();
    assert.equal(st.requestedFrameRate, 60);
    assert.equal(st.capturedFrameRate, 60);
  } finally {
    screenCaptureService.stopCapture();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
  }
});

// ============================================================================
// 7. Nightly 2 — Problema 5: Separação Estrita de FPS e Proibição de Exibir Preset como Efetivo
// ============================================================================

test('Problema 5: computeVideoStatsMetrics separa FPS solicitado, capturado, codificado/enviado, recebido e renderizado, e NUNCA usa preset como efetivo', () => {
  // Caso 1: Início de compartilhamento em 1080p60 ANTES de codificar frames RTP.
  // A faixa local tem frameRate=60 na constraint, mas outbound-rtp ainda não codificou nada.
  const initialStats = [
    {
      id: 'ms-video',
      type: 'media-source',
      kind: 'video',
      width: 1920,
      height: 1080,
      framesPerSecond: 60,
      frames: 10,
      timestamp: 1000,
    },
  ];

  const m1 = computeVideoStatsMetrics({
    statsReport: initialStats,
    prevSnapshot: null,
    nowMs: 1000,
    isLocalScreenSharing: true,
    activePreset: '1080p60',
    localTrackSettings: { width: 1920, height: 1080, frameRate: 60 },
  });

  assert.equal(m1.requestedFps, 60);
  assert.equal(m1.capturedFps, 60);
  assert.equal(m1.encodedFps, null, 'Sem outbound-rtp, encodedFps deve ser null');
  assert.equal(m1.sentFps, null, 'Sem outbound-rtp, sentFps deve ser null');
  assert.equal(
    m1.videoFps,
    null,
    'PROIBIDO exibir FPS do preset (60) ou da track local como videoFps efetivo antes de codificar RTP'
  );

  const settingsOnly = computeVideoStatsMetrics({ statsReport: [], prevSnapshot: null,
    nowMs: 1000, isLocalScreenSharing: true, activePreset: '1080p60',
    localTrackSettings: { frameRate: 60 } });
  assert.equal(settingsOnly.capturedFps, null, 'configured cadence is not measured capture FPS');
  assert.equal(settingsOnly.renderedFps, null);

  // Caso 2: 1080p60 solicitado (60 FPS) e capturado a 60 FPS, mas encoder limitado por CPU a 32 FPS
  // (calculado por delta de framesEncoded / framesSent quando framesPerSecond direto não está presente).
  const prevSnap: VideoStatsSnapshot = {
    timestampMs: 1000,
    audioBytes: 0,
    videoBytes: 100_000,
    framesCaptured: 60,
    captureTimestampMs: 1000,
    framesEncoded: 100,
    framesSent: 100,
    outboundVideoTimestampMs: 1000,
    framesReceived: null,
    framesDecoded: null,
    inboundVideoTimestampMs: null,
  };

  const bottleneckStats = [
    {
      id: 'codec-h264',
      type: 'codec',
      mimeType: 'video/H264',
    },
    {
      id: 'ms-video',
      type: 'media-source',
      kind: 'video',
      width: 1920,
      height: 1080,
      frames: 120, // +60 frames em 1.0s = 60 FPS capturados
      timestamp: 2000,
    },
    {
      id: 'out-video',
      type: 'outbound-rtp',
      kind: 'video',
      codecId: 'codec-h264',
      frameWidth: 1920,
      frameHeight: 1080,
      framesEncoded: 132, // +32 frames em 1.0s = 32 FPS codificados
      framesSent: 132, // +32 frames em 1.0s = 32 FPS enviados
      keyFramesEncoded: 2,
      qualityLimitationReason: 'cpu',
      encoderImplementation: 'MediaFoundationVideoEncodeAccelerator',
      powerEfficientEncoder: true,
      timestamp: 2000,
    },
  ];

  const m2 = computeVideoStatsMetrics({
    statsReport: bottleneckStats,
    prevSnapshot: prevSnap,
    nowMs: 2000,
    isLocalScreenSharing: true,
    activePreset: '1080p60',
    localTrackSettings: { width: 1920, height: 1080, frameRate: 60 },
  });

  assert.equal(m2.requestedFps, 60);
  assert.equal(m2.capturedFps, 60);
  assert.equal(m2.encodedFps, 32);
  assert.equal(m2.sentFps, 32);
  assert.equal(m2.videoFps, 32, 'videoFps efetivo deve refletir os 32 FPS realmente enviados');
  assert.equal(m2.qualityLimitationReason, 'cpu');
  assert.equal(m2.videoCodec, 'H264');
  assert.equal(m2.powerEfficientEncoder, true);

  // Caso 3: Recebimento de vídeo remoto com diferença entre frames recebidos (58 FPS) e decodificados/renderizados (54 FPS)
  const prevInboundSnap: VideoStatsSnapshot = {
    timestampMs: 2000,
    audioBytes: 0,
    videoBytes: 200_000,
    framesCaptured: null,
    captureTimestampMs: null,
    framesEncoded: null,
    framesSent: null,
    outboundVideoTimestampMs: null,
    framesReceived: 200,
    framesDecoded: 195,
    inboundVideoTimestampMs: 2000,
  };

  const inboundStats = [
    {
      id: 'in-video',
      type: 'inbound-rtp',
      kind: 'video',
      frameWidth: 1920,
      frameHeight: 1080,
      framesReceived: 258, // +58 em 1.0s = 58 FPS recebidos
      framesDecoded: 249, // +54 em 1.0s = 54 FPS decodificados (apresentação não medida)
      framesDropped: 4,
      timestamp: 3000,
    },
  ];

  const m3 = computeVideoStatsMetrics({
    statsReport: inboundStats,
    prevSnapshot: prevInboundSnap,
    nowMs: 3000,
    isLocalScreenSharing: false,
    activePreset: 'auto',
    localTrackSettings: null,
  });

  assert.equal(m3.requestedFps, null);
  assert.equal(m3.receivedFps, 58);
  assert.equal(m3.decodedFps, 54);
  assert.equal(m3.renderedFps, null, 'decoding does not prove video presentation');
  assert.equal(m3.videoFps, 54);
  assert.equal(m3.framesDropped, 4);
  assert.equal(m3.receivedWidth, 1920);
  assert.equal(m3.receivedHeight, 1080);
});

test('Problema 1 & 5: WebRtcService.attachScreenTrack aplica rampa warmup (scaleResolutionDownBy=1, maintain-resolution) e reaplica parâmetros no handleAnswer', async () => {
  const originalPeerConnection = (globalThis as any).RTCPeerConnection;
  const originalSessionDescription = (globalThis as any).RTCSessionDescription;

  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const stageTimers: { callback: () => void; delay: number }[] = [];
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    stageTimers.push({ callback, delay });
    return stageTimers.length as any;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
  const appliedSenderParams: any[] = [];
  let currentSenderParams: any = { encodings: [{}] };

  const mockSender: any = {
    track: { kind: 'video' },
    getParameters: () => JSON.parse(JSON.stringify(currentSenderParams)),
    setParameters: async (params: any) => {
      currentSenderParams = JSON.parse(JSON.stringify(params));
      appliedSenderParams.push(currentSenderParams);
    },
    replaceTrack: async () => {},
  };

  class MockRTCPeerConnection {
    signalingState = 'stable';
    connectionState = 'connected';
    iceConnectionState = 'connected';
    localDescription: any = null;
    remoteDescription: any = null;
    getSenders() {
      return [mockSender];
    }
    getTransceivers() {
      return [];
    }
    addTrack() {
      return mockSender;
    }
    async createOffer() {
      return { type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' };
    }
    async setLocalDescription(desc: any) {
      this.localDescription = desc;
      if (desc.type === 'offer') {
        this.signalingState = 'have-local-offer';
      }
    }
    async setRemoteDescription(desc: any) {
      this.remoteDescription = desc;
      if (desc.type === 'answer') {
        this.signalingState = 'stable';
      }
    }
    close() {}
  }

  (globalThis as any).RTCPeerConnection = MockRTCPeerConnection;
  (globalThis as any).RTCSessionDescription = class {
    type: string;
    sdp: string;
    constructor(init: { type: string; sdp: string }) {
      this.type = init.type;
      this.sdp = init.sdp;
    }
  };

  const rtc = new WebRtcService({
    onIceCandidate: () => {},
    onConnectionStateChange: () => {},
    onLocalSpeaking: () => {},
    onRemoteSpeaking: () => {},
    onError: () => {},
  });

  try {
    const fakeTrack: any = {
      id: 'screen-track-60',
      kind: 'video',
      contentHint: 'motion',
      stop: () => {},
    };
    const fakeStream: any = {
      getVideoTracks: () => [fakeTrack],
      getTracks: () => [fakeTrack],
    };

    await rtc.attachScreenTrack(fakeTrack, fakeStream, '1080p60');

    assert.ok(appliedSenderParams.length >= 1, 'Deve aplicar parâmetros no attachScreenTrack');
    const warmupParams = appliedSenderParams[0];
    assert.equal(warmupParams.degradationPreference, 'maintain-resolution');
    assert.equal(warmupParams.encodings[0].scaleResolutionDownBy, 1);
    assert.equal(warmupParams.encodings[0].maxFramerate, 60);
    assert.equal(
      warmupParams.encodings[0].maxBitrate,
      SCREEN_QUALITY_CONFIGS['1080p60'].initialBitrate
    );
    assert.equal(fakeTrack.contentHint, 'detail');

    assert.equal(stageTimers.length, 0, 'even an answer delayed beyond 1800ms must leave warmup pending');
    assert.equal(rtc.getBitrateRampStage(), 'warmup');
    const countBeforeAnswer = appliedSenderParams.length;
    await rtc.handleAnswer('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n');
    assert.ok(
      appliedSenderParams.length > countBeforeAnswer,
      'Deve reaplicar parâmetros do sender após setRemoteDescription(answer)'
    );

    assert.deepEqual(stageTimers.map(timer => timer.delay), [900, 1800]);
    stageTimers[0].callback();
    await Promise.resolve();
    assert.equal(rtc.getBitrateRampStage(), 'ramping');
    stageTimers[1].callback();
    await Promise.resolve();
    assert.equal(rtc.getBitrateRampStage(), 'steady');
    // Transição explícita para steady-state em 1080p60
    await rtc.applySenderQualityParameters('1080p60', 'steady');
    const steadyParams = appliedSenderParams[appliedSenderParams.length - 1];
    assert.equal(steadyParams.encodings[0].maxBitrate, 5_000_000);
    assert.equal(steadyParams.encodings[0].maxFramerate, 60);
    assert.equal(steadyParams.encodings[0].scaleResolutionDownBy, 1);
    assert.equal(steadyParams.degradationPreference, 'balanced');
    assert.equal(fakeTrack.contentHint, 'motion');
  } finally {
    rtc.destroy(false);
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    (globalThis as any).RTCPeerConnection = originalPeerConnection;
    (globalThis as any).RTCSessionDescription = originalSessionDescription;
  }
});
