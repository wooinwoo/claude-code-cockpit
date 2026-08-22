/**
 * Praetorium intentionally has no remote-access mode. Keep the network
 * boundary in this small module so every HTTP path shares the same policy.
 */
export const LOCAL_BIND_ADDRESS = '127.0.0.1';

/**
 * The bind address is deliberately not configurable. The argument exists only
 * so callers can report that an obsolete/non-local bind request was ignored.
 */
export function resolveBindAddress(_requestedAddress) {
  return LOCAL_BIND_ADDRESS;
}

export function isIgnoredBindRequest(requestedAddress) {
  const requested = String(requestedAddress || '').trim().toLowerCase();
  return Boolean(requested && requested !== LOCAL_BIND_ADDRESS);
}

/** Extract a hostname from an HTTP Host header, rejecting malformed variants. */
export function parseHostHeader(rawHost) {
  if (typeof rawHost !== 'string') return null;
  const value = rawHost.trim().toLowerCase();
  if (!value || value.includes(',') || value.includes('@')) return null;

  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close < 0) return null;
    const suffix = value.slice(close + 1);
    if (suffix && !/^:\d+$/.test(suffix)) return null;
    return value.slice(1, close);
  }

  // Accept the canonical unbracketed IPv6 loopback value when no port exists.
  if (value === '::1') return value;

  const colon = value.lastIndexOf(':');
  if (colon > 0) {
    const port = value.slice(colon + 1);
    if (!/^\d+$/.test(port)) return null;
    return value.slice(0, colon);
  }
  return value;
}

/** Allow only canonical loopback Host headers (DNS-rebinding defense). */
export function isLoopbackHost(rawHost) {
  const host = parseHostHeader(rawHost);
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** Match only canonical loopback peer addresses reported by Node sockets. */
export function isLoopbackAddress(remoteAddress) {
  const address = String(remoteAddress || '').toLowerCase();
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
