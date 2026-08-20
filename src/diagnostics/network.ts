import type { Envelope, SessionState, SlotRecord } from '../shared/types';
import { isGamAdRequest, isPrebidOrGptScript, originPath, requestMatchesSlot } from '../shared/gam-network';
import {
  NET_MATCH_MS,
  arr,
  bidOf,
  bidderOf,
  evidenceFrom,
  issue,
  named,
  num,
  payload,
  rec,
  slotIdForCode,
  str,
} from './helpers';
import type { DiagnosticIssue, Severity } from './types';

type RuleMeta = {
  ruleId: string;
  title: string;
  severity: Severity;
  scope: 'network';
  signal: string;
  explanation: string;
  checks: string[];
  recommendations: string[];
};

type NetKind = 'script' | 'bidder' | 'gam' | 'creative';

const RULES: Record<string, RuleMeta> = {
  'COMMON-NET-01': {
    ruleId: 'COMMON-NET-01',
    title: 'Request blocked by ad blocker or browser policy',
    severity: 'high',
    scope: 'network',
    signal:
      'A Prebid/GPT script, bidder request, GAM request, or creative is blocked in DevTools, or Prebid emits browserIntervention.',
    explanation:
      'Ad-blocking extension, browser privacy protection, a URL matching a block list, or a Chrome intervention (for example heavy-ad unload). browserIntervention is not the same as an ad blocker.',
    checks: ['DevTools blocked reason / loadingFailed; Prebid browserIntervention for rendered creatives.'],
    recommendations: ['Report environmental blocking; do not attempt to evade user-selected privacy tools.'],
  },
  'COMMON-NET-02': {
    ruleId: 'COMMON-NET-02',
    title: 'Bidder or GAM request returns an error or stalls',
    severity: 'high',
    scope: 'network',
    signal: 'A bidder or GAMPAD request is pending too long, canceled, or returns a failing HTTP status, and the expected lifecycle does not continue.',
    explanation: 'Endpoint/backend failure, invalid request, rate limiting, navigation, or connection problem.',
    checks: ['Request status, duration, cancellation, plus bidderError for bidders and slotResponseReceived for GAM.'],
    recommendations: [
      'Fix or escalate the observed request/endpoint failure; avoid guessing a low-level cause without evidence.',
    ],
  },
};

function emit(
  id: keyof typeof RULES,
  extra: {
    evidence: DiagnosticIssue['evidence'];
    confidence?: DiagnosticIssue['confidence'];
    slotId?: string;
    adUnitCode?: string;
    auctionId?: string;
  }
): DiagnosticIssue {
  const meta = RULES[id];
  return issue({
    ...meta,
    confidence: extra.confidence || 'confirmed',
    slotId: extra.slotId,
    adUnitCode: extra.adUnitCode,
    auctionId: extra.auctionId,
    evidence: extra.evidence,
  });
}

function networkEnvs(session: SessionState): Envelope[] {
  return session.envelopes.filter((e) => e.channel === 'network' && (e.name === 'gamRequest' || e.name === 'netRequest'));
}

function harUrl(env: Envelope): string {
  return str(payload(env).url) || '';
}

function harStatus(env: Envelope): number | undefined {
  return num(payload(env).status);
}

function harError(env: Envelope): string | undefined {
  return str(payload(env).error) || str(payload(env).blockedReason) || str(payload(env).statusText);
}

function resourceType(env: Envelope): string {
  return (str(payload(env).resourceType) || '').toLowerCase();
}

function requestIdOfHar(env: Envelope): string | undefined {
  return str(payload(env).requestId);
}

function isPolicyBlock(env: Envelope): boolean {
  const reason = (str(payload(env).blockedReason) || '').toLowerCase();
  if (reason) {
    if (reason === 'other') return false;
    return true;
  }
  const error = (str(payload(env).error) || str(payload(env).statusText) || '').toLowerCase();
  return /blocked_by_client|blocked_by_response|blocked_by_orb|err_blocked|subresource.filter|csp|mixed.access|mixed.content/.test(
    error
  );
}

function isCanceled(env: Envelope): boolean {
  const error = (str(payload(env).error) || str(payload(env).statusText) || '').toLowerCase();
  return /err_aborted|err_canceled|cancelled|canceled/.test(error);
}

function isHttpFail(env: Envelope): boolean {
  const status = harStatus(env);
  if (status === 200 || status === 204) return false;
  if (status != null && status >= 400) return true;
  return false;
}

function isTransportFail(env: Envelope): boolean {
  if (isPolicyBlock(env)) return false;
  if (isHttpFail(env) || isCanceled(env)) return true;
  const status = harStatus(env);
  if (status === 200 || status === 204) return false;
  const error = (str(payload(env).error) || '').toLowerCase();
  if (error && /err_|timeout|reset|refused|failed|internet|name_not_resolved|connection/.test(error)) return true;
  if (payload(env).failed === true && (status == null || status === 0)) return true;
  return false;
}

function classify(session: SessionState, env: Envelope): NetKind {
  const url = harUrl(env);
  if (env.name === 'gamRequest' || isGamAdRequest(url)) return 'gam';
  if (isPrebidOrGptScript(url) || resourceType(env) === 'script') return 'script';
  const type = resourceType(env);
  if (type === 'image' || type === 'media' || type === 'sub_frame') return 'creative';
  if (matchesBidderHttp(session, url)) return 'bidder';
  if (type === 'xhr' || type === 'fetch') return 'bidder';
  const host = originPath(url).host.toLowerCase();
  if (host.includes('doubleclick') || host.includes('googlesyndication') || host.includes('googleadservices')) {
    return 'creative';
  }
  return 'bidder';
}

function beforeHttpCalls(session: SessionState): { env: Envelope; url: string; bidder?: string; auctionId?: string }[] {
  const out: { env: Envelope; url: string; bidder?: string; auctionId?: string }[] = [];
  for (const env of named(session, 'prebid', 'beforeBidderHttp')) {
    const { bidderRequest, request } = beforeHttpParts(env);
    const url = str(request.url) || str(payload(env).url) || '';
    out.push({
      env,
      url,
      bidder: bidderOf(bidderRequest) || str(bidderRequest.bidderCode),
      auctionId: env.auctionId || str(bidderRequest.auctionId),
    });
  }
  for (const env of named(session, 'prebid', 'beforePBSHttp')) {
    const url = str(payload(env).endpointUrl) || str(payload(env).url) || '';
    out.push({
      env,
      url,
      bidder: 'prebidServer',
      auctionId: env.auctionId || str(payload(env).auctionId),
    });
  }
  return out;
}

function beforeHttpParts(env: Envelope): { bidderRequest: Record<string, unknown>; request: Record<string, unknown> } {
  if (Array.isArray(env.payload)) {
    return { bidderRequest: rec(env.payload[0]), request: rec(env.payload[1]) };
  }
  const p = payload(env);
  if (p.bidderRequest) return { bidderRequest: rec(p.bidderRequest), request: rec(p.requestObject || p.request) };
  return { bidderRequest: p, request: rec(p.requestObject) };
}

function matchesBidderHttp(session: SessionState, url: string): boolean {
  if (!url) return false;
  const host = originPath(url).host.toLowerCase();
  if (!host) return false;
  return beforeHttpCalls(session).some((c) => c.url && originPath(c.url).host.toLowerCase() === host);
}

function slotForGam(session: SessionState, env: Envelope): SlotRecord | undefined {
  const iu = arr(payload(env).iuPaths)
    .map((p) => str(p))
    .filter((p): p is string => !!p);
  for (const slot of session.slots.values()) {
    if (requestMatchesSlot(iu, slot.adUnitPath)) return slot;
  }
  const path = env.adUnitCode;
  if (path) {
    const id = slotIdForCode(session, path);
    if (id) return session.slots.get(id);
  }
  return undefined;
}

function safeUrl(env: Envelope): string {
  const url = harUrl(env);
  return originPath(url).originPath || url;
}

function kindLabel(kind: NetKind): string {
  if (kind === 'gam') return 'GAM';
  if (kind === 'script') return 'script';
  if (kind === 'creative') return 'creative';
  return 'bidder';
}

function net01(session: SessionState, out: DiagnosticIssue[], seen: Set<string>): void {
  for (const env of networkEnvs(session)) {
    if (!isPolicyBlock(env)) continue;
    const kind = classify(session, env);
    const loc = safeUrl(env);
    const key = ['COMMON-NET-01', requestIdOfHar(env) || loc, String(env.ts)].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const slot = kind === 'gam' ? slotForGam(session, env) : undefined;
    const reason = str(payload(env).blockedReason) || str(payload(env).error) || 'blocked';
    out.push(
      emit('COMMON-NET-01', {
        slotId: slot?.slotElementId,
        adUnitCode: slot?.slotElementId || env.adUnitCode,
        evidence: [
          evidenceFrom(
            env,
            `${kindLabel(kind)} request blocked (${reason}) ${loc}${requestIdOfHar(env) ? ` id=${requestIdOfHar(env)}` : ''}`
          ),
        ],
      })
    );
  }

  for (const env of named(session, 'prebid', 'browserIntervention')) {
    const data = payload(env);
    const bid = rec(data.bid);
    const nested = Object.keys(bid).length ? bid : rec(bidOf(env));
    const adId = str(data.adId) || str(nested.adId);
    const code = str(nested.adUnitCode) || env.adUnitCode;
    const intervention = data.intervention;
    const name =
      str(rec(intervention).name) ||
      str(rec(intervention).id) ||
      str(intervention) ||
      'browser intervention';
    const key = ['COMMON-NET-01', 'intervention', adId || code, String(env.seq)].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      emit('COMMON-NET-01', {
        slotId: code ? slotIdForCode(session, code) || code : undefined,
        adUnitCode: code,
        auctionId: env.auctionId || str(nested.auctionId),
        evidence: [
          evidenceFrom(
            env,
            `browserIntervention (${name}) adId=${adId || 'unknown'} — Chrome policy unload of a rendered creative, not an ad-blocker HAR row`
          ),
        ],
      })
    );
  }
}

function linkedBidder(session: SessionState, env: Envelope): { bidder?: string; auctionId?: string } {
  const url = harUrl(env);
  const host = originPath(url).host.toLowerCase();
  const hit = beforeHttpCalls(session).find((c) => {
    if (!c.url) return false;
    if (Math.abs(c.env.ts - env.ts) > NET_MATCH_MS) return false;
    return originPath(c.url).host.toLowerCase() === host;
  });
  return { bidder: hit?.bidder, auctionId: hit?.auctionId };
}

function net02(session: SessionState, out: DiagnosticIssue[], seen: Set<string>): void {
  for (const env of networkEnvs(session)) {
    if (!isTransportFail(env)) continue;
    const kind = classify(session, env);
    if (kind === 'script' || kind === 'creative') continue;
    if (kind === 'bidder') {
      const linked = linkedBidder(session, env);
      const covered = named(session, 'prebid', 'bidderError').some((e) => {
        if (Math.abs(e.ts - env.ts) > NET_MATCH_MS) return false;
        const br = rec(payload(e).bidderRequest);
        const bidder = bidderOf(br) || str(br.bidderCode);
        if (rec(payload(e).error).timedOut === true) return false;
        return !linked.bidder || bidder === linked.bidder;
      });
      if (covered) continue;
    }
    const loc = safeUrl(env);
    const key = ['COMMON-NET-02', requestIdOfHar(env) || loc, String(env.ts)].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const slot = kind === 'gam' ? slotForGam(session, env) : undefined;
    const linked = kind === 'bidder' ? linkedBidder(session, env) : {};
    const status = harStatus(env);
    const reason =
      (isCanceled(env) && 'canceled') ||
      (status != null && status >= 400 && `HTTP ${status}`) ||
      str(payload(env).error) ||
      'transport failure';
    out.push(
      emit('COMMON-NET-02', {
        slotId: slot?.slotElementId,
        adUnitCode: slot?.slotElementId || env.adUnitCode,
        auctionId: linked.auctionId,
        evidence: [
          evidenceFrom(
            env,
            `${kindLabel(kind)} ${reason} ${loc}${linked.bidder ? ` bidder=${linked.bidder}` : ''}${
              requestIdOfHar(env) ? ` id=${requestIdOfHar(env)}` : ''
            }`
          ),
        ],
      })
    );
  }

  for (const env of named(session, 'prebid', 'bidderError')) {
    const p = payload(env);
    const err = rec(p.error);
    if (err.timedOut === true) continue;
    const bidderRequest = rec(p.bidderRequest);
    const bidder = bidderOf(bidderRequest) || str(bidderRequest.bidderCode);
    const auctionId = env.auctionId || str(bidderRequest.auctionId);
    const bids = arr(bidderRequest.bids);
    const code = env.adUnitCode || str(rec(bids[0]).adUnitCode);
    const status = num(err.status);
    if (status === 200 || status === 204) continue;
    const msg = str(err.message) || str(err.statusText) || str(p.error) || 'bidder HTTP/adapter error';
    if (/blocked_by_client|err_blocked/i.test(msg)) {
      const key = ['COMMON-NET-01', 'bidderError', auctionId, bidder, String(env.seq)].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(
        emit('COMMON-NET-01', {
          slotId: code ? slotIdForCode(session, code) : undefined,
          adUnitCode: code,
          auctionId,
          evidence: [evidenceFrom(env, `bidderError${bidder ? ` ${bidder}` : ''} blocked: ${msg}`)],
        })
      );
      continue;
    }
    const key = ['COMMON-NET-02', 'bidderError', auctionId, bidder, String(env.seq)].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const harHit = networkEnvs(session).find((h) => {
      if (Math.abs(h.ts - env.ts) > NET_MATCH_MS) return false;
      return isTransportFail(h) && (!bidder || linkedBidder(session, h).bidder === bidder);
    });
    const evidence = [
      evidenceFrom(
        env,
        `bidderError${bidder ? ` ${bidder}` : ''}${status != null ? ` HTTP ${status}` : ''}: ${msg}`
      ),
    ];
    if (harHit) evidence.push(evidenceFrom(harHit, `Matching DevTools request ${safeUrl(harHit)}`));
    out.push(
      emit('COMMON-NET-02', {
        slotId: code ? slotIdForCode(session, code) : undefined,
        adUnitCode: code,
        auctionId,
        evidence,
      })
    );
  }
}

export function findNetworkIssues(session: SessionState): DiagnosticIssue[] {
  const out: DiagnosticIssue[] = [];
  const seen = new Set<string>();
  net01(session, out, seen);
  net02(session, out, seen);
  return out;
}
