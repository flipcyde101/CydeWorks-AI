// Which adapter this page runs on. Set once at startup by app.js and read by views for labels only.
// 'demo': the synthetic in-page workspace. 'http': the local workspace service over its existing API.
// Nothing here grants or changes permission; the host's own checks stay authoritative.

export const mode = {adapter: 'demo', get synthetic() { return this.adapter !== 'http'; }};

export function readAdapterMode(doc = globalThis.document) {
  const value = doc?.querySelector?.('meta[name="cydeworks-adapter"]')?.getAttribute('content');
  return value === 'http' ? 'http' : 'demo';
}
