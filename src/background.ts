// BidShitter service worker.
//
// Chrome MV3 workers are killed after ~30s idle even with an open DevTools
// port. In-memory Maps would vanish and a reconnect would hydrate the panel
// with an empty buffer (wiping the UI). Persist each tab's ring buffer in
// chrome.storage.session (RAM-only; cleared when Chrome closes or the tab is
// gone) and restore it before hydrating.

import { BUFFER_CAP, MESSAGE_SOURCE } from './shared/constants';
import type { BackgroundMessage, Envelope, PanelToBackground, RelayMessage } from './shared/types';

interface TabBuffer {
  envelopes: Envelope[];
  dropped: number;
}

const buffers = new Map<number, TabBuffer>();
const panelPorts = new Map<number, chrome.runtime.Port>();
const tabLocks = new Map<number, Promise<void>>();
const persistTimers = new Map<number, ReturnType<typeof setTimeout>>();

function storageKey(tabId: number): string {
  return `bidshitter:tab:${tabId}`;
}

function withTab(tabId: number, fn: (buf: TabBuffer) => void): Promise<void> {
  const prev = tabLocks.get(tabId) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      const buf = await loadBuffer(tabId);
      fn(buf);
    });
  tabLocks.set(tabId, next.then(() => undefined, () => undefined));
  return next;
}

async function loadBuffer(tabId: number): Promise<TabBuffer> {
  const existing = buffers.get(tabId);
  if (existing) return existing;

  let restored: TabBuffer = { envelopes: [], dropped: 0 };
  try {
    const key = storageKey(tabId);
    const stored = await chrome.storage.session.get(key);
    const raw = stored[key] as TabBuffer | undefined;
    if (raw && Array.isArray(raw.envelopes)) {
      restored = { envelopes: raw.envelopes, dropped: raw.dropped || 0 };
    }
  } catch {
    /* session storage unavailable — keep empty */
  }

  buffers.set(tabId, restored);
  return restored;
}

function schedulePersist(tabId: number, immediate = false): void {
  const flush = () => {
    persistTimers.delete(tabId);
    const buf = buffers.get(tabId);
    if (!buf) {
      void chrome.storage.session.remove(storageKey(tabId));
      return;
    }
    void chrome.storage.session.set({ [storageKey(tabId)]: buf }).catch(() => undefined);
  };
  const prev = persistTimers.get(tabId);
  if (prev) clearTimeout(prev);
  if (immediate) {
    flush();
    return;
  }
  persistTimers.set(tabId, setTimeout(flush, 250));
}

function pushInto(tabId: number, buf: TabBuffer, envelopes: Envelope[]): void {
  let navigated = false;
  for (const env of envelopes) {
    if (env.kind === 'status' && env.channel === 'hook' && env.name === 'hook-ready') {
      buf.envelopes = [];
      buf.dropped = 0;
      navigated = true;
      const port = panelPorts.get(tabId);
      if (port) safePost(port, { type: 'reset', reason: 'navigation' });
    }
    buf.envelopes.push(env);
  }

  if (buf.envelopes.length > BUFFER_CAP) {
    const overflow = buf.envelopes.length - BUFFER_CAP;
    buf.envelopes.splice(0, overflow);
    buf.dropped += overflow;
  }

  schedulePersist(tabId, navigated);

  const port = panelPorts.get(tabId);
  if (port) {
    safePost(port, { type: 'events', envelopes });
    if (buf.dropped) safePost(port, { type: 'dropped', dropped: buf.dropped });
  }
}

function safePost(port: chrome.runtime.Port, msg: BackgroundMessage): void {
  try {
    port.postMessage(msg);
  } catch {
    /* port closed */
  }
}

chrome.runtime.onMessage.addListener((message: RelayMessage, sender) => {
  if (!message || message.source !== MESSAGE_SOURCE || message.dir !== 'relay') return;
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') return;
  if (!Array.isArray(message.batch)) return;
  void withTab(tabId, (buf) => pushInto(tabId, buf, message.batch));
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'bidshitter-panel') return;

  let boundTabId: number | undefined;

  port.onMessage.addListener((msg: PanelToBackground) => {
    if (msg && msg.type === 'ping') return;
    if (msg && msg.type === 'init' && typeof msg.tabId === 'number') {
      boundTabId = msg.tabId;
      panelPorts.set(boundTabId, port);
      void withTab(boundTabId, (buf) => {
        safePost(port, {
          type: 'hydrate',
          tabId: boundTabId!,
          envelopes: buf.envelopes.slice(),
          dropped: buf.dropped,
        });
      });
    }
  });

  port.onDisconnect.addListener(() => {
    if (boundTabId !== undefined && panelPorts.get(boundTabId) === port) {
      panelPorts.delete(boundTabId);
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  buffers.delete(tabId);
  panelPorts.delete(tabId);
  tabLocks.delete(tabId);
  const timer = persistTimers.get(tabId);
  if (timer) clearTimeout(timer);
  persistTimers.delete(tabId);
  void chrome.storage.session.remove(storageKey(tabId));
});
