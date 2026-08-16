// BidShitter isolated-world content script.
//
// Bridges the MAIN-world hook (window.postMessage) to the service worker
// (chrome.runtime). It validates the message source and forwards batches;
// it does not read page globals (it cannot see window.pbjs / window.googletag).

import type { Envelope, HookMessage, RelayMessage } from './shared/types';

window.addEventListener('message', (event: MessageEvent) => {
  // Only accept messages from this same window posted by our hook (spec 4).
  if (event.source !== window) return;
  const data = event.data as HookMessage | undefined;
  if (!data || data.source !== 'bidshitter' || data.dir !== 'to-devtools') return;
  if (!Array.isArray(data.batch) || data.batch.length === 0) return;

  const relay: RelayMessage = {
    source: 'bidshitter',
    dir: 'relay',
    batch: data.batch as Envelope[],
  };
  try {
    chrome.runtime.sendMessage(relay, () => {
      // Swallow "Receiving end does not exist" while the SW spins up.
      void chrome.runtime.lastError;
    });
  } catch {
    /* extension context invalidated (reloaded) — ignore */
  }
});
