// Canonical event name lists — kept in sync with:
//   01_practice/pbjs-master-reference.md
//   01_practice/gpt-events-master-reference.md
// See spec.md section 16.

export const MESSAGE_SOURCE = 'bidshitter' as const;

/** Prebid events always subscribed via pbjs.onEvent (spec 8.2). */
export const PREBID_CORE_EVENTS = [
  // Auction lifecycle
  'requestBids',
  'beforeRequestBids',
  'auctionInit',
  'auctionEnd',
  'auctionTimeout',
  'auctionDebug',
  // Bid request / response
  'bidRequested',
  'beforeBidderHttp',
  'bidResponse',
  'noBid',
  'bidAccepted',
  'bidRejected',
  'bidAdjustment',
  'bidTimeout',
  'bidderDone',
  'bidderError',
  // Targeting & win
  'setTargeting',
  'bidWon',
  // Render
  'adRenderSucceeded',
  'adRenderFailed',
  'staleRender',
  'expiredRender',
  'browserIntervention',
] as const;

/** Optional Prebid events — recorded when they fire, module not required (spec 8.2). */
export const PREBID_OPTIONAL_EVENTS = [
  'tcf2Enforcement',
  'beforePBSHttp',
  'pbsAnalytics',
  'billableEvent',
  'bidViewable',
  'browsiInit',
  'browsiData',
] as const;

export const PREBID_EVENTS = [...PREBID_CORE_EVENTS, ...PREBID_OPTIONAL_EVENTS] as const;

/** All 12 GPT events via googletag.pubads().addEventListener (spec 8.6). */
export const GPT_EVENTS = [
  // Display lifecycle
  'slotRequested',
  'slotResponseReceived',
  'slotRenderEnded',
  'slotOnload',
  // Viewability
  'impressionViewable',
  'slotVisibilityChanged',
  // Rewarded
  'rewardedSlotReady',
  'rewardedSlotGranted',
  'rewardedSlotClosed',
  'rewardedSlotVideoCompleted',
  // Game manual interstitial
  'gameManualInterstitialSlotReady',
  'gameManualInterstitialSlotClosed',
] as const;

/** Prebid methods we wrap for observability (spec 8.3). Pure pass-through. */
export const PREBID_WRAP_METHODS = [
  'addAdUnits',
  'removeAdUnit',
  'requestBids',
  'setConfig',
  'mergeConfig',
  'setBidderConfig',
  'mergeBidderConfig',
  'setTargetingForGPTAsync',
  'setTargetingForAst',
  'renderAd',
  'markWinningBidAsUsed',
  'triggerBilling',
  'clearAllAuctions',
  'refreshPageViewId',
  'aliasBidder',
  'enableAnalytics',
  'registerBidAdapter',
  'registerAnalyticsAdapter',
  'triggerUserSyncs',
  'processQueue',
] as const;

/** googletag top-level methods we wrap (spec 8.7). */
export const GPT_WRAP_METHODS = [
  'defineSlot',
  'defineOutOfPageSlot',
  'display',
  'enableServices',
  'destroySlots',
  'setConfig',
] as const;

/** PubAdsService methods we wrap (spec 8.7). */
export const PUBADS_WRAP_METHODS = [
  'refresh',
  'clear',
  'disableInitialLoad',
  'enableSingleRequest',
  'enableLazyLoad',
  'collapseEmptyDivs',
  'setTargeting',
  'clearTargeting',
  'setPrivacySettings',
  'setPublisherProvidedId',
  'updateCorrelator',
  'display',
  'setForceSafeFrame',
  'setSafeFrameConfig',
] as const;

/** googletag.Slot methods we wrap after a slot is defined (spec 8.7). */
export const SLOT_WRAP_METHODS = [
  'addService',
  'defineSizeMapping',
  'setConfig',
  'setTargeting',
  'updateTargetingFromMap',
  'clearTargeting',
  'setCollapseEmptyDiv',
] as const;

/** Default Prebid targeting keys to highlight in the Targeting view (spec 8.4). */
export const PREBID_TARGETING_KEYS = [
  'hb_bidder',
  'hb_adid',
  'hb_pb',
  'hb_size',
  'hb_deal',
  'hb_source',
  'hb_format',
  'hb_uuid',
  'hb_cache_id',
  'hb_cache_host',
  'hb_adomain',
  'hb_acat',
  'hb_crid',
  'hb_dsp',
  'hb_ver',
] as const;

/** Keys stripped from any sanitized payload (creatives / PII / heavy). */
export const STRIP_KEYS = [
  'ad',
  'adm',
  'vastXml',
  'vastUrl',
  'vastImpUrl',
  'renderer',
  'native',
  'body',
  'consentString',
  'tcString',
  'addtlConsent',
  'gppString',
  'uspString',
] as const;

export const BUFFER_CAP = 5000;
export const STRING_CAP = 2048;
export const ARRAY_CAP = 500;
export const DEPTH_CAP = 10;
export const BOOT_POLL_MS = 50;
export const BOOT_POLL_TIMEOUT_MS = 10000;
export const VISIBILITY_SAMPLE_MS = 500;

export type PrebidEventName = (typeof PREBID_EVENTS)[number];
export type GptEventName = (typeof GPT_EVENTS)[number];
