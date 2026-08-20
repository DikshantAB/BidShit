import type { Envelope, SessionState, SlotRecord } from '../shared/types';
import type { Confidence, DiagnosticIssue, IssueEvidence } from './types';

export const FLOOR_REJECTION = 'Bid does not meet price floor';
export const PREBID_READY_MS = 10_000;
export const AUCTION_GRACE_MS = 1_500;
export const DEFAULT_AUCTION_TIMEOUT_MS = 3_000;
/** display() then refresh() inside this window is treated as a duplicate first-request (COMMON-GPT-05). */
export const GPT_DUP_REQUEST_MS = 2_000;
/** Pair bidderError / beforeBidderHttp with a DevTools HAR row inside this window. */
export const NET_MATCH_MS = 8_000;

export function named(session: SessionState, channel: Envelope['channel'], name: string): Envelope[] {
  return session.envelopes.filter((e) => e.channel === channel && e.name === name);
}

export function apis(session: SessionState, channel: Envelope['channel'], name: string): Envelope[] {
  return session.envelopes.filter((e) => e.kind === 'api' && e.channel === channel && e.name === name);
}

export function forSlot(session: SessionState, slotId: string): Envelope[] {
  return session.envelopes.filter((e) => e.slotElementId === slotId || e.adUnitCode === slotId);
}

export function lastNamed(
  session: SessionState,
  channel: Envelope['channel'],
  name: string,
  slotId?: string
): Envelope | undefined {
  const list = slotId
    ? named(session, channel, name).filter((e) => e.slotElementId === slotId || e.adUnitCode === slotId)
    : named(session, channel, name);
  return list[list.length - 1];
}

export function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

export function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export function payload(env: Envelope): Record<string, unknown> {
  return rec(env.payload);
}

/** Event payloads that are a single object or an array of objects (e.g. bidTimeout). */
export function payloadItems(env: Envelope): Record<string, unknown>[] {
  if (Array.isArray(env.payload)) return env.payload.map(rec);
  const p = rec(env.payload);
  return Object.keys(p).length ? [p] : [];
}

export function apiArgs(env: Envelope): unknown[] {
  return arr(payload(env).args);
}

export function bidOf(env: Envelope): Record<string, unknown> {
  const p = payload(env);
  const nested = rec(p.bid);
  return Object.keys(nested).length ? nested : p;
}

export function bidderOf(obj: Record<string, unknown>): string | undefined {
  return str(obj.bidder) || str(obj.bidderCode);
}

export function requestIdOf(obj: Record<string, unknown>): string | undefined {
  return str(obj.requestId) || str(obj.bidId) || str(obj.bidderRequestId);
}

export function rejectionReason(env: Envelope): string | undefined {
  const bid = bidOf(env);
  return str(bid.rejectionReason) || str(bid.reason) || str(bid.statusMessage) || str(payload(env).reason);
}

export function bootTs(session: SessionState): number {
  return named(session, 'hook', 'hook-ready')[0]?.ts ?? session.envelopes[0]?.ts ?? Date.now();
}

export function waited(fromTs: number, ms: number): boolean {
  return Date.now() - fromTs >= ms;
}

export function auctionTimeoutMs(session: SessionState, auctionId?: string): number {
  if (auctionId) {
    const auction = session.auctions.get(auctionId);
    if (typeof auction?.timeout === 'number' && auction.timeout > 0) return auction.timeout;
    const init = named(session, 'prebid', 'auctionInit').find((e) => e.auctionId === auctionId);
    const t = init ? num(payload(init).timeout) : undefined;
    if (t != null && t > 0) return t;
  }
  const cfg = rec(session.snapshots.readConfig);
  const configured = num(cfg.bidderTimeout);
  if (configured != null && configured > 0) return configured;
  return DEFAULT_AUCTION_TIMEOUT_MS;
}

export function auctionCodes(env: Envelope): string[] {
  const p = payload(env);
  const fromCodes = arr(p.adUnitCodes).map((c) => str(c)).filter((c): c is string => !!c);
  if (fromCodes.length) return fromCodes;
  return arr(p.adUnits)
    .map((u) => str(rec(u).code))
    .filter((c): c is string => !!c);
}

export function adUnitsFrom(env: Envelope): Record<string, unknown>[] {
  const p = payload(env);
  const fromEvent = arr(p.adUnits).map(rec).filter((u) => str(u.code));
  if (fromEvent.length) return fromEvent;
  const arg = apiArgs(env)[0];
  const list = Array.isArray(arg) ? arg : arg ? [arg] : [];
  return list.map(rec).filter((u) => str(u.code));
}

export function requestBidsCodes(env: Envelope): string[] {
  const arg = rec(apiArgs(env)[0]);
  const fromOpt = arr(arg.adUnitCodes)
    .concat(arg.adUnitCodes != null && !Array.isArray(arg.adUnitCodes) ? [arg.adUnitCodes] : [])
    .map((c) => str(c))
    .filter((c): c is string => !!c);
  if (fromOpt.length) return fromOpt;
  const fromUnits = arr(arg.adUnits)
    .map((u) => str(rec(u).code))
    .filter((c): c is string => !!c);
  if (fromUnits.length) return fromUnits;
  return auctionCodes(env);
}

export function slotIdForCode(session: SessionState, code: string): string | undefined {
  if (session.slots.has(code)) return code;
  for (const slot of session.slots.values()) {
    if (slot.adUnitPath === code) return slot.slotElementId;
  }
  return undefined;
}

/** Slot + Prebid targeting maps that may contain hb_* keys. */
export function slotTargeting(session: SessionState, slot: SlotRecord): Record<string, unknown> {
  return {
    ...(session.prebidTargeting[slot.slotElementId] || {}),
    ...(slot.targeting || {}),
    ...(slot.targetingAtRequest || {}),
  };
}

export function firstHb(map: Record<string, unknown>, key: string): string | undefined {
  const value = map[key];
  if (value == null || value === '') return undefined;
  return Array.isArray(value) ? String(value[0] ?? '') || undefined : String(value);
}

export function hasPrebidTargeting(session: SessionState, slot: SlotRecord): boolean {
  const map = slotTargeting(session, slot);
  return !!(firstHb(map, 'hb_adid') || firstHb(map, 'hb_bidder'));
}

/** Bids with a positive CPM for one ad unit. Shared by PB-11 and the integration family. */
export function eligibleBids(list: unknown[], code: string): Record<string, unknown>[] {
  return arr(list)
    .map(rec)
    .filter((b) => str(b.adUnitCode) === code)
    .filter((b) => {
      const cpm = num(b.cpm);
      return cpm != null && cpm > 0;
    });
}

export function hbKeysOf(map: Record<string, unknown>): string[] {
  return Object.keys(map).filter((k) => k.startsWith('hb_') && !!firstHb(map, k));
}

export function hasHbKeys(map: Record<string, unknown>): boolean {
  return hbKeysOf(map).length > 0;
}

export function absenceConfidence(session: SessionState): Confidence {
  if (session.status.hookLate || session.dropped > 0) return 'possible';
  return 'likely';
}

export function evidenceFrom(env: Envelope | undefined, summary: string, eventType?: string): IssueEvidence {
  return {
    timestamp: env?.ts || Date.now(),
    eventType: eventType || env?.name,
    summary,
  };
}

export function issue(partial: DiagnosticIssue): DiagnosticIssue {
  return partial;
}
