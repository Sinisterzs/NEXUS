/**
 * NEXUS - Phase 3.0: Automated Test Suite for Screen Capture Foundation
 *
 * Valida os 15 cenários obrigatórios especificados:
 * 1. Solicitação iniciada pelo usuário.
 * 2. Captura autorizada.
 * 3. Permissão negada.
 * 4. Usuário cancela o seletor.
 * 5. Captura encerrada pelo sistema.
 * 6. Duas tentativas simultâneas de captura.
 * 7. Cancelamento durante operação assíncrona.
 * 8. Encerramento manual.
 * 9. Logout com captura ativa.
 * 10. Encerramento da chamada.
 * 11. Liberação de tracks.
 * 12. Ausência de vazamento de listeners.
 * 13. Preservação do microfone.
 * 14. Ausência de envio de vídeo ao Gateway.
 * 15. Ausência de persistência de frames no disco.
 */

import { ScreenCaptureService } from '../src/services/ScreenCaptureService.ts';
import fs from 'fs';
import path from 'path';

// --- MOCK WEBRTC / MEDIA ENVIRONMENT ---

class MockMediaStreamTrack {
  id: string;
  kind: string;
  label: string;
  readyState: 'live' | 'ended' = 'live';
  enabled: boolean = true;
  private listeners: Record<string, Set<Function>> = {};

  constructor(kind: string, label: string) {
    this.id = 'track_' + Math.random().toString(36).slice(2, 9);
    this.kind = kind;
    this.label = label;
  }

  stop() {
    this.readyState = 'ended';
  }

  addEventListener(event: string, callback: Function) {
    if (!this.listeners[event]) this.listeners[event] = new Set();
    this.listeners[event].add(callback);
  }

  removeEventListener(event: string, callback: Function) {
    if (this.listeners[event]) {
      this.listeners[event].delete(callback);
    }
  }

  dispatchEvent(event: string) {
    if (this.listeners[event]) {
      for (const cb of this.listeners[event]) {
        cb({ type: event, target: this });
      }
    }
  }

  getListenerCount(event: string): number {
    return this.listeners[event] ? this.listeners[event].size : 0;
  }
}

class MockMediaStream {
  id: string;
  private tracks: MockMediaStreamTrack[] = [];

  constructor(tracks: MockMediaStreamTrack[] = []) {
    this.id = 'stream_' + Math.random().toString(36).slice(2, 9);
    this.tracks = tracks;
  }

  getTracks(): MockMediaStreamTrack[] {
    return [...this.tracks];
  }

  getVideoTracks(): MockMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }

  getAudioTracks(): MockMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }

  addTrack(track: MockMediaStreamTrack) {
    this.tracks.push(track);
  }
}

// Global Navigator Mock Setup
let getDisplayMediaMock: ((constraints: any) => Promise<any>) | null = null;

try {
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      mediaDevices: {
        getDisplayMedia: (constraints: any) => {
          if (getDisplayMediaMock) {
            return getDisplayMediaMock(constraints);
          }
          return Promise.reject(new Error('Mock getDisplayMedia not implemented'));
        },
      },
    },
    configurable: true,
    writable: true,
  });
} catch {
  (globalThis as any).navigator.mediaDevices = {
    getDisplayMedia: (constraints: any) => {
      if (getDisplayMediaMock) {
        return getDisplayMediaMock(constraints);
      }
      return Promise.reject(new Error('Mock getDisplayMedia not implemented'));
    },
  };
}

(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

// --- TEST RUNNER ---

let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ❌ FALHA: ${message}`);
    failedTests++;
    throw new Error(message);
  } else {
    console.log(`  ✅ ${message}`);
  }
}

async function runTest(title: string, testFn: () => Promise<void>) {
  console.log(`\n▶ [Teste] ${title}`);
  try {
    await testFn();
    passedTests++;
  } catch (err: any) {
    console.error(`  Exceção no teste: ${err.message}`);
  }
}

// --- TEST CASES ---

async function runAllTests() {
  console.log('===============================================================');
  console.log(' NEXUS - Testes Automatizados da Fundação de Transmissão 3.0   ');
  console.log('===============================================================');

  // Teste 1: Solicitação iniciada exclusivamente pelo usuário
  await runTest('1. Solicitação iniciada pelo usuário', async () => {
    const service = new ScreenCaptureService();
    const state = service.getState();
    assert(!state.isCapturing, 'Serviço deve iniciar em estado inativo (isCapturing: false)');
    assert(!state.isStarting, 'Serviço não deve estar em progresso inicial (isStarting: false)');
    assert(state.stream === null, 'Stream deve ser nulo antes de qualquer ação do usuário');
    service.destroy();
  });

  // Teste 2: Captura autorizada
  await runTest('2. Captura autorizada com seleção válida', async () => {
    const service = new ScreenCaptureService();
    const mockTrack = new MockMediaStreamTrack('video', 'Monitor 1 (2560x1440)');
    const mockStream = new MockMediaStream([mockTrack]);

    getDisplayMediaMock = async () => mockStream;

    const stream = await service.startCapture();
    assert(stream !== null, 'Stream retornado deve ser válido');
    assert(service.getState().isCapturing === true, 'Estado deve ser isCapturing: true');
    assert(service.getState().sourceLabel === 'Monitor 1 (2560x1440)', 'Rótulo da fonte deve corresponder à tela selecionada');
    assert(service.getState().error === null, 'Não deve haver erro quando a captura for autorizada');

    service.destroy();
  });

  // Teste 3: Permissão negada
  await runTest('3. Permissão negada pelo sistema ou runtime', async () => {
    const service = new ScreenCaptureService();
    getDisplayMediaMock = async () => {
      const err: any = new Error('Permission denied');
      err.name = 'NotAllowedError';
      throw err;
    };

    const stream = await service.startCapture();
    assert(stream === null, 'Stream deve ser nulo quando permissão for negada');
    assert(service.getState().isCapturing === false, 'isCapturing deve ser false após negação');
    assert(service.getState().error === 'Permissão de captura de tela negada.', 'Mensagem de erro deve identificar recusa de permissão');

    service.destroy();
  });

  // Teste 4: Usuário cancela o seletor
  await runTest('4. Usuário cancela o seletor nativo', async () => {
    const service = new ScreenCaptureService();
    getDisplayMediaMock = async () => {
      const err: any = new Error('Permission denied by user (cancelled)');
      err.name = 'NotAllowedError';
      throw err;
    };

    const stream = await service.startCapture();
    assert(stream === null, 'Stream deve ser nulo após cancelamento');
    assert(service.getState().isCapturing === false, 'isCapturing deve ser false');
    assert(service.getState().error === 'Seleção de tela cancelada pelo usuário.', 'Mensagem deve indicar cancelamento explícito pelo usuário');

    service.destroy();
  });

  // Teste 5: Captura encerrada pelo sistema (track.onended)
  await runTest('5. Captura encerrada pelo sistema (track.onended)', async () => {
    const service = new ScreenCaptureService();
    const mockTrack = new MockMediaStreamTrack('video', 'Janela: VS Code');
    const mockStream = new MockMediaStream([mockTrack]);

    getDisplayMediaMock = async () => mockStream;
    await service.startCapture();
    assert(service.getState().isCapturing === true, 'Captura iniciada com sucesso');

    // Simula clique no botão nativo "Parar compartilhamento" ou fechamento da janela capturada
    mockTrack.dispatchEvent('ended');

    assert(service.getState().isCapturing === false, 'isCapturing deve retornar para false automaticamente');
    assert(service.getState().stream === null, 'Referência ao stream deve ser limpa');

    service.destroy();
  });

  // Teste 6: Duas tentativas simultâneas de captura
  await runTest('6. Duas tentativas simultâneas de captura', async () => {
    const service = new ScreenCaptureService();
    let resolveMedia!: (val: any) => void;
    const pendingMediaPromise = new Promise((res) => {
      resolveMedia = res;
    });
    getDisplayMediaMock = () => pendingMediaPromise;

    // Dispara a primeira tentativa
    const firstPromise = service.startCapture();
    
    // Aguarda microtask para garantir que entrou em isStarting
    await new Promise((r) => setTimeout(r, 10));
    assert(service.getState().isStarting === true, 'isStarting deve ser true durante a primeira tentativa');

    // Dispara a segunda tentativa simultânea
    const secondResult = await service.startCapture();
    assert(secondResult === null, 'Segunda tentativa concorrente deve ser rejeitada imediatamente com null');

    // Conclui a primeira tentativa
    const mockTrack = new MockMediaStreamTrack('video', 'Monitor Principal');
    resolveMedia(new MockMediaStream([mockTrack]));
    const firstStream = await firstPromise;

    assert(firstStream !== null, 'Primeira solicitação deve concluir com sucesso');
    assert(service.getState().isCapturing === true, 'Serviço deve ficar em estado de captura');

    service.destroy();
  });

  // Teste 7: Cancelamento durante operação assíncrona
  await runTest('7. Cancelamento durante operação assíncrona pendente', async () => {
    const service = new ScreenCaptureService();
    let resolveMedia!: (val: any) => void;
    const pendingMediaPromise = new Promise((res) => {
      resolveMedia = res;
    });
    getDisplayMediaMock = () => pendingMediaPromise;

    const startPromise = service.startCapture();
    await new Promise((r) => setTimeout(r, 10));

    // Usuário clica em parar ou cancela antes do seletor resolver
    service.stopCapture();

    // Seletor eventualmente resolve depois do cancelamento
    const mockTrack = new MockMediaStreamTrack('video', 'Monitor Secundário');
    resolveMedia(new MockMediaStream([mockTrack]));
    const result = await startPromise;

    assert(result === null, 'Resultado retornado deve ser null devido ao cancelamento prévio');
    assert(mockTrack.readyState === 'ended', 'A faixa adquirida tardiamente deve ter sido imediatamente encerrada');
    assert(service.getState().isCapturing === false, 'Estado deve permanecer isCapturing: false');

    service.destroy();
  });

  // Teste 8: Encerramento manual
  await runTest('8. Encerramento manual com stopCapture()', async () => {
    const service = new ScreenCaptureService();
    const mockTrack = new MockMediaStreamTrack('video', 'Monitor 1');
    const mockStream = new MockMediaStream([mockTrack]);

    getDisplayMediaMock = async () => mockStream;
    await service.startCapture();
    assert(service.getState().isCapturing === true, 'Captura ativa');

    service.stopCapture();
    assert(service.getState().isCapturing === false, 'isCapturing deve ser false após stopCapture()');
    assert(service.getState().stream === null, 'Stream deve ser null após stopCapture()');
    assert(mockTrack.readyState === 'ended', 'Track deve ser parado após stopCapture()');

    service.destroy();
  });

  // Teste 9: Logout com captura ativa
  await runTest('9. Logout com captura ativa (simulação de encerramento de sessão)', async () => {
    const service = new ScreenCaptureService();
    const mockTrack = new MockMediaStreamTrack('video', 'Tela Compartilhada');
    getDisplayMediaMock = async () => new MockMediaStream([mockTrack]);

    await service.startCapture();
    assert(service.getState().isCapturing === true, 'Captura ativa antes de logout');

    // Simula a rotina de logout chamada pelo useAppStore/CallService
    service.stopCapture();

    assert(service.getState().isCapturing === false, 'Captura interrompida no logout');
    assert(mockTrack.readyState === 'ended', 'Track liberado no logout');

    service.destroy();
  });

  // Teste 10: Encerramento da chamada
  await runTest('10. Encerramento de chamada associada', async () => {
    const service = new ScreenCaptureService();
    const mockTrack = new MockMediaStreamTrack('video', 'Janela de Navegador');
    getDisplayMediaMock = async () => new MockMediaStream([mockTrack]);

    await service.startCapture();
    assert(service.getState().isCapturing === true, 'Captura ativa na chamada');

    // Simula término da chamada (CallService.cleanup())
    service.stopCapture();

    assert(service.getState().isCapturing === false, 'Captura encerrada ao finalizar chamada');
    assert(mockTrack.readyState === 'ended', 'Track finalizada ao encerrar chamada');

    service.destroy();
  });

  // Teste 11: Liberação completa de tracks
  await runTest('11. Liberação de todas as tracks de vídeo', async () => {
    const service = new ScreenCaptureService();
    const track1 = new MockMediaStreamTrack('video', 'Track 1');
    const track2 = new MockMediaStreamTrack('video', 'Track 2');
    const multiTrackStream = new MockMediaStream([track1, track2]);

    getDisplayMediaMock = async () => multiTrackStream;
    await service.startCapture();

    service.stopCapture();

    assert(track1.readyState === 'ended', 'Faixa 1 deve estar em estado ended');
    assert(track2.readyState === 'ended', 'Faixa 2 deve estar em estado ended');

    service.destroy();
  });

  // Teste 12: Ausência de vazamento de listeners
  await runTest('12. Ausência de vazamento de listeners (cleanup listener test)', async () => {
    const service = new ScreenCaptureService();
    const mockTrack = new MockMediaStreamTrack('video', 'Monitor Único');
    getDisplayMediaMock = async () => new MockMediaStream([mockTrack]);

    let externalListenerCalls = 0;
    const unsub = service.addListener((state) => {
      externalListenerCalls++;
    });

    await service.startCapture();
    assert(mockTrack.getListenerCount('ended') === 1, 'Deve registrar exatamente 1 listener de onended');

    service.stopCapture();
    assert(mockTrack.getListenerCount('ended') === 0, 'Listener de onended deve ter sido removido do track');

    unsub();
    service.destroy();
  });

  // Teste 13: Preservação do microfone
  await runTest('13. Preservação da faixa de microfone durante e após compartilhamento de tela', async () => {
    const service = new ScreenCaptureService();

    // Faixa simulada de microfone do WebRtcService
    const micTrack = new MockMediaStreamTrack('audio', 'Microfone Realtek');
    const micStream = new MockMediaStream([micTrack]);
    assert(micTrack.readyState === 'live', 'Microfone começa ativo');

    // Inicia captura de tela
    const screenTrack = new MockMediaStreamTrack('video', 'Tela Compartilhada');
    getDisplayMediaMock = async () => new MockMediaStream([screenTrack]);

    await service.startCapture();
    assert(micTrack.readyState === 'live', 'Microfone permanece live durante captura de tela');

    // Encerra compartilhamento de tela
    service.stopCapture();

    assert(screenTrack.readyState === 'ended', 'Track de tela deve ser parado');
    assert(micTrack.readyState === 'live', 'Microfone NUNCA deve ser interrompido ou alterado pelo ScreenCaptureService');
    assert(micTrack.enabled === true, 'Microfone permanece habilitado');

    service.destroy();
  });

  // Teste 14: Ausência de envio de vídeo ao Gateway
  await runTest('14. Ausência de envio de dados/frames de vídeo ao Gateway WebSocket', async () => {
    // Inspeciona implementação de ScreenCaptureService e valida ausência de dependências de rede
    const serviceCode = fs.readFileSync(
      path.resolve(process.cwd(), 'src/services/ScreenCaptureService.ts'),
      'utf-8'
    );

    assert(!serviceCode.includes('gatewayClient'), 'ScreenCaptureService não deve importar ou usar gatewayClient');
    assert(!serviceCode.includes('sendCall'), 'ScreenCaptureService não deve enviar comandos de chamada');
    assert(!serviceCode.includes('WebSocket'), 'ScreenCaptureService não deve instanciar WebSockets');
    assert(!serviceCode.includes('peerConnection'), 'ScreenCaptureService não deve manipular peerConnection na Fase 3.0');
    assert(!serviceCode.includes('fetch('), 'ScreenCaptureService não deve realizar requisições HTTP fetch com dados de tela');
  });

  // Teste 15: Ausência de persistência de frames no disco
  await runTest('15. Ausência de persistência de frames ou screenshots no disco', async () => {
    const serviceCode = fs.readFileSync(
      path.resolve(process.cwd(), 'src/services/ScreenCaptureService.ts'),
      'utf-8'
    );

    assert(!serviceCode.includes('writeFile'), 'ScreenCaptureService não deve gravar arquivos em disco');
    assert(!serviceCode.includes('toDataURL'), 'ScreenCaptureService não deve extrair imagens estáticas');
    assert(!serviceCode.includes('rusqlite'), 'ScreenCaptureService não deve persistir frames em banco de dados');
    assert(!serviceCode.includes('localStorage'), 'ScreenCaptureService não deve persistir frames em localStorage');
  });

  console.log('\n===============================================================');
  console.log(` RESULTADO DOS TESTES: ${passedTests} APROVADOS / ${failedTests} FALHAS`);
  console.log('===============================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Falha catastrófica na suíte de testes:', err);
  process.exit(1);
});
