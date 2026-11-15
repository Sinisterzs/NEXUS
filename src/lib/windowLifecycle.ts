import { useAppStore } from '../stores/useAppStore';
import { callService } from '../services/CallService';
import { meshRoomService } from '../services/MeshRoomService';
import { screenCaptureService } from '../services/ScreenCaptureService';
import { settingsRepository } from '../repositories/SettingsRepository';
import { diagnosticsService } from '../services/DiagnosticsService';
import { gatewayClient } from '../services/GatewayClient';

export interface WindowLifecycleMediaState {
  voiceCallState?: string;
  incomingCall?: unknown | null;
  voiceRoomState?: string;
  isScreenSharing?: boolean;
  isStartingScreenShare?: boolean;
  voiceRoomScreenSharing?: boolean;
  nativeCaptureStatus?: { active?: boolean } | null;
}

export interface ActiveMediaSessionSummary {
  hasActiveSession: boolean;
  inVoiceCall: boolean;
  hasIncomingCall: boolean;
  inVoiceRoom: boolean;
  isScreenSharing: boolean;
  title: string;
  description: string;
}

/**
 * Inspects store state and returns whether an active call, voice room, or screen share requires close confirmation.
 */
export function getActiveMediaSessionSummary(
  state: WindowLifecycleMediaState
): ActiveMediaSessionSummary {
  const inVoiceCall = Boolean(state.voiceCallState && state.voiceCallState !== 'idle');
  const hasIncomingCall = state.incomingCall != null;
  const inVoiceRoom = Boolean(state.voiceRoomState && state.voiceRoomState !== 'idle');
  const isScreenSharing = Boolean(
    state.isScreenSharing ||
      state.isStartingScreenShare ||
      state.voiceRoomScreenSharing ||
      state.nativeCaptureStatus?.active
  );
  const hasActiveSession = inVoiceCall || hasIncomingCall || inVoiceRoom || isScreenSharing;

  let title = 'Fechar o NEXUS?';
  let description = 'Deseja realmente fechar o aplicativo?';

  if ((inVoiceCall || hasIncomingCall) && isScreenSharing) {
    title = 'Chamada e transmissão ativas';
    description =
      'Você está em uma chamada compartilhando sua tela. Deseja encerrar a transmissão, sair da chamada e fechar o NEXUS?';
  } else if (inVoiceRoom && isScreenSharing) {
    title = 'Sala de voz e transmissão ativas';
    description =
      'Você está conectado a uma sala de voz compartilhando sua tela. Deseja encerrar a transmissão, sair da sala e fechar o NEXUS?';
  } else if (isScreenSharing) {
    title = 'Transmissão de tela ativa';
    description =
      'Você está compartilhando sua tela no momento. Deseja encerrar a transmissão e fechar o NEXUS?';
  } else if (inVoiceCall) {
    title = 'Chamada de voz ativa';
    description =
      'Você está em uma chamada no momento. Deseja encerrar a chamada e fechar o NEXUS?';
  } else if (hasIncomingCall) {
    title = 'Chamada recebida pendente';
    description =
      'Há uma chamada recebida tocando no momento. Deseja recusar a chamada e fechar o NEXUS?';
  } else if (inVoiceRoom) {
    title = 'Conectado à sala de voz';
    description =
      'Você está conectado a uma sala de voz no momento. Deseja sair da sala e fechar o NEXUS?';
  }

  return {
    hasActiveSession,
    inVoiceCall,
    hasIncomingCall,
    inVoiceRoom,
    isScreenSharing,
    title,
    description,
  };
}

export interface WindowLifecycleCleanupDeps {
  getState?: () => WindowLifecycleMediaState & {
    activeCallId?: string | null;
    activeVoiceCommunityId?: string | null;
    activeVoiceChannelId?: string | null;
  };
  stopCapture?: () => void;
  stopNativeShare?: () => Promise<unknown>;
  terminateCall?: () => void;
  sendRoomLeave?: (communityId: string, channelId: string) => void;
  leaveMeshRoom?: () => Promise<unknown>;
  flushSettings?: () => Promise<unknown>;
  hasActiveDiagnostics?: () => boolean;
  closeDiagnostics?: () => Promise<unknown>;
  disconnectGateway?: () => void;
}

/**
 * Releases active media sessions, flushes pending settings/diagnostics, and disconnects gateway within a bounded timeout.
 */
export async function cleanupBeforeWindowClose(
  options?: { timeoutMs?: number; deps?: WindowLifecycleCleanupDeps }
): Promise<void> {
  const timeoutMs =
    typeof options?.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : 2500;
  const deps = options?.deps;

  let timer: ReturnType<typeof setTimeout> | undefined;

  const performCleanup = async (): Promise<void> => {
    const state = deps?.getState ? deps.getState() : useAppStore.getState();

    try {
      (deps?.stopCapture ?? (() => screenCaptureService.stopCapture()))();
    } catch {
      // Ignore capture stop failures during shutdown
    }

    if (state.nativeCaptureStatus?.active) {
      try {
        await (deps?.stopNativeShare ?? (() => screenCaptureService.stopNativeShare()))();
      } catch {
        // Ignore native share stop failures during shutdown
      }
    }

    if (
      (state.voiceCallState && state.voiceCallState !== 'idle') ||
      state.incomingCall != null ||
      state.activeCallId != null
    ) {
      try {
        (deps?.terminateCall ?? (() => callService.terminateOnLogout()))();
      } catch {
        // Ignore call termination errors during shutdown
      }
    }

    if (state.voiceRoomState && state.voiceRoomState !== 'idle') {
      try {
        if (state.activeVoiceCommunityId && state.activeVoiceChannelId) {
          (deps?.sendRoomLeave ??
            ((communityId: string, channelId: string) =>
              gatewayClient.sendRoomLeave(communityId, channelId)))(
            state.activeVoiceCommunityId,
            state.activeVoiceChannelId
          );
        }
      } catch {
        // Ignore gateway room-leave failure during shutdown
      }

      try {
        await (deps?.leaveMeshRoom ?? (() => meshRoomService.leaveRoom()))();
      } catch {
        // Ignore mesh teardown errors during shutdown
      }
    }

    const flushTasks: Promise<unknown>[] = [
      Promise.resolve((deps?.flushSettings ?? (() => settingsRepository.flushSave()))()).catch(
        () => {}
      ),
    ];

    const diagnosticsActive = deps?.hasActiveDiagnostics
      ? deps.hasActiveDiagnostics()
      : Object.values(diagnosticsService.permissions).some(Boolean);
    if (diagnosticsActive) {
      flushTasks.push(
        Promise.resolve((deps?.closeDiagnostics ?? (() => diagnosticsService.close()))()).catch(
          () => {}
        )
      );
    }

    await Promise.allSettled(flushTasks);

    try {
      (deps?.disconnectGateway ?? (() => gatewayClient.disconnect()))();
    } catch {
      // Ignore gateway disconnect failure during shutdown
    }
  };

  try {
    await Promise.race([
      performCleanup(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Destroys the current Tauri window, falling back to close() or failing silently outside Tauri.
 */
export async function destroyMainWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    try {
      await win.destroy();
    } catch {
      await win.close();
    }
  } catch {
    // Non-Tauri environment or window unavailable
  }
}
