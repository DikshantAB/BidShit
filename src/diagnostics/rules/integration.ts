import {
  adIdOf,
  apiArgs,
  bidOf,
  confidenceForAbsence,
  defineRule,
  fromEvent,
  hasHb,
  hbKeys,
  lastOf,
  payload,
  rec,
  REQUIRED_HB_KEYS,
  slotTargeting,
  str,
  targetingMap,
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
  return { id, title, severity, scope: 'integration', explanation, checks, recommendations };
}

export const integrationRules: Rule[] = [
  defineRule(
    meta('INT-01', 'GAM refresh occurs before the Prebid auction ends', 'high', 'refresh/slotRequested occurs after auctionInit but before matching auctionEnd.', ['Correlate refresh, slotRequested, auctionId'], ['Trigger GAM from bids-back with a guarded failsafe']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const init of ctx.named('prebid', 'auctionInit')) {
        const end = [...ctx.named('prebid', 'auctionEnd'), ...ctx.named('prebid', 'auctionTimeout')].find((e) => e.auctionId === init.auctionId);
        const refresh = [...ctx.apis('gpt', 'refresh'), ...ctx.named('gpt', 'slotRequested')].find((e) => e.ts > init.ts && (!end || e.ts < end.ts));
        if (!refresh) continue;
        out.push(fromEvent(find('INT-01'), refresh, ctx, 'confirmed', `GAM request during auction ${init.auctionId}`, { auctionId: init.auctionId }));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-02', 'Targeting is generated before auction completion', 'high', 'setTargeting occurs before auctionEnd for the same auction.', ['Compare setTargeting time and auction state'], ['Apply targeting only after the auction is finalized']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'setTargeting')) {
        const init = lastOf(ctx.named('prebid', 'auctionInit').filter((e) => e.ts <= env.ts));
        if (!init?.auctionId) continue;
        const end = ctx.named('prebid', 'auctionEnd').find((e) => e.auctionId === init.auctionId);
        if (end && env.ts >= end.ts) continue;
        if (!end || env.ts < end.ts) out.push(fromEvent(find('INT-02'), env, ctx, 'confirmed', 'setTargeting before auctionEnd', { auctionId: init.auctionId }));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-03', 'Auction ends but targeting is never applied', 'high', 'Eligible bids exist at auctionEnd, but no setTargeting occurs before the GAM request.', ['Inspect setTargetingForGPTAsync', 'getAdserverTargeting'], ['Apply targeting before requesting GAM']),
    (ctx) => {
      if (!ctx.session.status.gptPresent) return [];
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'auctionEnd')) {
        const p = payload(env);
        const received = Array.isArray(p.bidsReceived) ? p.bidsReceived.length : 0;
        if (!received) continue;
        const targeting = ctx.named('prebid', 'setTargeting').some((e) => e.ts >= env.ts || e.auctionId === env.auctionId);
        const api = ctx.apis('prebid', 'setTargetingForGPTAsync').some((e) => e.ts >= env.ts);
        if (targeting || api) continue;
        const gptReq = ctx.named('gpt', 'slotRequested').find((e) => e.ts >= env.ts);
        if (!gptReq && ctx.elapsedSince(env) < THRESHOLDS.gptReadyMs) continue;
        out.push(fromEvent(find('INT-03'), env, ctx, confidenceForAbsence(ctx), 'eligible bids but no setTargeting before GAM'));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-04', 'Targeting is applied after refresh', 'high', 'Refresh/slotRequested precedes setTargeting.', ['Compare refresh, slotRequested, setTargeting'], ['Apply targeting first, then refresh']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const t of ctx.named('prebid', 'setTargeting')) {
        const req = [...ctx.apis('gpt', 'refresh'), ...ctx.named('gpt', 'slotRequested')].find((e) => e.ts < t.ts);
        if (!req) continue;
        const later = ctx.named('gpt', 'slotRequested').find((e) => e.ts >= t.ts);
        if (later) continue;
        out.push(fromEvent(find('INT-04'), t, ctx, 'confirmed', 'setTargeting after GAM request snapshot'));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-05', 'Prebid and GPT slot identifiers do not match', 'critical', 'Prebid adUnitCode differs from GPT slot element ID with no matching slot.', ['Compare Prebid code, GPT element ID, DOM ID'], ['Align identifiers or correct the custom mapping']),
    (ctx) => {
      if (!ctx.session.adUnits.size || !ctx.session.slots.size) return [];
      const out: DiagnosticIssue[] = [];
      for (const code of ctx.session.adUnits.keys()) {
        if (ctx.session.slots.has(code)) continue;
        const sample = ctx.forAdUnit(code)[0] || ctx.named('prebid', 'auctionInit')[0];
        if (!sample) continue;
        out.push(fromEvent(find('INT-05'), sample, ctx, 'likely', `no GPT slot with element id ${code}`, { adUnitCode: code }));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-06', 'Custom GPT slot matching maps to the wrong slot', 'critical', 'Prebid targeting appears on a GPT slot with a different intended ad unit.', ['Resolve hb_adid to bid.adUnitCode'], ['Make mapping one-to-one']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('gpt', 'slotRequested').concat(ctx.named('gpt', 'slotRenderEnded'))) {
        const t = slotTargeting(env);
        const adid = str(t.hb_adid);
        if (!adid || !env.slotElementId) continue;
        const bidEnv = ctx.named('prebid', 'bidResponse').find((e) => adIdOf(e) === adid);
        const unit = bidEnv?.adUnitCode || str(bidOf(bidEnv).adUnitCode);
        if (unit && unit !== env.slotElementId) {
          out.push(fromEvent(find('INT-06'), env, ctx, 'confirmed', `hb_adid ${adid} belongs to ${unit} but landed on ${env.slotElementId}`));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-07', 'Targeting payload is empty despite eligible bids', 'high', 'auctionEnd has valid bids but setTargeting[adUnitCode] is empty.', ['Inspect bid status and targeting API output'], ['Correct exclusion/scope/timing']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'setTargeting')) {
        const map = targetingMap(payload(env));
        const keys = Object.keys(map);
        if (!keys.length) {
          const end = lastOf(ctx.named('prebid', 'auctionEnd').filter((e) => e.ts <= env.ts));
          const received = end ? arrLen(payload(end).bidsReceived) : 0;
          if (received) out.push(fromEvent(find('INT-07'), env, ctx, 'confirmed', 'empty setTargeting despite bids'));
        }
        for (const code of keys) {
          const unitMap = targetingMap(map[code]);
          if (Object.keys(unitMap).length) continue;
          out.push(fromEvent(find('INT-07'), env, ctx, 'confirmed', `empty targeting for ${code}`, { adUnitCode: code }));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-08', 'Required hb_* keys are incomplete', 'high', 'A Prebid candidate has some but not all expected keys.', ['Compare bid fields and setTargeting payload'], ['Fix targeting configuration']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'setTargeting')) {
        const root = targetingMap(payload(env));
        const units = looksLikeUnitMap(root) ? root : { [env.adUnitCode || '_']: root };
        for (const [code, raw] of Object.entries(units)) {
          const map = targetingMap(raw);
          if (!hasHb(map)) continue;
          const missing = REQUIRED_HB_KEYS.filter((k) => map[k] == null);
          if (!missing.length) continue;
          out.push(fromEvent(find('INT-08'), env, ctx, 'confirmed', `missing ${missing.join(', ')} on ${code}`, { adUnitCode: code }));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-09', 'Prebid targeting is computed but absent on the GPT slot', 'critical', 'setTargeting contains values, but the GPT slot snapshot does not.', ['Compare targeting payload to slot state before refresh'], ['Define/match the slot before handoff']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'setTargeting')) {
        const root = targetingMap(payload(env));
        const units = looksLikeUnitMap(root) ? root : {};
        for (const [code, raw] of Object.entries(units)) {
          if (!hasHb(targetingMap(raw))) continue;
          const slot = ctx.session.slots.get(code);
          const req = ctx.named('gpt', 'slotRequested').filter((e) => e.slotElementId === code && e.ts >= env.ts)[0];
          const gptMap = req ? slotTargeting(req) : slot?.targetingAtRequest || slot?.targeting || {};
          if (!req && !slot) continue;
          if (hasHb(targetingMap(gptMap))) continue;
          out.push(fromEvent(find('INT-09'), req || env, ctx, 'likely', `Prebid hb_* for ${code} missing on GPT slot`, { adUnitCode: code, slotId: code }));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-10', 'Stale Prebid targeting leaks into a no-bid refresh', 'critical', 'Current auction has no eligible bid, but GPT still carries previous hb_* values.', ['Compare current auction bids with GPT keys'], ['Clear obsolete Prebid keys']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'auctionEnd')) {
        const received = arrLen(payload(env).bidsReceived);
        if (received) continue;
        const req = ctx.named('gpt', 'slotRequested').find((e) => e.ts >= env.ts);
        if (!req) continue;
        if (!hasHb(slotTargeting(req))) continue;
        out.push(fromEvent(find('INT-10'), req, ctx, 'confirmed', 'no-bid auction but GPT request still has hb_*'));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-11', 'Targeting from one slot leaks into another', 'critical', 'GPT slot contains hb_adid belonging to another Prebid adUnitCode.', ['Resolve hb_adid back to its bid'], ['Apply targeting per matched slot']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('gpt', 'slotRequested')) {
        const adid = str(slotTargeting(env).hb_adid);
        if (!adid || !env.slotElementId) continue;
        const bidEnv = ctx.named('prebid', 'bidResponse').find((e) => adIdOf(e) === adid);
        const unit = bidEnv?.adUnitCode;
        if (unit && unit !== env.slotElementId) {
          out.push(fromEvent(find('INT-11'), env, ctx, 'confirmed', `slot ${env.slotElementId} has hb_adid from ${unit}`));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-12', 'hb_pb does not equal the exact bid CPM', 'info', 'Bid cpm differs from hb_pb because hb_pb is a price bucket.', ['Inspect originalCpm, cpm, granularity, hb_pb'], ['Explain the transformation; error only if bucketing is inconsistent']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'setTargeting')) {
        const root = targetingMap(payload(env));
        const units = looksLikeUnitMap(root) ? root : {};
        for (const [code, raw] of Object.entries(units)) {
          const pb = str(targetingMap(raw).hb_pb);
          if (!pb) continue;
          const bid = ctx.named('prebid', 'bidResponse').find((e) => e.adUnitCode === code);
          const cpm = bidOf(bid).cpm;
          if (typeof cpm === 'number' && String(cpm) !== pb) {
            out.push(fromEvent(find('INT-12'), env, ctx, 'confirmed', `hb_pb=${pb} vs cpm=${cpm} (often valid bucketing)`, { adUnitCode: code }));
          }
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-13', 'GAM line-item buckets do not cover Prebid price buckets', 'high', 'Correct hb_pb reaches GAM, but Prebid demand consistently does not serve.', ['Compare GAM request keys with delivery'], ['Align GAM line-item targeting with emitted keys']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('gpt', 'slotRenderEnded')) {
        if (payload(env).isEmpty !== true) continue;
        const req = lastOf(ctx.named('gpt', 'slotRequested').filter((e) => e.slotElementId === env.slotElementId && e.ts <= env.ts));
        if (!req || !hasHb(slotTargeting(req))) continue;
        out.push(fromEvent(find('INT-13'), env, ctx, 'possible', 'hb_* present on request but GAM returned empty'));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-14', 'All-bids targeting collides or exceeds practical key limits', 'medium', 'Many bidder-suffixed keys inflate the GAM request.', ['Count hb_* keys', 'request size'], ['Reduce unnecessary targeting']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'setTargeting')) {
        const root = targetingMap(payload(env));
        for (const [code, raw] of Object.entries(looksLikeUnitMap(root) ? root : {})) {
          const keys = hbKeys(targetingMap(raw));
          if (keys.length <= 20) continue;
          out.push(fromEvent(find('INT-14'), env, ctx, 'likely', `${keys.length} hb_* keys on ${code}`, { adUnitCode: code }));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-15', 'Prebid candidate is incorrectly labeled as the final winner', 'medium', 'UI labeling invariant: Prebid candidate ≠ GAM rendered winner.', ['Wait for bidWon and slotRenderEnded'], ['Use distinct labels: Prebid candidate, targeting sent, rendered outcome']),
    () => []
  ),
  defineRule(
    meta('INT-16', 'GAM selects non-Prebid demand', 'info', 'Prebid targeting was present, but GPT renders non-Prebid demand and no matching bidWon.', ['Inspect slotRenderEnded and bidWon'], ['Report as valid unless GAM delivery was unexpected']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('gpt', 'slotRenderEnded')) {
        if (payload(env).isEmpty === true) continue;
        const req = lastOf(ctx.named('gpt', 'slotRequested').filter((e) => e.slotElementId === env.slotElementId && e.ts <= env.ts));
        if (!req || !hasHb(slotTargeting(req))) continue;
        const won = ctx.named('prebid', 'bidWon').some((e) => e.adUnitCode === env.slotElementId && e.ts >= env.ts - 2000);
        if (won) continue;
        out.push(fromEvent(find('INT-16'), env, ctx, 'likely', 'GAM filled with hb_* present but no bidWon'));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-17', 'GAM selects Prebid demand but the creative cannot resolve hb_adid', 'critical', 'cannotFindAd or missing bid for GPT hb_adid.', ['Match GPT hb_adid to a current bid'], ['Preserve bid state through render']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'adRenderFailed')) {
        if (!/cannotFindAd|cannot find/i.test(JSON.stringify(payload(env)))) continue;
        out.push(fromEvent(find('INT-17'), env, ctx, 'confirmed', 'cannotFindAd during Prebid creative resolve'));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-18', 'Failsafe and auction callback both request GAM', 'high', 'Two near-adjacent refreshes follow one auction.', ['Inspect refresh timestamps'], ['Route both paths through one guarded function']),
    (ctx) => {
      const refreshes = ctx.apis('gpt', 'refresh');
      const out: DiagnosticIssue[] = [];
      for (let i = 1; i < refreshes.length; i++) {
        if (refreshes[i].ts - refreshes[i - 1].ts > THRESHOLDS.dualRefreshMs) continue;
        const auction = ctx.named('prebid', 'auctionEnd').find((e) => Math.abs(e.ts - refreshes[i].ts) < 2000);
        if (!auction) continue;
        out.push(fromEvent(find('INT-18'), refreshes[i], ctx, 'likely', 'two refreshes adjacent to auctionEnd'));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-19', 'Failsafe fires before the configured auction deadline', 'high', 'Failsafe refresh occurs while the auction is still active.', ['Compare failsafe delay and auction timeout'], ['Set failsafe beyond the auction deadline']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const init of ctx.named('prebid', 'auctionInit')) {
        const timeout = Number(payload(init).timeout) || 0;
        const refresh = ctx.apis('gpt', 'refresh').find((e) => e.ts > init.ts && e.ts < init.ts + timeout);
        const end = ctx.named('prebid', 'auctionEnd').find((e) => e.auctionId === init.auctionId);
        if (refresh && (!end || refresh.ts < end.ts) && timeout) {
          out.push(fromEvent(find('INT-19'), refresh, ctx, 'likely', `refresh ${refresh.ts - init.ts}ms into ${timeout}ms auction`));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-20', 'Failsafe path requests GAM without available targeting', 'medium', 'Failsafe refreshes GAM with no Prebid targeting present.', ['Confirm Prebid failure and single fallback'], ['Label as fallback GAM request']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('gpt', 'refresh')) {
        const targeting = ctx.named('prebid', 'setTargeting').some((e) => e.ts <= env.ts);
        const auctioning = ctx.named('prebid', 'auctionInit').some((e) => {
          const end = ctx.named('prebid', 'auctionEnd').find((x) => x.auctionId === e.auctionId);
          return e.ts < env.ts && (!end || end.ts > env.ts);
        });
        if (targeting || !auctioning) continue;
        out.push(fromEvent(find('INT-20'), env, ctx, 'likely', 'refresh during in-flight auction without targeting (failsafe)'));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-21', 'New auction starts before the prior GPT cycle completes', 'high', 'Second auctionInit occurs before the first slot response/render.', ['Compare auction and render cycle ids'], ['Serialize a slot’s auction/request lifecycle']),
    (ctx) => {
      const inits = ctx.named('prebid', 'auctionInit');
      const out: DiagnosticIssue[] = [];
      for (let i = 1; i < inits.length; i++) {
        const prev = inits[i - 1];
        const code = prev.adUnitCode || inits[i].adUnitCode;
        const rendered = ctx.named('gpt', 'slotRenderEnded').some((e) => e.ts > prev.ts && e.ts <= inits[i].ts && (!code || e.slotElementId === code));
        if (rendered) continue;
        const requested = ctx.named('gpt', 'slotRequested').some((e) => e.ts > prev.ts);
        if (!requested) continue;
        out.push(fromEvent(find('INT-21'), inits[i], ctx, 'likely', 'new auction before prior GPT cycle completed'));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-22', 'Refresh uses targeting from the wrong auction', 'critical', 'GPT hb_adid maps to a bid whose auctionId is not the auction intended for that refresh.', ['Resolve hb_adid and compare auction IDs'], ['Bind targeting and refresh to the same cycle']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('gpt', 'slotRequested')) {
        const adid = str(slotTargeting(env).hb_adid);
        if (!adid) continue;
        const bidEnv = ctx.named('prebid', 'bidResponse').find((e) => adIdOf(e) === adid);
        const latest = lastOf(ctx.named('prebid', 'auctionInit').filter((e) => e.ts <= env.ts && (!env.slotElementId || e.adUnitCode === env.slotElementId || !e.adUnitCode)));
        if (bidEnv?.auctionId && latest?.auctionId && bidEnv.auctionId !== latest.auctionId) {
          out.push(fromEvent(find('INT-22'), env, ctx, 'confirmed', `hb_adid auction ${bidEnv.auctionId} != latest ${latest.auctionId}`));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-23', 'Auction covers one slot set while refresh covers another', 'high', 'requestBids.adUnitCodes and refresh slot array differ.', ['Compare auction, targeting, and refresh sets'], ['Align auction, targeting, and refresh scope']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('prebid', 'requestBids')) {
        const codes = (Array.isArray(rec(apiArgs(env)[0]).adUnitCodes) ? (rec(apiArgs(env)[0]).adUnitCodes as unknown[]) : [])
          .map(str)
          .filter((c): c is string => !!c);
        if (!codes.length) continue;
        const refresh = ctx.apis('gpt', 'refresh').find((e) => e.ts >= env.ts);
        if (!refresh) continue;
        const slots = refreshSlotIds(refresh);
        if (!slots.length) continue;
        const mismatch = codes.some((c) => !slots.includes(c)) || slots.some((s) => !codes.includes(s));
        if (mismatch) out.push(fromEvent(find('INT-23'), refresh, ctx, 'likely', `auction [${codes.join(',')}] vs refresh [${slots.join(',')}]`));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-24', 'Prebid and GPT size configurations disagree', 'high', 'Winning hb_size is not eligible in GPT sizes.', ['Compare hb_size with GPT mapping and rendered size'], ['Align eligible sizes']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('gpt', 'slotRenderEnded')) {
        const size = payload(env).size;
        const req = lastOf(ctx.named('gpt', 'slotRequested').filter((e) => e.slotElementId === env.slotElementId && e.ts <= env.ts));
        const hbSize = str(slotTargeting(req || env).hb_size);
        if (!hbSize || size == null) continue;
        const rendered = Array.isArray(size) ? `${size[0]}x${size[1]}` : String(size);
        if (rendered && hbSize && rendered !== hbSize && rendered !== '0x0') {
          out.push(fromEvent(find('INT-24'), env, ctx, 'possible', `hb_size=${hbSize} rendered=${rendered}`));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-25', 'Prebid and GPT privacy state disagree', 'high', 'Privacy settings applied on one side after the other already requested.', ['Compare tcf2Enforcement vs setPrivacySettings timestamps'], ['Coordinate both systems from the same consent state']),
    (ctx) => {
      const pb = ctx.named('prebid', 'tcf2Enforcement')[0];
      const gpt = ctx.apis('gpt', 'setPrivacySettings')[0];
      if (!pb || !gpt) return [];
      if (Math.abs(pb.ts - gpt.ts) < 1000) return [];
      const firstReq = ctx.named('prebid', 'bidRequested')[0] || ctx.named('gpt', 'slotRequested')[0];
      if (!firstReq) return [];
      if ((pb.ts - firstReq.ts) * (gpt.ts - firstReq.ts) > 0) return [];
      return [fromEvent(find('INT-25'), gpt, ctx, 'possible', 'Prebid and GPT privacy signals applied at different times relative to requests')];
    }
  ),
  defineRule(
    meta('INT-26', 'Late Prebid response arrives after GAM request', 'info', 'Bid response happens after auction timeout and/or slotRequested.', ['Compare response timestamp, timeout, slotRequested'], ['Do not attribute the late bid to the current GAM request']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'bidResponse')) {
        const end = ctx.named('prebid', 'auctionEnd').find((e) => e.auctionId === env.auctionId);
        const req = ctx.named('gpt', 'slotRequested').find((e) => e.ts < env.ts && (!env.adUnitCode || e.slotElementId === env.adUnitCode));
        if (end && env.ts > end.ts) out.push(fromEvent(find('INT-26'), env, ctx, 'confirmed', 'bidResponse after auctionEnd'));
        else if (req) out.push(fromEvent(find('INT-26'), env, ctx, 'likely', 'bidResponse after slotRequested'));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-27', 'GPT request succeeds but no Prebid bidWon appears', 'info', 'slotRenderEnded is filled, targeting existed, but no bidWon.', ['Determine rendered demand source'], ['Report missing bidWon as error only when Prebid creative actually rendered']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('gpt', 'slotRenderEnded')) {
        if (payload(env).isEmpty === true) continue;
        const won = ctx.named('prebid', 'bidWon').some((e) => !env.slotElementId || e.adUnitCode === env.slotElementId);
        if (won) continue;
        if (!ctx.session.status.libLoaded) continue;
        out.push(fromEvent(find('INT-27'), env, ctx, 'possible', 'filled GPT slot without bidWon'));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-28', 'Prebid reports render success but GPT outcome is missing', 'medium', 'adRenderSucceeded/bidWon without GPT response/render.', ['Identify render owner'], ['Classify by render path before reporting integration failure']),
    (ctx) => {
      if (!ctx.session.status.gptPresent) return [];
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'adRenderSucceeded')) {
        const gpt = ctx.named('gpt', 'slotRenderEnded').some((e) => !env.adUnitCode || e.slotElementId === env.adUnitCode);
        if (gpt) continue;
        out.push(fromEvent(find('INT-28'), env, ctx, 'possible', 'Prebid render success without GPT slotRenderEnded'));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-29', 'SafeFrame or iframe policy blocks the Prebid creative', 'high', 'Render fails with SafeFrame/sandbox/CSP evidence.', ['Inspect setForceSafeFrame', 'console/CSP'], ['Correct creative or supported frame configuration']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'adRenderFailed').concat(ctx.errors())) {
        if (!/safeframe|sandbox|csp|frame/i.test(JSON.stringify(payload(env)))) continue;
        out.push(fromEvent(find('INT-29'), env, ctx, 'likely', 'frame policy may have blocked creative'));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-30', 'Duplicate Prebid or GPT library instances split state', 'critical', 'Multiple libLoaded/apiReady versions or queue replacements.', ['Inspect versions and globals'], ['Use one intentional instance per integration']),
    (ctx) => {
      const pb = ctx.named('prebid', 'libLoaded');
      const gpt = ctx.named('gpt', 'apiReady');
      const out: DiagnosticIssue[] = [];
      if (pb.length > 1) out.push(fromEvent(find('INT-30'), pb[1], ctx, 'likely', 'multiple Prebid libLoaded events'));
      if (gpt.length > 1) out.push(fromEvent(find('INT-30'), gpt[1], ctx, 'likely', 'multiple GPT apiReady events'));
      return out;
    }
  ),
  defineRule(
    meta('INT-31', 'Send-all-bids limit removes eligible bids from targeting', 'medium', 'More valid bids exist than bidder-suffixed targeting entries.', ['Compare eligible bids vs targeting set'], ['Explain intentional limiting']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'auctionEnd')) {
        const bids = arrLen(payload(env).bidsReceived);
        if (bids < 3) continue;
        const t = ctx.named('prebid', 'setTargeting').find((e) => e.ts >= env.ts);
        if (!t) continue;
        const root = targetingMap(payload(t));
        let keyCount = 0;
        for (const raw of Object.values(looksLikeUnitMap(root) ? root : {})) keyCount += hbKeys(targetingMap(raw)).length;
        if (keyCount && keyCount < bids) out.push(fromEvent(find('INT-31'), t, ctx, 'possible', `${bids} bids vs ${keyCount} targeting keys`));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-32', 'Auction targeting character limit truncates entries', 'high', 'Generated targeting approaches auctionKeyMaxChars.', ['Inspect targetingControls.auctionKeyMaxChars'], ['Remove unnecessary keys']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('prebid', 'setConfig')) {
        const controls = rec(rec(apiArgs(env)[0]).targetingControls);
        const max = controls.auctionKeyMaxChars;
        if (typeof max === 'number' && max > 0 && max < 500) {
          out.push(fromEvent(find('INT-32'), env, ctx, 'possible', `low auctionKeyMaxChars=${max}`));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-33', 'Expected custom targeting key is missing', 'medium', 'Standard hb_* exists but a configured custom key is absent.', ['Compare bidder settings custom targeting'], ['Correct the custom targeting rule']),
    () => []
  ),
  defineRule(
    meta('INT-34', 'Custom targeting overwrites a standard Prebid key', 'critical', 'A standard key has an unexpected value after custom targeting.', ['Compare generation stages'], ['Rename custom keys']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('gpt', 'setTargeting')) {
        const key = str(apiArgs(env)[0]);
        if (key && REQUIRED_HB_KEYS.includes(key as (typeof REQUIRED_HB_KEYS)[number])) {
          out.push(fromEvent(find('INT-34'), env, ctx, 'likely', `publisher setTargeting overwrote ${key}`));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-35', 'Targeting allow-list/filter removes a required key', 'high', 'allowTargetingKeys omits a required standard key.', ['Inspect targetingControls.allowTargetingKeys'], ['Add the required key to the allow-list']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('prebid', 'setConfig')) {
        const keys = rec(apiArgs(env)[0]).allowTargetingKeys ?? rec(rec(apiArgs(env)[0]).targetingControls).allowTargetingKeys;
        if (!Array.isArray(keys) || !keys.length) continue;
        const allowed = new Set(keys.map(String));
        const missing = REQUIRED_HB_KEYS.filter((k) => ![...allowed].some((a) => a === k || a === k.replace('hb_', '')));
        if (missing.length) out.push(fromEvent(find('INT-35'), env, ctx, 'confirmed', `allowTargetingKeys omits ${missing.join(', ')}`));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-36', 'GPT is unavailable at the targeting handoff', 'critical', 'Auction completes with a candidate but googletag.pubads is unavailable.', ['Inspect apiReady/pubadsReady vs auctionEnd'], ['Coordinate handoff through GPT readiness']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('prebid', 'auctionEnd')) {
        const received = arrLen(payload(env).bidsReceived);
        if (!received) continue;
        if (ctx.session.status.pubadsReady && ctx.named('gpt', 'pubadsReady')[0]?.ts <= env.ts) continue;
        if (!ctx.session.status.gptPresent) continue;
        if (ctx.session.status.pubadsReady) continue;
        out.push(fromEvent(find('INT-36'), env, ctx, 'likely', 'auction ended with bids before GPT pubadsReady'));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-37', 'No GPT slot is defined for the Prebid ad unit', 'critical', 'Prebid auction exists but no GPT slot is defined.', ['Inspect live GPT slots'], ['Define the slot before handoff, or classify as Prebid-only']),
    (ctx) => {
      if (!ctx.session.status.gptPresent && ctx.apis('gpt', 'defineSlot').length === 0) return [];
      const out: DiagnosticIssue[] = [];
      for (const code of ctx.session.adUnits.keys()) {
        if (ctx.session.slots.has(code)) continue;
        if (!ctx.session.slots.size && ctx.named('gpt', 'apiReady').length === 0) continue;
        const sample = ctx.forAdUnit(code)[0];
        if (!sample) continue;
        out.push(fromEvent(find('INT-37'), sample, ctx, 'likely', `no GPT slot defined for ${code}`, { adUnitCode: code }));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-38', 'More than one GPT slot matches one Prebid ad unit', 'critical', 'Multiple live GPT slots share one element id / path.', ['Enumerate candidates'], ['Make matching one-to-one']),
    (ctx) => {
      const paths = new Map<string, string[]>();
      for (const slot of ctx.session.slots.values()) {
        if (!slot.adUnitPath) continue;
        const list = paths.get(slot.adUnitPath) || [];
        list.push(slot.slotElementId);
        paths.set(slot.adUnitPath, list);
      }
      const out: DiagnosticIssue[] = [];
      for (const [path, ids] of paths) {
        if (ids.length < 2) continue;
        const env = ctx.named('gpt', 'defineSlot.result')[0];
        if (!env) continue;
        out.push(fromEvent(find('INT-38'), env, ctx, 'likely', `path ${path} maps to ${ids.join(', ')}`));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-39', 'GPT targeting values differ from Prebid’s generated values', 'critical', 'Same hb_* key exists on both sides but values differ.', ['Diff keys at generation vs request'], ['Remove the unintended writer']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('gpt', 'slotRequested')) {
        const gptMap = slotTargeting(env);
        const prebid = ctx.session.prebidTargeting[env.slotElementId || ''] || {};
        for (const key of REQUIRED_HB_KEYS) {
          if (prebid[key] == null || gptMap[key] == null) continue;
          if (String(prebid[key]) === String(gptMap[key])) continue;
          out.push(fromEvent(find('INT-39'), env, ctx, 'confirmed', `${key} Prebid=${String(prebid[key])} GPT=${String(gptMap[key])}`));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-40', 'Publisher code overwrites Prebid targeting after handoff', 'critical', 'hb_* values change after setTargeting and before slotRequested.', ['Inspect GPT setTargeting after Prebid handoff'], ['Establish key ownership']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('gpt', 'setTargeting')) {
        const key = str(apiArgs(env)[0]);
        if (!key || !key.startsWith('hb_')) continue;
        const handoff = ctx.named('prebid', 'setTargeting').find((e) => e.ts <= env.ts);
        const req = ctx.named('gpt', 'slotRequested').find((e) => e.ts >= env.ts);
        if (handoff && req) out.push(fromEvent(find('INT-40'), env, ctx, 'confirmed', `GPT wrote ${key} after Prebid setTargeting`));
      }
      return out;
    }
  ),
  defineRule(
    meta('INT-41', 'Prebid targeting is cleared before the GAM request', 'critical', 'Expected hb_* keys are present after handoff but missing at request time.', ['Observe clearTargeting vs slotRequested'], ['Clear only obsolete cycle targeting after the snapshot']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('gpt', 'clearTargeting')) {
        const req = ctx.named('gpt', 'slotRequested').find((e) => e.ts >= env.ts);
        const handoff = ctx.named('prebid', 'setTargeting').find((e) => e.ts <= env.ts);
        if (handoff && req) out.push(fromEvent(find('INT-41'), env, ctx, 'confirmed', 'clearTargeting between Prebid handoff and GAM request'));
      }
      return out;
    }
  ),
];

const BY_ID = new Map(integrationRules.map((r) => [r.id, r]));
function find(id: string): RuleMeta {
  return BY_ID.get(id)!;
}

function arrLen(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

function looksLikeUnitMap(root: Record<string, unknown>): boolean {
  const values = Object.values(root);
  return values.length > 0 && values.every((v) => v && typeof v === 'object' && !Array.isArray(v));
}

function refreshSlotIds(env: { payload: unknown }): string[] {
  const arg = apiArgs(env as any)[0];
  if (!Array.isArray(arg)) return [];
  return arg.map((s) => (typeof s === 'string' ? s : str(rec(s).slotElementId))).filter((x): x is string => !!x);
}
