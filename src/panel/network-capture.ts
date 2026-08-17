// Captures Google Ad Manager HTTP requests via the DevTools HAR API.
// Only runs in the DevTools panel (chrome.devtools.network). Observe-only.

import { summarizeGamRequest, isGamAdRequest } from '../shared/gam-network';
import type { Envelope } from '../shared/types';
import { store } from './store';

let networkSeq = 2_000_000_000;
let started = false;

export function startNetworkCapture(): void {
  if (started) return;
  const net = typeof chrome !== 'undefined' ? chrome.devtools?.network : undefined;
  if (!net?.onRequestFinished) return;
  started = true;

  net.onRequestFinished.addListener((har: chrome.devtools.network.Request) => {
    try {
      const url = har.request?.url;
      if (!url || !isGamAdRequest(url)) return;
      ingestHar(har, url, true);
    } catch {
      /* never break the panel */
    }
  });

  try {
    net.getHAR((log) => {
      if (!log?.entries) return;
      for (const entry of log.entries) {
        const url = entry.request?.url;
        if (!url || !isGamAdRequest(url)) continue;
        ingestHar(entry as chrome.devtools.network.Request, url, false);
      }
    });
  } catch {
    /* getHAR not available */
  }
}

function ingestHar(har: chrome.devtools.network.Request, url: string, tryBody: boolean): void {
  const env = harToEnvelope(har, url);
  const req = har as chrome.devtools.network.Request & {
    getContent?: (cb: (content: string, encoding: string) => void) => void;
  };
  if (tryBody && typeof req.getContent === 'function') {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      store.ingestNetwork(env);
    };
    const timer = setTimeout(finish, 1500);
    req.getContent((content, encoding) => {
      clearTimeout(timer);
      attachBodyPreview(env, content, encoding, har.response?.content?.mimeType);
      finish();
    });
    return;
  }
  store.ingestNetwork(env);
}

function harToEnvelope(har: chrome.devtools.network.Request, url: string): Envelope {
  const parsed = summarizeGamRequest(url);
  const startedDate = Date.parse(har.startedDateTime);
  const status = har.response?.status;
  const payload = {
    method: har.request?.method,
    url,
    status,
    statusText: har.response?.statusText,
    mimeType: har.response?.content?.mimeType,
    bodySize: har.response?.bodySize,
    timeMs: har.time,
    timings: har.timings
      ? {
          blocked: har.timings.blocked,
          dns: har.timings.dns,
          connect: har.timings.connect,
          send: har.timings.send,
          wait: har.timings.wait,
          receive: har.timings.receive,
        }
      : undefined,
    host: parsed.host,
    path: parsed.path,
    iuPaths: parsed.iuPaths,
    sizes: parsed.sizes,
    correlator: parsed.correlator,
    query: parsed.query,
    custParams: parsed.custParams,
    slotParams: parsed.slotParams,
    prev_scp: parsed.query.prev_scp,
    scp: parsed.query.scp,
    hbKeys: parsed.hbKeys,
    requestHeaders: pickHeaders(har.request?.headers, ['content-type', 'accept']),
    responseHeaders: pickHeaders(har.response?.headers, [
      'content-type',
      'content-length',
      'x-afma-request-id',
      'google-lineitem-id',
      'google-creative-id',
    ]),
    failed: !status || status >= 400,
  };

  return {
    source: 'bidshitter',
    seq: networkSeq++,
    ts: Number.isFinite(startedDate) ? startedDate : Date.now(),
    perf: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    kind: 'event',
    channel: 'network',
    name: 'gamRequest',
    slotElementId: parsed.iuPaths.length === 1 ? undefined : undefined,
    adUnitCode: parsed.iuPaths.length === 1 ? parsed.iuPaths[0] : undefined,
    payload,
  };
}

function attachBodyPreview(env: Envelope, content: string, encoding: string, mime?: string): void {
  if (!content || encoding === 'base64') return;
  const p = env.payload as Record<string, unknown>;
  p.bodyChars = content.length;
  const mimeL = (mime || '').toLowerCase();
  if (mimeL.includes('html') || mimeL.includes('javascript')) {
    p.bodyKind = mimeL.includes('html') ? 'html-creative' : 'javascript';
    // Do not persist creative HTML/JS. Keep a diagnostic sniff only.
    p.bodySniff = content.slice(0, 600).replace(/\s+/g, ' ');
    return;
  }
  if (mimeL.includes('json') || content.trim().startsWith('{') || content.trim().startsWith('[')) {
    p.bodyKind = 'json';
    p.bodyPreview = content.length > 2000 ? content.slice(0, 2000) + '…' : content;
    return;
  }
  p.bodyKind = mime || 'text';
  p.bodyPreview = content.slice(0, 400);
}

function pickHeaders(
  headers: Array<{ name: string; value: string }> | undefined,
  allow: string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const allowL = new Set(allow.map((n) => n.toLowerCase()));
  for (const h of headers) {
    const n = h.name.toLowerCase();
    if (allowL.has(n) || n.startsWith('google-') || n.startsWith('x-afma')) {
      out[h.name] = h.value;
    }
  }
  return out;
}
