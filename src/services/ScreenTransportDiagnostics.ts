// Values from SDP/certificates stay in memory. Only booleans and fixed enums leave this helper.
export function summarizeScreenNegotiation(pc: RTCPeerConnection, stats: Map<string, any>, transport: any) {
  const local = pc.localDescription?.sdp ?? '';
  const remote = pc.remoteDescription?.sdp ?? '';
  const setup = (sdp: string): string | null => {
    const values = [...sdp.matchAll(/^a=setup:([^\r\n]+)$/gm)].map(m => m[1].trim().toLowerCase());
    return values.length && values.every(v => v === values[0]) && ['active','passive','actpass'].includes(values[0]) ? values[0] : null;
  };
  const fingerprint = (sdp: string) => /^a=fingerprint:([^\r\n]+)/m.exec(sdp)?.[1].trim().toLowerCase().replaceAll(':','') ?? null;
  const matches = (sdp: string, id: unknown): boolean | null => {
    const cert = typeof id === 'string' ? stats.get(id) : undefined;
    const value = fingerprint(sdp);
    return value && typeof cert?.fingerprint === 'string' && typeof cert?.fingerprintAlgorithm === 'string'
      ? value === (cert.fingerprintAlgorithm + ' ' + cert.fingerprint).toLowerCase().replaceAll(':','') : null;
  };
  const credentials = (sdp: string) => /^a=ice-ufrag:[^\s]+/m.test(sdp) && /^a=ice-pwd:[^\s]+/m.test(sdp);
  const l = setup(local), r = setup(remote);
  const compatible = !l || !r ? null : (l === 'active' && r === 'passive') || (l === 'passive' && r === 'active') ||
    (pc.localDescription?.type === 'offer' && l === 'actpass' && ['active','passive'].includes(r)) ||
    (pc.remoteDescription?.type === 'offer' && r === 'actpass' && ['active','passive'].includes(l));
  return { localSetup: l, remoteSetup: r, setupCompatible: compatible,
    localSdpPresent: Boolean(local), remoteSdpPresent: Boolean(remote),
    localIceCredentialsPresent: local ? credentials(local) : null,
    remoteIceCredentialsPresent: remote ? credentials(remote) : null,
    localFingerprintPresent: local ? Boolean(fingerprint(local)) : null,
    remoteFingerprintPresent: remote ? Boolean(fingerprint(remote)) : null,
    localFingerprintMatchesCertificate: matches(local, transport?.localCertificateId),
    remoteFingerprintMatchesCertificate: matches(remote, transport?.remoteCertificateId) };
}
