// Browser wiring for the demo backend: real SHA-256 from Web Crypto, a one second simulation
// timer, and nothing else. Swap this module for an HTTP adapter at integration.

import {createDemoBackend} from './backend.js';
import {assertAdapter} from '../adapters/contract.js';

async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function createDemoAdapter({profile = 'returning'} = {}) {
  const backend = await createDemoBackend({sha256, profile});
  const timer = setInterval(() => { void backend.demo.tick(); }, 500);
  return {adapter: assertAdapter(backend), demo: backend.demo, dispose: () => clearInterval(timer), synthetic: true};
}
