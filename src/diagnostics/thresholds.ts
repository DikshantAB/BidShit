/** Wait / classification thresholds used by catalog rules. */
export const THRESHOLDS = {
  /** Prebid boot: libLoaded / first lifecycle event. */
  prebidReadyMs: 10_000,
  /** GPT apiReady / pubadsReady. */
  gptReadyMs: 10_000,
  /** Extra grace after auction timeout before calling the auction stalled. */
  auctionStallGraceMs: 1_500,
  /** Fallback when auction timeout is unknown. */
  auctionStallFallbackMs: 8_000,
  /** slotRequested without slotResponseReceived. */
  gamResponseMs: 12_000,
  /** slotResponseReceived without slotRenderEnded. */
  gamRenderMs: 8_000,
  /** Filled render without slotOnload when an iframe load is expected. */
  slotOnloadMs: 8_000,
  /** slotRenderEnded → slotOnload considered slow. */
  slowOnloadMs: 3_000,
  /** bidderTimeout / auction timeout considered excessively long. */
  longAuctionTimeoutMs: 4_000,
  /** Auction timeout considered too short when timeouts cluster. */
  shortAuctionTimeoutMs: 500,
  /** Refresh interval that is suspiciously frequent. */
  frequentRefreshMs: 15_000,
  /** Duplicate-event window (identical fingerprints). */
  duplicateEventMs: 8,
  /** Failsafe vs auction-end adjacency. */
  dualRefreshMs: 750,
  /** OPTIONS preflight consuming a large share of auction budget. */
  preflightBudgetShare: 0.35,
  /** GAM / bidder request URL or body considered oversized. */
  largeRequestChars: 8_192,
} as const;
