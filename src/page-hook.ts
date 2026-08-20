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
    onCall?: (args: any[], result: unknown) => void,
    ids?: () => { auctionId?: string; adUnitCode?: string; slotElementId?: string }
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
          post('api', channel, method, { args, threw: didThrow ? String(threw) : undefined }, ids?.());
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
  let lastTcfAuctionId: string | undefined;
  let tcfListenerAttached = false;
  let lastTcfPingKey = '';
  let tcfPollTimer: ReturnType<typeof setInterval> | undefined;
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
    // PUC may load after Prebid; keep trying while the boot poller runs.
    if (prebidAttached) observeUcTag();
    tickTcfApi();
  }

  // IAB TCF CMP API: observe-only. Subscribe to addEventListener as soon as
  // __tcfapi exists (stub or full CMP). Independently ping every 50ms.
  // Never wrap or replace __tcfapi.
  function tcfPingKey(pingReturn: Record<string, unknown>): string {
    return [
      pingReturn.cmpStatus,
      pingReturn.cmpLoaded,
      pingReturn.displayStatus,
      pingReturn.gdprApplies,
      pingReturn.cmpId,
      pingReturn.apiVersion,
    ].map((v) => String(v)).join('|');
  }

  function onTcfPing(pingReturn: any): void {
    const payload =
      pingReturn && typeof pingReturn === 'object' && !Array.isArray(pingReturn)
        ? pingReturn
        : { pingReturn };
    const key = tcfPingKey(payload as Record<string, unknown>);
    if (key === lastTcfPingKey) return;
    lastTcfPingKey = key;
    post('event', 'cmp', 'tcfapi-ping', payload);
  }

  function onTcfApi(tcData: any, success?: boolean): void {
    const base = { success: success !== false };
    const payload =
      tcData && typeof tcData === 'object' && !Array.isArray(tcData) ? { ...base, ...tcData } : { ...base, tcData };
    post('event', 'cmp', 'tcfapi', payload);
  }

  function subscribeTcfListener(): void {
    if (tcfListenerAttached) return;
    const api = w.__tcfapi;
    if (typeof api !== 'function') return;
    tcfListenerAttached = true;
    try {
      api('addEventListener', 2, onTcfApi);
    } catch (e) {
      tcfListenerAttached = false;
      post('error', 'hook', 'tcfapi_subscribe_error', { message: String(e) });
    }
  }

  function tickTcfApi(): void {
    const api = w.__tcfapi;
    if (typeof api !== 'function') return;
    subscribeTcfListener();
    try {
      api('ping', 2, onTcfPing);
    } catch (e) {
      post('error', 'hook', 'tcfapi_ping_error', { message: String(e) });
    }
  }

  function startTcfPoller(): void {
    const tick = () => {
      try {
        tickTcfApi();
      } catch (e) {
        post('error', 'hook', 'tcfapi_poll_error', { message: String(e) });
      }
    };
    tcfPollTimer = setInterval(tick, BOOT_POLL_MS);
    tick();
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
    for (const m of PREBID_WRAP_METHODS) {
      if (m === 'renderAd') wrapRenderAd(pbjs);
      else if (m === 'requestBids') wrapRequestBids(pbjs);
      else wrap(pbjs, m, 'prebid');
    }
    observeUcTag();

    snapshotPrebidGlobals();

    // Late-attach backfill of events that fired before we hooked.
    if (typeof pbjs.getEvents === 'function') {
      const events = safe(() => pbjs.getEvents());
      if (events) post('snapshot', 'prebid', 'getEvents', events);
    }
  }

  function onPrebidEvent(ev: string, args: any[]): void {
    const payload = args.length <= 1 ? args[0] : args;
    if (
      (ev === 'auctionInit' || ev === 'auctionEnd') &&
      payload &&
      typeof payload === 'object' &&
      payload.auctionId
    ) {
      lastTcfAuctionId = payload.auctionId;
    }
    post('event', 'prebid', ev, payload, extractPrebidIds(ev, payload));

    // Snapshot read-only state at the useful moments.
    if (ev === 'auctionEnd' || ev === 'auctionTimeout') snapshotAuction();
    if (ev === 'setTargeting') snapshotTargeting();
  }

  function extractPrebidIds(ev: string, payload: any): { auctionId?: string; adUnitCode?: string } {
    const out: { auctionId?: string; adUnitCode?: string } = {};
    if (Array.isArray(payload) && payload[0] && typeof payload[0] === 'object') {
      const br = payload[0];
      out.auctionId = br.auctionId;
      out.adUnitCode = br.bids?.[0]?.adUnitCode || br.adUnitCode;
      return out;
    }
    if (!payload || typeof payload !== 'object') return out;
    if (ev === 'tcf2Enforcement') {
      out.auctionId = payload.auctionId || lastTcfAuctionId;
      return out;
    }
    const bid = payload.bid && typeof payload.bid === 'object' ? payload.bid : payload;
    out.auctionId =
      bid.auctionId || payload.auctionId || payload.bidderRequest?.auctionId || bid.bidderRequest?.auctionId;
    out.adUnitCode =
      bid.adUnitCode ||
      payload.adUnitCode ||
      payload.adUnit ||
      bid.adUnit ||
      payload.bidderRequest?.bids?.[0]?.adUnitCode;
    if (ev === 'adRenderSucceeded' || ev === 'adRenderFailed' || ev === 'bidWon') {
      out.adUnitCode = bid.adUnitCode || payload.adUnitCode || out.adUnitCode;
      out.auctionId = bid.auctionId || payload.auctionId || out.auctionId;
    }
    return out;
  }

  function summarizeRenderAdArgs(args: any[]): unknown[] {
    // args: [doc, adId, options?] — never serialize the Document.
    const adId = args[1] != null ? String(args[1]) : undefined;
    const options = args[2] && typeof args[2] === 'object' ? sanitize(args[2]) : args[2];
    return [{ __type: 'Document' }, adId, options];
  }

  // Prebid catches bidsBackHandler exceptions (logError, no rethrow), so wrapping
  // requestBids alone never sees them. Wrap the callback, call through, rethrow.
  function wrapRequestBids(pbjs: any): void {
    try {
      const orig = pbjs.requestBids;
      if (typeof orig !== 'function' || orig.__bsWrapped) return;
      const wrapped = function (this: any, ...args: any[]) {
        const callArgs = requestBidsArgsWithWrappedHandler(args);
        let result: unknown;
        let threw: unknown;
        let didThrow = false;
        try {
          result = orig.apply(this, callArgs);
        } catch (e) {
          didThrow = true;
          threw = e;
        }
        try {
          post('api', 'prebid', 'requestBids', { args, threw: didThrow ? String(threw) : undefined });
        } catch (e) {
          post('error', 'hook', 'wrap_callback_error', { method: 'requestBids', message: String(e) });
        }
        if (didThrow) throw threw;
        return result;
      };
      (wrapped as any).__bsWrapped = true;
      pbjs.requestBids = wrapped;
    } catch (e) {
      post('error', 'hook', 'wrap_error', { method: 'requestBids', message: String(e) });
    }
  }

  function requestBidsArgsWithWrappedHandler(args: any[]): any[] {
    const opts = args[0];
    if (!opts || typeof opts !== 'object' || typeof opts.bidsBackHandler !== 'function') return args;
    return [Object.assign({}, opts, { bidsBackHandler: wrapBidsBackHandler(opts.bidsBackHandler) }), ...args.slice(1)];
  }

  function wrapBidsBackHandler(handler: (...handlerArgs: any[]) => unknown): (...handlerArgs: any[]) => unknown {
    if ((handler as any).__bsWrapped) return handler;
    const wrapped = function (this: any, ...handlerArgs: any[]) {
      let result: unknown;
      let threw: unknown;
      let didThrow = false;
      try {
        result = handler.apply(this, handlerArgs);
      } catch (e) {
        didThrow = true;
        threw = e;
      }
      try {
        const bids = handlerArgs[0];
        const auctionId = handlerArgs[2] != null ? String(handlerArgs[2]) : undefined;
        post(
          'api',
          'prebid',
          'bidsBackHandler',
          {
            timedOut: !!handlerArgs[1],
            threw: didThrow ? String(threw) : undefined,
            bidGroups: bids && typeof bids === 'object' && !Array.isArray(bids) ? Object.keys(bids) : [],
          },
          { auctionId }
        );
      } catch (e) {
        post('error', 'hook', 'wrap_callback_error', { method: 'bidsBackHandler', message: String(e) });
      }
      if (didThrow) throw threw;
      return result;
    };
    (wrapped as any).__bsWrapped = true;
    return wrapped;
  }

  function wrapRenderAd(pbjs: any): void {
    try {
      const orig = pbjs.renderAd;
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
          const adId = args[1] != null ? String(args[1]) : undefined;
          post(
            'api',
            'prebid',
            'renderAd',
            { args: summarizeRenderAdArgs(args), threw: didThrow ? String(threw) : undefined, adId },
            {}
          );
        } catch (e) {
          post('error', 'hook', 'wrap_callback_error', { method: 'renderAd', message: String(e) });
        }
        if (didThrow) throw threw;
        return result;
      };
      (wrapped as any).__bsWrapped = true;
      pbjs.renderAd = wrapped;
    } catch (e) {
      post('error', 'hook', 'wrap_error', { method: 'renderAd', message: String(e) });
    }
  }

  let ucTagWrapped = false;
  function observeUcTag(): void {
    if (ucTagWrapped) return;
    try {
      const uc = w.ucTag || (w.pbjs && w.pbjs.ucTag);
      if (!uc || typeof uc.renderAd !== 'function') return;
      if ((uc.renderAd as any).__bsWrapped) {
        ucTagWrapped = true;
        return;
      }
      const orig = uc.renderAd.bind(uc);
      const wrapped = function (this: any, ...args: any[]) {
        let result: unknown;
        let threw: unknown;
        let didThrow = false;
        try {
          result = orig(...args);
        } catch (e) {
          didThrow = true;
          threw = e;
        }
        try {
          const first = args[0];
          const adId =
            typeof first === 'string'
              ? first
              : first && typeof first === 'object'
                ? first.adId || first.hb_adid || first.adid
                : undefined;
          post(
            'api',
            'prebid',
            'ucTag.renderAd',
            { args: sanitize(args), threw: didThrow ? String(threw) : undefined },
            { adUnitCode: adId != null ? String(adId) : undefined }
          );
        } catch (e) {
          post('error', 'hook', 'wrap_callback_error', { method: 'ucTag.renderAd', message: String(e) });
        }
        if (didThrow) throw threw;
        return result;
      };
      (wrapped as any).__bsWrapped = true;
      uc.renderAd = wrapped;
      ucTagWrapped = true;
      post('status', 'prebid', 'ucTag-observed', { hasRenderAd: true });
    } catch (e) {
      post('error', 'prebid', 'ucTag_wrap_error', { message: String(e) });
    }
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
      if (m === 'defineSlot' || m === 'defineOutOfPageSlot') wrapDefineSlot(gt, m);
      else if (m === 'display') wrapGptDisplay(gt);
      else wrap(gt, m, 'gpt');
    }
  }

  function summarizeGptSlot(slot: any): { __type: string; slotElementId?: string; adUnitPath?: string } | null {
    if (slot == null) return null;
    return {
      __type: 'googletag.Slot',
      slotElementId: safe(() => slot.getSlotElementId()),
      adUnitPath: safe(() => slot.getAdUnitPath()),
    };
  }

  function wrapDefineSlot(gt: any, method: string): void {
    try {
      const orig = gt[method];
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
        const summarized = didThrow ? undefined : summarizeGptSlot(result);
        try {
          post(
            'api',
            'gpt',
            method,
            { args, result: summarized === undefined ? null : summarized, threw: didThrow ? String(threw) : undefined },
            { slotElementId: summarized?.slotElementId }
          );
          if (!didThrow && result) wrapSlot(result);
        } catch (e) {
          post('error', 'hook', 'wrap_callback_error', { method, message: String(e) });
        }
        if (didThrow) throw threw;
        return result;
      };
      (wrapped as any).__bsWrapped = true;
      gt[method] = wrapped;
    } catch (e) {
      post('error', 'hook', 'wrap_error', { method, message: String(e) });
    }
  }

  function displayTargetId(args: any[]): string | undefined {
    const a0 = args[0];
    if (typeof a0 === 'string' && !a0.startsWith('/')) return a0;
    if (typeof a0 === 'string' && a0.startsWith('/') && typeof args[2] === 'string') return args[2];
    return summarizeGptSlot(a0)?.slotElementId;
  }

  function wrapGptDisplay(host: any): void {
    try {
      const orig = host.display;
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
        const slotElementId = displayTargetId(args);
        try {
          post(
            'api',
            'gpt',
            'display',
            { args, slotElementId, threw: didThrow ? String(threw) : undefined },
            { slotElementId }
          );
        } catch (e) {
          post('error', 'hook', 'wrap_callback_error', { method: 'display', message: String(e) });
        }
        if (didThrow) throw threw;
        return result;
      };
      (wrapped as any).__bsWrapped = true;
      host.display = wrapped;
    } catch (e) {
      post('error', 'hook', 'wrap_error', { method: 'display', message: String(e) });
    }
  }

  function wrapRefresh(pubads: any): void {
    try {
      const orig = pubads.refresh;
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
        const arg = args[0];
        let unscoped = arg == null || (!Array.isArray(arg) && (typeof arg !== 'object' || !arg));
        let slotIds: string[] = [];
        try {
          if (Array.isArray(arg)) {
            unscoped = false;
            slotIds = arg
              .map((s) => (typeof s === 'string' ? s : safe(() => s && s.getSlotElementId && s.getSlotElementId())))
              .filter((id: unknown): id is string => typeof id === 'string' && !!id);
          } else if (arg && typeof arg.getSlotElementId === 'function') {
            unscoped = false;
            const id = safe(() => arg.getSlotElementId());
            if (id) slotIds = [id];
          } else if (typeof pubads.getSlots === 'function') {
            slotIds = pubads
              .getSlots()
              .map((s: any) => safe(() => s && s.getSlotElementId && s.getSlotElementId()))
              .filter((id: unknown): id is string => typeof id === 'string' && !!id);
          }
        } catch {
          /* keep empty slotIds */
        }
        try {
          post('api', 'gpt', 'refresh', {
            args,
            slotIds,
            unscoped,
            threw: didThrow ? String(threw) : undefined,
          });
        } catch (e) {
          post('error', 'hook', 'wrap_callback_error', { method: 'refresh', message: String(e) });
        }
        if (didThrow) throw threw;
        return result;
      };
      (wrapped as any).__bsWrapped = true;
      pubads.refresh = wrapped;
    } catch (e) {
      post('error', 'hook', 'wrap_error', { method: 'refresh', message: String(e) });
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

    for (const m of PUBADS_WRAP_METHODS) {
      if (m === 'refresh') wrapRefresh(pubads);
      else if (m === 'display') wrapGptDisplay(pubads);
      else wrap(pubads, m, 'gpt');
    }

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
        if (m === 'addService') wrapAddService(slot, slotElementId);
        else wrap(slot, m, 'gpt', undefined, () => ({ slotElementId, adUnitCode: slotElementId }));
      }
    } catch (e) {
      post('error', 'gpt', 'wrap_slot_error', { message: String(e) });
    }
  }

  function wrapAddService(slot: any, slotElementId?: string): void {
    try {
      const orig = slot.addService;
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
          post(
            'api',
            'gpt',
            'addService',
            {
              args,
              service: describeGptService(args[0]),
              threw: didThrow ? String(threw) : undefined,
            },
            { slotElementId, adUnitCode: slotElementId }
          );
        } catch (e) {
          post('error', 'hook', 'wrap_callback_error', { method: 'addService', message: String(e) });
        }
        if (didThrow) throw threw;
        return result;
      };
      (wrapped as any).__bsWrapped = true;
      slot.addService = wrapped;
    } catch (e) {
      post('error', 'hook', 'wrap_error', { method: 'addService', message: String(e) });
    }
  }

  function describeGptService(svc: any): string {
    const gt = w.googletag;
    try {
      if (gt && typeof gt.pubads === 'function' && svc === gt.pubads()) return 'pubads';
      if (gt && typeof gt.companionAds === 'function' && svc === gt.companionAds()) return 'companionAds';
      if (svc && typeof svc.getSlots === 'function' && typeof svc.refresh === 'function') return 'pubads';
    } catch {
      /* ignore */
    }
    return 'other';
  }

  function onGptEvent(ev: string, e: any): void {
    const slot = e && e.slot;
    const slotElementId = safe(() => slot && slot.getSlotElementId());
    const adUnitPath = safe(() => slot && slot.getAdUnitPath());
    const payload = extractGptEvent(ev, e, adUnitPath, slot);
    post('event', 'gpt', ev, payload, { slotElementId, adUnitCode: slotElementId });

    if (ev === 'slotRenderEnded' && slot) {
      const info = safe(() => slot.getResponseInformation && slot.getResponseInformation());
      if (info) post('snapshot', 'gpt', 'getResponseInformation', info, { slotElementId });
    }
  }

  function readSlotTargeting(slot: any): { targeting?: Record<string, unknown>; targetingKeys?: string[] } {
    if (!slot) return {};
    // The official googletag.Slot API has NO getTargetingMap(). Build the map from
    // getTargetingKeys() + getTargeting(key), falling back to getConfig('targeting').
    // Capturing hb_adid here is what lets ad-source classification correlate a GPT
    // render cycle to a Prebid bid by adId (the strongest PREBID signal).
    let targetingKeys = safe(() => (slot.getTargetingKeys ? slot.getTargetingKeys() : undefined));
    let targeting: Record<string, unknown> | undefined;
    if (Array.isArray(targetingKeys) && typeof slot.getTargeting === 'function') {
      const map: Record<string, unknown> = {};
      for (const key of targetingKeys) {
        const val = safe(() => slot.getTargeting(key));
        if (val !== undefined) map[key] = val;
      }
      targeting = map;
    }
    // Fallback: modern config read (frozen object).
    if (!targeting || Object.keys(targeting).length === 0) {
      const cfg = safe(() => (slot.getConfig ? slot.getConfig('targeting') : undefined)) as any;
      const fromCfg = cfg && typeof cfg === 'object' ? (cfg.targeting ?? cfg) : undefined;
      if (fromCfg && typeof fromCfg === 'object') {
        targeting = fromCfg as Record<string, unknown>;
        if (!targetingKeys) targetingKeys = Object.keys(targeting);
      }
    }
    // Last resort: some GPT builds expose getTargetingMap; keep it if present.
    if (!targeting) {
      targeting = safe(() => (slot.getTargetingMap ? slot.getTargetingMap() : undefined));
      if (targeting && !targetingKeys) targetingKeys = Object.keys(targeting);
    }
    return { targeting, targetingKeys };
  }

  function extractGptEvent(ev: string, e: any, adUnitPath?: string, slot?: any): Record<string, unknown> {
    const base: Record<string, unknown> = {
      serviceName: safe(() => e && e.serviceName),
      adUnitPath,
    };
    if (ev === 'slotRequested' || ev === 'slotResponseReceived' || ev === 'slotRenderEnded') {
      Object.assign(base, readSlotTargeting(slot));
    }
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
          creativeTemplateId: e && e.creativeTemplateId,
          companyIds: e && e.companyIds,
          yieldGroupIds: e && e.yieldGroupIds,
          isBackfill: e && e.isBackfill,
          sourceAgnosticLineItemId: e && e.sourceAgnosticLineItemId,
          sourceAgnosticCreativeId: e && e.sourceAgnosticCreativeId,
          responseIdentifier: e && e.responseIdentifier,
          slotContentChanged: e && e.slotContentChanged,
          labelIds: e && e.labelIds,
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
  startTcfPoller();
})();
