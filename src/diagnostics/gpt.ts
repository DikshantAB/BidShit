import type { Envelope, SessionState } from '../shared/types';
import { parseCustParams, requestMatchesSlot } from '../shared/gam-network';
import {
  GPT_DUP_REQUEST_MS,
  apiArgs,
  apis,
  arr,
  auctionCodes,
  evidenceFrom,
  firstHb,
  issue,
  named,
  num,
  payload,
  rec,
  slotIdForCode,
  slotTargeting,
  str,
} from './helpers';
import type { DiagnosticIssue, Severity } from './types';

type RuleMeta = {
  ruleId: string;
  title: string;
  severity: Severity;
  scope: 'gpt';
  signal: string;
  explanation: string;
  checks: string[];
  recommendations: string[];
};

const RULES: Record<string, RuleMeta> = {
  'COMMON-GPT-01': {
    ruleId: 'COMMON-GPT-01',
    title: 'GPT does not load or become ready',
    severity: 'critical',
    scope: 'gpt',
    signal: 'GPT intent exists (command queue or gpt.js request), but googletag.apiReady never becomes true.',
    explanation: 'Script was blocked/failed, wrong URL, queue overwritten, or the library never booted.',
    checks: ['Inspect the official GPT script request, googletag.cmd, and googletag.apiReady.'],
    recommendations: ['Fix GPT loading and run API calls through the command queue.'],
  },
  'COMMON-GPT-02': {
    ruleId: 'COMMON-GPT-02',
    title: 'GPT slot is not defined or attached correctly',
    severity: 'critical',
    scope: 'gpt',
    signal: 'defineSlot / defineOutOfPageSlot returns null, or the slot never receives addService(googletag.pubads()).',
    explanation: 'Invalid arguments/size, unsupported definition, or PubAds was not attached.',
    checks: ['Inspect the definition return value and whether addService(pubads) ran for that slot.'],
    recommendations: ['Define a valid slot and attach PubAdsService before requesting it.'],
  },
  'COMMON-GPT-03': {
    ruleId: 'COMMON-GPT-03',
    title: 'Initial load disabled but refresh never occurs',
    severity: 'critical',
    scope: 'gpt',
    signal: 'display() runs with initial load disabled, but no later refresh() or slotRequested occurs for that slot.',
    explanation: 'Auction callback/failsafe failed, early return, or the refresh path was omitted.',
    checks: ['Confirm disable-initial-load, then wait for refresh or slotRequested after display().'],
    recommendations: ['Ensure one guarded path eventually refreshes the intended slot.'],
  },
  'COMMON-GPT-04': {
    ruleId: 'COMMON-GPT-04',
    title: 'Refresh occurs before display',
    severity: 'high',
    scope: 'gpt',
    signal: 'refresh() targets a slot that has not yet been display()ed.',
    explanation: 'Async component/setup race. GPT only refreshes slots already registered with display().',
    checks: ['Compare per-slot display and refresh timestamps.'],
    recommendations: ['display() / register the slot before refreshing it.'],
  },
  'COMMON-GPT-05': {
    ruleId: 'COMMON-GPT-05',
    title: 'Duplicate initial GAM requests',
    severity: 'high',
    scope: 'gpt',
    signal: 'With initial load still enabled, display() fetches the slot and an immediate refresh() fetches it again.',
    explanation:
      'Initial load remains enabled while the publisher also uses refresh() as the first-request mechanism. Prebid integrations should disable initial load.',
    checks: ['disableInitialLoad was not set, then display + refresh for the same slot produce two GAM requests.'],
    recommendations: ['Choose one first-request strategy; Prebid integrations normally disable initial load.'],
  },
  'COMMON-GPT-06': {
    ruleId: 'COMMON-GPT-06',
    title: 'Refresh requests the wrong or every slot',
    severity: 'high',
    scope: 'gpt',
    signal: 'refresh() is called with a stale/destroyed/wrong slot, or with no slot array when only a subset was intended.',
    explanation: 'Omitted slot array, stale component state, or a destroyed slot object. Unscoped refresh() is valid GPT API usage and refreshes every registered slot.',
    checks: ['Compare refresh arguments with live pubads().getSlots() and the current auction’s intended ad units.'],
    recommendations: ['Refresh the explicit current slot array when only some slots should be requested.'],
  },
  'COMMON-GPT-07': {
    ruleId: 'COMMON-GPT-07',
    title: 'GAM request fails or never completes',
    severity: 'critical',
    scope: 'gpt',
    signal: 'slotRequested occurs but the GAM request is blocked/fails, or slotResponseReceived never follows.',
    explanation: 'Ad blocker/browser policy, connection failure, cancellation/navigation, or a bad GAM request.',
    checks: ['Matching /gampad/ads transport status, then slotResponseReceived for that slot.'],
    recommendations: ['Fix the observed browser/network/request failure; do not invent a cause when transport evidence is missing.'],
  },
  'COMMON-GPT-08': {
    ruleId: 'COMMON-GPT-08',
    title: 'GAM responds but rendering never completes',
    severity: 'critical',
    scope: 'gpt',
    signal: 'slotResponseReceived occurs without a later matching slotRenderEnded.',
    explanation: 'Render exception, slot destruction, blocked creative processing, main-thread stall, or a missed observer.',
    checks: ['Wait a render threshold after slotResponseReceived for slotRenderEnded on the same slot.'],
    recommendations: ['Fix the render/slot lifecycle problem or reproduce with early instrumentation.'],
  },
  'COMMON-GPT-09': {
    ruleId: 'COMMON-GPT-09',
    title: 'GAM returns no fill',
    severity: 'info',
    scope: 'gpt',
    signal: 'slotRenderEnded.isEmpty === true.',
    explanation: 'No eligible GAM demand, targeting/size mismatch, policy restriction, or inventory/delivery configuration.',
    checks: ['The isEmpty flag on slotRenderEnded. HTTP 200/204 on GAMPAD is not a network failure.'],
    recommendations: ['Investigate GAM eligibility/delivery; do not label this as network failure.'],
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
    adUnitCode: extra.adUnitCode || extra.slotId,
    auctionId: extra.auctionId,
    evidence: extra.evidence,
  });
}

function slotIdOf(env: Envelope): string | undefined {
  return env.slotElementId || env.adUnitCode || str(payload(env).slotElementId);
}

function argSlotId(value: unknown): string | undefined {
  if (typeof value === 'string' && value && !value.startsWith('/')) return value;
  return str(rec(value).slotElementId);
}

function displaySlotId(session: SessionState, env: Envelope): string | undefined {
  const fromPayload = str(payload(env).slotElementId) || env.slotElementId;
  if (fromPayload) return fromPayload;
  const a0 = apiArgs(env)[0];
  const fromArg = argSlotId(a0);
  if (fromArg) return fromArg;
  const path = typeof a0 === 'string' && a0.startsWith('/') ? a0 : str(rec(a0).adUnitPath);
  if (!path) return undefined;
  for (const slot of session.slots.values()) {
    if (slot.adUnitPath === path) return slot.slotElementId;
  }
  return path;
}

function definedSlots(session: SessionState): { id: string; env: Envelope }[] {
  const out: { id: string; env: Envelope }[] = [];
  for (const name of ['defineSlot', 'defineOutOfPageSlot'] as const) {
    for (const env of apis(session, 'gpt', name)) {
      const result = rec(payload(env).result);
      const id = str(result.slotElementId) || env.slotElementId || defineDivId(env);
      if (id && payload(env).result != null) out.push({ id, env });
    }
  }
  for (const env of named(session, 'gpt', 'defineSlot.result')) {
    const id = env.slotElementId || str(payload(env).slotElementId);
    if (id && !out.some((s) => s.id === id)) out.push({ id, env });
  }
  return out;
}

function defineDivId(env: Envelope): string | undefined {
  const args = apiArgs(env);
  if (env.name === 'defineOutOfPageSlot') return typeof args[1] === 'string' ? args[1] : undefined;
  return typeof args[2] === 'string' ? args[2] : undefined;
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

function liveSlotIds(session: SessionState): Set<string> {
  const dead = destroyedIds(session);
  const ids = new Set<string>();
  for (const { id } of definedSlots(session)) {
    if (!dead.has(id)) ids.add(id);
  }
  for (const id of session.slots.keys()) {
    if (!dead.has(id)) ids.add(id);
  }
  return ids;
}

function hasPubadsService(session: SessionState, slotId: string): boolean {
  return apis(session, 'gpt', 'addService').some((env) => {
    if (slotIdOf(env) !== slotId) return false;
    const service = str(payload(env).service);
    return service ? service === 'pubads' : true;
  });
}

function hasGptIntent(session: SessionState): boolean {
  if (apis(session, 'gpt', 'cmd.push').length) return true;
  if (apis(session, 'gpt', 'defineSlot').length || apis(session, 'gpt', 'defineOutOfPageSlot').length) return true;
  if (apis(session, 'gpt', 'setConfig').length || apis(session, 'gpt', 'enableServices').length) return true;
  if (apis(session, 'gpt', 'display').length) return true;
  return session.envelopes.some((e) => e.channel === 'gpt' && e.kind === 'event');
}

function initialLoadDisabled(session: SessionState): boolean {
  const enableSeq = apis(session, 'gpt', 'enableServices')[0]?.seq;
  const hits: Envelope[] = [...apis(session, 'gpt', 'disableInitialLoad')];
  for (const env of apis(session, 'gpt', 'setConfig')) {
    if (rec(apiArgs(env)[0]).disableInitialLoad === true) hits.push(env);
  }
  if (enableSeq == null) {
    return hits.length > 0 || rec(session.snapshots.pubads).isInitialLoadDisabled === true;
  }
  return hits.some((e) => e.seq <= enableSeq);
}

function lazyLoadActive(session: SessionState): boolean {
  let active = false;
  const events = [...apis(session, 'gpt', 'enableLazyLoad'), ...apis(session, 'gpt', 'setConfig')].sort(
    (a, b) => a.seq - b.seq
  );
  for (const env of events) {
    if (env.name === 'enableLazyLoad') {
      const arg = apiArgs(env)[0];
      active = arg != null && arg !== false;
      continue;
    }
    const cfg = rec(apiArgs(env)[0]);
    if ('lazyLoad' in cfg) active = cfg.lazyLoad != null && cfg.lazyLoad !== false;
  }
  return active;
}

function refreshTargets(session: SessionState, env: Envelope): { ids: string[]; unscoped: boolean } {
  const recorded = arr(payload(env).slotIds)
    .map((id) => str(id))
    .filter((id): id is string => !!id);
  if (payload(env).unscoped === true) return { ids: recorded.length ? recorded : [...liveSlotIds(session)], unscoped: true };
  if (recorded.length) return { ids: recorded, unscoped: false };
  const arg = apiArgs(env)[0];
  if (arg == null || (!Array.isArray(arg) && typeof arg === 'object' && !str(rec(arg).slotElementId))) {
    return { ids: [...liveSlotIds(session)], unscoped: true };
  }
  if (!Array.isArray(arg)) {
    const id = argSlotId(arg);
    return id ? { ids: [id], unscoped: false } : { ids: [...liveSlotIds(session)], unscoped: true };
  }
  const ids = arg.map((item) => argSlotId(item)).filter((id): id is string => !!id);
  return { ids, unscoped: false };
}

function displaysFor(session: SessionState, slotId: string): Envelope[] {
  return apis(session, 'gpt', 'display').filter((env) => displaySlotId(session, env) === slotId);
}

function refreshesFor(session: SessionState, slotId: string): Envelope[] {
  return apis(session, 'gpt', 'refresh').filter((env) => refreshTargets(session, env).ids.includes(slotId));
}

function intendedSlotIds(session: SessionState): Set<string> | undefined {
  if (!session.auctions.size) return undefined;
  const auctions = [...session.auctions.values()];
  const current = auctions.find((a) => a.status === 'inProgress') || auctions[auctions.length - 1];
  const ids = new Set<string>();
  for (const code of current.adUnitCodes) {
    ids.add(code);
    const matched = slotIdForCode(session, code);
    if (matched) ids.add(matched);
    for (const slot of session.slots.values()) {
      if (slot.adUnitPath === code) ids.add(slot.slotElementId);
    }
  }
  return ids;
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

function correlatorOf(env: Envelope): string {
  return str(payload(env).correlator) || `seq:${env.seq}`;
}

function iuPathsOf(env: Envelope): string[] {
  return arr(payload(env).iuPaths)
    .map((p) => str(p))
    .filter((p): p is string => !!p);
}

function hbAdIdsFromScpField(env: Envelope, field: 'prev_scp' | 'scp'): string[] {
  const p = payload(env);
  const raw = str(p[field]) || str(rec(p.query)[field]) || '';
  if (!raw) return [];
  const ids = new Set<string>();
  for (const chunk of raw.split('|')) {
    const parsed = parseCustParams(chunk);
    const value = parsed.hb_adid || parsed.hb_adId;
    if (!value) continue;
    for (const part of value.split(',')) {
      const id = part.trim();
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/** Slot-level Prebid ad id on a GAMPAD URL. Later requests copy it into prev_scp; the first request has it on scp. */
function hbAdIdsFromGam(env: Envelope): { adIds: string[]; fromPrevScp: boolean } {
  const fromPrev = hbAdIdsFromScpField(env, 'prev_scp');
  if (fromPrev.length) return { adIds: fromPrev, fromPrevScp: true };
  return { adIds: hbAdIdsFromScpField(env, 'scp'), fromPrevScp: false };
}

function slotIdForGam(session: SessionState, env: Envelope, hbAdId?: string): string | undefined {
  const ius = iuPathsOf(env);
  for (const slot of session.slots.values()) {
    if (requestMatchesSlot(ius, slot.adUnitPath)) return slot.slotElementId;
    if (hbAdId && firstHb(slotTargeting(session, slot), 'hb_adid') === hbAdId) return slot.slotElementId;
  }
  if (env.adUnitCode) return slotIdForCode(session, env.adUnitCode) || env.adUnitCode;
  if (ius.length === 1) return slotIdForCode(session, ius[0]) || ius[0];
  return undefined;
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

function gamForSlot(session: SessionState, slotId: string, aroundTs: number): Envelope[] {
  const path = session.slots.get(slotId)?.adUnitPath;
  return gamRequests(session).filter((env) => {
    const iu = arr(payload(env).iuPaths).map((p) => str(p)).filter((p): p is string => !!p);
    const pathMatch = requestMatchesSlot(iu, path) || iu.includes(slotId);
    const idMatch = env.adUnitCode === slotId || env.adUnitCode === path;
    if (!pathMatch && !idMatch && iu.length) return false;
    return Math.abs(env.ts - aroundTs) <= 8_000;
  });
}

function nextSameSlot(events: Envelope[], env: Envelope, slotId: string): Envelope | undefined {
  return events.find((e) => e.seq > env.seq && slotIdOf(e) === slotId);
}

function auctionInFlightFor(session: SessionState, slotId: string): boolean {
  const path = session.slots.get(slotId)?.adUnitPath;
  const matches = (codes: string[]) => codes.includes(slotId) || (path ? codes.includes(path) : false);
  for (const auction of session.auctions.values()) {
    if (auction.status && auction.status !== 'inProgress') continue;
    if (matches(auction.adUnitCodes)) return true;
  }
  for (const init of named(session, 'prebid', 'auctionInit')) {
    if (named(session, 'prebid', 'auctionEnd').some((e) => e.auctionId === init.auctionId)) continue;
    if (matches(auctionCodes(init))) return true;
  }
  return false;
}

function gpt01(session: SessionState, out: DiagnosticIssue[]): void {
  if (session.status.apiReady) return;
  if (!session.status.hookReady) return;
  if (!hasGptIntent(session)) return;
  const hook = named(session, 'hook', 'hook-ready')[0] || apis(session, 'gpt', 'cmd.push')[0];
  out.push(
    emit('COMMON-GPT-01', session, {
      evidence: [evidenceFrom(hook, 'googletag.apiReady is false after GPT intent was observed')],
    })
  );
}

function gpt02(session: SessionState, out: DiagnosticIssue[]): void {
  const dead = destroyedIds(session);
  for (const name of ['defineSlot', 'defineOutOfPageSlot'] as const) {
    for (const env of apis(session, 'gpt', name)) {
      if (payload(env).result != null) continue;
      const slotId = defineDivId(env);
      out.push(
        emit('COMMON-GPT-02', session, {
          slotId,
          evidence: [evidenceFrom(env, `${name} returned null${slotId ? ` for "${slotId}"` : ''}`)],
        })
      );
    }
  }
  for (const { id, env } of definedSlots(session)) {
    if (dead.has(id)) continue;
    if (hasPubadsService(session, id)) continue;
    out.push(
      emit('COMMON-GPT-02', session, {
        slotId: id,
        evidence: [evidenceFrom(env, `Slot "${id}" was defined but addService(pubads) was not observed`)],
      })
    );
  }
}

function gpt03(session: SessionState, out: DiagnosticIssue[]): void {
  if (!initialLoadDisabled(session)) return;
  if (lazyLoadActive(session)) return;
  for (const env of apis(session, 'gpt', 'display')) {
    const slotId = displaySlotId(session, env);
    if (!slotId) continue;
    const refreshed = refreshesFor(session, slotId).some((e) => e.ts >= env.ts);
    const requested = named(session, 'gpt', 'slotRequested').some(
      (e) => slotIdOf(e) === slotId && e.ts >= env.ts
    );
    if (refreshed || requested) continue;
    if (auctionInFlightFor(session, slotId)) continue;
    out.push(
      emit('COMMON-GPT-03', session, {
        slotId,
        evidence: [evidenceFrom(env, `display("${slotId}") with disableInitialLoad and no later refresh/slotRequested`)],
      })
    );
  }
}

function gpt04(session: SessionState, out: DiagnosticIssue[]): void {
  for (const env of apis(session, 'gpt', 'refresh')) {
    const { ids, unscoped } = refreshTargets(session, env);
    for (const slotId of ids) {
      const displayed = displaysFor(session, slotId).some((e) => e.ts <= env.ts);
      if (displayed) continue;
      out.push(
        emit('COMMON-GPT-04', session, {
          confidence: unscoped ? 'likely' : 'confirmed',
          slotId,
          evidence: [
            evidenceFrom(
              env,
              unscoped
                ? `Unscoped refresh included "${slotId}" before display()`
                : `refresh() targeted "${slotId}" before display()`
            ),
          ],
        })
      );
    }
  }
}

function gpt05(session: SessionState, out: DiagnosticIssue[]): void {
  if (initialLoadDisabled(session)) return;
  const gams = [...gamRequests(session)].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  const byAdId = new Map<string, Envelope[]>();
  const byIu = new Map<string, Envelope[]>();

  for (const env of gams) {
    const { adIds } = hbAdIdsFromGam(env);
    if (adIds.length) {
      for (const adId of adIds) {
        const list = byAdId.get(adId) || [];
        list.push(env);
        byAdId.set(adId, list);
      }
      continue;
    }
    for (const iu of iuPathsOf(env)) {
      const list = byIu.get(iu) || [];
      list.push(env);
      byIu.set(iu, list);
    }
  }

  const emitted = new Set<string>();
  const pushDup = (
    slotId: string | undefined,
    pair: { first: Envelope; second: Envelope },
    summary: string,
    confidence: DiagnosticIssue['confidence']
  ) => {
    const key = slotId || correlatorOf(pair.first) + correlatorOf(pair.second);
    if (emitted.has(key)) return;
    emitted.add(key);
    out.push(
      emit('COMMON-GPT-05', session, {
        confidence,
        slotId,
        evidence: [
          evidenceFrom(pair.first, summary),
          evidenceFrom(pair.second, `Second GAMPAD correlator=${correlatorOf(pair.second)} (${pair.second.ts - pair.first.ts}ms later)`),
        ],
      })
    );
  };

  for (const [adId, list] of byAdId) {
    const pair = pairWithinWindow(list);
    if (!pair) continue;
    const slotId = slotIdForGam(session, pair.second, adId) || slotIdForGam(session, pair.first, adId);
    const sawPrev = hbAdIdsFromGam(pair.second).fromPrevScp || hbAdIdsFromGam(pair.first).fromPrevScp;
    pushDup(
      slotId,
      pair,
      `Duplicate GAMPAD for hb_adid=${adId} (${sawPrev ? 'prev_scp' : 'scp'}; ${distinctCorrelators(list).length} correlators)`,
      'confirmed'
    );
  }

  for (const [iu, list] of byIu) {
    const pair = pairWithinWindow(list);
    if (!pair) continue;
    const slotId = slotIdForGam(session, pair.second) || slotIdForGam(session, pair.first) || slotIdForCode(session, iu) || iu;
    pushDup(
      slotId,
      pair,
      `Duplicate GAMPAD for iu=${iu} with no hb_adid on prev_scp/scp (${distinctCorrelators(list).length} correlators)`,
      'likely'
    );
  }
}

function gpt06(session: SessionState, out: DiagnosticIssue[]): void {
  const live = liveSlotIds(session);
  const intended = intendedSlotIds(session);
  for (const env of apis(session, 'gpt', 'refresh')) {
    const { ids, unscoped } = refreshTargets(session, env);
    if (unscoped) {
      if (!intended) continue;
      const extras = ids.filter((id) => !intended.has(id));
      if (!extras.length) continue;
      for (const slotId of extras) {
        out.push(
          emit('COMMON-GPT-06', session, {
            confidence: 'likely',
            slotId,
            evidence: [
              evidenceFrom(
                env,
                `Unscoped refresh() included "${slotId}", which is outside the current auction’s intended ad units`
              ),
            ],
          })
        );
      }
      continue;
    }
    for (const slotId of ids) {
      const missing = !live.has(slotId);
      const wrong = intended ? !intended.has(slotId) && !intended.has(session.slots.get(slotId)?.adUnitPath || '') : false;
      if (!missing && !wrong) continue;
      out.push(
        emit('COMMON-GPT-06', session, {
          slotId,
          evidence: [
            evidenceFrom(
              env,
              missing
                ? `refresh() targeted "${slotId}", which is missing from the live PubAds slot set`
                : `refresh() targeted "${slotId}", which is not the current auction’s intended ad unit`
            ),
          ],
        })
      );
    }
  }
}

function gpt07(session: SessionState, out: DiagnosticIssue[]): void {
  const requested = named(session, 'gpt', 'slotRequested');
  const responses = named(session, 'gpt', 'slotResponseReceived');
  for (const env of requested) {
    const slotId = slotIdOf(env);
    if (!slotId) continue;
    const nextReq = nextSameSlot(requested, env, slotId);
    const responded = responses.some(
      (e) => slotIdOf(e) === slotId && e.ts >= env.ts && (!nextReq || e.ts <= nextReq.ts)
    );
    const gams = gamForSlot(session, slotId, env.ts);
    const failed = gams.find(gamFailed);
    if (failed) {
      const status = num(payload(failed).status);
      out.push(
        emit('COMMON-GPT-07', session, {
          slotId,
          evidence: [
            evidenceFrom(failed, `GAMPAD transport failed for "${slotId}" (status=${status ?? 'blocked/unknown'})`),
            evidenceFrom(env, 'slotRequested observed for this cycle'),
          ],
        })
      );
      continue;
    }
    if (responded) continue;
    const httpDone = gams.some((g) => {
      const status = num(payload(g).status);
      return status === 200 || status === 204;
    });
    const cycleClosed = !!nextReq || destroyedAfter(session, env, slotId);
    if (!httpDone && !cycleClosed) continue;
    out.push(
      emit('COMMON-GPT-07', session, {
        confidence: httpDone || gams.length ? 'likely' : 'possible',
        slotId,
        evidence: [
          evidenceFrom(
            env,
            httpDone
              ? `GAMPAD completed for "${slotId}" but slotResponseReceived never followed`
              : `slotRequested for "${slotId}" with no matching GAMPAD request and no slotResponseReceived`
          ),
        ],
      })
    );
  }
}

function destroyedAfter(session: SessionState, env: Envelope, slotId: string): boolean {
  return apis(session, 'gpt', 'destroySlots').some((e) => {
    if (e.seq <= env.seq) return false;
    const arg = apiArgs(e)[0];
    if (arg == null) return true;
    return (Array.isArray(arg) ? arg : [arg]).some((item) => argSlotId(item) === slotId);
  });
}

function gpt08(session: SessionState, out: DiagnosticIssue[]): void {
  const responses = named(session, 'gpt', 'slotResponseReceived');
  const renders = named(session, 'gpt', 'slotRenderEnded');
  for (const env of responses) {
    const slotId = slotIdOf(env);
    if (!slotId) continue;
    const nextResp = nextSameSlot(responses, env, slotId);
    const rendered = renders.some(
      (e) => slotIdOf(e) === slotId && e.ts >= env.ts && (!nextResp || e.ts <= nextResp.ts)
    );
    if (rendered) continue;
    const later = session.envelopes.some((e) => e.seq > env.seq);
    const destroyedSlot = destroyedAfter(session, env, slotId);
    if (!later && !destroyedSlot) continue;
    out.push(
      emit('COMMON-GPT-08', session, {
        slotId,
        evidence: [
          evidenceFrom(
            env,
            destroyedSlot
              ? `slotResponseReceived for "${slotId}" with no slotRenderEnded; destroySlots ran in between`
              : `slotResponseReceived for "${slotId}" with no later slotRenderEnded`
          ),
        ],
      })
    );
  }
}

function gpt09(session: SessionState, out: DiagnosticIssue[]): void {
  for (const env of named(session, 'gpt', 'slotRenderEnded')) {
    if (payload(env).isEmpty !== true) continue;
    const slotId = slotIdOf(env);
    const slot = slotId ? session.slots.get(slotId) : undefined;
    const targeting = rec(slot?.targetingAtRequest);
    const keys = Object.keys(targeting).slice(0, 12);
    out.push(
      emit('COMMON-GPT-09', session, {
        slotId,
        evidence: [
          evidenceFrom(
            env,
            [
              `slotRenderEnded.isEmpty=true`,
              slot?.adUnitPath ? `path=${slot.adUnitPath}` : undefined,
              payload(env).responseIdentifier != null
                ? `responseIdentifier=${String(payload(env).responseIdentifier)}`
                : undefined,
              keys.length ? `requestTargetingKeys=${keys.join(',')}` : undefined,
            ]
              .filter(Boolean)
              .join('; ')
          ),
        ],
      })
    );
  }
}

export function findGptIssues(session: SessionState): DiagnosticIssue[] {
  const out: DiagnosticIssue[] = [];
  gpt01(session, out);
  gpt02(session, out);
  gpt03(session, out);
  gpt04(session, out);
  gpt05(session, out);
  gpt06(session, out);
  gpt07(session, out);
  gpt08(session, out);
  gpt09(session, out);
  return out;
}
