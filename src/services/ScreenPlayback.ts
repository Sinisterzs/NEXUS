export function updateScreenPlaybackAudio(element: HTMLVideoElement, muted: boolean, volume: number): void {
  element.muted = muted;
  element.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
}

// Only the screen player is affected; microphone/voice playback is independent.
export function bindScreenPlayback(
  element: HTMLVideoElement, stream: MediaStream,
  muted = false, volume = 1, onBlocked?: () => void
): () => void {
  let alive = true;
  element.srcObject = stream;
  updateScreenPlaybackAudio(element, muted, volume);
  const play = () => {
    void element.play().catch(() => {
      if (alive) { console.warn('[ScreenPlayback] play_blocked'); onBlocked?.(); }
    });
  };
  // Audio can arrive after video on the same mutable MediaStream.
  stream.addEventListener('addtrack', play);
  play();
  return () => {
    alive = false;
    stream.removeEventListener('addtrack', play);
    if (element.srcObject === stream) {
      element.pause(); element.srcObject = null;
    }
  };
}
