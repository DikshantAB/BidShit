/**
 * Ad-source classification for each GPT render cycle.
 *
 * Labels: PREBID | GAM | UNKNOWN
 * Core rule: Prebid participated ≠ Prebid won; GAM served the slot ≠ GAM demand won.
 * Prefer UNKNOWN when evidence is incomplete or conflicting.
 */

import { requestMatchesSlot } from '../shared/gam-network';
import type { Envelope, SessionState, SlotRecord } from '../shared/types';

export type CreativeSource = 'PREBID' | 'GAM' | 'UNKNOWN';
export type Confidence = 'HIGH' | 'LOW';

export interface EvidenceItem {
  label: string;
  value: string;
  /** true = supports the verdict, false = contradicts/missing, undefined = context only */
  supports?: boolean;
  /** verdict = used to pick PREBID / GAM / UNKNOWN. context = shown, never decisive. */
  role?: 'verdict' | 'context';
}

/** Structured facts stored on every classification (spec output). */
export interface ClassificationFacts {
  slotId?: string;
  adUnitPath?: string;
  auctionId?: string;
  transactionId?: string;
  requestId?: string;
  prebidAdId?: string;
  hbAdId?: string;
  bidder?: string;
  prebidCoverageComplete: boolean;
  bidWonObserved: boolean;
  renderAdObserved: boolean;
  pucObserved: boolean;
  adRenderSucceeded: boolean;
  customRendererObserved: boolean;
  gptSlotRendered: boolean;
  isEmpty: boolean;
  lineItemId?: string | number | null;
  creativeId?: string | number | null;
  advertiserId?: string | number | null;
  renderSeq?: number;
  requestSeq?: number;
}

export interface CreativeClassification {
  source: CreativeSource;
  confidence: Confidence;
  reason: string;
  /** slotElementId#renderSeq — one classification per GPT render cycle */
  cycleId: string;
  bidder?: string;
  adId?: string;
  evidence: EvidenceItem[];
  facts: ClassificationFacts;
}

export interface RenderCycle {
  slotId: string;
  adUnitPath?: string;
  render: Envelope;
  request?: Envelope;
  response?: Envelope;
  renderSeq: number;
  requestSeq?: number;
  renderTs: number;
  isEmpty: boolean;
  targetingAtRequest?: Record<string, unknown>;
  targetingAtRender?: Record<string, unknown>;
  lineItemId?: number | null;
  creativeId?: number | null;
  advertiserId?: number | null;
  isBackfill?: boolean;
  size?: unknown;
  /** true when this cycle came from a Prebid render path (pbjs.renderAd / PUC / adRenderSucceeded) and not GPT. */
  native?: boolean;
  /** adId asserted by the render event, for native (non-GPT) cycles. */
  nativeAdId?: string;
}

interface PrebidBidSignal {
  adId?: string;
  bidder?: string;
  adUnitCode?: string;
  auctionId?: string;
  transactionId?: string;
  requestId?: string;
  cpm?: number;
  status?: string;
  seq: number;
  ts: number;
  kind: 'bidResponse' | 'bidWon' | 'adRenderSucceeded' | 'adRenderFailed' | 'renderAd' | 'puc' | 'customRenderer' | 'winningBid';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * All render cycles on the page (or filtered to one slot / ad unit).
 *
 * A render cycle is any observed creative render:
 *  - GPT `slotRenderEnded` (the usual GAM / header-bidding path), or
 *  - a Prebid-native render (`pbjs.renderAd` / PUC / `adRenderSucceeded`) for an
 *    ad unit that GPT did not render — e.g. a pure-Prebid page with no GPT.
 */
export function listRenderCycles(s: SessionState, entity?: string): RenderCycle[] {
  const cycles: RenderCycle[] = [];
  const gptSlotIds = new Set<string>();

  for (const env of s.envelopes) {
    if (env.channel !== 'gpt' || env.kind !== 'event' || env.name !== 'slotRenderEnded') continue;
    const slotId = env.slotElementId;
    if (!slotId) continue;
    gptSlotIds.add(slotId);
    if (entity && slotId !== entity && !slotMatchesEntity(s, slotId, entity)) continue;
    cycles.push(buildCycle(s, env));
  }

  for (const nc of buildPrebidNativeCycles(s, gptSlotIds)) {
    if (entity && nc.slotId !== entity && nc.adUnitPath !== entity) continue;
    cycles.push(nc);
  }

  cycles.sort((a, b) => a.renderSeq - b.renderSeq);
  return cycles;
}

/**
 * Build render cycles from Prebid render events for ad units GPT never rendered.
 * Covers pure-Prebid pages (no GPT) and direct `pbjs.renderAd` integrations.
 */
function buildPrebidNativeCycles(s: SessionState, gptSlotIds: Set<string>): RenderCycle[] {
  const cycles: RenderCycle[] = [];
  const seen = new Set<string>();

  for (const env of s.envelopes) {
    if (env.channel !== 'prebid') continue;

    let adId: string | undefined;
    let isFailure = false;
    if (env.kind === 'event' && env.name === 'adRenderSucceeded') {
      const p = env.payload as any;
      adId = p?.adId != null ? String(p.adId) : p?.bid?.adId != null ? String(p.bid.adId) : undefined;
    } else if (env.kind === 'event' && env.name === 'adRenderFailed') {
      const p = env.payload as any;
      adId = p?.adId != null ? String(p.adId) : p?.bid?.adId != null ? String(p.bid.adId) : undefined;
      isFailure = true;
    } else if (env.kind === 'api' && env.name === 'renderAd') {
      const p = env.payload as any;
      adId = p?.adId != null ? String(p.adId) : (p?.args?.[1] != null ? String(p.args[1]) : undefined);
    } else if (env.kind === 'api' && env.name === 'ucTag.renderAd') {
      const p = env.payload as any;
      const first = p?.args?.[0];
      adId =
        typeof first === 'string'
          ? first
          : first && typeof first === 'object'
            ? String(first.adId || first.hb_adid || first.adid || '')
            : undefined;
      if (!adId) adId = undefined;
    } else {
      continue;
    }
    if (!adId) continue;

    const resolved = resolveBidByAdId(s, adId);
    const slotId = resolved?.adUnitCode || env.adUnitCode || adId;
    // GPT already accounts for this ad unit's render; don't duplicate.
    if (gptSlotIds.has(slotId)) continue;

    const dedupeKey = `${slotId}#${adId}#${env.seq}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    cycles.push({
      slotId,
      adUnitPath: s.slots.get(slotId)?.adUnitPath,
      render: env,
      renderSeq: env.seq,
      renderTs: env.ts,
      isEmpty: isFailure,
      lineItemId: null,
      creativeId: null,
      advertiserId: null,
      native: true,
      nativeAdId: adId,
    });
  }

  return cycles;
}

/** Classify every render cycle (newest last). */
export function classifyAllRenderCycles(s: SessionState, entity?: string): CreativeClassification[] {
  return listRenderCycles(s, entity).map((c) => classifyRenderCycle(s, c));
}

/**
 * Latest render-cycle classification for a slot / ad-unit code.
 * Used by the left rail and GPT table badges.
 */
export function classifyCreative(s: SessionState, code: string): CreativeClassification {
  const cycles = listRenderCycles(s, code);
  if (cycles.length) return classifyRenderCycle(s, cycles[cycles.length - 1]);
  return classifyNoRender(s, code);
}

export function creativeSourceVariant(source: CreativeSource): 'default' | 'warning' | 'secondary' {
  if (source === 'PREBID') return 'default';
  if (source === 'GAM') return 'warning';
  return 'secondary';
}

export function confidenceVariant(c: Confidence): 'success' | 'outline' {
  return c === 'HIGH' ? 'success' : 'outline';
}

// ---------------------------------------------------------------------------
// Decision tree
// ---------------------------------------------------------------------------

export function classifyRenderCycle(s: SessionState, cycle: RenderCycle): CreativeClassification {
  const evidence: EvidenceItem[] = [];
  const hbAdId = scalar(cycle.targetingAtRequest?.hb_adid) || scalar(cycle.targetingAtRender?.hb_adid);
  const hbBidder = scalar(cycle.targetingAtRequest?.hb_bidder) || scalar(cycle.targetingAtRender?.hb_bidder);
  // Effective adId used for correlation: GPT hb_adid, else the adId asserted by
  // a Prebid-native render (pbjs.renderAd / PUC / adRenderSucceeded).
  const matchAdId = hbAdId || cycle.nativeAdId;

  const coverage = computePrebidCoverage(s, cycle);
  const signals = collectPrebidSignals(s, cycle);
  const win = cycleSeqWindow(s, cycle);
  const match = findStrongPrebidMatch(signals, cycle, matchAdId, hbBidder, win);
  const weak = findWeakPrebidEvidence(signals, cycle, matchAdId, hbBidder);
  const conflict = detectConflict(signals, cycle, matchAdId, match);

  const facts: ClassificationFacts = {
    slotId: cycle.slotId,
    adUnitPath: cycle.adUnitPath,
    auctionId: match?.bid.auctionId || weak?.auctionId,
    transactionId: match?.bid.transactionId || weak?.transactionId,
    requestId: match?.bid.requestId || weak?.requestId,
    prebidAdId: match?.bid.adId || weak?.adId || cycle.nativeAdId,
    hbAdId: hbAdId,
    bidder: match?.bid.bidder || hbBidder || weak?.bidder,
    prebidCoverageComplete: coverage.complete,
    bidWonObserved: signals.some((x) => x.kind === 'bidWon' && correlatesToCycle(x, cycle, matchAdId, win)),
    renderAdObserved: signals.some((x) => x.kind === 'renderAd' && correlatesToCycle(x, cycle, matchAdId, win)),
    pucObserved: signals.some((x) => x.kind === 'puc' && correlatesToCycle(x, cycle, matchAdId, win)),
    adRenderSucceeded: signals.some((x) => x.kind === 'adRenderSucceeded' && correlatesToCycle(x, cycle, matchAdId, win)),
    customRendererObserved: signals.some((x) => x.kind === 'customRenderer' && correlatesToCycle(x, cycle, matchAdId, win)),
    gptSlotRendered: !cycle.isEmpty,
    isEmpty: cycle.isEmpty,
    lineItemId: cycle.lineItemId,
    creativeId: cycle.creativeId,
    advertiserId: cycle.advertiserId,
    renderSeq: cycle.renderSeq,
    requestSeq: cycle.requestSeq,
  };

  pushCycleEvidence(evidence, cycle, coverage, hbAdId, hbBidder, signals, match, weak, conflict, facts);

  // 1) No / empty render
  if (cycle.isEmpty) {
    const reason = cycle.native ? 'PREBID_RENDER_FAILED' : 'GPT_SLOT_EMPTY';
    return finish('UNKNOWN', 'LOW', reason, cycle, evidence, facts, hbBidder, matchAdId);
  }

  // 2) Strong Prebid win/render evidence for THIS cycle → PREBID
  if (match) {
    facts.auctionId = match.bid.auctionId || facts.auctionId;
    facts.transactionId = match.bid.transactionId || facts.transactionId;
    facts.requestId = match.bid.requestId || facts.requestId;
    facts.prebidAdId = match.bid.adId || facts.prebidAdId;
    facts.bidder = match.bid.bidder || facts.bidder;
    return finish(
      'PREBID',
      'HIGH',
      match.reason,
      cycle,
      evidence,
      facts,
      match.bid.bidder,
      match.bid.adId || hbAdId
    );
  }

  // 3) Incomplete Prebid coverage → never infer GAM
  if (!coverage.complete) {
    return finish(
      'UNKNOWN',
      'LOW',
      coverage.reason || 'PREBID_COVERAGE_INCOMPLETE',
      cycle,
      evidence,
      facts,
      hbBidder,
      hbAdId
    );
  }

  // 4) Weak / unresolved / conflicting Prebid evidence → UNKNOWN
  if (conflict) {
    return finish('UNKNOWN', 'LOW', conflict, cycle, evidence, facts, hbBidder, hbAdId);
  }
  if (weak) {
    return finish(
      'UNKNOWN',
      'LOW',
      weak.reason,
      cycle,
      evidence,
      facts,
      weak.bidder || hbBidder,
      weak.adId || hbAdId
    );
  }

  // 5) Coverage complete, auction settled or clearly absent, no Prebid win/render → GAM
  const auction = auctionSettledForCycle(s, cycle);
  if (!auction.ok) {
    return finish('UNKNOWN', 'LOW', auction.reason, cycle, evidence, facts, hbBidder, hbAdId);
  }

  // Require at least one positive PubAds/GAM field before asserting GAM. Per the GPT
  // reference, advertiserId/lineItemId/creativeId are null for non-PubAds renders, so a
  // non-empty render with none of these (and no backfill) is not demonstrably a GAM fill —
  // it may be a non-GPT script writing into the div. Prefer UNKNOWN there.
  const hasGamId =
    cycle.lineItemId != null ||
    cycle.creativeId != null ||
    cycle.advertiserId != null ||
    cycle.isBackfill === true;
  if (!hasGamId) {
    return finish(
      'UNKNOWN',
      'LOW',
      'RENDERED_WITHOUT_GAM_EVIDENCE: slot rendered non-empty but no lineItemId / creativeId / advertiserId / backfill was reported, and no Prebid win/render evidence — cannot confirm a GAM/PubAds creative.',
      cycle,
      evidence,
      facts,
      hbBidder,
      hbAdId
    );
  }

  return finish(
    'GAM',
    'HIGH',
    'Non-Prebid creative rendered through GPT/GAM: Prebid coverage complete, auction settled or absent for this cycle, a PubAds line item/creative/advertiser (or backfill) was reported, and no matching Prebid win/render evidence.',
    cycle,
    evidence,
    facts,
    hbBidder,
    hbAdId
  );
}

function classifyNoRender(s: SessionState, code: string): CreativeClassification {
  const slot = s.slots.get(code);
  const evidence: EvidenceItem[] = [
    {
      label: 'slotRenderEnded',
      role: 'verdict',
      value: 'not observed for this slot',
      supports: false,
    },
  ];
  const coverage = computePrebidCoverage(s, {
    slotId: code,
    render: { seq: Number.POSITIVE_INFINITY, ts: Date.now() } as Envelope,
    renderSeq: Number.POSITIVE_INFINITY,
    renderTs: Date.now(),
  });
  evidence.push({
    label: 'prebidCoverageComplete',
    role: 'verdict',
    value: String(coverage.complete) + (coverage.reason ? ` — ${coverage.reason}` : ''),
    supports: coverage.complete,
  });
  const facts: ClassificationFacts = {
    slotId: code,
    adUnitPath: slot?.adUnitPath,
    prebidCoverageComplete: coverage.complete,
    bidWonObserved: false,
    renderAdObserved: false,
    pucObserved: false,
    adRenderSucceeded: false,
    customRendererObserved: false,
    gptSlotRendered: false,
    isEmpty: true,
    lineItemId: slot?.lineItemId,
    creativeId: slot?.creativeId,
    advertiserId: slot?.advertiserId,
  };
  return {
    source: 'UNKNOWN',
    confidence: 'LOW',
    reason: 'NO_SLOT_RENDER_ENDED',
    cycleId: `${code}#none`,
    evidence,
    facts,
  };
}

function finish(
  source: CreativeSource,
  confidence: Confidence,
  reason: string,
  cycle: RenderCycle,
  evidence: EvidenceItem[],
  facts: ClassificationFacts,
  bidder?: string,
  adId?: string
): CreativeClassification {
  return {
    source,
    confidence,
    reason,
    cycleId: `${cycle.slotId}#${cycle.renderSeq}`,
    bidder,
    adId,
    evidence,
    facts,
  };
}

// ---------------------------------------------------------------------------
// Render cycles
// ---------------------------------------------------------------------------

function buildCycle(s: SessionState, render: Envelope): RenderCycle {
  const slotId = render.slotElementId!;
  const p = (render.payload || {}) as any;
  const request = findPrecedingSlotEvent(s, slotId, 'slotRequested', render.seq);
  const response = findPrecedingSlotEvent(s, slotId, 'slotResponseReceived', render.seq);
  const targetingAtRequest =
    ((request?.payload as any)?.targeting as Record<string, unknown> | undefined) ||
    (request ? undefined : s.slots.get(slotId)?.targetingAtRequest);
  return {
    slotId,
    adUnitPath: p.adUnitPath || s.slots.get(slotId)?.adUnitPath,
    render,
    request,
    response,
    renderSeq: render.seq,
    requestSeq: request?.seq,
    renderTs: render.ts,
    isEmpty: !!p.isEmpty,
    targetingAtRequest,
    targetingAtRender: p.targeting,
    lineItemId: p.lineItemId ?? null,
    creativeId: p.creativeId ?? null,
    advertiserId: p.advertiserId ?? null,
    isBackfill: p.isBackfill,
    size: p.size,
  };
}

function findPrecedingSlotEvent(
  s: SessionState,
  slotId: string,
  name: string,
  beforeSeq: number
): Envelope | undefined {
  let last: Envelope | undefined;
  for (const env of s.envelopes) {
    if (env.seq >= beforeSeq) break;
    if (env.channel === 'gpt' && env.kind === 'event' && env.name === name && env.slotElementId === slotId) {
      last = env;
    }
  }
  return last;
}

function slotMatchesEntity(s: SessionState, slotId: string, entity: string): boolean {
  if (slotId === entity) return true;
  const slot = s.slots.get(slotId);
  return slot?.adUnitPath === entity;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

function computePrebidCoverage(
  s: SessionState,
  cycle: Pick<RenderCycle, 'slotId' | 'render' | 'renderSeq' | 'requestSeq' | 'renderTs'>
): { complete: boolean; reason?: string } {
  const hookReady = findFirst(s, (e) => e.channel === 'hook' && e.name === 'hook-ready');
  if (!hookReady) {
    return { complete: false, reason: 'Hook never reported ready — Prebid lifecycle may have been missed.' };
  }

  const cycleStartSeq = cycle.requestSeq ?? cycle.renderSeq;
  if (hookReady.seq > cycleStartSeq) {
    return {
      complete: false,
      reason: 'GPT render cycle began before BidShitter hook-ready — Prebid observation incomplete.',
    };
  }

  if (s.status.hookLate) {
    return {
      complete: false,
      reason: 'Hook attached after Prebid/GPT were already loaded — early Prebid lifecycle may be missing.',
    };
  }

  // GPT rendered before any Prebid attach while Prebid later appeared.
  const libLoaded = findFirst(s, (e) => e.channel === 'prebid' && e.name === 'libLoaded');
  if (libLoaded && libLoaded.seq > cycleStartSeq && s.status.prebidPresent) {
    return {
      complete: false,
      reason: 'GPT rendered before Prebid libLoaded was observed for this cycle.',
    };
  }

  // No Prebid on the page at all: coverage is "complete" in the sense we did not miss Prebid.
  if (!s.status.prebidPresent && !s.status.libLoaded) {
    return { complete: true, reason: 'No Prebid.js observed on the page.' };
  }

  // Prebid present: require that we subscribed before this cycle (libLoaded ≤ cycle start).
  if (s.status.prebidPresent || s.status.libLoaded) {
    if (!libLoaded || libLoaded.seq > cycleStartSeq) {
      return {
        complete: false,
        reason: 'Prebid present but instrumentation was not active before this GPT render cycle.',
      };
    }
  }

  return { complete: true };
}

function findFirst(s: SessionState, pred: (e: Envelope) => boolean): Envelope | undefined {
  for (const e of s.envelopes) if (pred(e)) return e;
  return undefined;
}

// ---------------------------------------------------------------------------
// Prebid signals
// ---------------------------------------------------------------------------

function collectPrebidSignals(s: SessionState, cycle: RenderCycle): PrebidBidSignal[] {
  const out: PrebidBidSignal[] = [];
  // Do NOT gate on a tight seq window: bidWon / adRenderSucceeded / renderAd
  // routinely fire AFTER slotRenderEnded (the GAM/PUC creative renders inside
  // the slot iframe and only then calls back into Prebid). Correlation is done
  // by adId / hb_adid / adUnitCode + timestamp proximity, not by sequence.

  const push = (raw: any, kind: PrebidBidSignal['kind'], env: Envelope, fallbackUnit?: string) => {
    if (!raw || typeof raw !== 'object') return;
    const bid = raw.bid && typeof raw.bid === 'object' ? { ...raw.bid, ...raw } : raw;
    const adUnitCode = bid.adUnitCode || bid.adUnit || fallbackUnit || env.adUnitCode;
    out.push({
      adId: bid.adId != null ? String(bid.adId) : raw.adId != null ? String(raw.adId) : undefined,
      bidder: bid.bidderCode || bid.bidder,
      adUnitCode,
      auctionId: bid.auctionId || env.auctionId,
      transactionId: bid.transactionId != null ? String(bid.transactionId) : undefined,
      requestId: bid.requestId != null ? String(bid.requestId) : undefined,
      cpm: bid.cpm,
      status: bid.status,
      seq: env.seq,
      ts: env.ts,
      kind,
    });
  };

  for (const env of s.envelopes) {
    if (env.channel === 'prebid' && env.kind === 'event') {
      if (env.name === 'bidResponse' || env.name === 'bidAccepted') push(env.payload, 'bidResponse', env);
      else if (env.name === 'bidWon') push(env.payload, 'bidWon', env);
      else if (env.name === 'adRenderSucceeded') push(env.payload, 'adRenderSucceeded', env);
      else if (env.name === 'adRenderFailed') push(env.payload, 'adRenderFailed', env);
    }
    if (env.channel === 'prebid' && env.kind === 'api' && env.name === 'renderAd') {
      const args = (env.payload as any)?.args || [];
      const adId =
        (env.payload as any)?.adId != null
          ? String((env.payload as any).adId)
          : args[1] != null
            ? String(args[1])
            : undefined;
      const resolved = adId ? resolveBidByAdId(s, adId) : undefined;
      push(
        {
          adId,
          adUnitCode: resolved?.adUnitCode || env.adUnitCode,
          auctionId: resolved?.auctionId || env.auctionId,
          bidder: resolved?.bidder,
          transactionId: resolved?.transactionId,
          requestId: resolved?.requestId,
        },
        'renderAd',
        env
      );
    }
    if (env.channel === 'prebid' && env.kind === 'api' && env.name === 'ucTag.renderAd') {
      const args = (env.payload as any)?.args || [];
      const first = args[0];
      const adId =
        (typeof first === 'object' && first && (first.adId || first.hb_adid)) ||
        (typeof first === 'string' ? first : undefined);
      push({ adId: adId != null ? String(adId) : undefined }, 'puc', env);
    }
    if (env.channel === 'prebid' && env.kind === 'api' && env.name === 'customRenderer') {
      push(env.payload, 'customRenderer', env);
    }
  }

  // Auction winningBids that land in the same time window (status / snapshot).
  for (const a of s.auctions.values()) {
    if (a.endTs && Math.abs(a.endTs - cycle.renderTs) > 120_000) continue;
    for (const b of a.winningBids as any[]) {
      if (!b) continue;
      const unit = b.adUnitCode || b.adUnit;
      if (unit && unit !== cycle.slotId) continue;
      out.push({
        adId: b.adId != null ? String(b.adId) : undefined,
        bidder: b.bidderCode || b.bidder,
        adUnitCode: unit || cycle.slotId,
        auctionId: a.auctionId,
        transactionId: b.transactionId != null ? String(b.transactionId) : undefined,
        requestId: b.requestId != null ? String(b.requestId) : undefined,
        cpm: b.cpm,
        status: b.status || 'winningBid',
        seq: cycle.renderSeq,
        ts: a.endTs || cycle.renderTs,
        kind: 'winningBid',
      });
    }
  }

  return out;
}

function resolveBidByAdId(
  s: SessionState,
  adId: string
): { adUnitCode?: string; auctionId?: string; bidder?: string; transactionId?: string; requestId?: string } | undefined {
  for (const a of s.auctions.values()) {
    for (const bag of [a.bidsReceived, a.winningBids] as unknown[][]) {
      for (const b of bag as any[]) {
        if (b?.adId != null && String(b.adId) === adId) {
          return {
            adUnitCode: b.adUnitCode || b.adUnit,
            auctionId: a.auctionId,
            bidder: b.bidderCode || b.bidder,
            transactionId: b.transactionId != null ? String(b.transactionId) : undefined,
            requestId: b.requestId != null ? String(b.requestId) : undefined,
          };
        }
      }
    }
  }
  for (const env of s.envelopes) {
    if (env.channel !== 'prebid' || env.kind !== 'event') continue;
    if (env.name !== 'bidResponse' && env.name !== 'bidWon' && env.name !== 'bidAccepted') continue;
    const p = env.payload as any;
    const bid = p?.bid && typeof p.bid === 'object' ? p.bid : p;
    if (bid?.adId != null && String(bid.adId) === adId) {
      return {
        adUnitCode: bid.adUnitCode || env.adUnitCode,
        auctionId: bid.auctionId || env.auctionId,
        bidder: bid.bidderCode || bid.bidder,
        transactionId: bid.transactionId != null ? String(bid.transactionId) : undefined,
        requestId: bid.requestId != null ? String(bid.requestId) : undefined,
      };
    }
  }
  return undefined;
}

/**
 * Sequence window that a win/render signal must fall in to belong to THIS render
 * cycle: at/after THIS slotRenderEnded and before the NEXT one for the same slot.
 *
 * Prebid win/render callbacks (bidWon / adRenderSucceeded / renderAd / PUC) fire
 * AFTER their own slotRenderEnded — the GAM/PUC creative renders inside the slot
 * iframe and only then calls back into Prebid. So the window must OPEN at this
 * cycle's own render seq, not the previous render's: otherwise a bidWon from
 * render #1 (seq > R1) would also fall inside render #2's window and leak across
 * refreshes (render #1 PREBID, render #2 GAM, ...). `lo` is compared with a strict
 * `>` at the call sites, and this cycle's own slotRenderEnded carries no Prebid
 * signal, so opening exactly at `renderSeq` is correct.
 */
function cycleSeqWindow(s: SessionState, cycle: RenderCycle): { lo: number; hi: number } {
  let lo = cycle.renderSeq;
  let hi = Number.POSITIVE_INFINITY;
  for (const env of s.envelopes) {
    if (env.channel !== 'gpt' || env.kind !== 'event' || env.name !== 'slotRenderEnded') continue;
    if (env.slotElementId !== cycle.slotId) continue;
    if (env.seq > cycle.renderSeq && env.seq < hi) hi = env.seq;
  }
  return { lo, hi };
}

function correlatesToCycle(
  sig: PrebidBidSignal,
  cycle: RenderCycle,
  hbAdId?: string,
  win?: { lo: number; hi: number }
): boolean {
  // adId correlation is unique per auction — always safe across refreshes.
  if (sig.adId && hbAdId && sig.adId === hbAdId) return true;
  if (sig.adId && scalar(cycle.targetingAtRender?.hb_adid) === sig.adId) return true;
  // adUnitCode-only correlation: constrain to this render cycle's window so a
  // win/render from a different refresh of the same slot is not reused.
  if (sig.adUnitCode && sig.adUnitCode === cycle.slotId) {
    if (!win) return true;
    return sig.seq > win.lo && sig.seq < win.hi;
  }
  return false;
}

type StrongMatch = { bid: PrebidBidSignal; reason: string; strength: 'very-strong' | 'strong' };

function findStrongPrebidMatch(
  signals: PrebidBidSignal[],
  cycle: RenderCycle,
  hbAdId?: string,
  hbBidder?: string,
  win?: { lo: number; hi: number }
): StrongMatch | undefined {
  const sameSlot = (b: PrebidBidSignal) => !b.adUnitCode || b.adUnitCode === cycle.slotId;
  const adIdMatch = (b: PrebidBidSignal) => !!(b.adId && hbAdId && b.adId === hbAdId);
  // adUnitCode-only fallbacks must land in this cycle's render window so a win/render
  // from another refresh of the same slot is not reused.
  const inWindow = (b: PrebidBidSignal) => !win || (b.seq > win.lo && b.seq < win.hi);

  // Very strong: matching adId + bidWon / adRenderSucceeded / renderAd / PUC / custom renderer
  for (const kind of ['bidWon', 'adRenderSucceeded', 'renderAd', 'puc', 'customRenderer'] as const) {
    const hit = signals.find((b) => b.kind === kind && sameSlot(b) && adIdMatch(b));
    if (hit) {
      return {
        bid: hit,
        strength: 'very-strong',
        reason: `PREBID win/render: ${kind} with matching adId/hb_adid ${hit.adId} on slot ${cycle.slotId} for this render cycle.`,
      };
    }
  }

  // matching bid + matching adId + bidWon (bid may be bidResponse paired with bidWon)
  const won = signals.find((b) => b.kind === 'bidWon' && sameSlot(b) && adIdMatch(b));
  if (won) {
    return {
      bid: won,
      strength: 'very-strong',
      reason: `PREBID: bidWon + matching hb_adid ${won.adId} for this GPT render cycle.`,
    };
  }

  // Strong: bidWon + same adUnitCode + same auction/transaction + same render cycle window
  // (even if hb_adid was not captured — still require no conflicting different adId)
  const wonSameUnit = signals
    .filter((b) => b.kind === 'bidWon' && b.adUnitCode === cycle.slotId && inWindow(b))
    .sort((a, b) => Math.abs(a.ts - cycle.renderTs) - Math.abs(b.ts - cycle.renderTs));
  if (wonSameUnit.length) {
    const best = wonSameUnit[0];
    const closeInTime = Math.abs(best.ts - cycle.renderTs) < 30_000;
    if (closeInTime && (!hbAdId || !best.adId || best.adId === hbAdId)) {
      return {
        bid: best,
        strength: 'strong',
        reason: `PREBID: bidWon for adUnitCode ${cycle.slotId} in the same render-cycle window${
          best.auctionId ? ` (auction ${best.auctionId.slice(0, 8)})` : ''
        }.`,
      };
    }
  }

  // renderAd / adRenderSucceeded for this unit without hb map (Prebid-only render path)
  for (const kind of ['adRenderSucceeded', 'renderAd', 'puc', 'customRenderer'] as const) {
    const hit = signals.find(
      (b) =>
        b.kind === kind &&
        b.adUnitCode === cycle.slotId &&
        inWindow(b) &&
        Math.abs(b.ts - cycle.renderTs) < 30_000 &&
        (!hbAdId || !b.adId || b.adId === hbAdId)
    );
    if (hit) {
      return {
        bid: hit,
        strength: 'strong',
        reason: `PREBID: ${kind} for ${cycle.slotId} correlated to this render cycle.`,
      };
    }
  }

  // Suppress unused hbBidder lint — reserved for future bidder-only strong matches (not used alone).
  void hbBidder;
  return undefined;
}

type WeakEvidence = {
  reason: string;
  adId?: string;
  bidder?: string;
  auctionId?: string;
  transactionId?: string;
  requestId?: string;
};

function findWeakPrebidEvidence(
  signals: PrebidBidSignal[],
  cycle: RenderCycle,
  hbAdId?: string,
  hbBidder?: string
): WeakEvidence | undefined {
  const bidResponses = signals.filter(
    (b) => b.kind === 'bidResponse' && (!b.adUnitCode || b.adUnitCode === cycle.slotId)
  );
  const hasHb = !!(hbAdId || hbBidder);
  const hasBid = bidResponses.length > 0 || signals.some((b) => b.kind === 'winningBid' && b.adUnitCode === cycle.slotId);

  // Spec: bidResponse + hb_* + no winning/render evidence => UNKNOWN (weak)
  if (hasBid && hasHb) {
    const b = bidResponses.find((x) => x.adId && x.adId === hbAdId) || bidResponses[0];
    return {
      reason:
        'WEAK_PREBID_EVIDENCE: bid and/or hb_* targeting exist for this slot, but no bidWon / adRenderSucceeded / renderAd / PUC evidence for this render cycle. hb_* only proves Prebid submitted demand to GAM.',
      adId: hbAdId || b?.adId,
      bidder: hbBidder || b?.bidder,
      auctionId: b?.auctionId,
      transactionId: b?.transactionId,
      requestId: b?.requestId,
    };
  }

  if (hasHb && !hasBid) {
    return {
      reason:
        'WEAK_PREBID_EVIDENCE: hb_* targeting on the slot without a correlated Prebid bid/win/render for this cycle.',
      adId: hbAdId,
      bidder: hbBidder,
    };
  }

  if (hasBid && !hasHb) {
    const b = bidResponses[0];
    return {
      reason:
        'WEAK_PREBID_EVIDENCE: Prebid bid(s) for this ad unit without matching win/render evidence on this GPT render cycle.',
      adId: b?.adId,
      bidder: b?.bidder,
      auctionId: b?.auctionId,
    };
  }

  return undefined;
}

function detectConflict(
  signals: PrebidBidSignal[],
  cycle: RenderCycle,
  hbAdId: string | undefined,
  match: StrongMatch | undefined
): string | undefined {
  if (match) return undefined;
  // bidWon for a different adId than hb_adid on the slot
  if (hbAdId) {
    const otherWon = signals.find(
      (b) => b.kind === 'bidWon' && b.adUnitCode === cycle.slotId && b.adId && b.adId !== hbAdId
    );
    if (otherWon) {
      return `CONFLICTING_EVIDENCE: bidWon adId ${otherWon.adId} ≠ slot hb_adid ${hbAdId} for this cycle.`;
    }
  }
  // adRenderFailed for the hb_adid around this cycle
  if (hbAdId) {
    const failed = signals.find((b) => b.kind === 'adRenderFailed' && b.adId === hbAdId);
    if (failed) {
      return `CONFLICTING_EVIDENCE: adRenderFailed for hb_adid ${hbAdId} around this render cycle.`;
    }
  }
  return undefined;
}

function auctionSettledForCycle(
  s: SessionState,
  cycle: RenderCycle
): { ok: boolean; reason: string } {
  const matching = [...s.auctions.values()].filter((a) => {
    if (a.adUnitCodes.includes(cycle.slotId)) return true;
    for (const bag of [a.bidsReceived, a.noBids, a.winningBids] as unknown[][]) {
      for (const bid of bag as any[]) {
        if (bid?.adUnitCode === cycle.slotId) return true;
      }
    }
    return false;
  });

  if (matching.length) {
    const done = matching.filter((a) => a.status === 'ended' || a.status === 'timeout' || a.endTs);
    // Prefer auctions that ended before or near this render
    const relevant = done.filter((a) => !a.endTs || a.endTs <= cycle.renderTs + 5_000);
    if (relevant.length) return { ok: true, reason: 'Prebid auction completed for this ad unit.' };
    if (matching.some((a) => a.status === 'inProgress')) {
      return { ok: false, reason: 'Prebid auction still in progress for this ad unit — cannot classify as GAM.' };
    }
    return { ok: false, reason: 'Prebid auction for this ad unit did not complete before this render cycle.' };
  }

  // No auction for this unit: OK only if Prebid coverage saw the page and this slot was not requested
  if (!s.status.prebidPresent && !s.status.libLoaded) {
    return { ok: true, reason: 'No Prebid.js on the page for this cycle.' };
  }
  // Prebid exists but this slot was never in an auction we saw
  return { ok: true, reason: 'No Prebid auction observed for this slot; treating as non-Prebid demand.' };
}

// ---------------------------------------------------------------------------
// Evidence UI rows
// ---------------------------------------------------------------------------

function pushCycleEvidence(
  evidence: EvidenceItem[],
  cycle: RenderCycle,
  coverage: { complete: boolean; reason?: string },
  hbAdId: string | undefined,
  hbBidder: string | undefined,
  signals: PrebidBidSignal[],
  match: StrongMatch | undefined,
  weak: WeakEvidence | undefined,
  conflict: string | undefined,
  facts: ClassificationFacts
): void {
  evidence.push({
    label: 'render cycle',
    role: 'verdict',
    value: `${cycle.native ? 'Prebid-native render' : 'GPT slot'} ${cycle.slotId} · render seq ${cycle.renderSeq}${
      cycle.requestSeq != null ? ` · request seq ${cycle.requestSeq}` : ''
    }${cycle.native && cycle.nativeAdId ? ` · adId ${cycle.nativeAdId}` : ''}`,
  });
  evidence.push({
    label: cycle.native ? 'Prebid render event' : 'slotRenderEnded',
    role: 'verdict',
    value: cycle.native
      ? `${cycle.render.name} seq ${cycle.renderSeq}${cycle.isEmpty ? ' (render failed)' : ' (rendered)'}`
      : cycle.isEmpty
        ? `seq ${cycle.renderSeq} isEmpty=true`
        : `seq ${cycle.renderSeq} isEmpty=false size=${fmt(cycle.size)}`,
    supports: !cycle.isEmpty,
  });
  evidence.push({
    label: 'prebidCoverageComplete',
    role: 'verdict',
    value: `${coverage.complete}${coverage.reason ? ` — ${coverage.reason}` : ''}`,
    supports: coverage.complete,
  });
  evidence.push({
    label: 'GPT hb_* at slotRequested',
    role: 'verdict',
    value: cycle.targetingAtRequest
      ? formatHbMap(cycle.targetingAtRequest)
      : cycle.request
        ? 'slotRequested observed but no targeting map'
        : 'no slotRequested before this render',
    supports: !!(hbAdId || hbBidder),
  });
  if (hbAdId) evidence.push({ label: 'hb_adid', role: 'verdict', value: hbAdId, supports: !!match });
  if (hbBidder) evidence.push({ label: 'hb_bidder', role: 'context', value: hbBidder });

  evidence.push({
    label: 'bidWonObserved',
    role: 'verdict',
    value: String(facts.bidWonObserved),
    supports: facts.bidWonObserved,
  });
  evidence.push({
    label: 'adRenderSucceeded',
    role: 'verdict',
    value: String(facts.adRenderSucceeded),
    supports: facts.adRenderSucceeded,
  });
  evidence.push({
    label: 'renderAdObserved',
    role: 'verdict',
    value: String(facts.renderAdObserved),
    supports: facts.renderAdObserved,
  });
  evidence.push({
    label: 'pucObserved',
    role: 'verdict',
    value: String(facts.pucObserved),
    supports: facts.pucObserved,
  });

  if (match) {
    evidence.push({
      label: 'Prebid win/render match',
      role: 'verdict',
      value: `${match.strength}: ${match.bid.kind} adId=${match.bid.adId || '—'} bidder=${match.bid.bidder || '—'} auction=${match.bid.auctionId || '—'}`,
      supports: true,
    });
  } else {
    evidence.push({
      label: 'Prebid win/render match',
      role: 'verdict',
      value: 'none for this render cycle',
      supports: false,
    });
  }

  if (weak) {
    evidence.push({ label: 'weak Prebid evidence', role: 'verdict', value: weak.reason, supports: false });
  }
  if (conflict) {
    evidence.push({ label: 'conflict', role: 'verdict', value: conflict, supports: false });
  }

  const related = signals.filter((x) => correlatesToCycle(x, cycle, hbAdId) || x.adUnitCode === cycle.slotId);
  if (related.length) {
    evidence.push({
      label: 'Prebid signals in window',
      role: 'context',
      value: related
        .map((x) => `${x.kind}:${x.bidder || '?'} adId=${x.adId || '—'}`)
        .slice(0, 12)
        .join(' | '),
    });
  }

  // Supporting GAM fields — never decisive
  evidence.push({
    label: 'GAM ids (supporting only)',
    role: 'context',
    value: `lineItemId=${fmt(cycle.lineItemId)} creativeId=${fmt(cycle.creativeId)} advertiserId=${fmt(cycle.advertiserId)} isBackfill=${fmt(cycle.isBackfill)}`,
  });
}

function formatHbMap(targeting?: Record<string, unknown>): string {
  if (!targeting) return 'no targeting map';
  const entries = Object.entries(targeting).filter(([k]) => k.startsWith('hb_'));
  if (!entries.length) return 'no hb_* keys';
  return entries
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.map(String).join(',') : v == null ? '—' : String(v)}`)
    .join(' ');
}

function scalar(v: unknown): string | undefined {
  if (v == null || v === '') return undefined;
  if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
  return String(v);
}

function fmt(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** @deprecated kept for any leftover imports — prefer classify facts */
export function unusedGamHttpCount(s: SessionState, slot: SlotRecord | undefined): number {
  if (!slot?.adUnitPath) return 0;
  return s.envelopes.filter(
    (e) =>
      e.channel === 'network' &&
      e.name === 'gamRequest' &&
      requestMatchesSlot((e.payload as any)?.iuPaths, slot.adUnitPath)
  ).length;
}
