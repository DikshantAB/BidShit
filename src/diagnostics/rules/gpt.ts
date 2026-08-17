import {
  apiArgs,
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
  return { id, title, severity, scope: 'gpt', explanation, checks, recommendations };
}

export const gptRules: Rule[] = [
  defineRule(
    meta('GPT-01', 'GPT library fails to load', 'critical', 'googletag queue activity exists but apiReady never fires.', ['Inspect GPT script request', 'apiReady'], ['Fix GPT script URL/load/blocking']),
    (ctx) => {
      const intended = ctx.named('gpt', 'cmd.push').length + ctx.apis('gpt', 'cmd.push').length + ctx.apis('gpt', 'defineSlot').length;
      if (!intended) return [];
      if (ctx.session.status.apiReady || ctx.named('gpt', 'apiReady').length) return [];
      const hook = ctx.named('hook', 'hook-ready')[0];
      if (!hook || ctx.elapsedSince(hook) < THRESHOLDS.gptReadyMs) return [];
      return [issue(find('GPT-01'), ctx, { confidence: confidenceForAbsence(ctx), evidence: [evidenceFrom(hook, 'GPT queue activity without apiReady')] })];
    }
  ),
  defineRule(
    meta('GPT-02', 'GPT command queue is initialized incorrectly', 'critical', 'googletag.cmd is not an array queue.', ['Inspect cmd.push wraps', 'ensure_queue_error'], ['Initialize googletag.cmd as an array before pushing']),
    (ctx) => ctx.errors('ensure_queue_error').filter((e) => JSON.stringify(payload(e)).includes('googletag')).map((e) => fromEvent(find('GPT-02'), e, ctx, 'confirmed', 'GPT queue initialization error'))
  ),
  defineRule(
    meta('GPT-03', 'GPT APIs called before readiness or outside the command queue', 'high', 'defineSlot/display/enableServices occur before apiReady without going through cmd.', ['Compare API timestamps with apiReady'], ['Call GPT APIs inside googletag.cmd']),
    (ctx) => {
      const ready = ctx.named('gpt', 'apiReady')[0];
      const out: DiagnosticIssue[] = [];
      for (const env of [...ctx.apis('gpt', 'defineSlot'), ...ctx.apis('gpt', 'display'), ...ctx.apis('gpt', 'enableServices')]) {
        if (ready && env.ts >= ready.ts) continue;
        if (!ready) continue;
        out.push(fromEvent(find('GPT-03'), env, ctx, 'likely', `${env.name} before apiReady`));
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-04', 'Slot definition returns null', 'critical', 'defineSlot.result has a null slot.', ['Inspect defineSlot.result'], ['Fix ad unit path / sizes / DOM id so defineSlot succeeds']),
    (ctx) => ctx.named('gpt', 'defineSlot.result').filter((e) => payload(e).slotElementId == null && payload(e).slot == null).map((e) => fromEvent(find('GPT-04'), e, ctx, 'confirmed', 'defineSlot returned null'))
  ),
  defineRule(
    meta('GPT-05', 'Slot is not attached to PubAdsService', 'critical', 'Slot is defined but addService(pubads) is never observed.', ['Inspect addService wraps'], ['Attach every slot to pubads before display']),
    (ctx) => {
      const defined = new Set(ctx.named('gpt', 'defineSlot.result').map((e) => str(payload(e).slotElementId)).filter(Boolean) as string[]);
      const attached = new Set(
        ctx.apis('gpt', 'addService').map((e) => e.slotElementId).filter(Boolean) as string[]
      );
      const displayed = new Set(ctx.apis('gpt', 'display').map((e) => slotArg(e)).filter(Boolean) as string[]);
      const out: DiagnosticIssue[] = [];
      for (const id of defined) {
        if (attached.has(id)) continue;
        if (!displayed.has(id) && !ctx.session.slots.get(id)?.requested) continue;
        const env = ctx.named('gpt', 'defineSlot.result').find((e) => str(payload(e).slotElementId) === id)!;
        out.push(fromEvent(find('GPT-05'), env, ctx, 'likely', `slot ${id} never addService(pubads)`, { slotId: id }));
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-06', 'Slot element is missing when displayed', 'critical', 'display() is called but the slot element is missing.', ['Inspect display args vs DOM id'], ['Create the slot element before display']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('gpt', 'display')) {
        const threw = str(payload(env).threw);
        if (threw && /not found|null|element/i.test(threw)) {
          out.push(fromEvent(find('GPT-06'), env, ctx, 'confirmed', threw));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-07', 'Duplicate slot element IDs', 'critical', 'Two defineSlot results share the same slotElementId.', ['Inspect defineSlot.result ids'], ['Keep slot element IDs unique']),
    (ctx) => {
      const groups = groupBy(
        ctx.named('gpt', 'defineSlot.result').filter((e) => str(payload(e).slotElementId)),
        (e) => str(payload(e).slotElementId)
      );
      const out: DiagnosticIssue[] = [];
      for (const [id, list] of groups) {
        if (list.length < 2) continue;
        out.push(fromEvent(find('GPT-07'), list[1], ctx, 'confirmed', `duplicate slot id ${id}`, { slotId: id }));
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-08', 'display() uses an ID different from the defined slot', 'critical', 'display target does not match any defined slotElementId.', ['Compare display arg with defineSlot.result'], ['Display the defined element id']),
    (ctx) => {
      const defined = new Set(ctx.named('gpt', 'defineSlot.result').map((e) => str(payload(e).slotElementId)).filter(Boolean) as string[]);
      if (!defined.size) return [];
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('gpt', 'display')) {
        const id = slotArg(env);
        if (!id || defined.has(id)) continue;
        out.push(fromEvent(find('GPT-08'), env, ctx, 'confirmed', `display(${id}) has no defined slot`, { slotId: id }));
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-09', 'Services enabled before required page configuration', 'high', 'disableInitialLoad / SRA / privacy occur after enableServices.', ['Compare config timestamps with enableServices'], ['Apply request-affecting config before enableServices']),
    (ctx) => {
      const enabled = ctx.apis('gpt', 'enableServices')[0];
      if (!enabled) return [];
      const late = [
        ...ctx.apis('gpt', 'disableInitialLoad'),
        ...ctx.apis('gpt', 'enableSingleRequest'),
        ...ctx.apis('gpt', 'setPrivacySettings'),
      ].filter((e) => e.ts > enabled.ts);
      return late.map((e) => fromEvent(find('GPT-09'), e, ctx, 'confirmed', `${e.name} after enableServices`));
    }
  ),
  defineRule(
    meta('GPT-10', 'Slot is defined but never displayed', 'critical', 'Slot appears in registry but no display() or request occurs.', ['Inspect display instrumentation'], ['Call display() once when the slot element is ready']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      const hook = ctx.named('hook', 'hook-ready')[0];
      for (const slot of ctx.session.slots.values()) {
        if (slot.displayed || slot.requested || slot.refreshed) continue;
        const defined = ctx.named('gpt', 'defineSlot.result').find((e) => str(payload(e).slotElementId) === slot.slotElementId);
        if (!defined) continue;
        if (hook && ctx.elapsedSince(defined) < THRESHOLDS.gptReadyMs) continue;
        out.push(fromEvent(find('GPT-10'), defined, ctx, confidenceForAbsence(ctx), `slot ${slot.slotElementId} never displayed`, { slotId: slot.slotElementId }));
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-11', 'Initial load disabled but refresh() never called', 'critical', 'display() occurs with disableInitialLoad, but no refresh and no slotRequested follow.', ['Inspect disableInitialLoad', 'refresh', 'slotRequested'], ['Ensure a guarded request path calls refresh()']),
    (ctx) => {
      if (!ctx.apis('gpt', 'disableInitialLoad').length) return [];
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('gpt', 'display')) {
        const id = slotArg(env);
        if (!id) continue;
        const slot = ctx.session.slots.get(id);
        if (slot?.refreshed || slot?.requested) continue;
        if (ctx.elapsedSince(env) < THRESHOLDS.gptReadyMs) continue;
        out.push(fromEvent(find('GPT-11'), env, ctx, confidenceForAbsence(ctx), `disableInitialLoad but no refresh for ${id}`, { slotId: id }));
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-12', 'refresh() called before display()', 'high', 'Refresh invocation precedes slot registration/display.', ['Compare define, display, refresh timestamps'], ['Call display() first, then refresh']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('gpt', 'refresh')) {
        const ids = refreshIds(env);
        const targets = ids.length ? ids : [...ctx.session.slots.keys()];
        for (const id of targets) {
          const display = ctx.apis('gpt', 'display').find((e) => slotArg(e) === id);
          if (display && display.ts <= env.ts) continue;
          if (!display) {
            out.push(fromEvent(find('GPT-12'), env, ctx, 'likely', `refresh before display for ${id}`, { slotId: id }));
          }
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-13', 'Unexpected duplicate initial requests', 'high', 'display() triggers a request and an immediate refresh() triggers another.', ['Inspect disableInitialLoad', 'two slotRequested'], ['Choose one first-request strategy']),
    (ctx) => {
      const dil = ctx.apis('gpt', 'disableInitialLoad').length > 0;
      if (dil) return [];
      const out: DiagnosticIssue[] = [];
      const bySlot = groupBy(ctx.named('gpt', 'slotRequested'), (e) => e.slotElementId);
      for (const [id, list] of bySlot) {
        if (list.length < 2) continue;
        if (list[1].ts - list[0].ts > 2000) continue;
        const displayed = ctx.apis('gpt', 'display').some((e) => slotArg(e) === id);
        const refreshed = ctx.apis('gpt', 'refresh').length > 0;
        if (displayed && refreshed) {
          out.push(fromEvent(find('GPT-13'), list[1], ctx, 'likely', `duplicate initial slotRequested for ${id}`, { slotId: id }));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-14', 'Refresh unintentionally requests every slot', 'high', 'refresh() without a slot array produces slotRequested for unrelated slots.', ['Inspect refresh arguments'], ['Pass the intended slot array']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('gpt', 'refresh')) {
        const args = apiArgs(env);
        if (args.length && Array.isArray(args[0])) continue;
        if (ctx.session.slots.size < 2) continue;
        out.push(fromEvent(find('GPT-14'), env, ctx, 'confirmed', 'refresh() called without a slot array'));
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-15', 'Wrong or destroyed slot object passed to refresh', 'critical', 'Refresh argument does not match a current PubAds slot.', ['Compare refresh ids with destroySlots'], ['Refresh only current registered slots']),
    (ctx) => {
      const destroyed = new Set<string>();
      for (const env of ctx.apis('gpt', 'destroySlots')) {
        for (const id of refreshIds(env)) destroyed.add(id);
      }
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('gpt', 'refresh')) {
        for (const id of refreshIds(env)) {
          if (!destroyed.has(id)) continue;
          out.push(fromEvent(find('GPT-15'), env, ctx, 'confirmed', `refresh of destroyed slot ${id}`, { slotId: id }));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-16', 'slotRequested fires but no GAM network request is visible', 'high', 'GPT reports slotRequested, but no plausible GAM ad request appears.', ['Search GAM request patterns', 'SRA batching', 'late observer'], ['Classify as blocked/unknown only after accounting for SRA']),
    (ctx) => {
      const gam = ctx.named('network', 'gamRequest');
      if (!ctx.named('gpt', 'slotRequested').length) return [];
      if (gam.length) return [];
      const first = ctx.named('gpt', 'slotRequested')[0];
      if (ctx.elapsedSince(first) < THRESHOLDS.gamResponseMs) return [];
      return [fromEvent(find('GPT-16'), first, ctx, ctx.observedFromStart ? 'likely' : 'possible', 'slotRequested without visible GAM request')];
    }
  ),
  defineRule(
    meta('GPT-17', 'GAM network request fails', 'critical', 'GAM ad request failed status/blocked and no slot response.', ['Inspect URL, status, blocked reason'], ['Address the concrete network or policy failure']),
    (ctx) =>
      ctx
        .named('network', 'gamRequest')
        .filter((e) => payload(e).failed === true || (num(payload(e).status) ?? 0) >= 400)
        .map((e) => fromEvent(find('GPT-17'), e, ctx, 'confirmed', `GAM request status ${String(payload(e).status)}`))
  ),
  defineRule(
    meta('GPT-18', 'GAM request sent but response never completes', 'critical', 'slotRequested without slotResponseReceived beyond threshold.', ['Inspect network end state', 'navigation'], ['Fix network/server; mark unknown if observation ended first']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      const bySlot = groupBy(ctx.named('gpt', 'slotRequested'), (e) => e.slotElementId);
      for (const [id, reqs] of bySlot) {
        const lastReq = lastOf(reqs)!;
        const resp = ctx.named('gpt', 'slotResponseReceived').filter((e) => e.slotElementId === id && e.ts >= lastReq.ts);
        if (resp.length) continue;
        if (ctx.elapsedSince(lastReq) < THRESHOLDS.gamResponseMs) continue;
        out.push(fromEvent(find('GPT-18'), lastReq, ctx, confidenceForAbsence(ctx), `no slotResponseReceived for ${id}`, { slotId: id }));
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-19', 'Response received but render never ends', 'critical', 'slotResponseReceived without slotRenderEnded within threshold.', ['Inspect console, slot lifetime'], ['Fix render/slot lifecycle']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('gpt', 'slotResponseReceived')) {
        const rendered = ctx.named('gpt', 'slotRenderEnded').some((e) => e.slotElementId === env.slotElementId && e.ts >= env.ts);
        if (rendered) continue;
        if (ctx.elapsedSince(env) < THRESHOLDS.gamRenderMs) continue;
        out.push(fromEvent(find('GPT-19'), env, ctx, confidenceForAbsence(ctx), `no slotRenderEnded for ${env.slotElementId}`));
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-20', 'GAM returns an empty slot', 'info', 'slotRenderEnded.isEmpty === true.', ['Record ad unit path and targeting snapshot'], ['Investigate GAM eligibility; this is not a network failure']),
    (ctx) =>
      ctx
        .named('gpt', 'slotRenderEnded')
        .filter((e) => payload(e).isEmpty === true)
        .map((e) => fromEvent(find('GPT-20'), e, ctx, 'confirmed', 'slotRenderEnded.isEmpty'))
  ),
  defineRule(
    meta('GPT-21', 'Creative metadata is null', 'info', 'creativeId/lineItemId are null even though the slot may be filled.', ['Inspect isEmpty, isBackfill, source-agnostic IDs'], ['Avoid false alarms; use source-agnostic identifiers']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('gpt', 'slotRenderEnded')) {
        const p = payload(env);
        if (p.isEmpty === true) continue;
        if (p.creativeId != null || p.lineItemId != null) continue;
        out.push(fromEvent(find('GPT-21'), env, ctx, 'confirmed', 'filled slot with null creative/line item ids'));
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-22', 'Creative iframe never reports load', 'medium', 'Filled slotRenderEnded occurs but no slotOnload appears.', ['Determine render mode', 'iframe DOM'], ['Report a load failure only when an iframe load is expected']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('gpt', 'slotRenderEnded')) {
        if (payload(env).isEmpty === true) continue;
        const loaded = ctx.named('gpt', 'slotOnload').some((e) => e.slotElementId === env.slotElementId && e.ts >= env.ts);
        if (loaded) continue;
        if (ctx.elapsedSince(env) < THRESHOLDS.slotOnloadMs) continue;
        out.push(fromEvent(find('GPT-22'), env, ctx, 'possible', `no slotOnload after filled render (may be valid non-iframe)`));
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-23', 'Creative loads very slowly', 'medium', 'Large delay between slotRenderEnded and slotOnload.', ['Inspect creative waterfall'], ['Escalate timing evidence to the creative vendor']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('gpt', 'slotRenderEnded')) {
        const load = ctx.named('gpt', 'slotOnload').find((e) => e.slotElementId === env.slotElementId && e.ts >= env.ts);
        if (!load) continue;
        if (load.ts - env.ts < THRESHOLDS.slowOnloadMs) continue;
        out.push(fromEvent(find('GPT-23'), load, ctx, 'confirmed', `slotOnload ${load.ts - env.ts}ms after render`));
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-24', 'Impression never becomes viewable', 'info', 'Render succeeds but impressionViewable never fires.', ['Inspect slotVisibilityChanged', 'viewport'], ['Do not call this a serving failure by default']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('gpt', 'slotRenderEnded')) {
        if (payload(env).isEmpty === true) continue;
        const viewable = ctx.named('gpt', 'impressionViewable').some((e) => e.slotElementId === env.slotElementId);
        if (viewable) continue;
        out.push(fromEvent(find('GPT-24'), env, ctx, 'confirmed', 'impressionViewable not observed (often valid)'));
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-25', 'Slot visibility remains unexpectedly at zero', 'medium', 'Repeated slotVisibilityChanged.inViewPercentage is 0.', ['Inspect bounding rectangle / CSS'], ['Correct layout/visibility conditions']),
    (ctx) => {
      const groups = groupBy(ctx.named('gpt', 'slotVisibilityChanged'), (e) => e.slotElementId);
      const out: DiagnosticIssue[] = [];
      for (const [id, list] of groups) {
        if (list.length < 3) continue;
        if (!list.every((e) => num(payload(e).inViewPercentage) === 0)) continue;
        if (ctx.named('gpt', 'impressionViewable').some((e) => e.slotElementId === id)) continue;
        out.push(fromEvent(find('GPT-25'), lastOf(list)!, ctx, 'likely', `inViewPercentage stayed 0 for ${id}`, { slotId: id }));
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-26', 'Responsive size mapping does not match the active viewport', 'high', 'Rendered size is absent from expected mapping.', ['Compare viewport, size mapping, event.size'], ['Correct the responsive mapping']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('gpt', 'defineSizeMapping')) {
        const threw = str(payload(env).threw);
        if (threw) out.push(fromEvent(find('GPT-26'), env, ctx, 'confirmed', threw));
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-27', 'Targeting is changed after the request snapshot', 'high', 'Targeting call occurs after display/refresh for that request.', ['Compare targeting time with slotRequested'], ['Apply targeting before the request']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of [...ctx.apis('gpt', 'setTargeting'), ...ctx.named('gpt', 'setTargeting')]) {
        const id = env.slotElementId;
        const req = ctx.named('gpt', 'slotRequested').find((e) => (!id || e.slotElementId === id) && e.ts < env.ts);
        if (!req) continue;
        const laterReq = ctx.named('gpt', 'slotRequested').find((e) => (!id || e.slotElementId === id) && e.ts >= env.ts);
        if (laterReq) continue;
        out.push(fromEvent(find('GPT-27'), env, ctx, 'confirmed', 'targeting after slotRequested'));
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-28', 'Targeting applied at the wrong scope', 'high', 'A key intended for one slot appears on other slots via page-level targeting.', ['Compare page vs slot targeting'], ['Put targeting at the intended level']),
    (ctx) => {
      const pageHb = Object.keys(ctx.session.gptPageTargeting).filter((k) => k.startsWith('hb_'));
      if (!pageHb.length) return [];
      const env = ctx.apis('gpt', 'setTargeting')[0];
      if (!env) return [];
      return [fromEvent(find('GPT-28'), env, ctx, 'likely', `page-level hb_* keys: ${pageHb.join(', ')}`)];
    }
  ),
  defineRule(
    meta('GPT-29', 'SRA batches unintended or incomplete slots', 'high', 'One display/request causes multiple unfetched slots to request.', ['Inspect SRA config and request timestamps'], ['Define intended slots before the SRA request']),
    (ctx) => {
      if (!ctx.apis('gpt', 'enableSingleRequest').length) return [];
      const reqs = ctx.named('gpt', 'slotRequested');
      if (reqs.length < 2) return [];
      const cluster = reqs.filter((e) => Math.abs(e.ts - reqs[0].ts) < 50);
      if (cluster.length < 2) return [];
      return [fromEvent(find('GPT-29'), cluster[1], ctx, 'possible', `SRA clustered ${cluster.length} slotRequested events`)];
    }
  ),
  defineRule(
    meta('GPT-30', 'Lazy loading is mistaken for a missing request', 'info', 'Defined slot has no request until it approaches the fetch margin.', ['Inspect enableLazyLoad', 'later slotRequested'], ['Mark the request as deferred']),
    (ctx) => {
      if (!ctx.apis('gpt', 'enableLazyLoad').length) return [];
      const env = ctx.apis('gpt', 'enableLazyLoad')[0];
      return [fromEvent(find('GPT-30'), env, ctx, 'confirmed', 'lazy load enabled; missing early slotRequested may be intentional')];
    }
  ),
  defineRule(
    meta('GPT-31', 'Privacy settings are applied too late', 'high', 'Privacy configuration occurs after display/refresh.', ['Compare setPrivacySettings with request start'], ['Apply privacy settings before the request']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('gpt', 'setPrivacySettings')) {
        const req = ctx.named('gpt', 'slotRequested')[0] || ctx.apis('gpt', 'refresh')[0] || ctx.apis('gpt', 'display')[0];
        if (req && env.ts > req.ts) out.push(fromEvent(find('GPT-31'), env, ctx, 'confirmed', 'setPrivacySettings after request start'));
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-32', 'Slot destroyed while request/render is active', 'high', 'destroySlots occurs between slotRequested and slotRenderEnded.', ['Compare destroySlots with request lifecycle'], ['Coordinate cleanup with slot lifecycle']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.apis('gpt', 'destroySlots')) {
        const ids = refreshIds(env);
        for (const id of ids.length ? ids : [...ctx.session.slots.keys()]) {
          const req = ctx.named('gpt', 'slotRequested').filter((e) => e.slotElementId === id && e.ts < env.ts);
          const lastReq = lastOf(req);
          if (!lastReq) continue;
          const rendered = ctx.named('gpt', 'slotRenderEnded').some((e) => e.slotElementId === id && e.ts >= lastReq.ts && e.ts <= env.ts);
          if (rendered) continue;
          out.push(fromEvent(find('GPT-32'), env, ctx, 'confirmed', `destroyed ${id} during in-flight request`, { slotId: id }));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-33', 'Rewarded or manual interstitial is ready but never shown', 'medium', 'rewardedSlotReady / gameManualInterstitialSlotReady without a visibility method.', ['Inspect ready handler'], ['Call the event method from the supported user flow if appropriate']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('gpt', 'rewardedSlotReady')) {
        const granted = ctx.named('gpt', 'rewardedSlotGranted').some((e) => e.ts >= env.ts);
        const closed = ctx.named('gpt', 'rewardedSlotClosed').some((e) => e.ts >= env.ts);
        if (granted || closed) continue;
        if (ctx.elapsedSince(env) < THRESHOLDS.gptReadyMs) continue;
        out.push(fromEvent(find('GPT-33'), env, ctx, 'possible', 'rewarded slot ready but not shown'));
      }
      for (const env of ctx.named('gpt', 'gameManualInterstitialSlotReady')) {
        const closed = ctx.named('gpt', 'gameManualInterstitialSlotClosed').some((e) => e.ts >= env.ts);
        if (closed) continue;
        if (ctx.elapsedSince(env) < THRESHOLDS.gptReadyMs) continue;
        out.push(fromEvent(find('GPT-33'), env, ctx, 'possible', 'GMI ready but not shown'));
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-34', 'Reward granted based on the wrong event', 'high', 'Application appears to complete a rewarded flow without rewardedSlotGranted.', ['Compare closed/completed vs granted'], ['Grant the reward only from rewardedSlotGranted']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      const granted = ctx.named('gpt', 'rewardedSlotGranted');
      for (const env of [...ctx.named('gpt', 'rewardedSlotClosed'), ...ctx.named('gpt', 'rewardedSlotVideoCompleted')]) {
        if (granted.some((g) => Math.abs(g.ts - env.ts) < 5000)) continue;
        if (!granted.length) out.push(fromEvent(find('GPT-34'), env, ctx, 'possible', `${env.name} without rewardedSlotGranted`));
      }
      return out;
    }
  ),
  defineRule(
    meta('GPT-35', 'Auto-refresh or publisher refresh occurs too frequently', 'medium', 'Repeated request cycles at a short interval.', ['Identify refresh initiators'], ['Consolidate refresh ownership']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      const bySlot = groupBy(ctx.named('gpt', 'slotRequested'), (e) => e.slotElementId);
      for (const [id, list] of bySlot) {
        for (let i = 1; i < list.length; i++) {
          const dt = list[i].ts - list[i - 1].ts;
          if (dt >= THRESHOLDS.frequentRefreshMs) continue;
          out.push(fromEvent(find('GPT-35'), list[i], ctx, 'likely', `slotRequested ${dt}ms after previous for ${id}`, { slotId: id }));
          break;
        }
      }
      return out;
    }
  ),
];

const BY_ID = new Map(gptRules.map((r) => [r.id, r]));
function find(id: string): RuleMeta {
  return BY_ID.get(id)!;
}

function slotArg(env: { payload: unknown; slotElementId?: string }): string | undefined {
  if (env.slotElementId) return env.slotElementId;
  const arg = apiArgs(env as any)[0];
  if (typeof arg === 'string') return arg;
  return str(rec(arg).slotElementId);
}

function refreshIds(env: { payload: unknown }): string[] {
  const arg = apiArgs(env as any)[0];
  if (!Array.isArray(arg)) return [];
  return arg.map((s) => (typeof s === 'string' ? s : str(rec(s).slotElementId))).filter((x): x is string => !!x);
}
