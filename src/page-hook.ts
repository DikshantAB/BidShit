// BidShitter MAIN-world page hook.
//
// Runs at document_start in the inspected page's MAIN world so it can wrap
// pbjs.que / pbjs.cmd and googletag.cmd BEFORE the publisher's first push,
// subscribe to Prebid + GPT events, and snapshot read-only state.
//
// STRICT OBSERVE-ONLY: every wrapper calls the original function with the
// original arguments and returns its result unchanged. We never start an
// auction, apply targeting, refresh ads, or change config. See spec.md 8, 9, 12.

import {
  BOOT_POLL_MS,
  BOOT_POLL_TIMEOUT_MS,
  GPT_EVENTS,
  GPT_WRAP_METHODS,
  PREBID_EVENTS,
  PREBID_WRAP_METHODS,
  PUBADS_WRAP_METHODS,
  SLOT_WRAP_METHODS,
} from './shared/constants';
import { sanitize } from './shared/sanitize';
import type { Envelope, EnvelopeChannel, EnvelopeKind } from './shared/types';

(function bidshitterHook() {
  const w = window as any;
  if (w.__BIDSHITTER_HOOKED__) return;
  w.__BIDSHITTER_HOOKED__ = true;

  // ---- transport (batched postMessage on rAF) ----------------------------
  let seq = 0;
  let outbox: Envelope[] = [];
  let flushScheduled = false;

  function post(
    kind: EnvelopeKind,
    channel: EnvelopeChannel,
    name: string,
    payload: unknown,
    ids?: { auctionId?: string; adUnitCode?: string; slotElementId?: string }
  ): void {
    outbox.push({
      source: 'bidshitter',
      seq: seq++,
      ts: Date.now(),
      perf: nowPerf(),
      kind,
      channel,
      name,
      auctionId: ids?.auctionId,
      adUnitCode: ids?.adUnitCode,
      slotElementId: ids?.slotElementId,
      payload: sanitize(payload),
    });
    scheduleFlush();
  }

  function scheduleFlush(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    const flush = () => {
      flushScheduled = false;
      if (!outbox.length) return;
      const batch = outbox;
      outbox = [];
      try {
        window.postMessage({ source: 'bidshitter', dir: 'to-devtools', batch }, '*');
      } catch {
        /* ignore */
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }

  function nowPerf(): number {
    try {
      return performance.now();
    } catch {
      return Date.now();
    }
  }

  function safe<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch {
      return undefined;
    }
  }

  function wrap<T extends (...args: any[]) => any>(
    host: any,
    method: string,
    channel: EnvelopeChannel,
    onCall?: (args: any[], result: unknown) => void
  ): void {
    try {
      const orig = host[method];
      if (typeof orig !== 'function' || orig.__bsWrapped) return;
      const wrapped = function (this: any, ...args: any[]) {
        let result: unknown;
        let threw: unknown;
        let didThrow = false;
        try {
          result = orig.apply(this, args);
        } catch (e) {
          didThrow = true;
          threw = e;
        }
        try {
          post('api', channel, method, { args, threw: didThrow ? String(threw) : undefined });
          if (!didThrow && onCall) onCall(args, result);
        } catch (e) {
          post('error', 'hook', 'wrap_callback_error', { method, message: String(e) });
        }
        if (didThrow) throw threw; // never swallow publisher errors (spec 4)
        return result;
      };
      (wrapped as any).__bsWrapped = true;
      host[method] = wrapped;
    } catch (e) {
      post('error', 'hook', 'wrap_error', { method, message: String(e) });
    }
  }

  // ---- boot state (must be initialized before startBootPoller runs) -----
  let prevLibLoaded = false;
  let prevApiReady = false;
  let prevPubadsReady = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let prebidAttached = false;
  let gptApiAttached = false;
  let gptPubadsAttached = false;
  const startedAt = nowPerf();

  function ensureQueue(globalName: 'pbjs' | 'googletag', channel: EnvelopeChannel): void {
    try {
      if (globalName === 'pbjs') {
        w.pbjs = w.pbjs || {};
        w.pbjs.que = w.pbjs.que || [];
        // pbjs.cmd is an alias of pbjs.que.
        w.pbjs.cmd = w.pbjs.cmd || w.pbjs.que;
        wrapQueuePush(w.pbjs.que, channel, 'que.push');
        if (w.pbjs.cmd !== w.pbjs.que) wrapQueuePush(w.pbjs.cmd, channel, 'cmd.push');
      } else {
        w.googletag = w.googletag || { cmd: [] };
        w.googletag.cmd = w.googletag.cmd || [];
        wrapQueuePush(w.googletag.cmd, channel, 'cmd.push');
      }
    } catch (e) {
      post('error', 'hook', 'ensure_queue_error', { globalName, message: String(e) });
    }
  }

  function wrapQueuePush(queue: any[], channel: EnvelopeChannel, label: string): void {
    try {
      if (!queue || typeof queue.push !== 'function' || (queue as any).__bsWrapped) return;
      const origPush = queue.push.bind(queue);
      (queue as any).push = function (...fns: any[]) {
        post('api', channel, label, { count: fns.length, items: fns.map(describePushed) });
        const ret = origPush(...fns);
        tryAttachAll();
        return ret;
      };
      (queue as any).__bsWrapped = true;
    } catch (e) {
      post('error', 'hook', 'wrap_queue_error', { label, message: String(e) });
    }
  }

  function describePushed(item: unknown): unknown {
    if (typeof item === 'function') {
      const fn = item as { name?: string };
      let preview = '';
      try {
        preview = Function.prototype.toString.call(item);
      } catch {
        preview = '';
      }
      if (preview.length > 500) preview = preview.slice(0, 500) + `…(+${preview.length - 500} chars)`;
      return { type: 'function', name: fn.name || 'anonymous', preview };
    }
    return sanitize(item);
  }

  // Single boot poller: detect libLoaded / apiReady / pubadsReady transitions.
  function startBootPoller(): void {
    const tick = () => {
      try {
        tryAttachAll();
      } catch (e) {
        post('error', 'hook', 'boot_poll_error', { message: String(e) });
      }
      if (nowPerf() - startedAt > BOOT_POLL_TIMEOUT_MS) {
        if (pollTimer !== undefined) clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };
    pollTimer = setInterval(tick, BOOT_POLL_MS);
    tick();
  }

  function tryAttachAll(): void {
    const pbjs = w.pbjs;
    const gt = w.googletag;

    const libLoaded = !!(pbjs && pbjs.libLoaded);
    if (libLoaded && !prevLibLoaded) {
      prevLibLoaded = true;
      post('status', 'prebid', 'libLoaded', { version: safe(() => pbjs.version) });
      attachPrebid();
    }

    const apiReady = !!(gt && gt.apiReady);
    if (apiReady && !prevApiReady) {
      prevApiReady = true;
      post('status', 'gpt', 'apiReady', { version: safe(() => gt.getVersion && gt.getVersion()) });
      attachGptApi();
    }

    const pubadsReady = !!(gt && gt.pubadsReady);
    if (pubadsReady && !prevPubadsReady) {
      prevPubadsReady = true;
      post('status', 'gpt', 'pubadsReady', {});
    }

    // Attaching pubads listeners may be possible before pubadsReady flips,
    // as soon as pubads() is callable.
    attachGptPubads();
  }

  // ---- Prebid ------------------------------------------------------------
  function attachPrebid(): void {
    const pbjs = w.pbjs;
    if (prebidAttached || !pbjs || typeof pbjs.onEvent !== 'function') return;
    prebidAttached = true;

    // Subscribe to every event name from the reference docs.
    for (const ev of PREBID_EVENTS) {
      try {
        pbjs.onEvent(ev, (...args: any[]) => onPrebidEvent(ev, args));
      } catch (e) {
        post('error', 'prebid', 'onEvent_error', { event: ev, message: String(e) });
      }
    }

    // Wrap observability methods (pure pass-through).
    for (const m of PREBID_WRAP_METHODS) wrap(pbjs, m, 'prebid');

    snapshotPrebidGlobals();

    // Late-attach backfill of events that fired before we hooked.
    if (typeof pbjs.getEvents === 'function') {
      const events = safe(() => pbjs.getEvents());
      if (events) post('snapshot', 'prebid', 'getEvents', events);
    }
  }

  function onPrebidEvent(ev: string, args: any[]): void {
    const payload = args.length <= 1 ? args[0] : args;
    post('event', 'prebid', ev, payload, extractPrebidIds(ev, payload));

    // Snapshot read-only state at the useful moments.
    if (ev === 'auctionEnd' || ev === 'auctionTimeout') snapshotAuction();
    if (ev === 'setTargeting') snapshotTargeting();
  }

  function extractPrebidIds(ev: string, payload: any): { auctionId?: string; adUnitCode?: string } {
    const out: { auctionId?: string; adUnitCode?: string } = {};
    if (payload && typeof payload === 'object') {
      out.auctionId = payload.auctionId || payload.bidderRequest?.auctionId;
      out.adUnitCode =
        payload.adUnitCode || payload.adUnit || payload.bidderRequest?.bids?.[0]?.adUnitCode;
    }
    return out;
  }

  function snapshotPrebidGlobals(): void {
    const pbjs = w.pbjs;
    if (!pbjs) return;
    post('snapshot', 'prebid', 'globals', {
      version: safe(() => pbjs.version),
      libLoaded: safe(() => pbjs.libLoaded),
      installedModules: safe(() => pbjs.installedModules),
      adUnits: safe(() => pbjs.adUnits),
      bidderSettings: safe(() => pbjs.bidderSettings && Object.keys(pbjs.bidderSettings)),
      aliasRegistry: safe(() => pbjs.aliasRegistry),
      delayPrerendering: safe(() => pbjs.delayPrerendering),
      pageViewIdPerBidder: safe(() => pbjs.pageViewIdPerBidder),
    });
  }

  function snapshotAuction(): void {
    const pbjs = w.pbjs;
    if (!pbjs) return;
    const snap = (method: string, fn: () => unknown) => {
      try {
        const value = fn();
        post('snapshot', 'prebid', method, value);
      } catch (e) {
        post('error', 'prebid', 'snapshot_error', { method, message: String(e) });
      }
    };
    if (typeof pbjs.getBidResponses === 'function') snap('getBidResponses', () => pbjs.getBidResponses());
    if (typeof pbjs.getHighestCpmBids === 'function') snap('getHighestCpmBids', () => pbjs.getHighestCpmBids());
    if (typeof pbjs.getNoBids === 'function') snap('getNoBids', () => pbjs.getNoBids());
    if (typeof pbjs.getAllWinningBids === 'function') snap('getAllWinningBids', () => pbjs.getAllWinningBids());
    if (typeof pbjs.getAllPrebidWinningBids === 'function')
      snap('getAllPrebidWinningBids', () => pbjs.getAllPrebidWinningBids());
    if (typeof pbjs.readConfig === 'function') {
      snap('readConfig', () => {
        const c = pbjs.readConfig();
        return {
          debug: c && c.debug,
          bidderTimeout: c && c.bidderTimeout,
          priceGranularity: c && c.priceGranularity,
          enableSendAllBids: c && c.enableSendAllBids,
          useBidCache: c && c.useBidCache,
          s2sConfig: !!(c && c.s2sConfig),
          deviceAccess: c && c.deviceAccess,
          maxBid: c && c.maxBid,
        };
      });
    }
    if (typeof pbjs.getConsentMetadata === 'function') snap('getConsentMetadata', () => pbjs.getConsentMetadata());
    snapshotTargeting();
  }

  function snapshotTargeting(): void {
    const pbjs = w.pbjs;
    if (!pbjs || typeof pbjs.getAdserverTargeting !== 'function') return;
    try {
      post('snapshot', 'prebid', 'getAdserverTargeting', pbjs.getAdserverTargeting());
    } catch (e) {
      post('error', 'prebid', 'snapshot_error', { method: 'getAdserverTargeting', message: String(e) });
    }
  }

  // ---- GPT ---------------------------------------------------------------
  function attachGptApi(): void {
    const gt = w.googletag;
    if (gptApiAttached || !gt) return;
    gptApiAttached = true;

    for (const m of GPT_WRAP_METHODS) {
      if (m === 'defineSlot' || m === 'defineOutOfPageSlot') {
        wrap(gt, m, 'gpt', (_args, result) => wrapSlot(result));
      } else {
        wrap(gt, m, 'gpt');
      }
    }
  }

  function attachGptPubads(): void {
    const gt = w.googletag;
    if (gptPubadsAttached || !gt || typeof gt.pubads !== 'function') return;
    const pubads = safe(() => gt.pubads());
    if (!pubads || typeof pubads.addEventListener !== 'function') return;
    gptPubadsAttached = true;

    for (const ev of GPT_EVENTS) {
      try {
        pubads.addEventListener(ev, (e: any) => onGptEvent(ev, e));
      } catch (err) {
        post('error', 'gpt', 'addEventListener_error', { event: ev, message: String(err) });
      }
    }

    for (const m of PUBADS_WRAP_METHODS) wrap(pubads, m, 'gpt');

    // Read-only snapshot of PubAds state.
    post('snapshot', 'gpt', 'pubads', {
      isInitialLoadDisabled: safe(() => pubads.isInitialLoadDisabled && pubads.isInitialLoadDisabled()),
      slotCount: safe(() => (pubads.getSlots ? pubads.getSlots().length : undefined)),
    });
  }

  function wrapSlot(slot: any): void {
    if (!slot || typeof slot !== 'object' || slot.__bsSlotWrapped) return;
    try {
      slot.__bsSlotWrapped = true;
      const slotElementId = safe(() => slot.getSlotElementId());
      const adUnitPath = safe(() => slot.getAdUnitPath());
      post('snapshot', 'gpt', 'defineSlot.result', {
        slotElementId,
        adUnitPath,
        sizes: safe(() => slot.getSizes && slot.getSizes()),
      }, { slotElementId });
      for (const m of SLOT_WRAP_METHODS) {
        wrap(slot, m, 'gpt', () => {
          // no-op; the generic wrapper already logs args
        });
      }
    } catch (e) {
      post('error', 'gpt', 'wrap_slot_error', { message: String(e) });
    }
  }

  function onGptEvent(ev: string, e: any): void {
    const slotElementId = safe(() => e && e.slot && e.slot.getSlotElementId());
    const adUnitPath = safe(() => e && e.slot && e.slot.getAdUnitPath());
    const payload = extractGptEvent(ev, e, adUnitPath);
    post('event', 'gpt', ev, payload, { slotElementId, adUnitCode: slotElementId });

    // Enrich non-empty renders with response information (read-only).
    if (ev === 'slotRenderEnded' && e && e.slot && !e.isEmpty) {
      const info = safe(() => e.slot.getResponseInformation && e.slot.getResponseInformation());
      if (info) post('snapshot', 'gpt', 'getResponseInformation', info, { slotElementId });
    }
  }

  function extractGptEvent(ev: string, e: any, adUnitPath?: string): Record<string, unknown> {
    const base: Record<string, unknown> = {
      serviceName: safe(() => e && e.serviceName),
      adUnitPath,
    };
    switch (ev) {
      case 'slotRenderEnded':
        return {
          ...base,
          isEmpty: e && e.isEmpty,
          size: e && e.size,
          lineItemId: e && e.lineItemId,
          creativeId: e && e.creativeId,
          advertiserId: e && e.advertiserId,
          campaignId: e && e.campaignId,
          isBackfill: e && e.isBackfill,
          sourceAgnosticLineItemId: e && e.sourceAgnosticLineItemId,
          sourceAgnosticCreativeId: e && e.sourceAgnosticCreativeId,
          responseIdentifier: e && e.responseIdentifier,
          slotContentChanged: e && e.slotContentChanged,
        };
      case 'slotVisibilityChanged':
        return { ...base, inViewPercentage: e && e.inViewPercentage };
      case 'rewardedSlotGranted':
        return { ...base, type: e && e.payload && e.payload.type, amount: e && e.payload && e.payload.amount };
      default:
        return base;
    }
  }

  // Boot last: all lets/consts above are initialized, so the poller cannot
  // hit a temporal-dead-zone ReferenceError on first tick.
  post('status', 'hook', 'hook-ready', {
    url: safe(() => location.href),
    documentReadyState: safe(() => document.readyState),
    prebidAlreadyLoaded: !!(w.pbjs && w.pbjs.libLoaded),
    gptAlreadyReady: !!(w.googletag && w.googletag.apiReady),
  });
  ensureQueue('pbjs', 'prebid');
  ensureQueue('googletag', 'gpt');
  startBootPoller();
})();
