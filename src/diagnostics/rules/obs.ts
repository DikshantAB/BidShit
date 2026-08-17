import { defineRule, envFingerprint, evidenceFrom, fromEvent, groupBy, issue, unique } from '../helpers';
import { THRESHOLDS } from '../thresholds';
import type { DiagnosticIssue, Rule } from '../types';

const OPTIONAL_EVENTS = new Set(['slotOnload', 'impressionViewable', 'bidWon', 'bidViewable', 'billableEvent']);

export const obsRules: Rule[] = [
  defineRule(
    {
      id: 'OBS-01',
      title: 'BidShitter attached after the lifecycle started',
      severity: 'medium',
      scope: 'observation',
      explanation:
        'The first observed event is in the middle of an auction or GPT request; prerequisite events are absent.',
      checks: [
        'Compare extension session start with performance.timeOrigin',
        'Inspect Prebid event history / getEvents backfill',
        'Inspect first captured network request vs hook-ready',
      ],
      recommendations: [
        'Mark earlier stages as not observed, not failed',
        'Reload the page with BidShitter recording from document_start',
      ],
    },
    (ctx) => {
      if (!ctx.session.status.hookLate) return [];
      const hook = ctx.named('hook', 'hook-ready')[0];
      return [
        issue(obsMeta('OBS-01'), ctx, {
          confidence: 'confirmed',
          evidence: hook
            ? [evidenceFrom(hook, 'hook-ready reported Prebid or GPT already loaded')]
            : [{ timestamp: ctx.now, summary: 'status.hookLate is true' }],
        }),
      ];
    }
  ),

  defineRule(
    {
      id: 'OBS-02',
      title: 'Events from different auctions are combined',
      severity: 'high',
      scope: 'observation',
      explanation:
        'Bid responses, targeting, or timeouts have different auctionId values but appear in one overlapping lifecycle.',
      checks: ['Compare auctionId', 'Compare request timestamps and requestId', 'Compare refresh invocation time'],
      recommendations: [
        'Partition Prebid state by auctionId',
        'Associate each GPT request with the most recent targeting/refresh cycle for that slot',
      ],
    },
    (ctx) => {
      const inits = ctx.named('prebid', 'auctionInit');
      const ends = new Set(
        [...ctx.named('prebid', 'auctionEnd'), ...ctx.named('prebid', 'auctionTimeout')]
          .map((e) => e.auctionId)
          .filter(Boolean)
      );
      const open = inits.filter((e) => e.auctionId && !ends.has(e.auctionId));
      const byUnit = groupBy(open, (e) => e.adUnitCode);
      const out: DiagnosticIssue[] = [];
      for (const [code, list] of byUnit) {
        const ids = unique(list.map((e) => e.auctionId));
        if (ids.length < 2) continue;
        out.push(
          issue(obsMeta('OBS-02'), ctx, {
            confidence: 'confirmed',
            adUnitCode: code,
            auctionId: ids[0],
            evidence: list.slice(0, 4).map((e) =>
              evidenceFrom(e, `overlapping auctionInit ${e.auctionId} for ${code}`)
            ),
            explanation: `Ad unit ${code} has overlapping auctions: ${ids.join(', ')}.`,
          })
        );
      }
      return out;
    }
  ),

  defineRule(
    {
      id: 'OBS-03',
      title: 'Events from different slots are combined',
      severity: 'high',
      scope: 'observation',
      explanation: 'Bid adUnitCode, GPT element ID, or GAM ad unit path changes within one displayed lifecycle.',
      checks: ['Compare adUnitCode', 'Compare getSlotElementId()', 'Compare getAdUnitPath()'],
      recommendations: ['Filter and correlate per slot', 'Show cross-slot activity separately'],
    },
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.envelopes) {
        if (!env.adUnitCode || !env.slotElementId) continue;
        if (env.adUnitCode === env.slotElementId) continue;
        const hasUnit = ctx.session.adUnits.has(env.adUnitCode);
        const hasSlot = ctx.session.slots.has(env.slotElementId);
        if (!hasUnit || !hasSlot) continue;
        if (ctx.session.adUnits.has(env.slotElementId) || ctx.session.slots.has(env.adUnitCode)) {
          out.push(
            fromEvent(obsMeta('OBS-03'), env, ctx, 'likely', `event mixes adUnitCode=${env.adUnitCode} with slot=${env.slotElementId}`)
          );
        }
      }
      return dedupeByRuleSlot(out);
    }
  ),

  defineRule(
    {
      id: 'OBS-04',
      title: 'A missing optional event is reported as an error',
      severity: 'info',
      scope: 'observation',
      explanation:
        'slotOnload, impressionViewable, bidWon, or module-specific events are optional unless their preconditions are met.',
      checks: ['Identify media type and render mode', 'Identify winning demand source', 'Inspect installedModules'],
      recommendations: ['Classify the event as not applicable or pending unless documented preconditions are satisfied'],
    },
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const slot of ctx.session.slots.values()) {
        if (!slot.filled) continue;
        const envs = ctx.forSlot(slot.slotElementId);
        const names = new Set(envs.map((e) => e.name));
        const missing = [...OPTIONAL_EVENTS].filter((n) => !names.has(n));
        if (!missing.length) continue;
        const render = envs.find((e) => e.name === 'slotRenderEnded');
        if (!render) continue;
        out.push(
          issue(obsMeta('OBS-04'), ctx, {
            confidence: 'confirmed',
            slotId: slot.slotElementId,
            evidence: [
              evidenceFrom(render, `filled slot is missing optional events: ${missing.join(', ')}`),
            ],
            explanation: `Do not treat missing ${missing.join(', ')} as a serving failure for ${slot.slotElementId}.`,
          })
        );
      }
      return out;
    }
  ),

  defineRule(
    {
      id: 'OBS-05',
      title: 'Duplicate listeners produce duplicate records',
      severity: 'medium',
      scope: 'observation',
      explanation: 'Identical events with effectively identical timestamps and payload identifiers appear multiple times.',
      checks: ['Count listener-registration cycles', 'Compare payload object IDs / sequence values'],
      recommendations: ['Make collector registration idempotent', 'Retain the exact handler reference for removal'],
    },
    (ctx) => {
      const groups = groupBy(ctx.envelopes.filter((e) => e.kind === 'event'), envFingerprint);
      const out: DiagnosticIssue[] = [];
      for (const [, list] of groups) {
        if (list.length < 2) continue;
        for (let i = 1; i < list.length; i++) {
          if (Math.abs(list[i].ts - list[i - 1].ts) <= THRESHOLDS.duplicateEventMs) {
            out.push(
              fromEvent(
                obsMeta('OBS-05'),
                list[i],
                ctx,
                'likely',
                `duplicate ${list[i].channel}:${list[i].name} within ${THRESHOLDS.duplicateEventMs}ms`
              )
            );
            break;
          }
        }
      }
      return dedupeByRuleSlot(out);
    }
  ),

  defineRule(
    {
      id: 'OBS-06',
      title: 'Listener removed with a different function reference',
      severity: 'low',
      scope: 'observation',
      explanation: 'GPT or Prebid events continue after code claims to have unsubscribed.',
      checks: ['Inspect registration and removal call sites'],
      recommendations: ['Store and reuse the original callback reference'],
    },
    () => []
  ),

  defineRule(
    {
      id: 'OBS-07',
      title: 'Page spoofing or malformed diagnostic messages',
      severity: 'high',
      scope: 'observation',
      explanation: 'Extension messages contain unknown event names, invalid types, oversized payloads, or impossible identifiers.',
      checks: ['Validate schema, source marker, size limit', 'Allowed event names', 'Sequence monotonicity'],
      recommendations: ['Treat page-originated data as untrusted', 'Sanitize in the bridge and panel'],
    },
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      let prevSeq = -1;
      const allowedChannels = new Set(['prebid', 'gpt', 'hook', 'network']);
      const allowedKinds = new Set(['event', 'api', 'snapshot', 'status', 'error']);
      for (const env of ctx.envelopes) {
        const badChannel = !allowedChannels.has(env.channel);
        const badKind = !allowedKinds.has(env.kind);
        const badName = !env.name;
        const seqJump = prevSeq >= 0 && env.seq < prevSeq && env.channel !== 'network';
        prevSeq = env.seq;
        if (!badChannel && !badKind && !badName && !seqJump) continue;
        out.push(
          fromEvent(
            obsMeta('OBS-07'),
            env,
            ctx,
            'confirmed',
            `malformed envelope kind=${env.kind} channel=${env.channel} name=${env.name} seq=${env.seq}`
          )
        );
      }
      return out.slice(0, 20);
    }
  ),

  defineRule(
    {
      id: 'OBS-08',
      title: 'Refresh or transaction identifiers overlap across cycles',
      severity: 'high',
      scope: 'observation',
      explanation:
        'Events with different auctions or refreshes share a transaction/cycle identifier, or one refresh is associated with bids from another lifecycle.',
      checks: ['Compare auctionId, transaction ID, adUnitCode, requestId, refresh time'],
      recommendations: ['Generate unique identifiers per logical lifecycle', 'Correlate using auction, slot, request, and time boundaries'],
    },
    (ctx) => {
      const inits = groupBy(
        ctx.named('prebid', 'auctionInit').filter((e) => e.auctionId),
        (e) => e.auctionId
      );
      const out: DiagnosticIssue[] = [];
      for (const [id, list] of inits) {
        if (list.length < 2) continue;
        out.push(
          fromEvent(
            obsMeta('OBS-08'),
            list[1],
            ctx,
            'confirmed',
            `auctionId ${id} reused on ${list.length} auctionInit events`,
            { auctionId: id }
          )
        );
      }
      return out;
    }
  ),
];

const META = new Map(obsRules.map((r) => [r.id, r]));

function obsMeta(id: string) {
  return META.get(id)!;
}

function dedupeByRuleSlot(issues: DiagnosticIssue[]): DiagnosticIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.ruleId}|${i.slotId ?? ''}|${i.adUnitCode ?? ''}|${i.auctionId ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
