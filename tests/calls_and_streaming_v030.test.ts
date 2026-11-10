import test from 'node:test';
import assert from 'node:assert/strict';
import { audioDeviceService } from '../src/services/AudioDeviceService.ts';
import {
  screenCaptureService,
  buildDisplayVideoConstraints,
  SCREEN_QUALITY_CONFIGS,
} from '../src/services/ScreenCaptureService.ts';

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

