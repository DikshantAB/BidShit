import type { Envelope, SessionState } from '../shared/types';
import {
  AUCTION_GRACE_MS,
  FLOOR_REJECTION,
  absenceConfidence,
  adUnitsFrom,
  apiArgs,
  apis,
  arr,
  auctionCodes,
  auctionTimeoutMs,
  bidOf,
  bidderOf,
  eligibleBids,
  evidenceFrom,
  issue,
  named,
  num,
  payload,
  payloadItems,
  rec,
  rejectionReason,
  requestBidsCodes,
  requestIdOf,
  slotIdForCode,
  str,
  waited,
} from './helpers';
import type { DiagnosticIssue, Severity } from './types';

type RuleMeta = {
  ruleId: string;
  title: string;
  severity: Severity;
  scope: 'prebid';
  signal: string;
  explanation: string;
  checks: string[];
  recommendations: string[];
};

const RULES: Record<string, RuleMeta> = {
  'COMMON-PB-01': {
    ruleId: 'COMMON-PB-01',
    title: 'Prebid does not load or become ready',
    severity: 'critical',
    scope: 'prebid',
    signal: 'pbjs.libLoaded is false.',
    explanation: 'Script failed/was blocked, the wrong global is observed, the queue was overwritten, or initialization threw.',
    checks: ['Inspect the Prebid script request, console, window._pbjsGlobals, pbjs.libLoaded, and pbjs.que/pbjs.cmd.'],
    recommendations: ['Fix the script/global/initialization failure and wait for the Prebid queue before calling its APIs.'],
  },
  'COMMON-PB-02': {
    ruleId: 'COMMON-PB-02',
    title: 'Auction is never started',
    severity: 'critical',
    scope: 'prebid',
    signal: 'Prebid is ready and ad units exist, but neither requestBids nor auctionInit occurs.',
    explanation: 'Publisher control flow skipped requestBids(), a component did not mount, or an earlier exception interrupted execution.',
    checks: ['Inspect Prebid event history, the wrapped requestBids call site, and console.'],
    recommendations: ['Correct the publisher flow so the intended auction starts once.'],
  },
  'COMMON-PB-03': {
    ruleId: 'COMMON-PB-03',
    title: 'Requested ad unit is missing or excluded',
    severity: 'critical',
    scope: 'prebid',
    signal: 'requestBids/auctionInit references an unknown code, or an expected slot code is absent from auctionInit.adUnitCodes.',
    explanation: 'Typo, stale/renamed slot code, per-call adUnitCodes filter, labels, or the unit was added after the request.',
    checks: ['Compare exact strings: pbjs.adUnits[].code vs requestBids options vs auctionInit.adUnitCodes.'],
    recommendations: ['Register the ad unit before the auction and include its canonical code in the request.'],
  },
  'COMMON-PB-04': {
    ruleId: 'COMMON-PB-04',
    title: 'Duplicate ad-unit code',
    severity: 'high',
    scope: 'prebid',
    signal: 'The same code is registered twice as an accidental copy (SPA remount / duplicate addAdUnits), not as an intentional twin-code split.',
    explanation:
      'SPA remount, duplicate component registration, or configuration appends stale definitions. Prebid officially allows twin codes when the definitions differ.',
    checks: ['Group live pbjs.adUnits and each auctionInit.adUnits array by exact code.'],
    recommendations: ['Keep one live definition per code unless twin codes are intentional.'],
  },
  'COMMON-PB-05': {
    ruleId: 'COMMON-PB-05',
    title: 'No usable bidder is configured',
    severity: 'high',
    scope: 'prebid',
    signal: 'Auction starts for the slot but emits no bidRequested for that ad unit.',
    explanation: 'Empty bids, missing adapter in the build, invalid bidder name, labels, unsupported media type, or consent filtering.',
    checks: ['Inspect the auction ad unit’s bids array and whether any bidRequested fired for that auctionId + ad unit.'],
    recommendations: ['Correct the publisher configuration/build; BidShitter must not add bidders.'],
  },
  'COMMON-PB-06': {
    ruleId: 'COMMON-PB-06',
    title: 'Banner sizes are missing or invalid',
    severity: 'high',
    scope: 'prebid',
    signal: 'A banner ad unit has no usable mediaTypes.banner.sizes (or format), so the auction cannot request valid banner dimensions.',
    explanation: 'Empty/malformed mediaTypes.banner.sizes, sizes left only on the deprecated top-level sizes, or non-numeric/non-positive pairs.',
    checks: ['Read mediaTypes.banner.sizes (or format) on the auction ad unit. Legacy top-level sizes is fallback only.'],
    recommendations: ['Declare valid sizes in mediaTypes.banner.sizes (or format).'],
  },
  'COMMON-PB-07': {
    ruleId: 'COMMON-PB-07',
    title: 'Bidder returns no bid',
    severity: 'info',
    scope: 'prebid',
    signal: 'noBid fires for a requested bidder/ad unit.',
    explanation: 'Bidder intentionally declined or had no eligible demand.',
    checks: ['Distinguish noBid from bidTimeout, bidderError, and bidRejected.'],
    recommendations: ['Treat as a normal bidder outcome unless commercial expectations require investigation.'],
  },
  'COMMON-PB-08': {
    ruleId: 'COMMON-PB-08',
    title: 'Bidder or auction times out',
    severity: 'info',
    scope: 'prebid',
    signal: 'bidTimeout and/or auctionTimeout fires.',
    explanation: 'Slow bidder/network, timeout too short, or other work consumed auction time.',
    checks: ['Use the events plus auctionInit.timeout (or bidderTimeout config).'],
    recommendations: ['Fix upstream latency or tune timeout using measured value-versus-delay trade-offs.'],
  },
  'COMMON-PB-09': {
    ruleId: 'COMMON-PB-09',
    title: 'Bid response is malformed or rejected',
    severity: 'high',
    scope: 'prebid',
    signal: 'bidRejected fires for a reason other than the price floor.',
    explanation: 'Invalid CPM/currency/request ID/size/media type/creative fields, disallowed bidder code, DSA, maxBid, or adapter/backend contract mismatch.',
    checks: ['Read bidRejected and its REJECTION_REASON.'],
    recommendations: ['Correct the bidder response or adapter mapping; do not retain raw creative or identity data.'],
  },
  'COMMON-PB-10': {
    ruleId: 'COMMON-PB-10',
    title: 'Bid is below the configured floor',
    severity: 'info',
    scope: 'prebid',
    signal: 'bidRejected reason is Bid does not meet price floor.',
    explanation: 'Effective bid CPM is below the resolved floor after currency and rule selection.',
    checks: ['Match that exact REJECTION_REASON. Attach CPM/currency/size from the payload when present.'],
    recommendations: ['Verify floor configuration; otherwise treat the rejection as intentional.'],
  },
  'COMMON-PB-11': {
    ruleId: 'COMMON-PB-11',
    title: 'Auction ends with no eligible bid',
    severity: 'info',
    scope: 'prebid',
    signal: 'auctionEnd occurs with no eligible/winning bid for the ad unit.',
    explanation: 'Every bidder returned no-bid, timed out, errored, was blocked, or was rejected.',
    checks: ['Reconcile requested bidders to a terminal outcome.'],
    recommendations: ['Show the individual causes instead of reporting only “no bids.”'],
  },
  'COMMON-PB-12': {
    ruleId: 'COMMON-PB-12',
    title: 'Auction never completes or continuation callback fails',
    severity: 'critical',
    scope: 'prebid',
    signal: 'auctionInit has no matching auctionEnd after the auction timeout, or the supplied bidsBackHandler throws.',
    explanation: 'Adapter/core exception, stuck completion accounting, invalid callback, or page teardown.',
    checks: ['Match auctionInit → auctionEnd by auctionId. Observe bidsBackHandler invocation/throw via a transparent wrap.'],
    recommendations: ['Fix the stuck lifecycle/callback and make continuation idempotent and bound to the correct auction.'],
  },
  'COMMON-PB-13': {
    ruleId: 'COMMON-PB-13',
    title: 'Prebid render cannot resolve or use the selected creative',
    severity: 'critical',
    scope: 'prebid',
    signal: 'adRenderFailed fires.',
    explanation: 'Unknown adId, missing markup, render on the main document, missing doc/adId, or a render exception.',
    checks: ['Read adRenderFailed.reason and whether adId resolves to a known bid.'],
    recommendations: ['Use the current selected bid and supported iframe/renderer path; correct the underlying creative error.'],
  },
  'COMMON-PB-14': {
    ruleId: 'COMMON-PB-14',
    title: 'Bid is rendered more than once (staleRender)',
    severity: 'critical',
    scope: 'prebid',
    signal: 'The staleRender event fires because a bid whose status is already rendered is being rendered again.',
    explanation:
      'Refresh reused an old adId, bid caching was mishandled, or duplicate render callbacks ran. Prebid emits staleRender before bidWon; the creative still renders unless auctionOptions.suppressStaleRender is true.',
    checks: ['Read the staleRender bid payload (adId, adUnitCode, auctionId, bidder, status). Compare with the earlier render/bidWon for that adId.'],
    recommendations: [
      'Use a fresh unused bid per render, make render callbacks idempotent, and consider pbjs.setConfig({ auctionOptions: { suppressStaleRender: true } }).',
    ],
  },
};

function emit(
  id: keyof typeof RULES,
  session: SessionState,
  extra: {
    evidence: DiagnosticIssue['evidence'];
    confidence?: DiagnosticIssue['confidence'];
    slotId?: string;
    adUnitCode?: string;
    auctionId?: string;
  }
): DiagnosticIssue {
  const meta = RULES[id];
  const slotId = extra.slotId || (extra.adUnitCode ? slotIdForCode(session, extra.adUnitCode) : undefined);
  return issue({
    ...meta,
    confidence: extra.confidence || 'confirmed',
    slotId,
    adUnitCode: extra.adUnitCode,
    auctionId: extra.auctionId,
    evidence: extra.evidence,
  });
}

function registryCodes(session: SessionState): Set<string> {
  const codes = new Set<string>();
  for (const code of session.adUnits.keys()) codes.add(code);
  for (const unit of arr(rec(session.snapshots.globals).adUnits)) {
    const code = str(rec(unit).code);
    if (code) codes.add(code);
  }
  for (const env of apis(session, 'prebid', 'addAdUnits')) {
    for (const unit of adUnitsFrom(env)) {
      const code = str(unit.code);
      if (code) codes.add(code);
    }
  }
  return codes;
}

function liveAdUnits(session: SessionState): Record<string, unknown>[] {
  let live = arr(rec(session.snapshots.globals).adUnits).map(rec);
  const ops = [...apis(session, 'prebid', 'addAdUnits'), ...apis(session, 'prebid', 'removeAdUnit')].sort(
    (a, b) => a.seq - b.seq
  );
  for (const env of ops) {
    if (env.name === 'addAdUnits') {
      live = live.concat(adUnitsFrom(env));
      continue;
    }
    const arg = apiArgs(env)[0];
    if (arg == null) {
      live = [];
      continue;
    }
    const remove = new Set((Array.isArray(arg) ? arg : [arg]).map((c) => str(c)).filter((c): c is string => !!c));
    live = live.filter((u) => !remove.has(str(u.code) || ''));
  }
  return live;
}

function unitFingerprint(unit: Record<string, unknown>): string {
  const bidders = arr(unit.bids)
    .map((b) => bidderOf(rec(b)))
    .filter(Boolean)
    .sort()
    .join(',');
  const media = Object.keys(rec(unit.mediaTypes)).sort().join(',');
  return `${bidders}|${media}`;
}

function bannerSizesOk(unit: Record<string, unknown>): { ok: boolean; reason?: string } {
  const media = rec(unit.mediaTypes);
  if (media.banner == null) return { ok: true };
  const banner = rec(media.banner);
  if (arr(banner.format).length) return { ok: true };
  const sizes = banner.sizes != null ? banner.sizes : unit.sizes;
  if (sizes == null) return { ok: false, reason: 'mediaTypes.banner.sizes is missing' };
  if (typeof sizes === 'string' && sizes.includes('…(+')) return { ok: true };
  const pairs = normalizeSizeList(sizes);
  if (!pairs) return { ok: false, reason: 'mediaTypes.banner.sizes is empty or malformed' };
  return { ok: true };
}

function normalizeSizeList(sizes: unknown): [number, number][] | undefined {
  if (!Array.isArray(sizes) || sizes.length === 0) return undefined;
  if (sizes.length >= 2 && typeof sizes[0] === 'number') {
    const w = num(sizes[0]);
    const h = num(sizes[1]);
    if (w != null && h != null && w > 0 && h > 0) return [[w, h]];
    return undefined;
  }
  const out: [number, number][] = [];
  for (const item of sizes) {
    if (!Array.isArray(item) || item.length < 2) return undefined;
    const w = num(item[0]);
    const h = num(item[1]);
    if (w == null || h == null || w <= 0 || h <= 0) return undefined;
    out.push([w, h]);
  }
  return out.length ? out : undefined;
}

function bidRequestedFor(session: SessionState, auctionId: string, code: string): Envelope[] {
  return named(session, 'prebid', 'bidRequested').filter((e) => {
    if (e.auctionId && e.auctionId !== auctionId) return false;
    if (e.adUnitCode === code) return true;
    const p = payload(e);
    return arr(p.bids).some((b) => str(rec(b).adUnitCode) === code);
  });
}

function strongerThanNoBid(session: SessionState, env: Envelope): boolean {
  const bid = bidOf(env);
  const reqId = requestIdOf(bid);
  const auctionId = env.auctionId || str(bid.auctionId);
  const code = env.adUnitCode || str(bid.adUnitCode);
  const bidder = bidderOf(bid);
  const stronger = [
    ...named(session, 'prebid', 'bidTimeout').flatMap((e) => payloadItems(e).map((item) => ({ env: e, item }))),
    ...named(session, 'prebid', 'bidderError').map((e) => ({ env: e, item: rec(rec(payload(e).bidderRequest)) })),
    ...named(session, 'prebid', 'bidRejected').map((e) => ({ env: e, item: bidOf(e) })),
  ];
  return stronger.some(({ env: other, item }) => {
    if (reqId && requestIdOf(item) === reqId) return true;
    return (
      (other.auctionId || str(item.auctionId)) === auctionId &&
      (other.adUnitCode || str(item.adUnitCode)) === code &&
      bidderOf(item) === bidder
    );
  });
}

function countForUnit(
  session: SessionState,
  name: string,
  auctionId: string,
  code: string
): number {
  let n = 0;
  for (const env of named(session, 'prebid', name)) {
    if (env.auctionId && env.auctionId !== auctionId) continue;
    const items = name === 'bidTimeout' ? payloadItems(env) : name === 'bidderError' ? [rec(payload(env).bidderRequest)] : [bidOf(env)];
    for (const item of items) {
      const itemCode = str(item.adUnitCode) || env.adUnitCode;
      const nested = arr(item.bids).some((b) => str(rec(b).adUnitCode) === code);
      if (!itemCode || itemCode === code || nested) n += 1;
    }
  }
  return n;
}

function pb01(session: SessionState, out: DiagnosticIssue[]): void {
  if (session.status.libLoaded) return;
  if (!session.status.hookReady) return;
  const hook = named(session, 'hook', 'hook-ready')[0];
  out.push(
    emit('COMMON-PB-01', session, {
      confidence: 'confirmed',
      evidence: [evidenceFrom(hook, 'pbjs.libLoaded is false')],
    })
  );
}

function auctionStarted(session: SessionState): boolean {
  return !!(
    apis(session, 'prebid', 'requestBids').length ||
    named(session, 'prebid', 'requestBids').length ||
    named(session, 'prebid', 'auctionInit').length
  );
}

function pb02(session: SessionState, out: DiagnosticIssue[]): void {
  if (!session.status.libLoaded) return;
  if (auctionStarted(session)) return;
  const codes = [...registryCodes(session)];
  if (!codes.length) return;
  const ready = named(session, 'prebid', 'libLoaded')[0];
  for (const code of codes) {
    out.push(
      emit('COMMON-PB-02', session, {
        adUnitCode: code,
        evidence: [evidenceFrom(ready, `Ad unit "${code}" is registered, but requestBids/auctionInit never occurred`)],
      })
    );
  }
}

function pb03(session: SessionState, out: DiagnosticIssue[]): void {
  const known = registryCodes(session);
  const requests = [...apis(session, 'prebid', 'requestBids'), ...named(session, 'prebid', 'auctionInit')];
  for (const env of requests) {
    const codes = env.kind === 'api' ? requestBidsCodes(env) : auctionCodes(env);
    for (const code of codes) {
      if (known.has(code)) continue;
      out.push(
        emit('COMMON-PB-03', session, {
          adUnitCode: code,
          auctionId: env.auctionId,
          evidence: [evidenceFrom(env, `${env.name} referenced unknown ad unit code "${code}"`)],
        })
      );
    }
  }
  if (!named(session, 'prebid', 'auctionInit').length) return;
  const auctionCodesAll = new Set<string>();
  for (const env of named(session, 'prebid', 'auctionInit')) {
    for (const code of auctionCodes(env)) auctionCodesAll.add(code);
  }
  for (const slot of session.slots.values()) {
    if (auctionCodesAll.has(slot.slotElementId) || (slot.adUnitPath && auctionCodesAll.has(slot.adUnitPath))) continue;
    const init = named(session, 'prebid', 'auctionInit')[0];
    out.push(
      emit('COMMON-PB-03', session, {
        confidence: 'likely',
        slotId: slot.slotElementId,
        adUnitCode: slot.slotElementId,
        auctionId: init?.auctionId,
        evidence: [evidenceFrom(init, `GPT slot "${slot.slotElementId}" is absent from auction adUnitCodes`)],
      })
    );
  }
}

function emitDuplicate(
  session: SessionState,
  env: Envelope | undefined,
  units: Record<string, unknown>[],
  out: DiagnosticIssue[]
): void {
  const byCode = new Map<string, Record<string, unknown>[]>();
  for (const unit of units) {
    const code = str(unit.code);
    if (!code) continue;
    const list = byCode.get(code) || [];
    list.push(unit);
    byCode.set(code, list);
  }
  for (const [code, list] of byCode) {
    if (list.length < 2) continue;
    const prints = new Set(list.map(unitFingerprint));
    if (prints.size > 1) continue;
    out.push(
      emit('COMMON-PB-04', session, {
        adUnitCode: code,
        auctionId: env?.auctionId,
        evidence: [
          evidenceFrom(
            env,
            `Duplicate identical definitions for "${code}" (same bidders/media types) — accidental copy, not twin codes`
          ),
        ],
      })
    );
  }
}

function pb04(session: SessionState, out: DiagnosticIssue[]): void {
  emitDuplicate(session, apis(session, 'prebid', 'addAdUnits')[0], liveAdUnits(session), out);
  for (const env of named(session, 'prebid', 'auctionInit')) {
    emitDuplicate(session, env, adUnitsFrom(env), out);
  }
}

function pb05(session: SessionState, out: DiagnosticIssue[]): void {
  for (const env of named(session, 'prebid', 'auctionInit')) {
    const auctionId = env.auctionId;
    if (!auctionId) continue;
    const units = adUnitsFrom(env);
    const codes = units.length ? units.map((u) => str(u.code)).filter((c): c is string => !!c) : auctionCodes(env);
    for (const code of codes) {
      if (bidRequestedFor(session, auctionId, code).length) continue;
      const unit = units.find((u) => str(u.code) === code) || rec(undefined);
      const bids = arr(unit.bids);
      const stored = rec(rec(unit.ortb2Imp).ext);
      const emptyConfig = bids.length === 0 && !stored.prebid;
      out.push(
        emit('COMMON-PB-05', session, {
          confidence: emptyConfig ? 'confirmed' : 'likely',
          auctionId,
          adUnitCode: code,
          evidence: [
            evidenceFrom(
              env,
              emptyConfig
                ? `Ad unit "${code}" has an empty bidder list and no stored impression.`
                : `No bidRequested for "${code}" in auction ${auctionId}.`
            ),
          ],
        })
      );
    }
  }
}

function pb06(session: SessionState, out: DiagnosticIssue[]): void {
  const inspect = [...apis(session, 'prebid', 'addAdUnits'), ...named(session, 'prebid', 'auctionInit')];
  for (const env of inspect) {
    for (const unit of adUnitsFrom(env)) {
      const result = bannerSizesOk(unit);
      if (result.ok) continue;
      const code = str(unit.code);
      out.push(
        emit('COMMON-PB-06', session, {
          adUnitCode: code,
          auctionId: env.auctionId,
          evidence: [evidenceFrom(env, `Invalid banner sizes on "${code || '?'}": ${result.reason}`)],
        })
      );
    }
  }
}

function pb07(session: SessionState, out: DiagnosticIssue[]): void {
  for (const env of named(session, 'prebid', 'noBid')) {
    if (strongerThanNoBid(session, env)) continue;
    const bid = bidOf(env);
    const code = env.adUnitCode || str(bid.adUnitCode);
    out.push(
      emit('COMMON-PB-07', session, {
        auctionId: env.auctionId || str(bid.auctionId),
        adUnitCode: code,
        evidence: [evidenceFrom(env, `noBid for ${bidderOf(bid) || code || 'bidder'}`)],
      })
    );
  }
}

function pb08(session: SessionState, out: DiagnosticIssue[]): void {
  for (const env of named(session, 'prebid', 'auctionTimeout')) {
    const timeout = auctionTimeoutMs(session, env.auctionId);
    out.push(
      emit('COMMON-PB-08', session, {
        auctionId: env.auctionId,
        evidence: [evidenceFrom(env, `auctionTimeout (effective timeout ${timeout}ms)`)],
      })
    );
  }
  for (const env of named(session, 'prebid', 'bidTimeout')) {
    const timeout = auctionTimeoutMs(session, env.auctionId);
    const items = payloadItems(env);
    const labels = items.map((b) => `${bidderOf(b) || '?'}@${str(b.adUnitCode) || env.adUnitCode || '?'}`);
    out.push(
      emit('COMMON-PB-08', session, {
        auctionId: env.auctionId || str(items[0]?.auctionId),
        adUnitCode: str(items[0]?.adUnitCode) || env.adUnitCode,
        evidence: [
          evidenceFrom(env, `bidTimeout for ${labels.join(', ') || 'bidder'} (effective timeout ${timeout}ms)`),
        ],
      })
    );
  }
}

function pb09and10(session: SessionState, out: DiagnosticIssue[]): void {
  for (const env of named(session, 'prebid', 'bidRejected')) {
    const reason = rejectionReason(env) || 'unspecified';
    const bid = bidOf(env);
    const code = env.adUnitCode || str(bid.adUnitCode);
    const safe = `bidder=${bidderOf(bid) || '—'} cpm=${bid.cpm ?? '—'} ${str(bid.currency) || ''} ${str(bid.mediaType) || ''} ${
      bid.width && bid.height ? `${bid.width}x${bid.height}` : ''
    }`.trim();
    if (reason === FLOOR_REJECTION) {
      out.push(
        emit('COMMON-PB-10', session, {
          auctionId: env.auctionId || str(bid.auctionId),
          adUnitCode: code,
          evidence: [evidenceFrom(env, `Floor rejection ${safe}`)],
        })
      );
      continue;
    }
    out.push(
      emit('COMMON-PB-09', session, {
        auctionId: env.auctionId || str(bid.auctionId),
        adUnitCode: code,
        evidence: [evidenceFrom(env, `bidRejected: ${reason} ${safe}`)],
      })
    );
  }
}

function pb11(session: SessionState, out: DiagnosticIssue[]): void {
  for (const env of named(session, 'prebid', 'auctionEnd')) {
    const auctionId = env.auctionId;
    if (!auctionId) continue;
    const auction = session.auctions.get(auctionId);
    const codes = auction?.adUnitCodes.length ? auction.adUnitCodes : auctionCodes(env);
    const received = auction?.bidsReceived || arr(payload(env).bidsReceived);
    const winning = auction?.winningBids || arr(payload(env).winningBids);
    for (const code of codes) {
      if (eligibleBids(received, code).length || eligibleBids(winning, code).length) continue;
      const noBids = countForUnit(session, 'noBid', auctionId, code);
      const timeouts = countForUnit(session, 'bidTimeout', auctionId, code);
      const errors = countForUnit(session, 'bidderError', auctionId, code);
      const rejected = countForUnit(session, 'bidRejected', auctionId, code);
      out.push(
        emit('COMMON-PB-11', session, {
          auctionId,
          adUnitCode: code,
          evidence: [
            evidenceFrom(
              env,
              `No eligible bid for "${code}": noBid=${noBids} timeout=${timeouts} error=${errors} rejected=${rejected}`
            ),
          ],
        })
      );
    }
  }
}

function pb12(session: SessionState, out: DiagnosticIssue[]): void {
  for (const env of named(session, 'prebid', 'auctionInit')) {
    const auctionId = env.auctionId;
    if (!auctionId) continue;
    const ended = named(session, 'prebid', 'auctionEnd').some((e) => e.auctionId === auctionId);
    const wait = auctionTimeoutMs(session, auctionId) + AUCTION_GRACE_MS;
    if (!ended && waited(env.ts, wait)) {
      out.push(
        emit('COMMON-PB-12', session, {
          confidence: absenceConfidence(session),
          auctionId,
          evidence: [evidenceFrom(env, `auctionInit without auctionEnd after ${wait}ms`)],
        })
      );
    }
  }
  for (const env of apis(session, 'prebid', 'requestBids')) {
    const threw = str(payload(env).threw);
    if (!threw) continue;
    out.push(
      emit('COMMON-PB-12', session, {
        auctionId: env.auctionId || str(rec(apiArgs(env)[0]).auctionId),
        evidence: [evidenceFrom(env, `requestBids threw: ${threw}`)],
      })
    );
  }
  for (const env of apis(session, 'prebid', 'bidsBackHandler')) {
    const threw = str(payload(env).threw);
    if (!threw) continue;
    const auctionId = env.auctionId || str(payload(env).auctionId);
    const fromGroups = arr(payload(env).bidGroups)
      .map((c) => str(c))
      .filter((c): c is string => !!c);
    const fromAuction = auctionId ? session.auctions.get(auctionId)?.adUnitCodes || [] : [];
    const codes = fromGroups.length ? fromGroups : fromAuction;
    if (codes.length) {
      for (const code of codes) {
        out.push(
          emit('COMMON-PB-12', session, {
            auctionId,
            adUnitCode: code,
            evidence: [evidenceFrom(env, `bidsBackHandler threw: ${threw}`)],
          })
        );
      }
      continue;
    }
    out.push(
      emit('COMMON-PB-12', session, {
        auctionId,
        evidence: [evidenceFrom(env, `bidsBackHandler threw: ${threw}`)],
      })
    );
  }
}

function pb13(session: SessionState, out: DiagnosticIssue[]): void {
  for (const env of named(session, 'prebid', 'adRenderFailed')) {
    const p = payload(env);
    const bid = bidOf(env);
    const reason = str(p.reason) || str(bid.reason) || 'unknown';
    const adId = str(p.adId) || str(bid.adId);
    const matched = adId
      ? named(session, 'prebid', 'bidResponse').some((e) => str(bidOf(e).adId) === adId)
      : false;
    const code = env.adUnitCode || str(bid.adUnitCode);
    out.push(
      emit('COMMON-PB-13', session, {
        auctionId: env.auctionId || str(bid.auctionId),
        adUnitCode: code,
        evidence: [
          evidenceFrom(
            env,
            `adRenderFailed reason=${reason} adId=${adId || '—'} matchedBid=${matched ? 'yes' : 'no'}`
          ),
        ],
      })
    );
  }
}

function staleRenderSummary(env: Envelope): string {
  const bid = bidOf(env);
  const parts = [
    `staleRender adId=${str(bid.adId) || '—'}`,
    str(bid.adUnitCode) ? `adUnitCode=${str(bid.adUnitCode)}` : undefined,
    str(bid.auctionId) ? `auctionId=${str(bid.auctionId)}` : undefined,
    bidderOf(bid) ? `bidder=${bidderOf(bid)}` : undefined,
    str(bid.status) ? `status=${str(bid.status)}` : undefined,
    bid.cpm != null ? `cpm=${str(bid.cpm)}` : undefined,
    str(bid.mediaType) ? `mediaType=${str(bid.mediaType)}` : undefined,
    bid.width != null && bid.height != null ? `size=${str(bid.width)}x${str(bid.height)}` : undefined,
    bid.ttl != null ? `ttl=${str(bid.ttl)}` : undefined,
  ];
  return parts.filter(Boolean).join('; ');
}

function pb14(session: SessionState, out: DiagnosticIssue[]): void {
  for (const env of named(session, 'prebid', 'staleRender')) {
    const bid = bidOf(env);
    const code = env.adUnitCode || str(bid.adUnitCode);
    out.push(
      emit('COMMON-PB-14', session, {
        auctionId: env.auctionId || str(bid.auctionId),
        adUnitCode: code,
        slotId: code ? slotIdForCode(session, code) : undefined,
        evidence: [evidenceFrom(env, staleRenderSummary(env), 'staleRender')],
      })
    );
  }
}

export function findPrebidIssues(session: SessionState): DiagnosticIssue[] {
  const out: DiagnosticIssue[] = [];
  pb01(session, out);
  pb02(session, out);
  pb03(session, out);
  pb04(session, out);
  pb05(session, out);
  pb06(session, out);
  pb07(session, out);
  pb08(session, out);
  pb09and10(session, out);
  pb11(session, out);
  pb12(session, out);
  pb13(session, out);
  pb14(session, out);
  return out;
}
