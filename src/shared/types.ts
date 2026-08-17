// Shared message + domain types. See spec.md sections 7.3 and 7.4.

export type EnvelopeKind = 'event' | 'api' | 'snapshot' | 'status' | 'error';
export type EnvelopeChannel = 'prebid' | 'gpt' | 'hook' | 'network';

/** One captured record travelling hook -> content-script -> background -> panel. */
export interface Envelope {
  source: 'bidshitter';
  seq: number;
  /** Wall-clock ms (Date.now). */
  ts: number;
  /** High-res monotonic ms (performance.now) for ordering + durations. */
  perf: number;
  kind: EnvelopeKind;
  channel: EnvelopeChannel;
  /** Event name or API/status/error name. */
  name: string;
  auctionId?: string;
  adUnitCode?: string;
  slotElementId?: string;
  payload: unknown;
}

/** Batch posted from the MAIN world hook to the isolated content script. */
export interface HookMessage {
  source: 'bidshitter';
  dir: 'to-devtools';
  batch: Envelope[];
}

/** content-script -> background. */
export interface RelayMessage {
  source: 'bidshitter';
  dir: 'relay';
  batch: Envelope[];
}

/** panel -> background (port). */
export type PanelToBackground =
  | { type: 'init'; tabId: number }
  | { type: 'ping' }
  | { type: 'network'; envelopes: Envelope[] };

/** @deprecated use PanelToBackground */
export type PanelInit = Extract<PanelToBackground, { type: 'init' }>;

/** background -> panel (port). */
export type BackgroundMessage =
  | { type: 'hydrate'; tabId: number; envelopes: Envelope[]; dropped: number }
  | { type: 'events'; envelopes: Envelope[] }
  | { type: 'reset'; reason: string }
  | { type: 'dropped'; dropped: number };

// ---- Panel-side derived domain model -------------------------------------

export interface StatusFlags {
  hookReady: boolean;
  hookLate: boolean;
  prebidPresent: boolean;
  gptPresent: boolean;
  libLoaded: boolean;
  apiReady: boolean;
  pubadsReady: boolean;
  prebidVersion?: string;
  gptVersion?: string;
  installedModules?: string[];
  delayPrerendering?: boolean;
  pageUrl?: string;
}

export interface BidRow {
  auctionId?: string;
  adUnitCode?: string;
  bidder?: string;
  mediaType?: string;
  cpm?: number;
  originalCpm?: number;
  currency?: string;
  size?: string;
  ttl?: number;
  dealId?: string;
  status?: string;
  /** Time to respond, ms (from bidRequested / auctionInit). */
  ttr?: number;
  outcome: 'bid' | 'noBid' | 'timeout' | 'rejected' | 'error' | 'won';
  rejectionReason?: string;
  adId?: string;
  requestId?: string;
  meta?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface AuctionRecord {
  auctionId: string;
  startTs?: number;
  endTs?: number;
  status?: string;
  adUnitCodes: string[];
  bidderRequests: unknown[];
  bidsReceived: unknown[];
  noBids: unknown[];
  bidsRejected: unknown[];
  winningBids: unknown[];
  timeout?: number;
  /** hook perf ms at auctionInit, for TTR math. */
  initPerf?: number;
  /** bidder -> hook perf ms at its bidRequested. */
  bidRequestedPerf: Record<string, number>;
}

export interface SlotRecord {
  slotElementId: string;
  adUnitPath?: string;
  sizes?: unknown;
  format?: string;
  outOfPage?: boolean;
  isEmpty?: boolean;
  filled?: boolean;
  lineItemId?: number | null;
  creativeId?: number | null;
  advertiserId?: number | null;
  campaignId?: number | null;
  creativeTemplateId?: number | null;
  companyIds?: number[] | null;
  yieldGroupIds?: number[] | null;
  isBackfill?: boolean;
  sourceAgnosticLineItemId?: number | null;
  sourceAgnosticCreativeId?: number | null;
  responseIdentifier?: string;
  renderedSize?: unknown;
  slotContentChanged?: boolean;
  requested?: boolean;
  responseReceived?: boolean;
  onloaded?: boolean;
  viewable?: boolean;
  inViewPercentage?: number;
  lastActivity?: string;
  displayed?: boolean;
  refreshed?: boolean;
  targeting?: Record<string, unknown>;
  targetingAtRequest?: Record<string, unknown>;
}

export interface AdUnitRecord {
  code: string;
  mediaTypes?: string[];
  bidders?: string[];
}

/** Panel-side derived session (spec 7.4). */
export interface SessionState {
  connected: boolean;
  dropped: number;
  status: StatusFlags;
  envelopes: Envelope[];
  auctions: Map<string, AuctionRecord>;
  adUnits: Map<string, AdUnitRecord>;
  slots: Map<string, SlotRecord>;
  /** adUnitCode -> {hb_key: value} (Prebid). */
  prebidTargeting: Record<string, Record<string, unknown>>;
  /** page-level GPT targeting key -> value. */
  gptPageTargeting: Record<string, unknown>;
  /** latest read-only snapshots for fallback/augmentation. */
  snapshots: Record<string, unknown>;
}
