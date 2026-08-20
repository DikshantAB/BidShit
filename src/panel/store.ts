// Panel-side store: connects to the background service worker, ingests
// envelopes, and derives the session domain model (spec 7.4). Exposes a
// React hook via useSyncExternalStore.

import { useSyncExternalStore } from 'react';
import { BUFFER_CAP } from '../shared/constants';
import type {
  AdUnitRecord,
  AuctionRecord,
  BackgroundMessage,
  Envelope,
  PanelToBackground,
  SessionState,
  SlotRecord,
  StatusFlags,
} from '../shared/types';

export type { SessionState };

function emptyStatus(): StatusFlags {
  return {
    hookReady: false,
    hookLate: false,
    prebidPresent: false,
    gptPresent: false,
    cmpPresent: false,
    cmpConnected: false,
    libLoaded: false,
    apiReady: false,
    pubadsReady: false,
  };
}

function emptyState(connected = false): SessionState {
  return {
    connected,
    dropped: 0,
    status: emptyStatus(),
    envelopes: [],
    auctions: new Map(),
    adUnits: new Map(),
    slots: new Map(),
    prebidTargeting: {},
    gptPageTargeting: {},
    snapshots: {},
  };
}

class Store {
  private state: SessionState = emptyState();
  private listeners = new Set<() => void>();
  private port?: chrome.runtime.Port;
  private connGen = 0;
  private seenSeq = new Set<number>();
  private seenNetwork = new Set<string>();
  private pingTimer?: ReturnType<typeof setInterval>;

  getSnapshot = (): SessionState => this.state;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  private emit(): void {
    // Replace the top-level object so useSyncExternalStore sees a new snapshot.
    this.state = { ...this.state };
    for (const cb of this.listeners) cb();
  }

  connect(tabId: number): void {
    if (this.port) return;
    const connectOnce = () => {
      const gen = ++this.connGen;
      const port = chrome.runtime.connect({ name: 'bidshitter-panel' });
      this.port = port;
      const init: PanelToBackground = { type: 'init', tabId };
      port.postMessage(init);
      this.state.connected = true;
      this.startPing(port);
      this.emit();

      port.onMessage.addListener((msg: BackgroundMessage) => this.onMessage(msg));
      port.onDisconnect.addListener(() => {
        if (this.connGen !== gen) return;
        this.port = undefined;
        this.stopPing();
        this.state.connected = false;
        this.emit();
        // Auto-reconnect: MV3 workers are killed after idle even with a port.
        setTimeout(() => {
          if (this.connGen === gen) connectOnce();
        }, 250);
      });
    };
    connectOnce();
  }

  private startPing(port: chrome.runtime.Port): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      try {
        port.postMessage({ type: 'ping' } satisfies PanelToBackground);
      } catch {
        /* port gone; onDisconnect reconnects */
      }
    }, 20_000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  ingestNetwork(env: Envelope): void {
    this.apply(env);
    this.emit();
    try {
      this.port?.postMessage({ type: 'network', envelopes: [env] } satisfies PanelToBackground);
    } catch {
      /* SW down; panel still has the event */
    }
  }

  reset(): void {
    const wasConnected = this.state.connected;
    this.seenSeq.clear();
    this.seenNetwork.clear();
    this.state = emptyState(wasConnected);
    this.emit();
  }

  private onMessage(msg: BackgroundMessage): void {
    switch (msg.type) {
      case 'hydrate':
        // Never wipe existing panel state with an empty/partial hydrate.
        // MV3 workers restart with an empty memory Map; the panel already
        // has the session, and session storage may restore a subset.
        this.state.connected = true;
        for (const env of msg.envelopes) this.apply(env);
        this.state.dropped = Math.max(this.state.dropped, msg.dropped);
        this.emit();
        break;
      case 'events':
        for (const env of msg.envelopes) this.apply(env);
        this.emit();
        break;
      case 'reset':
        this.reset();
        break;
      case 'dropped':
        this.state.dropped = Math.max(this.state.dropped, msg.dropped);
        this.emit();
        break;
    }
  }

  private apply(env: Envelope): void {
    if (this.seenSeq.has(env.seq)) return;
    if (env.channel === 'network') {
      const p = env.payload as any;
      const key = `${p?.url || ''}|${env.ts}|${p?.status ?? ''}|${p?.bodySize ?? ''}`;
      if (this.seenNetwork.has(key)) return;
      this.seenNetwork.add(key);
    }
    this.seenSeq.add(env.seq);
    const s = this.state;
    s.envelopes.push(env);
    if (s.envelopes.length > BUFFER_CAP) s.envelopes.splice(0, s.envelopes.length - BUFFER_CAP);

    if (env.channel === 'prebid') s.status.prebidPresent = true;
    if (env.channel === 'gpt') s.status.gptPresent = true;
    if (env.channel === 'cmp') s.status.cmpPresent = true;
    if (env.channel === 'cmp' && env.name === 'tcfapi') s.status.cmpConnected = true;
    if (env.channel === 'network' && env.name === 'gamRequest') s.status.gptPresent = true;

    if (env.kind === 'status') this.applyStatus(env);
    else if (env.kind === 'snapshot') this.applySnapshot(env);
    else if (env.kind === 'event' && env.channel === 'prebid') this.applyPrebidEvent(env);
    else if (env.kind === 'event' && env.channel === 'gpt') this.applyGptEvent(env);
    else if (env.kind === 'api') this.applyApi(env);
  }

  private applyStatus(env: Envelope): void {
    const s = this.state;
    const p = (env.payload || {}) as any;
    if (env.channel === 'hook' && env.name === 'hook-ready') {
      s.status.hookReady = true;
      s.status.pageUrl = p.url;
      s.status.hookLate = !!(p.prebidAlreadyLoaded || p.gptAlreadyReady);
    } else if (env.channel === 'prebid' && env.name === 'libLoaded') {
      s.status.libLoaded = true;
      s.status.prebidPresent = true;
      if (p.version) s.status.prebidVersion = p.version;
    } else if (env.channel === 'gpt' && env.name === 'apiReady') {
      s.status.apiReady = true;
      s.status.gptPresent = true;
      if (p.version) s.status.gptVersion = p.version;
    } else if (env.channel === 'gpt' && env.name === 'pubadsReady') {
      s.status.pubadsReady = true;
    }
  }

  private applySnapshot(env: Envelope): void {
    const s = this.state;
    s.snapshots[env.name] = env.payload;
    const p = env.payload as any;
    if (env.name === 'globals' && p) {
      if (p.version) s.status.prebidVersion = p.version;
      if (Array.isArray(p.installedModules)) s.status.installedModules = p.installedModules;
      if (typeof p.delayPrerendering === 'boolean') s.status.delayPrerendering = p.delayPrerendering;
      if (Array.isArray(p.adUnits)) for (const au of p.adUnits) this.upsertAdUnit(au);
    }
    if (env.name === 'getAdserverTargeting' && p && typeof p === 'object') {
      for (const code of Object.keys(p)) {
        s.prebidTargeting[code] = { ...(s.prebidTargeting[code] || {}), ...(p[code] || {}) };
      }
    }
    if (env.name === 'defineSlot.result' && p && p.slotElementId) {
      const slot = this.upsertSlot(p.slotElementId);
      slot.adUnitPath = p.adUnitPath;
      slot.sizes = p.sizes;
    }
    if (env.name === 'getResponseInformation' && env.slotElementId && p) {
      const slot = this.upsertSlot(env.slotElementId);
      slot.lineItemId = p.lineItemId ?? slot.lineItemId;
      slot.creativeId = p.creativeId ?? slot.creativeId;
      slot.advertiserId = p.advertiserId ?? slot.advertiserId;
      slot.campaignId = p.campaignId ?? slot.campaignId;
      slot.creativeTemplateId = p.creativeTemplateId ?? slot.creativeTemplateId;
    }
  }

  private applyApi(env: Envelope): void {
    const s = this.state;
    const args = ((env.payload as any)?.args || []) as any[];
    if (env.channel === 'prebid') {
      if (env.name === 'addAdUnits') {
        const arg = args[0];
        const list = Array.isArray(arg) ? arg : arg ? [arg] : [];
        for (const au of list) this.upsertAdUnit(au);
      }
    } else if (env.channel === 'gpt') {
      if (env.name === 'display') {
        const target = args[0];
        const id = env.slotElementId || (typeof target === 'string' ? target : target?.slotElementId);
        if (id) this.upsertSlot(id).displayed = true;
      } else if (env.name === 'refresh') {
        const recorded = Array.isArray((env.payload as any)?.slotIds) ? (env.payload as any).slotIds : [];
        if (recorded.length) {
          for (const id of recorded) if (id) this.upsertSlot(String(id)).refreshed = true;
        } else {
          const slotsArg = args[0];
          if (Array.isArray(slotsArg)) {
            for (const sl of slotsArg) {
              const id = sl?.slotElementId;
              if (id) this.upsertSlot(id).refreshed = true;
            }
          } else {
            for (const slot of s.slots.values()) slot.refreshed = true;
          }
        }
      } else if (env.name === 'setTargeting') {
        // pubads-level page targeting: setTargeting(key, value)
        const key = args[0];
        if (typeof key === 'string') s.gptPageTargeting[key] = args[1];
      }
    }
  }

  private applyPrebidEvent(env: Envelope): void {
    const s = this.state;
    const p = env.payload as any;
    const name = env.name;
    if (name === 'auctionInit' && p?.auctionId) {
      const a = this.upsertAuction(p.auctionId);
      a.startTs = env.ts;
      a.initPerf = env.perf;
      a.timeout = p.timeout;
      a.status = 'inProgress';
      a.adUnitCodes = normCodes(p);
    } else if (name === 'bidRequested' && p) {
      const auctionId = p.auctionId;
      const bidder = p.bidderCode || p.bidder;
      if (auctionId && bidder) {
        const a = this.upsertAuction(auctionId);
        a.bidRequestedPerf[bidder] = env.perf;
      }
    } else if ((name === 'auctionEnd' || name === 'auctionTimeout') && p?.auctionId) {
      const a = this.upsertAuction(p.auctionId);
      a.endTs = env.ts;
      a.status = name === 'auctionTimeout' ? 'timeout' : 'ended';
      a.adUnitCodes = normCodes(p);
      a.bidderRequests = p.bidderRequests || a.bidderRequests;
      a.bidsReceived = p.bidsReceived || a.bidsReceived;
      a.noBids = p.noBids || a.noBids;
      a.bidsRejected = p.bidsRejected || a.bidsRejected;
      a.winningBids = p.winningBids || a.winningBids;
      if (typeof p.timeout === 'number') a.timeout = p.timeout;
      for (const code of a.adUnitCodes) this.upsertAdUnitCode(code);
    } else if (name === 'setTargeting' && p && typeof p === 'object') {
      for (const code of Object.keys(p)) {
        s.prebidTargeting[code] = { ...(s.prebidTargeting[code] || {}), ...(p[code] || {}) };
      }
    }
  }

  private applyGptEvent(env: Envelope): void {
    const id = env.slotElementId;
    if (!id) return;
    const slot = this.upsertSlot(id);
    const p = env.payload as any;
    slot.lastActivity = env.name;
    if (p?.adUnitPath) slot.adUnitPath = p.adUnitPath;
    switch (env.name) {
      case 'slotRequested':
        slot.requested = true;
        if (p?.targeting && typeof p.targeting === 'object') slot.targetingAtRequest = p.targeting;
        break;
      case 'slotResponseReceived':
        slot.responseReceived = true;
        break;
      case 'slotRenderEnded':
        slot.isEmpty = !!p?.isEmpty;
        slot.filled = !p?.isEmpty;
        slot.lineItemId = p?.lineItemId ?? slot.lineItemId;
        slot.creativeId = p?.creativeId ?? slot.creativeId;
        slot.advertiserId = p?.advertiserId ?? slot.advertiserId;
        slot.campaignId = p?.campaignId ?? slot.campaignId;
        slot.creativeTemplateId = p?.creativeTemplateId ?? slot.creativeTemplateId;
        slot.companyIds = p?.companyIds ?? slot.companyIds;
        slot.yieldGroupIds = p?.yieldGroupIds ?? slot.yieldGroupIds;
        slot.isBackfill = p?.isBackfill ?? slot.isBackfill;
        slot.sourceAgnosticLineItemId = p?.sourceAgnosticLineItemId ?? slot.sourceAgnosticLineItemId;
        slot.sourceAgnosticCreativeId = p?.sourceAgnosticCreativeId ?? slot.sourceAgnosticCreativeId;
        slot.responseIdentifier = p?.responseIdentifier ?? slot.responseIdentifier;
        slot.renderedSize = p?.size ?? slot.renderedSize;
        slot.slotContentChanged = p?.slotContentChanged ?? slot.slotContentChanged;
        if (p?.targeting && typeof p.targeting === 'object') slot.targeting = p.targeting;
        break;
      case 'slotOnload':
        slot.onloaded = true;
        break;
      case 'impressionViewable':
        slot.viewable = true;
        break;
      case 'slotVisibilityChanged':
        if (typeof p?.inViewPercentage === 'number') slot.inViewPercentage = p.inViewPercentage;
        break;
    }
  }

  // ---- upserts ----------------------------------------------------------
  private upsertAuction(id: string): AuctionRecord {
    let a = this.state.auctions.get(id);
    if (!a) {
      a = {
        auctionId: id,
        adUnitCodes: [],
        bidderRequests: [],
        bidsReceived: [],
        noBids: [],
        bidsRejected: [],
        winningBids: [],
        bidRequestedPerf: {},
      };
      this.state.auctions.set(id, a);
    }
    return a;
  }

  private upsertSlot(id: string): SlotRecord {
    let sl = this.state.slots.get(id);
    if (!sl) {
      sl = { slotElementId: id };
      this.state.slots.set(id, sl);
    }
    return sl;
  }

  private upsertAdUnitCode(code: string): AdUnitRecord {
    let au = this.state.adUnits.get(code);
    if (!au) {
      au = { code };
      this.state.adUnits.set(code, au);
    }
    return au;
  }

  private upsertAdUnit(raw: any): void {
    if (!raw || !raw.code) return;
    const au = this.upsertAdUnitCode(raw.code);
    if (raw.mediaTypes && typeof raw.mediaTypes === 'object') {
      au.mediaTypes = Object.keys(raw.mediaTypes);
    }
    if (Array.isArray(raw.bids)) {
      au.bidders = raw.bids.map((b: any) => b?.bidder).filter(Boolean);
    }
  }
}

function normCodes(p: any): string[] {
  if (Array.isArray(p?.adUnitCodes)) return p.adUnitCodes.filter(Boolean);
  if (Array.isArray(p?.adUnits)) return p.adUnits.map((a: any) => a?.code).filter(Boolean);
  return [];
}

export const store = new Store();

export function useSession(): SessionState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
