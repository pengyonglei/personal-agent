const LOCAL_RESOURCE_PROTOCOLS = new Set([
  'http:',
  'https:',
  'ws:',
  'wss:',
]);

/** Allow embedded validation pages to use local HTTP and WebSocket resources only. */
export function isAllowedLocalResource(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['about:', 'data:', 'blob:'].includes(url.protocol) ||
      (LOCAL_RESOURCE_PROTOCOLS.has(url.protocol) && isLoopback(url.hostname))
    );
  } catch {
    return false;
  }
}

/** Main-frame navigation remains limited to local HTTP pages. */
export function isAllowedLocalNavigation(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'about:' ||
      (['http:', 'https:'].includes(url.protocol) && isLoopback(url.hostname))
    );
  } catch {
    return false;
  }
}

function isLoopback(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
}
