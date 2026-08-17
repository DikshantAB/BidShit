import {
  apiArgs,
  arr,
  bidOf,
  codesOfAuctionPayload,
  confidenceForAbsence,
  defineRule,
  evidenceFrom,
  fromEvent,
  groupBy,
  issue,
  lastOf,
  num,
  payload,
  rec,
  str,
  unique,
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

export const prebidLifecycleRules: Rule[] = [
  defineRule(
    meta(
      'PB-01',
      'Prebid never becomes ready',
      'critical',
      'window.pbjs is absent or queued callbacks never execute; there are no Prebid lifecycle events.',
      ['Inspect the Prebid script request', 'console errors', 'pbjs.libLoaded / version', 'pbjs.que length'],
      ['Fix the script URL/load error or blocking policy', 'Do not call public APIs until the Prebid queue runs']
    ),
    (ctx) => {
      const intended =
        ctx.apis('prebid', 'que.push').length +
          ctx.apis('prebid', 'cmd.push').length +
          ctx.named('prebid', 'que.push').length >
        0;
      if (!intended) return [];
      if (ctx.session.status.libLoaded || ctx.named('prebid', 'libLoaded').length) return [];
      const hook = ctx.named('hook', 'hook-ready')[0];
      if (!hook || ctx.elapsedSince(hook) < THRESHOLDS.prebidReadyMs) return [];
      return [
        issue(prebidLifecycleRules[0], ctx, {
          confidence: confidenceForAbsence(ctx),
          evidence: [evidenceFrom(hook, 'Prebid queue activity observed but libLoaded never fired')],
        }),
      ];
    }
  ),

  defineRule(
    meta(
      'PB-02',
      'requestBids called before ad units exist',
      'critical',
      'requestBids/auctionInit occurs with no applicable adUnits or adUnitCodes; no bidRequested follows.',
      ['Inspect pbjs.adUnits', 'RequestBidsOptions.adUnits', 'adUnitCodes at request time'],
      ['Add and validate ad units before starting the auction']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('prebid', 'requestBids')) {
        const opts = rec(apiArgs(env)[0]);
        const codes = arr(opts.adUnitCodes).map(str).filter((c): c is string => !!c);
        const units = arr(opts.adUnits);
        const hasInline = codes.length > 0 || units.length > 0;
        const globalUnits = ctx.session.adUnits.size > 0;
        const init = ctx.named('prebid', 'auctionInit').find((e) => e.ts >= env.ts);
        const initCodes = init ? codesOfAuctionPayload(payload(init)) : [];
        if (hasInline || globalUnits || initCodes.length) continue;
        const requested = ctx.named('prebid', 'bidRequested').some((e) => e.ts >= env.ts);
        if (requested) continue;
        out.push(fromEvent(find('PB-02'), env, ctx, 'confirmed', 'requestBids ran with no ad units'));
      }
      for (const env of ctx.named('prebid', 'auctionInit')) {
        if (codesOfAuctionPayload(payload(env)).length) continue;
        if (ctx.named('prebid', 'bidRequested').some((e) => e.auctionId === env.auctionId)) continue;
        out.push(fromEvent(find('PB-02'), env, ctx, 'confirmed', 'auctionInit has no ad unit codes'));
      }
      return out;
    }
  ),

  defineRule(
    meta(
      'PB-03',
      'Requested ad unit code does not exist',
      'critical',
      'requestBids.adUnitCodes includes a code that is not in pbjs.adUnits.',
      ['Compare requested codes with pbjs.adUnits'],
      ['Request only registered ad unit codes']
    ),
    (ctx) => {
      const known = ctx.session.adUnits;
      if (!known.size) return [];
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('prebid', 'requestBids')) {
        const codes = arr(rec(apiArgs(env)[0]).adUnitCodes)
          .map(str)
          .filter((c): c is string => !!c);
        for (const code of codes) {
          if (known.has(code)) continue;
          out.push(fromEvent(find('PB-03'), env, ctx, 'confirmed', `requested unknown ad unit ${code}`, { adUnitCode: code }));
        }
      }
      return out;
    }
  ),

  defineRule(
    meta(
      'PB-04',
      'Ad unit has no usable bidders',
      'critical',
      'An ad unit is auctioned with an empty or invalid bids array.',
      ['Inspect ad unit bids[]', 'bidder codes', 'installed adapters'],
      ['Configure at least one usable bidder per ad unit']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const au of ctx.session.adUnits.values()) {
        if (au.bidders && au.bidders.length) continue;
        const requested = ctx.named('prebid', 'auctionInit').some((e) => codesOfAuctionPayload(payload(e)).includes(au.code));
        if (!requested && !ctx.named('prebid', 'requestBids').length) continue;
        const sample = ctx.forAdUnit(au.code)[0] || ctx.named('prebid', 'auctionInit')[0];
        if (!sample) continue;
        out.push(
          fromEvent(find('PB-04'), sample, ctx, 'likely', `ad unit ${au.code} has no bidders`, { adUnitCode: au.code })
        );
      }
      return out;
    }
  ),

  defineRule(
    meta(
      'PB-05',
      'Invalid or unsupported media-type configuration',
      'high',
      'Ad unit mediaTypes is missing, empty, or uses a type the adapter/build does not support.',
      ['Inspect mediaTypes', 'installed modules', 'adapter media types'],
      ['Declare a supported media type before requesting bids']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const au of ctx.session.adUnits.values()) {
        if (au.mediaTypes && au.mediaTypes.length) continue;
        const sample = ctx.forAdUnit(au.code)[0];
        if (!sample) continue;
        out.push(
          fromEvent(find('PB-05'), sample, ctx, 'likely', `ad unit ${au.code} has no mediaTypes`, { adUnitCode: au.code })
        );
      }
      return out;
    }
  ),

  defineRule(
    meta(
      'PB-06',
      'Bid request created but bidder HTTP request never starts',
      'high',
      'bidRequested occurs but no corresponding beforeBidderHttp, PBS request, response, no-bid, or error is observed.',
      ['Inspect auctionDebug', 'tcf2Enforcement', 'beforePBSHttp', 'client vs S2S'],
      ['Fix invalid configuration/adapter error or consent setup', 'Do not require beforeBidderHttp for S2S paths']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      const outcomes = ['beforeBidderHttp', 'beforePBSHttp', 'bidResponse', 'noBid', 'bidRejected', 'bidTimeout', 'bidderError', 'bidderDone'];
      for (const env of ctx.named('prebid', 'bidRequested')) {
        const bidder = str(payload(env).bidderCode) || str(payload(env).bidder);
        const later = ctx.envelopes.filter(
          (e) =>
            e.channel === 'prebid' &&
            e.ts >= env.ts &&
            e.auctionId === env.auctionId &&
            outcomes.includes(e.name) &&
            (!bidder || str(payload(e).bidderCode) === bidder || str(payload(e).bidder) === bidder || str(bidOf(e).bidder) === bidder)
        );
        if (later.length) continue;
        const ended = ctx.named('prebid', 'auctionEnd').some((e) => e.auctionId === env.auctionId);
        if (!ended && ctx.elapsedSince(env) < THRESHOLDS.auctionStallFallbackMs) continue;
        out.push(
          fromEvent(find('PB-06'), env, ctx, confidenceForAbsence(ctx), `no HTTP/outcome after bidRequested for ${bidder || 'bidder'}`)
        );
      }
      return out;
    }
  ),

  defineRule(
    meta(
      'PB-07',
      'Bidder network request fails',
      'high',
      'beforeBidderHttp occurs, followed by bidderError, a failed network entry, or no response until timeout.',
      ['Inspect request URL, status/error', 'blocked reason', 'duration'],
      ['Address the specific network/policy failure or bidder endpoint issue']
    ),
    (ctx) => ctx.named('prebid', 'bidderError').map((env) => fromEvent(find('PB-07'), env, ctx, 'confirmed', `bidderError ${str(payload(env).error) || bidderLabel(env)}`))
  ),

  defineRule(
    meta(
      'PB-08',
      'Bidder returns no bid',
      'info',
      'noBid fires for a requested bidder.',
      ['Confirm noBid versus transport failure, timeout, or rejection'],
      ['Treat as a valid commercial outcome unless the bidder was expected to return demand']
    ),
    (ctx) => ctx.named('prebid', 'noBid').map((env) => fromEvent(find('PB-08'), env, ctx, 'confirmed', `noBid ${bidderLabel(env)}`))
  ),

  defineRule(
    meta(
      'PB-09',
      'Bidder times out',
      'medium',
      'auctionTimeout and/or bidTimeout includes the bidder.',
      ['Compare request start, timeToRespond, configured timeout', 'late network completion'],
      ['Investigate latency and timeout allocation']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of [...ctx.named('prebid', 'bidTimeout'), ...ctx.named('prebid', 'auctionTimeout')]) {
        out.push(fromEvent(find('PB-09'), env, ctx, 'confirmed', `${env.name} ${bidderLabel(env)}`));
      }
      return out;
    }
  ),

  defineRule(
    meta(
      'PB-10',
      'Auction timeout is excessively long',
      'medium',
      'Ad serving waits a long time for one or more bidders, materially delaying render.',
      ['Compare configured timeout', 'bidder latency distribution', 'GPT request delay'],
      ['Tune the timeout based on measured bidder value and latency']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'auctionInit')) {
        const timeout = num(payload(env).timeout) ?? ctx.session.auctions.get(env.auctionId || '')?.timeout;
        if (timeout == null || timeout <= THRESHOLDS.longAuctionTimeoutMs) continue;
        out.push(
          fromEvent(find('PB-10'), env, ctx, 'confirmed', `auction timeout ${timeout}ms exceeds ${THRESHOLDS.longAuctionTimeoutMs}ms`)
        );
      }
      return out;
    }
  ),

  defineRule(
    meta(
      'PB-11',
      'Auction timeout is too short',
      'medium',
      'Many bidders consistently time out just before valid responses arrive.',
      ['Compare late-response timing with the deadline across repeated auctions'],
      ['Reduce upstream delay or adjust the timeout based on evidence']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'auctionInit')) {
        const timeout = num(payload(env).timeout) ?? ctx.session.auctions.get(env.auctionId || '')?.timeout;
        if (timeout == null || timeout >= THRESHOLDS.shortAuctionTimeoutMs) continue;
        const timedOut = ctx.named('prebid', 'bidTimeout').some((e) => e.auctionId === env.auctionId);
        if (!timedOut) continue;
        out.push(fromEvent(find('PB-11'), env, ctx, 'likely', `short timeout ${timeout}ms with bidTimeout`));
      }
      return out;
    }
  ),

  defineRule(
    meta(
      'PB-32',
      'Latest-auction APIs are mistaken for historical data',
      'medium',
      'Winning/targeting reads occur after a newer auctionInit and no longer describe the prior cycle.',
      ['Compare auctionId on targeting vs the intended refresh', 'Avoid getHighestCpmBids after a new auction'],
      ['Bind targeting and refresh to an explicit auctionId']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      const inits = ctx.named('prebid', 'auctionInit');
      for (const t of ctx.named('prebid', 'setTargeting')) {
        const laterInit = inits.find((i) => i.ts < t.ts && i.auctionId && i.auctionId !== t.auctionId);
        if (!laterInit) continue;
        const moreRecent = inits.some((i) => i.ts > laterInit.ts && i.ts < t.ts);
        if (!moreRecent && laterInit.ts < t.ts) {
          // targeting after a different auction started
          const newest = lastOf(inits.filter((i) => i.ts <= t.ts));
          if (newest && t.auctionId && newest.auctionId && t.auctionId !== newest.auctionId) {
            out.push(
              fromEvent(
                find('PB-32'),
                t,
                ctx,
                'possible',
                `setTargeting auction ${t.auctionId} is not the latest auction ${newest.auctionId}`
              )
            );
          }
        }
      }
      return out;
    }
  ),

  defineRule(
    meta(
      'PB-33',
      'Page uses a custom Prebid global',
      'medium',
      'Prebid-like activity exists but window.pbjs never becomes ready; a custom global may be in use.',
      ['Inspect script globals', 'custom pbjs name'],
      ['Configure BidShitter to observe the correct custom global when supported']
    ),
    (ctx) => {
      if (ctx.session.status.libLoaded) return [];
      if (ctx.session.status.prebidPresent) return [];
      return [];
    }
  ),

  defineRule(
    meta(
      'PB-34',
      'Unexpected or obsolete Prebid build is deployed',
      'medium',
      'pbjs.version is missing, clearly outdated, or does not match the intended build.',
      ['Inspect pbjs.version', 'installedModules'],
      ['Deploy the intended Prebid build']
    ),
    (ctx) => {
      const version = ctx.session.status.prebidVersion;
      if (!ctx.session.status.libLoaded) return [];
      if (version) return [];
      const env = ctx.named('prebid', 'libLoaded')[0] || ctx.named('prebid', 'globals')[0];
      if (!env) return [];
      return [fromEvent(find('PB-34'), env, ctx, 'possible', 'Prebid is loaded but version is unknown')];
    }
  ),

  defineRule(
    meta(
      'PB-35',
      'Page prerendering delays the auction',
      'info',
      'pbjs.delayPrerendering is true; the auction is deferred until prerender completes.',
      ['Inspect delayPrerendering', 'auctionInit time'],
      ['Do not treat prerender delay as a hung auction']
    ),
    (ctx) => {
      if (!ctx.session.status.delayPrerendering) return [];
      const env = ctx.named('prebid', 'globals')[0] || ctx.named('prebid', 'libLoaded')[0];
      if (!env) return [];
      return [fromEvent(find('PB-35'), env, ctx, 'confirmed', 'delayPrerendering is true')];
    }
  ),

  defineRule(
    meta(
      'PB-36',
      'Configured ad unit is excluded from requestBids',
      'high',
      'An ad unit exists on pbjs.adUnits but is omitted from requestBids.adUnitCodes.',
      ['Compare adUnits with requestBids options'],
      ['Include the unit or document why it is intentionally excluded']
    ),
    (ctx) => {
      const requested = new Set<string>();
      for (const env of ctx.apis('prebid', 'requestBids')) {
        const opts = rec(apiArgs(env)[0]);
        for (const c of arr(opts.adUnitCodes)) if (str(c)) requested.add(str(c)!);
        for (const u of arr(opts.adUnits)) {
          const code = str(rec(u).code);
          if (code) requested.add(code);
        }
      }
      if (!requested.size) return [];
      const out: DiagnosticIssue[] = [];
      for (const au of ctx.session.adUnits.values()) {
        if (requested.has(au.code)) continue;
        const sample = ctx.apis('prebid', 'requestBids')[0];
        out.push(fromEvent(find('PB-36'), sample, ctx, 'likely', `ad unit ${au.code} never requested`, { adUnitCode: au.code }));
      }
      return out;
    }
  ),

  defineRule(
    meta(
      'PB-37',
      'Multiple ad-unit definitions use the same code',
      'high',
      'addAdUnits registers the same code more than once.',
      ['Inspect addAdUnits calls'],
      ['Keep ad unit codes unique']
    ),
    (ctx) => {
      const counts = new Map<string, number>();
      for (const env of ctx.apis('prebid', 'addAdUnits')) {
        const arg = apiArgs(env)[0];
        const list = Array.isArray(arg) ? arg : arg ? [arg] : [];
        for (const u of list) {
          const code = str(rec(u).code);
          if (!code) continue;
          counts.set(code, (counts.get(code) || 0) + 1);
        }
      }
      const out: DiagnosticIssue[] = [];
      for (const [code, n] of counts) {
        if (n < 2) continue;
        const env = ctx.apis('prebid', 'addAdUnits')[0];
        out.push(fromEvent(find('PB-37'), env, ctx, 'confirmed', `ad unit code ${code} registered ${n} times`, { adUnitCode: code }));
      }
      return out;
    }
  ),

  defineRule(
    meta(
      'PB-48',
      'Publisher never calls requestBids()',
      'critical',
      'Prebid is ready and ad units exist, but no requestBids/auctionInit is observed.',
      ['Inspect publisher auction trigger', 'que callbacks'],
      ['Call requestBids after ad units are defined']
    ),
    (ctx) => {
      if (!ctx.session.status.libLoaded) return [];
      if (!ctx.session.adUnits.size) return [];
      if (ctx.apis('prebid', 'requestBids').length || ctx.named('prebid', 'auctionInit').length) return [];
      const ready = ctx.named('prebid', 'libLoaded')[0];
      if (!ready || ctx.elapsedSince(ready) < THRESHOLDS.prebidReadyMs) return [];
      return [fromEvent(find('PB-48'), ready, ctx, confidenceForAbsence(ctx), 'no requestBids after Prebid ready')];
    }
  ),

  defineRule(
    meta(
      'PB-49',
      'Auction continuation callback fails',
      'high',
      'requestBids throws or its continuation reports an error before auctionEnd.',
      ['Inspect wrap threw', 'hook wrap_callback_error'],
      ['Fix the publisher callback exception']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('prebid', 'requestBids')) {
        const threw = str(payload(env).threw);
        if (!threw) continue;
        out.push(fromEvent(find('PB-49'), env, ctx, 'confirmed', `requestBids threw: ${threw}`));
      }
      return out;
    }
  ),

  defineRule(
    meta(
      'PB-50',
      'Effective auction timeout differs from expected configuration',
      'medium',
      'auctionInit.timeout does not match setConfig bidderTimeout when both are visible.',
      ['Compare setConfig bidderTimeout with auctionInit.timeout'],
      ['Account for per-request timeout overrides']
    ),
    (ctx) => {
      let configured: number | undefined;
      for (const env of ctx.apis('prebid', 'setConfig')) {
        const t = num(rec(apiArgs(env)[0]).bidderTimeout);
        if (t != null) configured = t;
      }
      if (configured == null) return [];
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'auctionInit')) {
        const t = num(payload(env).timeout);
        if (t == null || t === configured) continue;
        out.push(
          fromEvent(find('PB-50'), env, ctx, 'likely', `auction timeout ${t}ms != configured bidderTimeout ${configured}ms`)
        );
      }
      return out;
    }
  ),

  defineRule(
    meta(
      'PB-51',
      'Auction never completes',
      'critical',
      'auctionInit occurs but auctionEnd/auctionTimeout never follows after the wait threshold.',
      ['Inspect bidderDone', 'page navigation', 'observer start'],
      ['Fix the hung auction path; mark unknown if observation ended first']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      const ended = new Set(
        [...ctx.named('prebid', 'auctionEnd'), ...ctx.named('prebid', 'auctionTimeout')]
          .map((e) => e.auctionId)
          .filter(Boolean)
      );
      for (const env of ctx.named('prebid', 'auctionInit')) {
        if (!env.auctionId || ended.has(env.auctionId)) continue;
        const timeout = num(payload(env).timeout) ?? THRESHOLDS.auctionStallFallbackMs;
        const wait = timeout + THRESHOLDS.auctionStallGraceMs;
        if (ctx.elapsedSince(env) < wait) continue;
        out.push(fromEvent(find('PB-51'), env, ctx, confidenceForAbsence(ctx), `auction ${env.auctionId} never ended`));
      }
      return out;
    }
  ),

  defineRule(
    meta(
      'PB-52',
      'Auction terminates prematurely or is canceled',
      'high',
      'clearAllAuctions or equivalent cancellation occurs while an auction is in progress.',
      ['Inspect clearAllAuctions timing vs auctionEnd'],
      ['Avoid canceling an in-flight auction unless navigation requires it']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('prebid', 'clearAllAuctions')) {
        const open = ctx.named('prebid', 'auctionInit').filter((i) => {
          const ended = [...ctx.named('prebid', 'auctionEnd'), ...ctx.named('prebid', 'auctionTimeout')].some(
            (e) => e.auctionId === i.auctionId && e.ts <= env.ts
          );
          return i.ts < env.ts && !ended;
        });
        if (!open.length) continue;
        out.push(fromEvent(find('PB-52'), env, ctx, 'confirmed', `clearAllAuctions during ${open.length} in-flight auction(s)`));
      }
      return out;
    }
  ),

  defineRule(
    meta(
      'PB-76',
      'Prebid becomes ready only after ad-server serving begins',
      'high',
      'GPT display/refresh/slotRequested occurs before pbjs.libLoaded.',
      ['Compare libLoaded with first GPT request'],
      ['Load Prebid before the first ad-server request']
    ),
    (ctx) => {
      const loaded = ctx.named('prebid', 'libLoaded')[0];
      const gptStart =
        ctx.named('gpt', 'slotRequested')[0] || ctx.apis('gpt', 'refresh')[0] || ctx.apis('gpt', 'display')[0];
      if (!gptStart) return [];
      if (loaded && loaded.ts <= gptStart.ts) return [];
      if (!loaded && !ctx.session.status.libLoaded) return [];
      if (!loaded) return [];
      if (loaded.ts <= gptStart.ts) return [];
      return [fromEvent(find('PB-76'), loaded, ctx, 'confirmed', 'libLoaded after first GPT request')];
    }
  ),
];

const BY_ID = new Map(prebidLifecycleRules.map((r) => [r.id, r]));
function find(id: string): RuleMeta {
  return BY_ID.get(id)!;
}

function bidderLabel(env: { payload: unknown; name: string }): string {
  const p = payload(env as any);
  return str(p.bidderCode) || str(p.bidder) || str(bidOf(env as any).bidder) || env.name;
}

void groupBy;
void unique;
