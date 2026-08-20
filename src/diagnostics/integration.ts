import type { Envelope, SessionState, SlotRecord } from '../shared/types';
import { parseCustParams, requestMatchesSlot } from '../shared/gam-network';
import {
  GPT_DUP_REQUEST_MS,
  apiArgs,
  apis,
  arr,
  auctionCodes,
  bidOf,
  eligibleBids,
  evidenceFrom,
  firstHb,
  hasHbKeys,
  hbKeysOf,
  issue,
  named,
  num,
  payload,
  rec,
  str,
} from './helpers';
import type { DiagnosticIssue, Severity } from './types';

type RuleMeta = {
  ruleId: string;
  title: string;
  severity: Severity;
  scope: 'integration';
  signal: string;
  explanation: string;
  checks: string[];
  recommendations: string[];
};

const RULES: Record<string, RuleMeta> = {
  'COMMON-INT-01': {
    ruleId: 'COMMON-INT-01',
    title: 'GAM refresh occurs before Prebid auction completion',
    severity: 'high',
    scope: 'integration',
    signal: 'refresh() / slotRequested for the auction’s slot occurs after that auction’s auctionInit and before its auctionEnd.',
    explanation: 'GPT starts independently, callback ordering is wrong, or failsafe fires too early.',
    checks: ['Compare timestamps on the same auctionId and matched slot, not the latest global auction.'],
    recommendations: ['Request GAM from the matching auction-completion path with a properly delayed guarded failsafe.'],
  },
  'COMMON-INT-02': {
    ruleId: 'COMMON-INT-02',
    title: 'Targeting is generated before auction completion',
    severity: 'high',
    scope: 'integration',
    signal: 'setTargetingForGPTAsync / Prebid setTargeting runs before that auction’s auctionEnd.',
    explanation: 'Targeting is called immediately after requestBids() or from an early bidder callback, so GPT may receive incomplete bids.',
    checks: ['Timestamp of wrapped setTargetingForGPTAsync or the setTargeting event vs that auctionId’s auctionEnd.'],
    recommendations: ['Generate targeting only after the auction decision is finalized.'],
  },
  'COMMON-INT-03': {
    ruleId: 'COMMON-INT-03',
    title: 'Auction completes but targeting is never applied',
    severity: 'high',
    scope: 'integration',
    signal: 'Eligible bids exist at auctionEnd, but no setTargetingForGPTAsync / setTargeting runs before the slot’s next GAM request.',
    explanation: 'Missing handoff call, callback exception, wrong branch, or GPT unavailable.',
    checks: ['auctionEnd with bids, then absence of targeting apply before slotRequested.'],
    recommendations: ['Apply targeting on the completed-auction path before requesting GAM.'],
  },
  'COMMON-INT-04': {
    ruleId: 'COMMON-INT-04',
    title: 'Targeting is applied after refresh',
    severity: 'high',
    scope: 'integration',
    signal: 'refresh() / slotRequested happens before Prebid targeting is written, so the GAM request snapshot misses hb_*.',
    explanation: 'Async ordering mistake. GPT snapshots targeting at display()/refresh() time; later writes miss that request.',
    checks: ['Compare targeting-write time with slotRequested time and the slot targeting captured at request.'],
    recommendations: ['Apply targeting first, then refresh.'],
  },
  'COMMON-INT-05': {
    ruleId: 'COMMON-INT-05',
    title: 'Prebid and GPT slot identifiers do not match',
    severity: 'critical',
    scope: 'integration',
    signal: 'Prebid adUnit.code matches neither the GPT element id nor the GAM ad-unit path, and no custom matcher resolves it.',
    explanation: 'Typo, renamed DOM id, or the publisher expected path matching / custom matching that is not configured.',
    checks: ['Compare adUnit.code with getSlotElementId() and getAdUnitPath(). Honor customGptSlotMatching when captured.'],
    recommendations: ['Align identifiers, or configure customGptSlotMatching for an intentional one-to-one mapping.'],
  },
  'COMMON-INT-06': {
    ruleId: 'COMMON-INT-06',
    title: 'GPT slot is missing or matching is ambiguous',
    severity: 'critical',
    scope: 'integration',
    signal: 'At handoff, zero GPT slots match the Prebid ad unit, or more than one slot matches.',
    explanation: 'Slot setup did not run, definition failed, duplicate ids/slots exist, or the custom matcher is too broad.',
    checks: ['Run the same matcher over pubads().getSlots() at targeting/refresh time.'],
    recommendations: ['Define one intended slot and make mapping deterministic.'],
  },
  'COMMON-INT-07': {
    ruleId: 'COMMON-INT-07',
    title: 'Targeting is empty despite eligible bids',
    severity: 'high',
    scope: 'integration',
    signal: 'The auction has valid bids for the ad unit, but the generated targeting map for that code has no hb_* keys.',
    explanation: 'Wrong auction/slot scope, bid expired/used, bidTargetingExclusion / targeting key filters, or eligibility/size problem.',
    checks: ['Eligible bidResponse at auctionEnd vs empty setTargeting payload / getAdserverTargetingForAdUnitCode.'],
    recommendations: ['Correct scope/filter/timing or run a fresh auction.'],
  },
  'COMMON-INT-08': {
    ruleId: 'COMMON-INT-08',
    title: 'Required hb_* keys are missing or not applied to GPT',
    severity: 'critical',
    scope: 'integration',
    signal: 'After targeting apply, the matched GPT slot’s request-time targeting is missing hb_adid, hb_pb, or hb_bidder (and hb_size for banner).',
    explanation: 'Incomplete bid metadata, targetingControls.allowTargetingKeys / send-all-bids limits, slot-matching failure, or later clearing.',
    checks: ['Diff Prebid setTargeting output with GPT slot targeting captured at slotRequested.'],
    recommendations: ['Fix metadata/filter/matching and ensure required keys reach the intended request unchanged.'],
  },
  'COMMON-INT-09': {
    ruleId: 'COMMON-INT-09',
    title: 'Stale targeting from a previous auction is reused',
    severity: 'critical',
    scope: 'integration',
    signal: 'The current GAM request still carries an hb_adid from an earlier auction, or carries hb_* after the current auction had no eligible bid.',
    explanation: 'Old keys were not cleared, refresh bypassed current handoff, or overlapping cycles share GPT targeting.',
    checks: ['Resolve request-time hb_adid to its bid’s auctionId and compare with the current cycle.'],
    recommendations: ['Bind targeting to the current cycle and clear obsolete keys before the new request.'],
  },
  'COMMON-INT-10': {
    ruleId: 'COMMON-INT-10',
    title: 'Prebid and GPT sizes disagree',
    severity: 'high',
    scope: 'integration',
    signal: 'Winning hb_size is not in the GPT slot’s active size set.',
    explanation: 'Prebid mediaTypes.banner.sizes and GPT defineSlot / defineSizeMapping sizes diverged. Official guidance is that Prebid sizes should match GPT sizes.',
    checks: ['Compare hb_size with defineSlot sizes (and the active size-mapping entry if one was captured).'],
    recommendations: ['Align eligible sizes across Prebid, GPT, and GAM.'],
  },
  'COMMON-INT-11': {
    ruleId: 'COMMON-INT-11',
    title: 'Failsafe and auction callback both request GAM',
    severity: 'high',
    scope: 'integration',
    signal: 'Two near-adjacent refresh() calls or GAMPAD requests follow one auction for the same slot.',
    explanation: 'Missing shared idempotency guard, or failsafe fires while/after the callback also refreshes.',
    checks: ['Two distinct refreshes or two GAMPAD requests for the same slot shortly after auctionEnd.'],
    recommendations: ['Route callback and failsafe through one function that sets the guard before queuing GPT work.'],
  },
  'COMMON-INT-12': {
    ruleId: 'COMMON-INT-12',
    title: 'New auction starts before prior GPT cycle finishes',
    severity: 'high',
    scope: 'integration',
    signal: 'A new auctionInit for the same ad unit arrives before the prior cycle’s slotRenderEnded (or empty/failed terminal).',
    explanation: 'Aggressive refresh timer, multiple refresh owners, or missing in-flight guard.',
    checks: ['Per slot, compare successive auctionInit times with the prior cycle’s GPT terminal event.'],
    recommendations: ['Serialize the slot lifecycle unless overlap is deliberate and safely correlated.'],
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
  return issue({
    ...meta,
    confidence: extra.confidence || 'confirmed',
    slotId: extra.slotId,
    adUnitCode: extra.adUnitCode,
    auctionId: extra.auctionId,
    evidence: extra.evidence,
  });
}

type BidMeta = {
  auctionId: string;
  adUnitCode: string;
  ts: number;
  ttl?: number;
  responseTime?: number;
  mediaType?: string;
};

function slotIdOf(env: Envelope): string | undefined {
  return env.slotElementId || env.adUnitCode || str(payload(env).slotElementId);
}

function argSlotId(value: unknown): string | undefined {
  if (typeof value === 'string' && value && !value.startsWith('/')) return value;
  return str(rec(value).slotElementId);
}

function gptInPlay(session: SessionState): boolean {
  if (session.status.gptPresent || session.status.apiReady) return true;
  if (session.slots.size) return true;
  return apis(session, 'gpt', 'defineSlot').length + apis(session, 'gpt', 'defineOutOfPageSlot').length > 0;
}

function destroyedIds(session: SessionState): Set<string> {
  const out = new Set<string>();
  for (const env of apis(session, 'gpt', 'destroySlots')) {
    const arg = apiArgs(env)[0];
    if (arg == null) {
      for (const id of session.slots.keys()) out.add(id);
      continue;
    }
    const list = Array.isArray(arg) ? arg : [arg];
    for (const item of list) {
      const id = argSlotId(item);
      if (id) out.add(id);
    }
  }
  return out;
}

function liveSlots(session: SessionState): SlotRecord[] {
  const dead = destroyedIds(session);
  return [...session.slots.values()].filter((s) => !dead.has(s.slotElementId));
}

/** Prebid default: code === getSlotElementId() || code === getAdUnitPath(). */
function defaultMatch(code: string, slot: SlotRecord): boolean {
  return slot.slotElementId === code || slot.adUnitPath === code;
}

function matchingSlots(session: SessionState, code: string): SlotRecord[] {
  return liveSlots(session).filter((s) => defaultMatch(code, s));
}

function customMatcherConfigured(session: SessionState): boolean {
  for (const name of ['setConfig', 'mergeConfig'] as const) {
    for (const env of apis(session, 'prebid', name)) {
      if ('customGptSlotMatching' in rec(apiArgs(env)[0])) return true;
    }
  }
  return false;
}

function auctionInits(session: SessionState): Envelope[] {
  return named(session, 'prebid', 'auctionInit');
}

function auctionEndFor(session: SessionState, auctionId?: string): Envelope | undefined {
  if (!auctionId) return undefined;
  return named(session, 'prebid', 'auctionEnd').find((e) => e.auctionId === auctionId);
}

function codesOf(session: SessionState, init: Envelope): string[] {
  const id = init.auctionId;
  const auction = id ? session.auctions.get(id) : undefined;
  if (auction?.adUnitCodes.length) return auction.adUnitCodes;
  return auctionCodes(init);
}

function stillOpen(end: Envelope | undefined, seq: number): boolean {
  return !end || seq < end.seq;
}

function afterInit(env: Envelope, init: Envelope): boolean {
  return env.seq > init.seq;
}

function refreshSlotIds(session: SessionState, env: Envelope): string[] {
  const recorded = arr(payload(env).slotIds)
    .map((id) => str(id))
    .filter((id): id is string => !!id);
  if (recorded.length) return recorded;
  if (payload(env).unscoped === true) return liveSlots(session).map((s) => s.slotElementId);
  const arg = apiArgs(env)[0];
  if (arg == null) return liveSlots(session).map((s) => s.slotElementId);
  if (!Array.isArray(arg)) {
    const id = argSlotId(arg);
    return id ? [id] : liveSlots(session).map((s) => s.slotElementId);
  }
  return arg.map((item) => argSlotId(item)).filter((id): id is string => !!id);
}

function targetingApplies(session: SessionState): Envelope[] {
  return [...apis(session, 'prebid', 'setTargetingForGPTAsync'), ...named(session, 'prebid', 'setTargeting')].sort(
    (a, b) => a.seq - b.seq
  );
}

function targetingCodes(env: Envelope): string[] {
  if (env.kind === 'api') {
    const a0 = apiArgs(env)[0];
    if (a0 == null) return [];
    if (typeof a0 === 'function' || (typeof a0 === 'string' && a0.startsWith('[function'))) return [];
    if (typeof a0 === 'string') return [a0];
    return arr(a0)
      .map((c) => str(c))
      .filter((c): c is string => !!c);
  }
  return Object.keys(payload(env)).filter((k) => k && rec(payload(env)[k]) !== undefined && typeof payload(env)[k] === 'object');
}

function applyCoversCode(env: Envelope, code: string): boolean {
  const codes = targetingCodes(env);
  return codes.length === 0 || codes.includes(code);
}

function targetingMapForCode(env: Envelope, code: string): Record<string, unknown> {
  if (env.kind === 'api') return {};
  return rec(payload(env)[code]);
}

function overlappingInits(session: SessionState, code: string, seq: number): Envelope[] {
  return auctionInits(session).filter((init) => {
    if (!codesOf(session, init).includes(code)) return false;
    if (init.seq >= seq) return false;
    return stillOpen(auctionEndFor(session, init.auctionId), seq);
  });
}

function latestInitForCode(session: SessionState, code: string, seq: number): Envelope | undefined {
  const inits = auctionInits(session).filter((init) => init.seq < seq && codesOf(session, init).includes(code));
  return inits[inits.length - 1];
}

/** Prefer the setTargeting event (has the map). The API wrap posts after the original returns, so its seq is later. */
function targetingApplyMoments(session: SessionState): Envelope[] {
  const events = named(session, 'prebid', 'setTargeting');
  if (events.length) return events;
  return apis(session, 'prebid', 'setTargetingForGPTAsync');
}

function nextSlotRequested(session: SessionState, slotId: string, afterSeq: number): Envelope | undefined {
  return named(session, 'gpt', 'slotRequested').find((e) => slotIdOf(e) === slotId && e.seq > afterSeq);
}

function requestTargeting(env: Envelope): Record<string, unknown> {
  return rec(payload(env).targeting);
}

function correlatorOf(env: Envelope): string {
  return str(payload(env).correlator) || `seq:${env.seq}`;
}

function iuPathsOf(env: Envelope): string[] {
  return arr(payload(env).iuPaths)
    .map((p) => str(p))
    .filter((p): p is string => !!p);
}

function gamRequests(session: SessionState): Envelope[] {
  return named(session, 'network', 'gamRequest');
}

function gamFailed(env: Envelope): boolean {
  const p = payload(env);
  const status = num(p.status);
  if (status === 200 || status === 204) return false;
  if (p.failed === true) return true;
  if (status != null && (status === 0 || status >= 400)) return true;
  return false;
}

function gamMatchesSlot(session: SessionState, env: Envelope, slot: SlotRecord): boolean {
  const iu = iuPathsOf(env);
  if (requestMatchesSlot(iu, slot.adUnitPath)) return true;
  if (env.adUnitCode === slot.slotElementId || env.adUnitCode === slot.adUnitPath) return true;
  if (iu.includes(slot.slotElementId)) return true;
  return false;
}

function parseScpField(raw: string | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw) return out;
  for (const chunk of raw.split('|')) {
    Object.assign(out, parseCustParams(chunk));
  }
  return out;
}

function gamHbMap(env: Envelope): Record<string, unknown> {
  const p = payload(env);
  const query = rec(p.query);
  return {
    ...rec(p.custParams),
    ...rec(p.slotParams),
    ...parseCustParams(str(p.cust_params) || str(query.cust_params)),
    ...parseScpField(str(p.prev_scp) || str(query.prev_scp)),
    ...parseScpField(str(p.scp) || str(query.scp)),
  };
}

/** Case-insensitive hb_* lookup; GPT returns arrays, GAMPAD returns strings. */
function hbVal(map: Record<string, unknown>, key: string): string | undefined {
  const direct = firstHb(map, key);
  if (direct) return direct;
  const wanted = key.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() !== wanted) continue;
    return firstHb({ [key]: v }, key);
  }
  return undefined;
}

function mergeHbMaps(...maps: Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const map of maps) {
    for (const [k, v] of Object.entries(map)) {
      if (!k.toLowerCase().startsWith('hb_')) continue;
      if (hbVal(out, k)) continue;
      if (firstHb({ [k]: v }, k)) out[k] = v;
    }
  }
  return out;
}

function requestHbMap(session: SessionState, req: Envelope, slot: SlotRecord): Record<string, unknown> {
  const gpt = requestTargeting(req);
  const stored = rec(slot.targetingAtRequest);
  const gams = gamRequests(session).filter(
    (g) => gamMatchesSlot(session, g, slot) && g.ts >= req.ts - 1_000 && g.ts <= req.ts + 8_000
  );
  return mergeHbMaps(gpt, stored, ...gams.map(gamHbMap));
}

function requestLackedHb(session: SessionState, req: Envelope, slot: SlotRecord): boolean {
  if (hasHbKeys(requestTargeting(req))) return false;
  const gams = gamRequests(session).filter((g) => gamMatchesSlot(session, g, slot) && Math.abs(g.ts - req.ts) <= 8_000);
  if (gams.some((g) => hasHbKeys(gamHbMap(g)))) return false;
  return true;
}

function auctionBids(session: SessionState, auctionId: string, code: string): Record<string, unknown>[] {
  const auction = session.auctions.get(auctionId);
  const end = auctionEndFor(session, auctionId);
  const received = auction?.bidsReceived || (end ? arr(payload(end).bidsReceived) : []);
  const winning = auction?.winningBids || (end ? arr(payload(end).winningBids) : []);
  return [...eligibleBids(received, code), ...eligibleBids(winning, code)];
}

function hasEligible(session: SessionState, auctionId: string, code: string): boolean {
  return auctionBids(session, auctionId, code).length > 0;
}

function inspectedTargeting(session: SessionState, code: string, afterSeq: number): Envelope[] {
  const out: Envelope[] = [];
  for (const env of targetingApplies(session)) {
    if (env.seq <= afterSeq) continue;
    if (applyCoversCode(env, code)) out.push(env);
  }
  for (const env of named(session, 'prebid', 'getAdserverTargeting')) {
    if (env.seq <= afterSeq) continue;
    if (rec(payload(env)[code])) out.push(env);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

function mapFromInspect(env: Envelope, code: string): Record<string, unknown> {
  if (env.name === 'getAdserverTargeting') return rec(payload(env)[code]);
  return targetingMapForCode(env, code);
}

function nullDefineEvidence(session: SessionState): Envelope[] {
  const out: Envelope[] = [];
  for (const name of ['defineSlot', 'defineOutOfPageSlot'] as const) {
    for (const env of apis(session, 'gpt', name)) {
      if (payload(env).result == null) out.push(env);
    }
  }
  return out;
}

function parseHbSize(value: string | undefined): [number, number] | undefined {
  if (!value) return undefined;
  const m = /^(\d+)\s*[xX×]\s*(\d+)$/.exec(value.trim());
  if (!m) return undefined;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined;
  return [w, h];
}

function collectSizePairs(value: unknown, out: [number, number][]): void {
  if (value == null) return;
  if (typeof value === 'string') {
    const pair = parseHbSize(value);
    if (pair) out.push(pair);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length >= 2 && typeof value[0] === 'number') {
      const w = num(value[0]);
      const h = num(value[1]);
      if (w != null && h != null && w > 0 && h > 0) out.push([w, h]);
      else for (const item of value) collectSizePairs(item, out);
      return;
    }
    for (const item of value) collectSizePairs(item, out);
    return;
  }
  const obj = rec(value);
  const w = num(obj.width) ?? num(obj.getWidth);
  const h = num(obj.height) ?? num(obj.getHeight);
  if (w != null && h != null && w > 0 && h > 0) out.push([w, h]);
}

function slotSizeSet(session: SessionState, slot: SlotRecord): [number, number][] {
  const out: [number, number][] = [];
  collectSizePairs(slot.sizes, out);
  for (const name of ['defineSlot', 'defineOutOfPageSlot'] as const) {
    for (const env of apis(session, 'gpt', name)) {
      const result = rec(payload(env).result);
      const id = str(result.slotElementId) || env.slotElementId;
      if (id !== slot.slotElementId) continue;
      collectSizePairs(apiArgs(env)[1], out);
      collectSizePairs(result.sizes, out);
    }
  }
  for (const env of named(session, 'gpt', 'defineSlot.result')) {
    if ((env.slotElementId || str(payload(env).slotElementId)) !== slot.slotElementId) continue;
    collectSizePairs(payload(env).sizes, out);
  }
  const mapped: [number, number][] = [];
  for (const env of apis(session, 'gpt', 'defineSizeMapping')) {
    if (env.slotElementId !== slot.slotElementId) continue;
    collectSizePairs(apiArgs(env)[0], mapped);
  }
  return mapped.length ? mapped : out;
}

function sizeKey(pair: [number, number]): string {
  return `${pair[0]}x${pair[1]}`;
}

function isBannerCandidate(session: SessionState, code: string, auctionId?: string, generated?: Record<string, unknown>): boolean {
  const format = firstHb(generated || {}, 'hb_format');
  if (format === 'native' || format === 'video') {
    const unit = session.adUnits.get(code);
    if (unit?.mediaTypes?.length && !unit.mediaTypes.includes('banner')) return false;
  }
  const unit = session.adUnits.get(code);
  if (unit?.mediaTypes?.includes('banner')) return true;
  if (unit?.mediaTypes?.length && !unit.mediaTypes.includes('banner')) return false;
  if (auctionId) {
    const bids = auctionBids(session, auctionId, code);
    if (bids.length && bids.every((b) => str(b.mediaType) === 'native' || str(b.mediaType) === 'video')) return false;
    if (bids.some((b) => str(b.mediaType) === 'banner' || !str(b.mediaType))) return true;
  }
  return format ? format === 'banner' : true;
}

function requiredHbKeys(banner: boolean): string[] {
  return banner ? ['hb_adid', 'hb_pb', 'hb_bidder', 'hb_size'] : ['hb_adid', 'hb_pb', 'hb_bidder'];
}

function missingRequired(map: Record<string, unknown>, keys: string[]): string[] {
  return keys.filter((k) => !hbVal(map, k));
}

function changedRequired(generated: Record<string, unknown>, request: Record<string, unknown>, keys: string[]): string[] {
  return keys.filter((k) => {
    const a = hbVal(generated, k);
    const b = hbVal(request, k);
    return !!(a && b && a !== b);
  });
}

function indexBids(session: SessionState): Map<string, BidMeta> {
  const map = new Map<string, BidMeta>();
  const add = (bid: Record<string, unknown>, ts: number, auctionId?: string) => {
    const adId = str(bid.adId);
    if (!adId) return;
    map.set(adId, {
      auctionId: str(bid.auctionId) || auctionId || '',
      adUnitCode: str(bid.adUnitCode) || '',
      ts,
      ttl: num(bid.ttl),
      responseTime: num(bid.responseTimestamp) || num(bid.timeToRespond),
      mediaType: str(bid.mediaType),
    });
  };
  for (const [id, auction] of session.auctions) {
    const ts = auction.endTs || auction.startTs || 0;
    for (const b of [...auction.bidsReceived, ...auction.winningBids]) add(rec(b), ts, id);
  }
  for (const env of named(session, 'prebid', 'bidResponse')) add(bidOf(env), env.ts, env.auctionId);
  return map;
}

function currentInitForSlot(session: SessionState, slot: SlotRecord, seq: number): Envelope | undefined {
  const inits = auctionInits(session).filter((init) => {
    if (init.seq >= seq) return false;
    return codesOf(session, init).some((code) => defaultMatch(code, slot));
  });
  return inits[inits.length - 1];
}

function distinctCorrelators(list: Envelope[]): Envelope[] {
  const seen = new Set<string>();
  const out: Envelope[] = [];
  for (const env of list) {
    const key = correlatorOf(env);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(env);
  }
  return out.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
}

function pairWithinWindow(list: Envelope[]): { first: Envelope; second: Envelope } | undefined {
  const unique = distinctCorrelators(list);
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const delta = unique[j].ts - unique[i].ts;
      if (delta >= 0 && delta <= GPT_DUP_REQUEST_MS) return { first: unique[i], second: unique[j] };
    }
  }
  return undefined;
}

function seenKey(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join('|');
}

function int01(session: SessionState, out: DiagnosticIssue[], seen: Set<string>): void {
  const requested = named(session, 'gpt', 'slotRequested');
  const refreshes = apis(session, 'gpt', 'refresh');
  for (const init of auctionInits(session)) {
    const auctionId = init.auctionId;
    if (!auctionId) continue;
    const end = auctionEndFor(session, auctionId);
    for (const code of codesOf(session, init)) {
      const slots = matchingSlots(session, code);
      if (!slots.length) continue;
      for (const slot of slots) {
        const earlyRefresh = refreshes.find(
          (e) => afterInit(e, init) && stillOpen(end, e.seq) && refreshSlotIds(session, e).includes(slot.slotElementId)
        );
        const earlyReq = requested.find(
          (e) => afterInit(e, init) && stillOpen(end, e.seq) && slotIdOf(e) === slot.slotElementId
        );
        const hit = earlyRefresh || earlyReq;
        if (!hit) continue;
        const key = seenKey(['COMMON-INT-01', auctionId, code, slot.slotElementId]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(
          emit('COMMON-INT-01', session, {
            slotId: slot.slotElementId,
            adUnitCode: code,
            auctionId,
            evidence: [
              evidenceFrom(init, `auctionInit ${auctionId} for "${code}"`),
              evidenceFrom(
                hit,
                `${hit.name} for "${slot.slotElementId}" at seq ${hit.seq} is after auctionInit and ${end ? `before auctionEnd seq ${end.seq}` : 'auctionEnd has not arrived'}`
              ),
            ],
          })
        );
      }
    }
  }
}

function int02(session: SessionState, out: DiagnosticIssue[], seen: Set<string>): void {
  for (const apply of targetingApplies(session)) {
    const codes = targetingCodes(apply);
    const targets = codes.length ? codes : [...new Set(auctionInits(session).flatMap((init) => codesOf(session, init)))];
    for (const code of targets) {
      if (!applyCoversCode(apply, code)) continue;
      for (const init of overlappingInits(session, code, apply.seq)) {
        const auctionId = init.auctionId;
        if (!auctionId) continue;
        const end = auctionEndFor(session, auctionId);
        const key = seenKey(['COMMON-INT-02', auctionId, code]);
        if (seen.has(key)) continue;
        seen.add(key);
        const slot = matchingSlots(session, code)[0];
        out.push(
          emit('COMMON-INT-02', session, {
            slotId: slot?.slotElementId,
            adUnitCode: code,
            auctionId,
            evidence: [
              evidenceFrom(
                apply,
                `${apply.name} for "${code}" at seq ${apply.seq} is before ${end ? `auctionEnd seq ${end.seq}` : 'auctionEnd'} of ${auctionId}`
              ),
            ],
          })
        );
      }
    }
  }
}

function int03(session: SessionState, out: DiagnosticIssue[], seen: Set<string>): void {
  for (const end of named(session, 'prebid', 'auctionEnd')) {
    const auctionId = end.auctionId;
    if (!auctionId) continue;
    for (const code of codesOf(session, end)) {
      if (!hasEligible(session, auctionId, code)) continue;
      const slots = matchingSlots(session, code);
      if (!slots.length) continue;
      for (const slot of slots) {
        const next = nextSlotRequested(session, slot.slotElementId, end.seq);
        if (!next) continue;
        const applied = targetingApplies(session).some(
          (e) => e.seq > end.seq && e.seq < next.seq && applyCoversCode(e, code)
        );
        if (applied) continue;
        const key = seenKey(['COMMON-INT-03', auctionId, code, slot.slotElementId]);
        if (seen.has(key)) continue;
        seen.add(key);
        const snap = named(session, 'prebid', 'getAdserverTargeting').find((e) => e.seq >= end.seq && rec(payload(e)[code]));
        const generated = snap ? rec(payload(snap)[code]) : {};
        out.push(
          emit('COMMON-INT-03', session, {
            slotId: slot.slotElementId,
            adUnitCode: code,
            auctionId,
            evidence: [
              evidenceFrom(end, `auctionEnd ${auctionId} had eligible bids for "${code}"`),
              evidenceFrom(
                next,
                snap && hasHbKeys(generated)
                  ? `slotRequested for "${slot.slotElementId}" with no setTargetingForGPTAsync / setTargeting in between (targeting was generated but not applied)`
                  : `slotRequested for "${slot.slotElementId}" with no setTargetingForGPTAsync / setTargeting in between`
              ),
            ],
          })
        );
      }
    }
  }
}

function int04(session: SessionState, out: DiagnosticIssue[], seen: Set<string>): void {
  const requested = named(session, 'gpt', 'slotRequested');
  for (const req of requested) {
    const slotId = slotIdOf(req);
    if (!slotId) continue;
    const slot = session.slots.get(slotId);
    if (!slot) continue;
    const codes = [...new Set([...session.adUnits.keys(), ...auctionInits(session).flatMap((init) => codesOf(session, init))])].filter(
      (code) => defaultMatch(code, slot)
    );
    if (!codes.length) codes.push(slotId);
    const next = nextSlotRequested(session, slotId, req.seq);
    const late = targetingApplies(session).filter((e) => e.seq > req.seq && (!next || e.seq < next.seq));
    if (!late.length) continue;
    if (!requestLackedHb(session, req, slot)) continue;
    for (const code of codes) {
      const apply = late.find((e) => applyCoversCode(e, code));
      if (!apply) continue;
      const key = seenKey(['COMMON-INT-04', slotId, code, String(req.seq)]);
      if (seen.has(key)) continue;
      seen.add(key);
      const init = currentInitForSlot(session, slot, req.seq);
      out.push(
        emit('COMMON-INT-04', session, {
          slotId,
          adUnitCode: code,
          auctionId: init?.auctionId,
          evidence: [
            evidenceFrom(req, `slotRequested for "${slotId}" with no hb_* at request time`),
            evidenceFrom(apply, `${apply.name} for "${code}" ran after that request (seq ${apply.seq} > ${req.seq})`),
          ],
        })
      );
    }
  }
}

function int05and06(session: SessionState, out: DiagnosticIssue[], seen: Set<string>): void {
  if (!gptInPlay(session)) return;
  const custom = customMatcherConfigured(session);
  const live = liveSlots(session);
  const handoffs = [...named(session, 'prebid', 'auctionEnd'), ...apis(session, 'prebid', 'setTargetingForGPTAsync')];
  const nullDefs = nullDefineEvidence(session);
  for (const env of handoffs) {
    const codes =
      env.name === 'setTargetingForGPTAsync'
        ? targetingCodes(env).length
          ? targetingCodes(env)
          : [...new Set(auctionInits(session).filter((i) => i.seq < env.seq).flatMap((i) => codesOf(session, i)))]
        : codesOf(session, env);
    for (const code of codes) {
      const auctionId = env.auctionId || latestInitForCode(session, code, env.seq + 1)?.auctionId;
      const matches = matchingSlots(session, code);
      if (matches.length === 1) continue;
      if (matches.length > 1) {
        if (custom) continue;
        const key = seenKey(['COMMON-INT-06', 'ambiguous', code, auctionId]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(
          emit('COMMON-INT-06', session, {
            slotId: matches[0].slotElementId,
            adUnitCode: code,
            auctionId,
            evidence: [
              evidenceFrom(
                env,
                `Ambiguous GPT match for "${code}": ${matches.map((s) => `${s.slotElementId}${s.adUnitPath ? ` (${s.adUnitPath})` : ''}`).join(', ')}`
              ),
            ],
          })
        );
        continue;
      }
      if (live.length) {
        if (custom) continue;
        const key = seenKey(['COMMON-INT-05', code, auctionId]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(
          emit('COMMON-INT-05', session, {
            adUnitCode: code,
            auctionId,
            evidence: [
              evidenceFrom(
                env,
                `adUnit.code "${code}" matches neither getSlotElementId() nor getAdUnitPath() among ${live.length} live GPT slot(s): ${live
                  .map((s) => `${s.slotElementId}${s.adUnitPath ? `/${s.adUnitPath}` : ''}`)
                  .join(', ')}`
              ),
            ],
          })
        );
        continue;
      }
      const key = seenKey(['COMMON-INT-06', 'missing', code, auctionId]);
      if (seen.has(key)) continue;
      seen.add(key);
      const evidence = [
        evidenceFrom(env, `No live GPT slot matches "${code}" at ${env.name}`),
        ...nullDefs.slice(0, 3).map((e) => evidenceFrom(e, `${e.name} returned null`)),
      ];
      out.push(
        emit('COMMON-INT-06', session, {
          adUnitCode: code,
          auctionId,
          evidence,
        })
      );
    }
  }
}

function int07(session: SessionState, out: DiagnosticIssue[], seen: Set<string>): void {
  for (const end of named(session, 'prebid', 'auctionEnd')) {
    const auctionId = end.auctionId;
    if (!auctionId) continue;
    for (const code of codesOf(session, end)) {
      if (!hasEligible(session, auctionId, code)) continue;
      const inspects = inspectedTargeting(session, code, end.seq - 1).filter((e) => e.seq >= end.seq);
      if (!inspects.length) continue;
      const withMap = inspects.find((e) => Object.keys(mapFromInspect(e, code)).length);
      const map = withMap ? mapFromInspect(withMap, code) : mapFromInspect(inspects[0], code);
      if (hasHbKeys(map)) continue;
      const key = seenKey(['COMMON-INT-07', auctionId, code]);
      if (seen.has(key)) continue;
      seen.add(key);
      const slot = matchingSlots(session, code)[0];
      out.push(
        emit('COMMON-INT-07', session, {
          slotId: slot?.slotElementId,
          adUnitCode: code,
          auctionId,
          evidence: [
            evidenceFrom(end, `Eligible bids at auctionEnd for "${code}"`),
            evidenceFrom(withMap || inspects[0], `Targeting map for "${code}" has no hb_* keys (${hbKeysOf(map).join(',') || 'empty'})`),
          ],
        })
      );
    }
  }
}

function int08(session: SessionState, out: DiagnosticIssue[], seen: Set<string>): void {
  for (const apply of targetingApplyMoments(session)) {
    const codes = targetingCodes(apply);
    const targets = codes.length ? codes : [...new Set(auctionInits(session).flatMap((i) => codesOf(session, i)))];
    for (const code of targets) {
      if (!applyCoversCode(apply, code)) continue;
      const slots = matchingSlots(session, code);
      if (!slots.length) continue;
      const generatedEnv =
        apply.kind === 'event'
          ? apply
          : named(session, 'prebid', 'getAdserverTargeting')
              .filter((e) => rec(payload(e)[code]))
              .slice(-1)[0];
      const generated = generatedEnv ? mapFromInspect(generatedEnv, code) : targetingMapForCode(apply, code);
      const init = latestInitForCode(session, code, apply.seq + 1);
      const auctionId = apply.auctionId || init?.auctionId;
      const banner = isBannerCandidate(session, code, auctionId, generated);
      const keys = requiredHbKeys(banner);
      const parsedGenerated = hasHbKeys(generated);
      for (const slot of slots) {
        const next = nextSlotRequested(session, slot.slotElementId, apply.seq);
        // Catalog: after targeting apply, at the next slotRequested — do not emit from the Prebid map alone.
        if (!next) continue;
        const request = requestHbMap(session, next, slot);
        const missingAtReq = missingRequired(request, keys);
        const missingAtApply = parsedGenerated ? missingRequired(generated, keys) : [];
        const changed = parsedGenerated ? changedRequired(generated, request, keys) : [];
        // If GAMPAD scp/prev_scp (or GPT snapshot) has the required keys unchanged, they reached GAM.
        if (!missingAtReq.length && !changed.length) continue;
        const key = seenKey(['COMMON-INT-08', code, slot.slotElementId, String(apply.seq)]);
        if (seen.has(key)) continue;
        seen.add(key);
        const stage = missingAtApply.length && missingAtReq.length ? 'Prebid targeting map' : 'GPT/GAMPAD request targeting';
        const stageMissing = missingAtReq.length ? missingAtReq : missingAtApply;
        out.push(
          emit('COMMON-INT-08', session, {
            slotId: slot.slotElementId,
            adUnitCode: code,
            auctionId,
            evidence: [
              evidenceFrom(apply, `${apply.name} for "${code}"`),
              evidenceFrom(
                next,
                `${stage} missing/changed ${[...stageMissing, ...changed.map((k) => `${k} changed`)].join(', ')}${banner ? ' (banner requires hb_size)' : ''}`
              ),
            ],
          })
        );
      }
    }
  }
}

function int09(session: SessionState, out: DiagnosticIssue[], seen: Set<string>): void {
  const bids = indexBids(session);
  for (const req of named(session, 'gpt', 'slotRequested')) {
    const slotId = slotIdOf(req);
    if (!slotId) continue;
    const slot = session.slots.get(slotId);
    if (!slot) continue;
    const init = currentInitForSlot(session, slot, req.seq);
    if (!init?.auctionId) continue;
    const auctionId = init.auctionId;
    const code = codesOf(session, init).find((c) => defaultMatch(c, slot)) || slotId;
    const targeting = requestTargeting(req);
    const hbAdId = firstHb(targeting, 'hb_adid');
    const ended = auctionEndFor(session, auctionId);
    const currentEligible = ended ? hasEligible(session, auctionId, code) : undefined;
    let reason: string | undefined;
    if (hbAdId) {
      const meta = bids.get(hbAdId);
      if (meta?.auctionId && meta.auctionId !== auctionId) {
        reason = `hb_adid=${hbAdId} belongs to auction ${meta.auctionId}, not current cycle ${auctionId}`;
      }
    }
    if (!reason && ended && currentEligible === false && hasHbKeys(targeting)) {
      reason = `Current cycle ${auctionId} had no eligible bid for "${code}" but request-time targeting still has ${hbKeysOf(targeting).join(',')}`;
    }
    if (!reason) continue;
    const key = seenKey(['COMMON-INT-09', slotId, auctionId, String(req.seq)]);
    if (seen.has(key)) continue;
    seen.add(key);
    const meta = hbAdId ? bids.get(hbAdId) : undefined;
    out.push(
      emit('COMMON-INT-09', session, {
        slotId,
        adUnitCode: code,
        auctionId,
        evidence: [
          evidenceFrom(req, reason),
          evidenceFrom(
            init,
            meta
              ? `Resolved bid auctionId=${meta.auctionId} adUnitCode=${meta.adUnitCode}${meta.ttl != null ? ` ttl=${meta.ttl}` : ''}${meta.responseTime != null ? ` ttr=${meta.responseTime}` : ''}`
              : `Current cycle auctionInit ${auctionId}`
          ),
        ],
      })
    );
  }
}

function int10(session: SessionState, out: DiagnosticIssue[], seen: Set<string>): void {
  for (const req of named(session, 'gpt', 'slotRequested')) {
    const slotId = slotIdOf(req);
    if (!slotId) continue;
    const slot = session.slots.get(slotId);
    if (!slot) continue;
    const hbSize = firstHb(requestTargeting(req), 'hb_size');
    const pair = parseHbSize(hbSize);
    if (!pair) continue;
    const allowed = slotSizeSet(session, slot);
    if (!allowed.length) continue;
    if (allowed.some((s) => s[0] === pair[0] && s[1] === pair[1])) continue;
    const key = seenKey(['COMMON-INT-10', slotId, hbSize, String(req.seq)]);
    if (seen.has(key)) continue;
    seen.add(key);
    const init = currentInitForSlot(session, slot, req.seq);
    const code = init ? codesOf(session, init).find((c) => defaultMatch(c, slot)) : slotId;
    out.push(
      emit('COMMON-INT-10', session, {
        slotId,
        adUnitCode: code,
        auctionId: init?.auctionId,
        evidence: [
          evidenceFrom(
            req,
            `hb_size=${hbSize} is not in GPT sizes for "${slotId}" [${[...new Set(allowed.map(sizeKey))].join(', ')}]`
          ),
        ],
      })
    );
  }
}

function int11(session: SessionState, out: DiagnosticIssue[], seen: Set<string>): void {
  for (const end of named(session, 'prebid', 'auctionEnd')) {
    const auctionId = end.auctionId;
    if (!auctionId) continue;
    for (const code of codesOf(session, end)) {
      const slots = matchingSlots(session, code);
      for (const slot of slots) {
        const refreshes = apis(session, 'gpt', 'refresh').filter(
          (e) => e.seq > end.seq && refreshSlotIds(session, e).includes(slot.slotElementId)
        );
        const refreshPair = (() => {
          for (let i = 0; i < refreshes.length; i++) {
            for (let j = i + 1; j < refreshes.length; j++) {
              const delta = refreshes[j].ts - refreshes[i].ts;
              if (delta >= 0 && delta <= GPT_DUP_REQUEST_MS) return { first: refreshes[i], second: refreshes[j] };
            }
          }
          return undefined;
        })();
        const gams = distinctCorrelators(
          gamRequests(session).filter((e) => e.ts >= end.ts && gamMatchesSlot(session, e, slot))
        );
        const gamPair = pairWithinWindow(gams);
        const pair = refreshPair || gamPair;
        if (!pair) continue;
        const key = seenKey(['COMMON-INT-11', auctionId, code, slot.slotElementId]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(
          emit('COMMON-INT-11', session, {
            slotId: slot.slotElementId,
            adUnitCode: code,
            auctionId,
            evidence: [
              evidenceFrom(end, `auctionEnd ${auctionId} for "${code}"`),
              evidenceFrom(pair.first, `${pair.first.name} for "${slot.slotElementId}"`),
              evidenceFrom(
                pair.second,
                `Second ${pair.second.name} ${pair.second.ts - pair.first.ts}ms later (window ${GPT_DUP_REQUEST_MS}ms); distinct correlators required for GAMPAD`
              ),
            ],
          })
        );
      }
    }
  }
}

function int12(session: SessionState, out: DiagnosticIssue[], seen: Set<string>): void {
  const byCode = new Map<string, Envelope[]>();
  for (const init of auctionInits(session)) {
    for (const code of codesOf(session, init)) {
      const list = byCode.get(code) || [];
      list.push(init);
      byCode.set(code, list);
    }
  }
  const renders = named(session, 'gpt', 'slotRenderEnded');
  for (const [code, inits] of byCode) {
    const sorted = [...inits].sort((a, b) => a.seq - b.seq);
    const slots = matchingSlots(session, code);
    if (!slots.length) continue;
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      for (const slot of slots) {
        const terminal = renders.find(
          (e) => slotIdOf(e) === slot.slotElementId && e.seq > prev.seq && e.seq < curr.seq
        );
        const failed = gamRequests(session).find(
          (e) => gamFailed(e) && gamMatchesSlot(session, e, slot) && e.ts > prev.ts && e.ts < curr.ts
        );
        if (terminal || failed) continue;
        const key = seenKey(['COMMON-INT-12', code, slot.slotElementId, prev.auctionId, curr.auctionId]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(
          emit('COMMON-INT-12', session, {
            slotId: slot.slotElementId,
            adUnitCode: code,
            auctionId: curr.auctionId,
            evidence: [
              evidenceFrom(prev, `Prior auctionInit ${prev.auctionId} for "${code}" / "${slot.slotElementId}"`),
              evidenceFrom(
                curr,
                `New auctionInit ${curr.auctionId} before prior cycle reached slotRenderEnded or a GAM transport failure`
              ),
            ],
          })
        );
      }
    }
  }
}

export function findIntegrationIssues(session: SessionState): DiagnosticIssue[] {
  if (!auctionInits(session).length) return [];
  const out: DiagnosticIssue[] = [];
  const seen = new Set<string>();
  int01(session, out, seen);
  int02(session, out, seen);
  int03(session, out, seen);
  int04(session, out, seen);
  int05and06(session, out, seen);
  int07(session, out, seen);
  int08(session, out, seen);
  int09(session, out, seen);
  int10(session, out, seen);
  int11(session, out, seen);
  int12(session, out, seen);
  return out;
}
