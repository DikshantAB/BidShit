import {
  adIdOf,
  apiArgs,
  bidOf,
  confidenceForAbsence,
  defineRule,
  fromEvent,
  groupBy,
  lastOf,
  num,
  payload,
  rec,
  str,
} from '../helpers';
import { THRESHOLDS } from '../thresholds';
import type { DiagnosticIssue, Rule, RuleMeta } from '../types';

function meta(
  id: string,
  title: string,
  severity: RuleMeta['severity'],
  explanation: string,
  checks: string[],
  recommendations: string[]
): RuleMeta {
  return { id, title, severity, scope: 'prebid', explanation, checks, recommendations };
}

export const prebidRenderRules: Rule[] = [
  defineRule(
    meta(
      'PB-21',
      'Render attempted before auction completion',
      'high',
      'renderAd/bidWon occurs before auctionEnd for the same auction.',
      ['Compare renderAd/bidWon time with auctionEnd'],
      ['Wait for auction completion before rendering']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      const ends = ctx.named('prebid', 'auctionEnd');
      for (const env of [...ctx.apis('prebid', 'renderAd'), ...ctx.named('prebid', 'bidWon')]) {
        const end = ends.find((e) => e.auctionId && e.auctionId === env.auctionId);
        if (end && env.ts >= end.ts) continue;
        if (!env.auctionId) continue;
        const init = ctx.named('prebid', 'auctionInit').find((e) => e.auctionId === env.auctionId);
        if (!init) continue;
        if (end && env.ts < end.ts) {
          out.push(fromEvent(find('PB-21'), env, ctx, 'confirmed', `${env.name} before auctionEnd`));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-22',
      'Render called with a missing or unknown adId',
      'critical',
      'renderAd is called without adId, or adId is not in the auction.',
      ['Inspect renderAd arguments', 'known bid adIds'],
      ['Render only a known winning adId']
    ),
    (ctx) => {
      const known = new Set<string>();
      for (const env of ctx.named('prebid', 'bidResponse').concat(ctx.named('prebid', 'bidWon'))) {
        const id = adIdOf(env);
        if (id) known.add(id);
      }
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('prebid', 'renderAd')) {
        const adId = str(payload(env).adId) || str(apiArgs(env)[1]);
        if (!adId) {
          out.push(fromEvent(find('PB-22'), env, ctx, 'confirmed', 'renderAd missing adId'));
          continue;
        }
        if (known.size && !known.has(adId)) {
          out.push(fromEvent(find('PB-22'), env, ctx, 'confirmed', `unknown adId ${adId}`));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-23',
      'Render attempted on the main page document',
      'high',
      'renderAd document argument looks like the page document rather than a creative frame.',
      ['Inspect renderAd first argument type'],
      ['Render into the GPT/Prebid creative document']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('prebid', 'renderAd')) {
        const doc = rec(apiArgs(env)[0]);
        const type = str(doc.__type) || '';
        // Hook always summarizes Document; cannot distinguish top vs iframe from the summary alone.
        if (type === 'Document' && ctx.named('gpt', 'slotRenderEnded').length === 0) {
          out.push(fromEvent(find('PB-23'), env, ctx, 'possible', 'renderAd Document with no GPT render cycle'));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-24',
      'Winning bid has no renderable creative',
      'critical',
      'Winning bid has stripped/missing ad markup and render fails or never starts.',
      ['Inspect winning bid ad/vast fields (stripped)', 'adRenderFailed'],
      ['Ensure the winning bid includes renderable creative data']
    ),
    (ctx) =>
      ctx
        .named('prebid', 'adRenderFailed')
        .filter((e) => /cannotFindAd|no ad|missing creative|empty ad/i.test(JSON.stringify(payload(e))))
        .map((e) => fromEvent(find('PB-24'), e, ctx, 'confirmed', 'winning bid not renderable'))
  ),
  defineRule(
    meta(
      'PB-25',
      'Creative render throws an exception',
      'critical',
      'adRenderFailed or renderAd threw.',
      ['Inspect adRenderFailed.reason', 'renderAd.threw'],
      ['Fix the creative/renderer exception']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'adRenderFailed')) {
        out.push(fromEvent(find('PB-25'), env, ctx, 'confirmed', str(payload(env).reason) || 'adRenderFailed'));
      }
      for (const env of ctx.apis('prebid', 'renderAd')) {
        const threw = str(payload(env).threw);
        if (threw) out.push(fromEvent(find('PB-25'), env, ctx, 'confirmed', `renderAd threw: ${threw}`));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-26',
      'Bid is rendered more than once',
      'high',
      'The same adId is rendered twice.',
      ['Count renderAd / adRenderSucceeded per adId'],
      ['Render a bid once unless a new auction produced a new adId']
    ),
    (ctx) => {
      const groups = groupBy(
        [...ctx.apis('prebid', 'renderAd'), ...ctx.named('prebid', 'adRenderSucceeded')],
        (e) => adIdOf(e) || str(payload(e).adId)
      );
      const out: DiagnosticIssue[] = [];
      for (const [id, list] of groups) {
        if (!id || list.length < 2) continue;
        out.push(fromEvent(find('PB-26'), list[1], ctx, 'confirmed', `adId ${id} rendered ${list.length} times`));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-27',
      'Bid is rendered after TTL expiry',
      'high',
      'expiredRender fires, or render time exceeds bid.ttl.',
      ['Compare render time with bid ttl'],
      ['Re-auction instead of rendering an expired bid']
    ),
    (ctx) => ctx.named('prebid', 'expiredRender').map((e) => fromEvent(find('PB-27'), e, ctx, 'confirmed', 'expiredRender'))
  ),
  defineRule(
    meta(
      'PB-28',
      'Browser blocks the creative',
      'high',
      'browserIntervention fires during render.',
      ['Inspect browserIntervention payload'],
      ['Address the browser intervention; do not evade user protections']
    ),
    (ctx) =>
      ctx.named('prebid', 'browserIntervention').map((e) => fromEvent(find('PB-28'), e, ctx, 'confirmed', 'browserIntervention'))
  ),
  defineRule(
    meta(
      'PB-29',
      'Deferred billing never triggers',
      'medium',
      'A render that requires triggerBilling/billableEvent never produces one after the wait threshold.',
      ['Inspect triggerBilling wraps', 'billableEvent'],
      ['Call triggerBilling when the integration requires deferred billing']
    ),
    (ctx) => {
      const renders = ctx.named('prebid', 'adRenderSucceeded');
      const billed = ctx.named('prebid', 'billableEvent').concat(ctx.apis('prebid', 'triggerBilling'));
      if (!renders.length || billed.length) return [];
      const last = lastOf(renders)!;
      if (ctx.elapsedSince(last) < THRESHOLDS.gamRenderMs) return [];
      return [fromEvent(find('PB-29'), last, ctx, 'possible', 'no billableEvent after adRenderSucceeded')];
    }
  ),
  defineRule(
    meta(
      'PB-30',
      'Consent enforcement blocks demand or data',
      'high',
      'tcf2Enforcement reports a blocked activity.',
      ['Inspect tcf2Enforcement'],
      ['Review consent state and activity controls']
    ),
    (ctx) =>
      ctx
        .named('prebid', 'tcf2Enforcement')
        .filter((e) => {
          const p = payload(e);
          return p.blocked === true || /block/i.test(JSON.stringify(p));
        })
        .map((e) => fromEvent(find('PB-30'), e, ctx, 'confirmed', 'tcf2Enforcement blocked activity'))
  ),
  defineRule(
    meta(
      'PB-31',
      'Prebid Server request does not complete',
      'high',
      'beforePBSHttp occurs without a later pbsAnalytics/bidResponse/noBid/bidderError for that auction.',
      ['Inspect beforePBSHttp vs later PBS outcomes'],
      ['Fix PBS endpoint/network/timeout']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'beforePBSHttp')) {
        const later = ctx.envelopes.filter(
          (e) =>
            e.channel === 'prebid' &&
            e.ts >= env.ts &&
            e.auctionId === env.auctionId &&
            ['pbsAnalytics', 'bidResponse', 'noBid', 'bidderError', 'auctionEnd'].includes(e.name)
        );
        if (later.length) continue;
        const wait = THRESHOLDS.auctionStallFallbackMs;
        if (ctx.elapsedSince(env) < wait) continue;
        out.push(fromEvent(find('PB-31'), env, ctx, confidenceForAbsence(ctx), 'PBS request did not complete'));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-42',
      'Configured CMP is unavailable',
      'high',
      'Consent config exists but CMP/enforcement never produces metadata.',
      ['Inspect consentManagement config', 'getConsentMetadata snapshot'],
      ['Load the CMP before the auction']
    ),
    (ctx) => {
      let wantsCmp = false;
      for (const env of ctx.apis('prebid', 'setConfig')) {
        const cfg = rec(apiArgs(env)[0]);
        if (cfg.consentManagement) wantsCmp = true;
      }
      if (!wantsCmp) return [];
      if (ctx.named('prebid', 'tcf2Enforcement').length) return [];
      const snap = ctx.named('prebid', 'getConsentMetadata')[0];
      if (snap && rec(payload(snap)).gdpr != null) return [];
      const ready = ctx.named('prebid', 'libLoaded')[0];
      if (!ready || ctx.elapsedSince(ready) < THRESHOLDS.prebidReadyMs) return [];
      return [fromEvent(find('PB-42'), ready, ctx, 'possible', 'consentManagement configured but CMP metadata absent')];
    }
  ),
  defineRule(
    meta(
      'PB-43',
      'CMP response exceeds its timeout',
      'high',
      'Auction proceeds after consent timeout.',
      ['Inspect consent timeout vs auctionInit'],
      ['Ensure CMP responds within timeout']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'auctionDebug')) {
        if (!/consent.*timeout|cmp.*timeout/i.test(JSON.stringify(payload(env)))) continue;
        out.push(fromEvent(find('PB-43'), env, ctx, 'confirmed', 'CMP timeout mentioned in auctionDebug'));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-44',
      'GPP data or configuration is invalid',
      'high',
      'GPP configuration or string is invalid.',
      ['Inspect gpp config / auctionDebug'],
      ['Correct GPP configuration']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of [...ctx.named('prebid', 'auctionDebug'), ...ctx.apis('prebid', 'setConfig')]) {
        if (!/gpp/i.test(JSON.stringify(payload(env)))) continue;
        if (!/invalid|malformed|error/i.test(JSON.stringify(payload(env)))) continue;
        out.push(fromEvent(find('PB-44'), env, ctx, 'likely', 'GPP configuration looks invalid'));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-45',
      'Activity controls block an auction operation',
      'high',
      'Activity control denies transmitEids, fetchBids, or similar.',
      ['Inspect tcf2Enforcement / activity controls'],
      ['Review activity control configuration']
    ),
    (ctx) =>
      ctx
        .named('prebid', 'tcf2Enforcement')
        .filter((e) => /activity|transmitEids|fetchBids|syncUser/i.test(JSON.stringify(payload(e))))
        .map((e) => fromEvent(find('PB-45'), e, ctx, 'likely', 'activity control enforcement'))
  ),
  defineRule(
    meta(
      'PB-46',
      'User ID resolution delays bidder requests',
      'medium',
      'Long gap between auctionInit and bidRequested while userId config is present.',
      ['Compare auctionInit vs bidRequested', 'userSync/userId config'],
      ['Bound userId timeout so it cannot consume the auction']
    ),
    (ctx) => {
      let hasUserId = false;
      for (const env of ctx.apis('prebid', 'setConfig')) {
        if (rec(apiArgs(env)[0]).userSync || rec(apiArgs(env)[0]).userId) hasUserId = true;
      }
      if (!hasUserId) return [];
      const out: DiagnosticIssue[] = [];
      for (const init of ctx.named('prebid', 'auctionInit')) {
        const first = ctx.named('prebid', 'bidRequested').find((e) => e.auctionId === init.auctionId);
        if (!first) continue;
        if (first.ts - init.ts < 400) continue;
        out.push(fromEvent(find('PB-46'), first, ctx, 'possible', `bidRequested ${first.ts - init.ts}ms after auctionInit`));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-47',
      'RTD enrichment delays bidder requests',
      'medium',
      'Long gap between auctionInit and bidRequested while realTimeData config is present.',
      ['Inspect realTimeData config', 'auctionInit → bidRequested gap'],
      ['Bound RTD timeout']
    ),
    (ctx) => {
      let hasRtd = false;
      for (const env of ctx.apis('prebid', 'setConfig')) {
        if (rec(apiArgs(env)[0]).realTimeData) hasRtd = true;
      }
      if (!hasRtd) return [];
      const out: DiagnosticIssue[] = [];
      for (const init of ctx.named('prebid', 'auctionInit')) {
        const first = ctx.named('prebid', 'bidRequested').find((e) => e.auctionId === init.auctionId);
        if (!first) continue;
        if (first.ts - init.ts < 400) continue;
        out.push(fromEvent(find('PB-47'), first, ctx, 'possible', `RTD may have delayed bidRequested by ${first.ts - init.ts}ms`));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-71',
      'Custom renderer fails',
      'high',
      'adRenderFailed mentions renderer, or custom renderer path errors.',
      ['Inspect adRenderFailed', 'renderer config'],
      ['Fix the custom renderer']
    ),
    (ctx) =>
      ctx
        .named('prebid', 'adRenderFailed')
        .filter((e) => /renderer/i.test(JSON.stringify(payload(e))))
        .map((e) => fromEvent(find('PB-71'), e, ctx, 'confirmed', 'custom renderer failed'))
  ),
  defineRule(
    meta(
      'PB-72',
      'Video cache entry is missing, failed, or expired',
      'high',
      'Video render fails due to cache id/host.',
      ['Inspect hb_cache_id / video cache'],
      ['Fix video cache configuration']
    ),
    (ctx) =>
      ctx
        .named('prebid', 'adRenderFailed')
        .concat(ctx.named('prebid', 'bidRejected'))
        .filter((e) => /cache/i.test(JSON.stringify(payload(e))))
        .map((e) => fromEvent(find('PB-72'), e, ctx, 'likely', 'video cache failure'))
  ),
];

const BY_ID = new Map(prebidRenderRules.map((r) => [r.id, r]));
function find(id: string): RuleMeta {
  return BY_ID.get(id)!;
}

void num;
void bidOf;
