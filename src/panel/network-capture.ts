// Captures ad-stack HTTP via the DevTools HAR API. Observe-only.
// GAM ad requests stay named `gamRequest` (GPT/INT rules depend on that).
// Blocked/failed script, bidder, and creative requests are `netRequest`.

import { isGamAdRequest, isPrebidOrGptScript, originPath, summarizeGamRequest } from '../shared/gam-network';
import type { Envelope } from '../shared/types';
import { store } from './store';

type ChromeHar = chrome.devtools.network.Request & {
  _error?: string;
  _resourceType?: string;
  _type?: string;
  _blocked_reason?: string;
  blockedReason?: string;
  _requestId?: string;
  requestId?: string;
  response?: chrome.devtools.network.Request['response'] & { _error?: string; _blockedReason?: string };
};

const CAPTURE_TYPES = new Set(['script', 'xhr', 'fetch', 'image', 'media', 'sub_frame', 'document', 'other', '']);

let networkSeq = 2_000_000_000;
let started = false;

export function startNetworkCapture(): void {
  if (started) return;
  const net = typeof chrome !== 'undefined' ? chrome.devtools?.network : undefined;
  if (!net?.onRequestFinished) return;
  started = true;

  net.onRequestFinished.addListener((har: chrome.devtools.network.Request) => {
    try {
      ingest(har as ChromeHar, true);
    } catch {
      /* never break the panel */
    }
  });

  try {
    net.getHAR((log) => {
      if (!log?.entries) return;
      for (const entry of log.entries) {
        try {
          ingest(entry as ChromeHar, false);
        } catch {
          /* skip one bad HAR row */
        }
      }
    });
  } catch {
    /* getHAR not available */
  }
}

function ingest(har: ChromeHar, tryBody: boolean): void {
  const url = har.request?.url;
  if (!url) return;
  if (isGamAdRequest(url)) {
    ingestHar(har, url, tryBody);
    return;
  }
  if (!shouldCaptureFailure(har, url)) return;
  store.ingestNetwork(failureEnvelope(har, url));
}

function shouldCaptureFailure(har: ChromeHar, url: string): boolean {
  const extras = chromeExtras(har);
  const status = har.response?.status;
  const failed = !status || status >= 400 || !!extras.error || !!extras.blockedReason;
  if (!failed) return false;
  if (isPrebidOrGptScript(url)) return true;
  const type = (extras.resourceType || '').toLowerCase();
  if (!CAPTURE_TYPES.has(type)) return false;
  return type === 'script' || type === 'xhr' || type === 'fetch' || type === 'image' || type === 'media' || type === 'sub_frame';
}

function chromeExtras(har: ChromeHar): {
  error?: string;
  blockedReason?: string;
  resourceType?: string;
  requestId?: string;
} {
  const resp = har.response;
  const error = har._error || resp?._error;
  const blockedReason = har.blockedReason || har._blocked_reason || resp?._blockedReason;
  const resourceType = har._resourceType || har._type;
  const requestId = har._requestId || har.requestId;
  return {
    error: typeof error === 'string' && error ? error : undefined,
    blockedReason: typeof blockedReason === 'string' && blockedReason ? blockedReason : undefined,
    resourceType: typeof resourceType === 'string' && resourceType ? resourceType : undefined,
    requestId: typeof requestId === 'string' && requestId ? requestId : undefined,
  };
}

function ingestHar(har: ChromeHar, url: string, tryBody: boolean): void {
  const env = gamEnvelope(har, url);
  const req = har as ChromeHar & {
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

function commonHarFields(har: ChromeHar, url: string): Record<string, unknown> {
  const extras = chromeExtras(har);
  const status = har.response?.status;
  const startedDate = Date.parse(har.startedDateTime);
  return {
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
    error: extras.error,
    blockedReason: extras.blockedReason,
    resourceType: extras.resourceType,
    requestId: extras.requestId,
    failed: !status || status >= 400 || !!extras.error || !!extras.blockedReason,
    startedDateTime: Number.isFinite(startedDate) ? startedDate : undefined,
  };
}

function gamEnvelope(har: ChromeHar, url: string): Envelope {
  const parsed = summarizeGamRequest(url);
  const startedDate = Date.parse(har.startedDateTime);
  const common = commonHarFields(har, url);
  return {
    source: 'bidshitter',
    seq: networkSeq++,
    ts: Number.isFinite(startedDate) ? startedDate : Date.now(),
    perf: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    kind: 'event',
    channel: 'network',
    name: 'gamRequest',
    adUnitCode: parsed.iuPaths.length === 1 ? parsed.iuPaths[0] : undefined,
    payload: {
      ...common,
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
    },
  };
}

function failureEnvelope(har: ChromeHar, url: string): Envelope {
  const startedDate = Date.parse(har.startedDateTime);
  const loc = originPath(url);
  const common = commonHarFields(har, url);
  return {
    source: 'bidshitter',
    seq: networkSeq++,
    ts: Number.isFinite(startedDate) ? startedDate : Date.now(),
    perf: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    kind: 'event',
    channel: 'network',
    name: 'netRequest',
    payload: {
      ...common,
      url: loc.originPath,
      host: loc.host,
      path: loc.path,
    },
  };
}

function attachBodyPreview(env: Envelope, content: string, encoding: string, mime?: string): void {
  if (!content || encoding === 'base64') return;
  const p = env.payload as Record<string, unknown>;
  p.bodyChars = content.length;
  const mimeL = (mime || '').toLowerCase();
  if (mimeL.includes('html') || mimeL.includes('javascript')) {
    p.bodyKind = mimeL.includes('html') ? 'html-creative' : 'javascript';
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
