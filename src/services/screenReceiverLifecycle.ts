// The SDP origin identifies one native PeerConnection across its renegotiations.
// Never log the SDP itself.
export function screenSessionId(sdp: string): string | null {
  return /^o=\S+ ([0-9]{1,64}) /m.exec(sdp)?.[1] ?? null;
}

export function detachScreenElements(stream: MediaStream | null): void {
  if (!stream) return;
  if (typeof document !== 'undefined') {
    for (const element of document.querySelectorAll('video')) {
      if (element.srcObject !== stream) continue;
      try { element.pause(); } catch {}
      element.srcObject = null;
      try { element.load(); } catch {}
    }
  }
}

export function releaseScreenStream(stream: MediaStream | null): void {
  if (!stream) return;
  detachScreenElements(stream);
  for (const track of stream.getTracks()) {
    track.onended = null;
    track.onmute = null;
    track.onunmute = null;
    try { if (track.readyState !== 'ended') track.stop(); } catch {}
    try { stream.removeTrack(track); } catch {}
  }
}

// Routing metadata contains only the SDP origin session number, never ICE credentials.
export function screenCandidateSessionId(candidate: RTCIceCandidateInit): string | null {
  const value = (candidate as RTCIceCandidateInit & { nexusScreenSessionId?: unknown }).nexusScreenSessionId;
  return typeof value === 'string' && /^[0-9]{1,64}$/.test(value) ? value : null;
}
export function tagScreenCandidate(candidate: RTCIceCandidateInit, id: string | null): RTCIceCandidateInit {
  return id ? { ...candidate, nexusScreenSessionId: id } as RTCIceCandidateInit : candidate;
}
export function screenAnswerSessionId(sdp: string): string | null {
  return /^a=x-nexus-screen-session:([0-9]{1,64})\r?$/m.exec(sdp)?.[1] ?? null;
}
export function tagScreenAnswer(sdp: string, id: string | null): string {
  return id ? sdp.trimEnd() + '\r\na=x-nexus-screen-session:' + id + '\r\n' : sdp;
}

export function screenCandidateInit(candidate: RTCIceCandidateInit): RTCIceCandidateInit {
  return { candidate: candidate.candidate, sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex, usernameFragment: candidate.usernameFragment };
}
