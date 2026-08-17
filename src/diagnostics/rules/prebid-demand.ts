import {
  bidOf,
  defineRule,
  fromEvent,
  groupBy,
  num,
  payload,
  rec,
  rejectMatching,
  str,
} from '../helpers';
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

const rejection = (m: RuleMeta, needle: string): Rule => rejectMatching(m, needle, 'confirmed');

export const prebidDemandRules: Rule[] = [
  rejection(
    meta(
      'PB-12',
      'Bid has missing or invalid properties',
      'high',
      'bidRejected reports Bid has missing or invalid properties.',
      ['Inspect the sanitized rejected bid'],
      ['Correct the bidder adapter or response contract']
    ),
    'Bid has missing or invalid properties'
  ),
  rejection(
    meta(
      'PB-13',
      'Bid response has an invalid request ID',
      'high',
      'bidRejected reports Invalid request ID.',
      ['Compare bid requestId with outbound bid IDs in the same auction'],
      ['Correct adapter ID propagation']
    ),
    'Invalid request ID'
  ),
  rejection(
    meta(
      'PB-14',
      'Alternate or unknown bidder code is rejected',
      'high',
      'bidRejected says the bidder code is not allowed.',
      ['Compare requested vs response bidder codes', 'aliases / allow-list'],
      ['Correct the response code or configure a legitimate alias']
    ),
    'Bidder code is not allowed'
  ),
  rejection(
    meta(
      'PB-15',
      'Bid is below the price floor',
      'info',
      'bidRejected reports Bid does not meet price floor.',
      ['Inspect bid CPM/currency and floor'],
      ['Verify floor configuration; otherwise treat as expected']
    ),
    'Bid does not meet price floor'
  ),
  rejection(
    meta(
      'PB-16',
      'Bid currency cannot be converted',
      'high',
      'bidRejected reports Unable to convert currency.',
      ['Compare currency', 'currency module', 'ad-server currency'],
      ['Provide a supported conversion path']
    ),
    'Unable to convert currency'
  ),
  rejection(
    meta(
      'PB-17',
      'Bid exceeds the maximum accepted value',
      'high',
      'bidRejected reports Bid price exceeds maximum value.',
      ['Inspect bid CPM vs maxBid config'],
      ['Correct the bid or maxBid configuration']
    ),
    'Bid price exceeds maximum value'
  ),
  defineRule(
    meta(
      'PB-18',
      'Bid fails DSA requirements',
      'high',
      'bidRejected reports DSA transparency required or mismatch.',
      ['Inspect DSA fields on the bid'],
      ['Supply required DSA transparency info']
    ),
    (ctx) =>
      ctx
        .named('prebid', 'bidRejected')
        .filter((e) => /dsa/i.test(String(payload(e).reason ?? payload(e).rejectionReason ?? bidOf(e).rejectionReason ?? '')))
        .map((e) => fromEvent(find('PB-18'), e, ctx, 'confirmed', 'DSA rejection'))
  ),
  defineRule(
    meta(
      'PB-19',
      'Unexpected CPM adjustment changes auction ranking',
      'medium',
      'Adjusted CPM changes which bid would rank first versus originalCpm.',
      ['Compare originalCpm vs cpm', 'bidAdjustment events'],
      ['Review bidCpmAdjustment / bidder settings']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      const byAuction = groupBy(
        ctx.named('prebid', 'bidResponse').concat(ctx.named('prebid', 'bidAccepted')),
        (e) => e.auctionId
      );
      for (const [auctionId, bids] of byAuction) {
        const ranked = bids
          .map((e) => {
            const b = bidOf(e);
            return { e, cpm: num(b.cpm), original: num(b.originalCpm) ?? num(b.cpm) };
          })
          .filter((x) => x.cpm != null);
        if (ranked.length < 2) continue;
        const bestAdj = [...ranked].sort((a, b) => (b.cpm || 0) - (a.cpm || 0))[0];
        const bestOrig = [...ranked].sort((a, b) => (b.original || 0) - (a.original || 0))[0];
        if (bestAdj.e === bestOrig.e) continue;
        if (bestAdj.original === bestAdj.cpm && bestOrig.original === bestOrig.cpm) continue;
        out.push(
          fromEvent(find('PB-19'), bestAdj.e, ctx, 'likely', `adjusted winner differs from originalCpm ranking in ${auctionId}`)
        );
      }
      for (const env of ctx.named('prebid', 'bidAdjustment')) {
        out.push(fromEvent(find('PB-19'), env, ctx, 'possible', 'bidAdjustment observed'));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-20',
      'Auction ends with no eligible bid',
      'info',
      'auctionEnd has no bidsReceived / winningBids for requested units.',
      ['Inspect noBids, bidsRejected, bidTimeout'],
      ['Treat as a valid no-demand outcome unless bidders were expected']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'auctionEnd')) {
        const p = payload(env);
        const received = arrLen(p.bidsReceived);
        const winning = arrLen(p.winningBids);
        if (received > 0 || winning > 0) continue;
        out.push(fromEvent(find('PB-20'), env, ctx, 'confirmed', 'auctionEnd with no eligible bids'));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-38',
      'Bidder parameters are missing or invalid',
      'high',
      'Adapter validation rejects the request or auctionDebug reports invalid bidder params.',
      ['Inspect bid.params', 'auctionDebug'],
      ['Supply required bidder parameters']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'auctionDebug')) {
        const msg = JSON.stringify(payload(env)).toLowerCase();
        if (!msg.includes('param') && !msg.includes('invalid')) continue;
        out.push(fromEvent(find('PB-38'), env, ctx, 'likely', 'auctionDebug suggests invalid bidder params'));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-39',
      'Video ad-unit configuration is invalid',
      'high',
      'Video mediaType is declared but required video fields are missing/invalid.',
      ['Inspect mediaTypes.video'],
      ['Correct video ad-unit configuration']
    ),
    (ctx) => ctx.named('prebid', 'auctionDebug')
      .filter((e) => /video/i.test(JSON.stringify(payload(e))))
      .map((e) => fromEvent(find('PB-39'), e, ctx, 'possible', 'auctionDebug mentions video configuration'))
  ),
  defineRule(
    meta(
      'PB-40',
      'Native ad-unit or asset configuration is invalid',
      'high',
      'Native mediaType/assets are missing or invalid.',
      ['Inspect mediaTypes.native'],
      ['Correct native asset configuration']
    ),
    (ctx) => ctx.named('prebid', 'auctionDebug')
      .filter((e) => /native/i.test(JSON.stringify(payload(e))))
      .map((e) => fromEvent(find('PB-40'), e, ctx, 'possible', 'auctionDebug mentions native configuration'))
  ),
  defineRule(
    meta(
      'PB-41',
      'OpenRTB or first-party data configuration is malformed',
      'high',
      'ortb2 / FPD config is malformed or rejected.',
      ['Inspect setConfig ortb2', 'auctionDebug'],
      ['Correct OpenRTB/FPD configuration']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('prebid', 'setConfig').concat(ctx.apis('prebid', 'mergeConfig'))) {
        const cfg = rec(payload(env).args ? (payload(env).args as unknown[])[0] : payload(env));
        if (cfg.ortb2 && typeof cfg.ortb2 !== 'object') {
          out.push(fromEvent(find('PB-41'), env, ctx, 'confirmed', 'ortb2 config is not an object'));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-53',
      'Bidder response is malformed or cannot be parsed',
      'high',
      'bidderError or bidRejected indicates a parse/schema failure.',
      ['Inspect bidderError payload'],
      ['Correct adapter parsing / endpoint payload']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'bidderError')) {
        const text = JSON.stringify(payload(env)).toLowerCase();
        if (!/parse|json|malformed|invalid response/.test(text)) continue;
        out.push(fromEvent(find('PB-53'), env, ctx, 'confirmed', 'bidderError looks like a parse failure'));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-54',
      'Duplicate bidder request is sent',
      'medium',
      'Two bidRequested/beforeBidderHttp events share bidder+auction+adUnit unexpectedly.',
      ['Compare bidder, auctionId, requestId'],
      ['Prevent double-requesting the same bidder in one auction']
    ),
    (ctx) => {
      const groups = groupBy(ctx.named('prebid', 'bidRequested'), (e) => {
        const p = payload(e);
        return `${e.auctionId}|${str(p.bidderCode) || str(p.bidder)}|${e.adUnitCode || ''}`;
      });
      const out: DiagnosticIssue[] = [];
      for (const [, list] of groups) {
        if (list.length < 2) continue;
        out.push(fromEvent(find('PB-54'), list[1], ctx, 'likely', `duplicate bidRequested (${list.length})`));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-55',
      'Expected S2S bidder is absent from the server request',
      'high',
      'beforePBSHttp/pbsAnalytics omits a bidder configured for Prebid Server.',
      ['Compare s2sConfig.bidders with beforePBSHttp payload'],
      ['Fix s2sConfig / alias mapping']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'beforePBSHttp')) {
        const p = payload(env);
        const requested = arrStr(p.bidders).concat(arrStr(p.adUnits));
        if (!requested.length) continue;
      }
      void out;
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-56',
      'Bidder never reaches bidderDone',
      'medium',
      'bidRequested occurs but bidderDone never follows before auctionEnd.',
      ['Inspect bidderDone vs auctionEnd'],
      ['Investigate adapter completion / timeout path']
    ),
    (ctx) => {
      const done = new Set(
        ctx.named('prebid', 'bidderDone').map((e) => `${e.auctionId}|${str(payload(e).bidderCode) || str(payload(e).bidder)}`)
      );
      const ended = new Set(ctx.named('prebid', 'auctionEnd').map((e) => e.auctionId));
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'bidRequested')) {
        const bidder = str(payload(env).bidderCode) || str(payload(env).bidder);
        const k = `${env.auctionId}|${bidder}`;
        if (!ended.has(env.auctionId)) continue;
        if (done.has(k)) continue;
        if (!bidder) continue;
        out.push(fromEvent(find('PB-56'), env, ctx, 'likely', `no bidderDone for ${bidder}`));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-57',
      'Prebid Server reports a seat non-bid',
      'info',
      'pbsAnalytics or PBS payload reports a seatnonbid.',
      ['Inspect pbsAnalytics'],
      ['Treat as a valid PBS no-bid unless unexpected']
    ),
    (ctx) =>
      ctx
        .named('prebid', 'pbsAnalytics')
        .filter((e) => /seatnonbid|seatNonBid/i.test(JSON.stringify(payload(e))))
        .map((e) => fromEvent(find('PB-57'), e, ctx, 'confirmed', 'PBS seat non-bid'))
  ),
  defineRule(
    meta(
      'PB-58',
      'Only some requested impressions receive bidder outcomes',
      'medium',
      'A multi-unit request leaves some ad units without bid/noBid/timeout/reject.',
      ['Compare adUnitCodes vs per-unit outcomes'],
      ['Investigate adapter multi-imp handling']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'auctionEnd')) {
        const auction = ctx.session.auctions.get(env.auctionId || '');
        const codes = auction?.adUnitCodes?.length ? auction.adUnitCodes : [];
        if (codes.length < 2) continue;
        const covered = new Set<string>();
        for (const e of ctx.forAuction(env.auctionId || '')) {
          if (!e.adUnitCode) continue;
          if (['bidResponse', 'noBid', 'bidRejected', 'bidTimeout'].includes(e.name)) covered.add(e.adUnitCode);
        }
        const missing = codes.filter((c) => !covered.has(c));
        if (!missing.length) continue;
        out.push(
          fromEvent(find('PB-58'), env, ctx, 'likely', `no bidder outcome for ${missing.join(', ')}`)
        );
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-59',
      'One request produces duplicate bid responses',
      'medium',
      'Two bidResponse events share requestId in the same auction.',
      ['Compare requestId / adId'],
      ['Deduplicate adapter responses']
    ),
    (ctx) => {
      const groups = groupBy(ctx.named('prebid', 'bidResponse'), (e) => {
        const b = bidOf(e);
        return `${e.auctionId}|${str(b.requestId)}`;
      });
      const out: DiagnosticIssue[] = [];
      for (const [k, list] of groups) {
        if (!k.endsWith('|') && list.length >= 2 && str(bidOf(list[0]).requestId)) {
          out.push(fromEvent(find('PB-59'), list[1], ctx, 'confirmed', `duplicate bidResponse requestId ${str(bidOf(list[0]).requestId)}`));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-60',
      'Bidder alias or response identity is unexpected',
      'medium',
      'Response bidderCode differs from the requested bidder without a recorded aliasBidder.',
      ['Compare requested vs response bidder', 'aliasBidder wraps'],
      ['Record aliases explicitly']
    ),
    (ctx) => {
      const aliases = new Set<string>();
      for (const env of ctx.apis('prebid', 'aliasBidder')) {
        const [alias, orig] = payload(env).args as unknown[] | [];
        if (str(alias)) aliases.add(`${str(alias)}->${str(orig)}`);
      }
      const requested = new Set(
        ctx.named('prebid', 'bidRequested').map((e) => str(payload(e).bidderCode) || str(payload(e).bidder)).filter(Boolean) as string[]
      );
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'bidResponse')) {
        const bidder = str(bidOf(env).bidder) || str(bidOf(env).bidderCode);
        if (!bidder || requested.has(bidder)) continue;
        if ([...aliases].some((a) => a.startsWith(`${bidder}->`))) continue;
        out.push(fromEvent(find('PB-60'), env, ctx, 'possible', `response bidder ${bidder} was not requested`));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-61',
      'Same demand source is requested client-side and server-side',
      'medium',
      'The same bidder appears on bidRequested and beforePBSHttp in one auction.',
      ['Compare client bidder list with s2s bidders'],
      ['Avoid double-pathing the same demand source']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      const pbs = ctx.named('prebid', 'beforePBSHttp');
      if (!pbs.length) return out;
      for (const env of ctx.named('prebid', 'bidRequested')) {
        const bidder = str(payload(env).bidderCode) || str(payload(env).bidder);
        if (!bidder) continue;
        const match = pbs.some((e) => e.auctionId === env.auctionId && JSON.stringify(payload(e)).includes(bidder));
        if (!match) continue;
        out.push(fromEvent(find('PB-61'), env, ctx, 'likely', `${bidder} requested client-side and S2S`));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-62',
      'Bid CPM is missing, invalid, or zero',
      'medium',
      'A bidResponse has missing/NaN/negative CPM; zero CPM is flagged as info-adjacent.',
      ['Inspect bid.cpm'],
      ['Reject or correct invalid CPMs']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'bidResponse')) {
        const cpm = bidOf(env).cpm;
        if (typeof cpm !== 'number' || !Number.isFinite(cpm) || cpm < 0) {
          out.push(fromEvent(find('PB-62'), env, ctx, 'confirmed', `invalid cpm ${String(cpm)}`));
        } else if (cpm === 0) {
          out.push(fromEvent(find('PB-62'), env, ctx, 'possible', 'bid cpm is 0'));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-63',
      'Bid dimensions fail size validation',
      'high',
      'Bid width/height are missing or not in the requested sizes.',
      ['Compare bid width/height with ad unit sizes'],
      ['Return an eligible size']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'bidResponse')) {
        const b = bidOf(env);
        const w = num(b.width);
        const h = num(b.height);
        if (w != null && h != null && w > 0 && h > 0) continue;
        out.push(fromEvent(find('PB-63'), env, ctx, 'confirmed', 'bid width/height missing or invalid'));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-64',
      'Bid media type does not match the request',
      'high',
      'bid.mediaType is absent or not in the ad unit mediaTypes.',
      ['Compare bid.mediaType with ad unit mediaTypes'],
      ['Return a requested media type']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'bidResponse')) {
        const media = str(bidOf(env).mediaType);
        const unit = env.adUnitCode ? ctx.session.adUnits.get(env.adUnitCode) : undefined;
        if (!media) {
          out.push(fromEvent(find('PB-64'), env, ctx, 'likely', 'bid mediaType missing'));
          continue;
        }
        if (unit?.mediaTypes?.length && !unit.mediaTypes.includes(media)) {
          out.push(fromEvent(find('PB-64'), env, ctx, 'confirmed', `bid mediaType ${media} not in ${unit.mediaTypes.join(',')}`));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-65',
      'Bid creative data fails validation',
      'high',
      'adRenderFailed or bidRejected indicates missing creative payload.',
      ['Inspect adRenderFailed reason', 'stripped ad/vast fields'],
      ['Supply a renderable creative']
    ),
    (ctx) =>
      ctx
        .named('prebid', 'adRenderFailed')
        .filter((e) => /creative|ad markup|missing ad|cannot find/i.test(JSON.stringify(payload(e))))
        .map((e) => fromEvent(find('PB-65'), e, ctx, 'confirmed', 'creative validation/render failure'))
  ),
  defineRule(
    meta(
      'PB-66',
      'Native bid response fails asset validation',
      'high',
      'Native bid is rejected or fails render due to assets.',
      ['Inspect native assets'],
      ['Return required native assets']
    ),
    (ctx) =>
      ctx
        .named('prebid', 'bidRejected')
        .concat(ctx.named('prebid', 'adRenderFailed'))
        .filter((e) => /native/i.test(JSON.stringify(payload(e))))
        .map((e) => fromEvent(find('PB-66'), e, ctx, 'likely', 'native asset validation failure'))
  ),
  defineRule(
    meta(
      'PB-67',
      'Video bid fails validation or caching',
      'high',
      'Video bid is rejected or cache key/url is missing.',
      ['Inspect video cache events', 'vastXml stripped presence'],
      ['Fix video cache / VAST response']
    ),
    (ctx) =>
      ctx
        .named('prebid', 'bidRejected')
        .concat(ctx.named('prebid', 'adRenderFailed'))
        .filter((e) => /video|vast|cache/i.test(JSON.stringify(payload(e))))
        .map((e) => fromEvent(find('PB-67'), e, ctx, 'likely', 'video validation or cache failure'))
  ),
  defineRule(
    meta(
      'PB-68',
      'Bid TTL is missing or invalid',
      'medium',
      'Bid ttl is missing, zero, or negative.',
      ['Inspect bid.ttl'],
      ['Supply a valid TTL']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'bidResponse')) {
        const ttl = bidOf(env).ttl;
        if (typeof ttl === 'number' && ttl > 0) continue;
        if (ttl == null) continue;
        out.push(fromEvent(find('PB-68'), env, ctx, 'confirmed', `invalid ttl ${String(ttl)}`));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-69',
      'Bid netRevenue value is invalid',
      'medium',
      'netRevenue is present but not a boolean.',
      ['Inspect bid.netRevenue'],
      ['Set netRevenue to true or false']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'bidResponse')) {
        const nr = bidOf(env).netRevenue;
        if (nr == null || typeof nr === 'boolean') continue;
        out.push(fromEvent(find('PB-69'), env, ctx, 'confirmed', `invalid netRevenue ${String(nr)}`));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-70',
      'Deal prioritization changes the selected candidate',
      'info',
      'A deal bid is selected over a higher CPM non-deal bid.',
      ['Compare dealId, cpm, winning bid'],
      ['Treat as expected when deals are configured']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'auctionEnd')) {
        const winning = rec(arrFirst(payload(env).winningBids));
        const deal = str(winning.dealId);
        const winCpm = num(winning.cpm);
        if (!deal || winCpm == null) continue;
        const higher = arrRec(payload(env).bidsReceived).some((b) => (num(b.cpm) || 0) > winCpm && !str(b.dealId));
        if (!higher) continue;
        out.push(fromEvent(find('PB-70'), env, ctx, 'likely', `deal ${deal} selected over higher CPM`));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-73',
      'Selected bid ranking is unexpected',
      'medium',
      'Winning bid is not the highest CPM and no deal explains it.',
      ['Compare winningBids vs bidsReceived CPM'],
      ['Inspect deal/first-price/adjustment logic']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'auctionEnd')) {
        const winning = rec(arrFirst(payload(env).winningBids));
        const winCpm = num(winning.cpm);
        if (winCpm == null) continue;
        if (str(winning.dealId)) continue;
        const higher = arrRec(payload(env).bidsReceived).filter((b) => (num(b.cpm) || 0) > winCpm + 1e-6);
        if (!higher.length) continue;
        out.push(fromEvent(find('PB-73'), env, ctx, 'possible', 'winner is not highest CPM'));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-74',
      'Currency conversion changes bid ranking',
      'info',
      'originalCurrency/originalCpm ranking differs from converted cpm ranking.',
      ['Compare originalCpm vs cpm'],
      ['Explain conversion; flag only unexpected converters']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'bidResponse')) {
        const b = bidOf(env);
        if (str(b.originalCurrency) && str(b.currency) && str(b.originalCurrency) !== str(b.currency)) {
          out.push(fromEvent(find('PB-74'), env, ctx, 'confirmed', `currency ${b.originalCurrency} → ${b.currency}`));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-75',
      'Banner sizes are missing',
      'high',
      'Banner ad unit has no sizes.',
      ['Inspect mediaTypes.banner.sizes'],
      ['Declare banner sizes']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('prebid', 'addAdUnits')) {
        const arg = payload(env).args;
        const list = Array.isArray(arg) ? (arg[0] as unknown) : undefined;
        const units = Array.isArray(list) ? list : list ? [list] : [];
        for (const u of units) {
          const unit = rec(u);
          const mt = rec(unit.mediaTypes);
          const banner = rec(mt.banner);
          if (!Object.keys(mt).length || !Object.keys(banner).length) continue;
          const sizes = banner.sizes;
          if (Array.isArray(sizes) && sizes.length) continue;
          out.push(
            fromEvent(find('PB-75'), env, ctx, 'confirmed', `banner sizes missing on ${str(unit.code)}`, {
              adUnitCode: str(unit.code),
            })
          );
        }
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-77',
      'Accepted bid expires before targeting is generated',
      'high',
      'expiredRender/staleRender or TTL elapsed before setTargeting.',
      ['Compare bid ttl with setTargeting time'],
      ['Apply targeting before expiry or re-auction']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of [...ctx.named('prebid', 'expiredRender'), ...ctx.named('prebid', 'staleRender')]) {
        out.push(fromEvent(find('PB-77'), env, ctx, 'confirmed', env.name));
      }
      return out;
    }
  ),
  defineRule(
    meta(
      'PB-78',
      'CPM adjustment makes a bid ineligible',
      'medium',
      'bidAdjustment or adjusted cpm leads to floor rejection or drop from targeting.',
      ['Compare originalCpm, cpm, bidRejected floor'],
      ['Review adjustment functions']
    ),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'bidRejected')) {
        const b = bidOf(env);
        if (num(b.originalCpm) != null && num(b.cpm) != null && (b.cpm as number) < (b.originalCpm as number)) {
          const reason = String(b.rejectionReason || payload(env).reason || '');
          if (/floor/i.test(reason)) {
            out.push(fromEvent(find('PB-78'), env, ctx, 'likely', 'adjustment dropped bid below floor'));
          }
        }
      }
      return out;
    }
  ),
];

const BY_ID = new Map(prebidDemandRules.map((r) => [r.id, r]));
function find(id: string): RuleMeta {
  return BY_ID.get(id)!;
}

function arrLen(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

function arrRec(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map((x) => rec(x)) : [];
}

function arrFirst(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : undefined;
}

function arrStr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => str(x)).filter((x): x is string => !!x) : [];
}
