import type { Envelope } from '../shared/types';
import type { Confidence, DiagnosticIssue, DiagContext, EvidenceItem, Rule, RuleMeta, Severity } from './types';

export function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

export function payload(env?: Envelope): Record<string, unknown> {
  return rec(env?.payload);
}

export function apiArgs(env?: Envelope): unknown[] {
  return arr(payload(env).args);
}

export function bidOf(env?: Envelope): Record<string, unknown> {
  const p = payload(env);
  const nested = rec(p.bid);
  return Object.keys(nested).length ? nested : p;
}

export function rejectionReason(env?: Envelope): string {
  const p = payload(env);
  const bid = bidOf(env);
  return String(p.reason ?? p.rejectionReason ?? bid.rejectionReason ?? '');
}

export function bidderOf(env?: Envelope): string | undefined {
  const p = payload(env);
  const bid = bidOf(env);
  return str(bid.bidderCode) || str(bid.bidder) || str(p.bidderCode) || str(p.bidder);
}

export function adIdOf(env?: Envelope): string | undefined {
  const bid = bidOf(env);
  return str(bid.adId) || str(payload(env).adId);
}

export function requestIdOf(env?: Envelope): string | undefined {
  const bid = bidOf(env);
  return str(bid.requestId) || str(payload(env).requestId);
}

export function targetingMap(v: unknown): Record<string, unknown> {
  return rec(v);
}

export function hbKeys(map: Record<string, unknown>): string[] {
  return Object.keys(map).filter((k) => k === 'hb' || k.startsWith('hb_'));
}

export function hasHb(map: Record<string, unknown>): boolean {
  return hbKeys(map).length > 0;
}

export function evidenceFrom(env: Envelope, summary: string): EvidenceItem {
  return {
    eventType: `${env.channel}:${env.name}`,
    timestamp: env.ts,
    summary,
  };
}

export function issue(
  rule: RuleMeta,
  ctx: DiagContext,
  opts: {
    confidence: Confidence;
    evidence: EvidenceItem[];
    slotId?: string;
    auctionId?: string;
    adUnitCode?: string;
    cycleId?: string;
    explanation?: string;
  }
): DiagnosticIssue {
  const ev = opts.evidence[0];
  return {
    ruleId: rule.id,
    title: rule.title,
    severity: rule.severity,
    confidence: opts.confidence,
    scope: rule.scope,
    slotId: opts.slotId,
    auctionId: opts.auctionId,
    adUnitCode: opts.adUnitCode,
    cycleId: opts.cycleId,
    detectedAt: ev?.timestamp ?? ctx.now,
    evidence: opts.evidence,
    explanation: opts.explanation ?? rule.explanation,
    checks: rule.checks,
    recommendations: rule.recommendations,
  };
}

export function defineRule(meta: RuleMeta, evaluate: Rule['evaluate']): Rule {
  return { ...meta, evaluate };
}

export function fromEvent(
  meta: RuleMeta,
  env: Envelope,
  ctx: DiagContext,
  confidence: Confidence,
  summary: string,
  extra?: Partial<Pick<DiagnosticIssue, 'slotId' | 'auctionId' | 'adUnitCode' | 'explanation'>>
): DiagnosticIssue {
  const p = payload(env);
  return issue(meta, ctx, {
    confidence,
    evidence: [evidenceFrom(env, summary)],
    slotId: extra?.slotId ?? env.slotElementId,
    auctionId: extra?.auctionId ?? env.auctionId ?? str(p.auctionId),
    adUnitCode: extra?.adUnitCode ?? env.adUnitCode ?? str(bidOf(env).adUnitCode),
    explanation: extra?.explanation,
  });
}

export function rejectMatching(
  meta: RuleMeta,
  needle: string | RegExp,
  confidence: Confidence = 'confirmed'
): Rule {
  const test =
    typeof needle === 'string'
      ? (r: string) => r.toLowerCase().includes(needle.toLowerCase())
      : (r: string) => needle.test(r);
  return defineRule(meta, (ctx) => {
    const out: DiagnosticIssue[] = [];
    for (const env of ctx.named('prebid', 'bidRejected')) {
      const reason = rejectionReason(env);
      if (!test(reason)) continue;
      out.push(fromEvent(meta, env, ctx, confidence, `bidRejected: ${reason || meta.title}`));
    }
    return out;
  });
}

export function firstBy<T>(items: T[], pred: (item: T) => boolean): T | undefined {
  for (const item of items) if (pred(item)) return item;
}

export function lastOf<T>(items: T[]): T | undefined {
  return items.length ? items[items.length - 1] : undefined;
}

export function groupBy<T>(items: T[], keyFn: (item: T) => string | undefined): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

export function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

export function envFingerprint(env: Envelope): string {
  const bid = bidOf(env);
  return [
    env.channel,
    env.name,
    env.auctionId ?? '',
    env.adUnitCode ?? '',
    env.slotElementId ?? '',
    requestIdOf(env) ?? '',
    adIdOf(env) ?? '',
    bidderOf(env) ?? '',
    str(bid.auctionId) ?? '',
  ].join('|');
}

export function codesOfAuctionPayload(p: Record<string, unknown>): string[] {
  const fromCodes = arr(p.adUnitCodes).map((c) => str(c)).filter((c): c is string => !!c);
  if (fromCodes.length) return fromCodes;
  return arr(p.adUnits)
    .map((u) => str(rec(u).code))
    .filter((c): c is string => !!c);
}

export function isHbKey(key: string): boolean {
  return key === 'hb' || key.startsWith('hb_');
}

export const REQUIRED_HB_KEYS = ['hb_bidder', 'hb_pb', 'hb_adid', 'hb_size'] as const;

export function confidenceForAbsence(ctx: DiagContext): Confidence {
  if (!ctx.observedFromStart) return 'possible';
  return 'likely';
}

export function severityInfoIfLate(ctx: DiagContext, severity: Severity): Severity {
  return ctx.observedFromStart ? severity : severity === 'info' ? 'info' : severity;
}

export function slotTargeting(env: Envelope): Record<string, unknown> {
  const p = payload(env);
  return targetingMap(p.targeting ?? p.slotTargeting ?? p.targetingMap);
}
