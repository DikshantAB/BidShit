# Prebid.js Auction Issue Catalogue

This document catalogues the common issues developers investigate manually during a Prebid.js auction. It covers Prebid initialization, publisher configuration, consent, bid requests, bidder responses, bid validation, bid selection, ad-server targeting, the GPT handoff, and Prebid creative rendering.

The catalogue is intended to support an evidence-based diagnostic tool. A reported issue should identify the lifecycle stage, likely owner, supporting evidence, confidence, and the next manual check. It must not treat every warning or unsuccessful bidder response as a fatal auction failure.

## Manual inspection tools

Enable Prebid debug logging by adding the following query parameter and reloading the page:

```text
?pbjs_debug=true
```

Developers commonly inspect these values in the browser console:

```js
// Prebid version and installed modules
pbjs.version
pbjs.installedModules

// Publisher configuration and configured ad units
pbjs.getConfig()
pbjs.adUnits

// Complete Prebid event history
pbjs.getEvents()

// Auction results
pbjs.getBidResponses()
pbjs.getNoBids()
pbjs.getHighestCpmBids()

// Targeting Prebid intends to send to the ad server
pbjs.getAdserverTargeting()

// Bids that were actually rendered
pbjs.getAllWinningBids()
```

The following command produces a compact event timeline:

```js
console.table(
  pbjs.getEvents().map(event => ({
    event: event.eventType,
    time: event.elapsedTime,
    auctionId: event.args?.auctionId,
    adUnitCode: event.args?.adUnitCode,
    bidder: event.args?.bidder || event.args?.bidderCode
  }))
);
```

The following command filters the events most useful for auction diagnosis:

```js
pbjs.getEvents().filter(event =>
  [
    'auctionInit',
    'bidRequested',
    'bidResponse',
    'noBid',
    'bidRejected',
    'bidTimeout',
    'bidderError',
    'auctionTimeout',
    'auctionEnd',
    'setTargeting'
  ].includes(event.eventType)
);
```

## 1. Initialization and library loading

| Diagnostic code | Issue | What developers observe | Manual check |
|---|---|---|---|
| `PBJS_NOT_LOADED` | Prebid script did not load | `pbjs` is undefined | Check `window.pbjs`, the Network tab, and script errors in the Console |
| `PBJS_SCRIPT_BLOCKED` | Prebid request was blocked | Script request is cancelled or blocked | Filter the Network tab for `prebid`; check ad blockers and CSP errors |
| `PBJS_GLOBAL_MISMATCH` | Page uses a custom Prebid global | `pbjs` is missing but another instance exists | Inspect `window._pbjsGlobals` and the build configuration |
| `PBJS_MULTIPLE_INSTANCES` | Multiple Prebid instances are active | Events or bids appear under different globals | Inspect `window._pbjsGlobals` and query every registered global |
| `PBJS_QUEUE_NOT_PROCESSED` | Prebid command queue was not drained | Commands remain in `pbjs.que` | Inspect `pbjs.que`, script loading, and earlier JavaScript exceptions |
| `PBJS_LOADED_TOO_LATE` | Prebid loaded after the ad-server flow began | GPT requests occur before Prebid initialization | Compare Network, Prebid event, and GPT event timestamps |
| `PBJS_INITIALIZATION_ERROR` | Initialization threw an exception | Auction never starts | Preserve the browser Console and inspect the first exception |
| `PBJS_BUILD_UNEXPECTED` | Wrong or old build is deployed | Expected APIs or behavior are missing | Check `pbjs.version` and the downloaded bundle |
| `PBJS_MODULE_MISSING` | Required module is absent from the build | Expected bidder or module behavior is absent | Check `pbjs.installedModules` |
| `PBJS_DUPLICATE_LOAD` | Prebid or a module was loaded twice | Duplicate events or network requests | Inspect script requests, event sequences, and page source |
| `PBJS_COMMAND_ORDER_INVALID` | Configuration commands ran in the wrong order | Configuration or ad units were added after the auction | Compare the integration source with event timestamps |
| `PBJS_PRERENDER_DELAY` | Auction was delayed during page prerendering | Requests do not start until page activation | Check `document.prerendering` and `allowPrerendering` |

## 2. Publisher configuration and ad units

| Diagnostic code | Issue | What developers observe | Manual check |
|---|---|---|---|
| `AD_UNIT_NOT_CONFIGURED` | No matching Prebid ad unit exists | Selected slot never appears in an auction | Inspect `pbjs.adUnits` and `auctionInit.args.adUnits` |
| `AD_UNIT_NOT_REQUESTED` | Ad unit was excluded from `requestBids` | Other slots auction but the selected slot does not | Inspect `requestBids.args.adUnitCodes` and `auctionInit` |
| `AD_UNIT_DUPLICATE_CODE` | Multiple definitions use the same code | Results from separate definitions are mixed | Check for duplicate values in `pbjs.adUnits.map(unit => unit.code)` |
| `AD_UNIT_NO_BIDDERS` | Ad unit has no usable bidders | Auction exists but produces no bidder requests | Inspect the ad unit's `bids` array |
| `BIDDER_NOT_INSTALLED` | Configured bidder adapter is absent | Bidder never appears in `bidRequested` | Compare `adUnit.bids[].bidder` with `pbjs.installedModules` |
| `BIDDER_PARAMS_INVALID` | Required bidder parameters are missing or invalid | Adapter warns, skips, or builds an invalid request | Inspect debug logs and `bidRequested.args.bids[].params` |
| `MEDIA_TYPE_UNSUPPORTED` | Bidder does not support the requested media type | Bidder is omitted from the ad unit | Inspect debug logs and bidder media-type support |
| `BANNER_SIZE_MISSING` | Banner sizes are absent | Banner request cannot be constructed correctly | Inspect `mediaTypes.banner.sizes` |
| `MEDIA_SIZE_INVALID` | Size definition is malformed or unsupported | Request or response is rejected | Compare ad-unit sizes, bid sizes, and `bidRejected` |
| `VIDEO_CONFIG_INVALID` | Video context or required properties are invalid | Video bidder is omitted or response rejected | Inspect `mediaTypes.video`, debug logs, and rejection events |
| `NATIVE_CONFIG_INVALID` | Native assets are invalid | Native request or response is rejected | Inspect the native request and `bidRejected` evidence |
| `LABELS_EXCLUDED_AD_UNIT` | Labels filtered the ad unit or bidder | Fewer bidders are requested than expected | Compare request labels with ad-unit and bidder label configuration |
| `ORTB_CONFIGURATION_INVALID` | First-party/OpenRTB data is malformed | Outgoing request differs from publisher intent | Inspect `pbjs.getConfig('ortb2')` and `bidRequested` |
| `REFRESH_CORRELATION_CONFLICT` | Refresh or transaction identifiers overlap | Results are associated with the wrong refresh | Compare `auctionId`, `transactionId`, `adUnitCode`, and timestamps |

## 3. Consent and pre-auction blocking

| Diagnostic code | Issue | What developers observe | Manual check |
|---|---|---|---|
| `CMP_NOT_AVAILABLE` | Configured CMP cannot be found | Auction is delayed, cancelled, or missing bidders | Inspect consent configuration and debug logs |
| `CMP_TIMEOUT` | CMP did not respond before its timeout | Auction starts late or is cancelled | Compare consent timeout with auction event timing |
| `CONSENT_INVALID` | Consent data is invalid or incomplete | Some bidders are blocked | Inspect `pbjs.getConsentMetadata()` and enforcement events |
| `BIDDER_BLOCKED_BY_CONSENT` | Enforcement prevented bidder activity | Configured bidder has no request | Inspect `tcf2Enforcement` and compare configured/requested bidders |
| `GPP_CONFIGURATION_INVALID` | GPP data is absent or incorrect | Bidder request has unexpected privacy fields | Inspect consent metadata and the outgoing request |
| `ACTIVITY_NOT_ALLOWED` | Activity controls blocked an operation | Storage, sync, transmit, or enrichment did not occur | Inspect debug logs and activity-control configuration |
| `USER_ID_DELAY` | User ID module delayed auction activity | Bid requests begin later than expected | Compare module timing with `auctionInit` and `bidRequested` |
| `RTD_DELAY` | RTD module delayed the auction | Bid requests start after a long enrichment wait | Inspect RTD configuration, logs, and event timestamps |

## 4. Auction lifecycle

| Diagnostic code | Issue | What developers observe | Manual check |
|---|---|---|---|
| `REQUEST_BIDS_NOT_CALLED` | Publisher never invoked `requestBids()` | No `requestBids` or `auctionInit` event | Inspect `pbjs.getEvents()` and the integration source |
| `AUCTION_HAS_NO_AD_UNITS` | Auction was invoked with no usable ad units | Auction initializes with an empty selection | Inspect `requestBids` arguments and `auctionInit` |
| `AUCTION_HAS_NO_BIDDER_REQUESTS` | Auction starts but calls no adapters | `auctionInit` exists without `bidRequested` | Check ad units, labels, media types, consent, and installed adapters |
| `AUCTION_CALLBACK_INVALID` | Publisher continuation does not run correctly | Targeting or refresh does not follow the auction | Set a breakpoint in `bidsBackHandler` and inspect the integration source |
| `AUCTION_TIMEOUT_TOO_SHORT` | Auction timeout is too aggressive | Many bidders consistently time out | Inspect `auctionInit.args.timeout` and `bidTimeout` |
| `AUCTION_TIMEOUT_OVERRIDDEN` | Effective timeout differs from expected config | Runtime behavior does not match global setting | Use the timeout recorded by `auctionInit` |
| `CONCURRENT_AUCTION_CONFLICT` | Concurrent auctions interfere | Bids or targeting appear associated with another auction | Group every event and bid by `auctionId` |
| `AUCTION_CANCELLED` | Auction ends prematurely or without results | Normal bidder lifecycle is absent | Inspect consent, activity controls, and Console errors |
| `AUCTION_NOT_COMPLETED` | Auction never emits `auctionEnd` | Bidder activity exists but no completion | Inspect `bidderDone`, `bidTimeout`, `bidderError`, and timing |
| `AUCTION_TIMEOUT_REACHED` | Auction hit its deadline | `auctionTimeout` or timed-out requests are present | Inspect the auction timeout and bidder response times |

## 5. Bid request and network transport

| Diagnostic code | Issue | What developers observe | Manual check |
|---|---|---|---|
| `BID_REQUEST_NOT_BUILT` | Adapter could not construct the request | `bidRequested` exists but no valid HTTP request follows | Inspect adapter validation, Console errors, and bidder parameters |
| `BID_REQUEST_NOT_SENT` | Constructed request never reached the network | No `beforeBidderHttp` or Network entry | Compare Prebid events with the Network tab |
| `BID_ENDPOINT_INVALID` | Bidder endpoint is incorrect | DNS, 404, or unexpected destination | Inspect the request URL and status |
| `BID_REQUEST_BLOCKED` | Browser or extension blocked request | `ERR_BLOCKED_BY_CLIENT` or cancellation | Inspect the Network and Console panels |
| `BID_REQUEST_CSP_ERROR` | Content Security Policy blocked request | CSP violation appears in Console | Inspect CSP response headers and the violation message |
| `BID_REQUEST_MIXED_CONTENT` | HTTP request was blocked on HTTPS page | Mixed-content warning appears | Inspect Console security messages |
| `BID_REQUEST_CORS_ERROR` | Browser rejected response access | CORS error appears despite a server response | Inspect response headers and Console |
| `BID_REQUEST_PREFLIGHT_DELAY` | OPTIONS request delays bidding | Preflight consumes much of the timeout | Inspect the Network waterfall and content type |
| `BID_REQUEST_TIMEOUT` | HTTP request exceeds auction deadline | Request is pending when the auction ends | Compare Network timing with `bidTimeout` |
| `BID_REQUEST_HTTP_4XX` | Bidder endpoint rejected the request | Network response is 4xx | Inspect status and response body |
| `BID_REQUEST_HTTP_5XX` | Bidder backend failed | Network response is 5xx | Inspect status and response body |
| `BID_RESPONSE_EMPTY` | Endpoint returned no usable bid | `noBid` follows an empty response | Inspect the Network response and `noBid` |
| `BID_RESPONSE_MALFORMED` | Adapter cannot parse response | `bidderError`, Console error, or no bid | Inspect raw response and adapter logs |
| `PBS_REQUEST_FAILED` | Prebid Server request failed | All S2S bidders fail together | Inspect the OpenRTB request and PBS response |
| `S2S_BIDDER_NOT_CONFIGURED` | Expected server bidder is absent | Bidder has no S2S request | Inspect `s2sConfig` and `bidRequested.src` |
| `BID_REQUEST_DUPLICATE` | Same bidder request is sent repeatedly | Duplicate network entries or request IDs | Compare bidder request IDs and auction IDs |

## 6. Bidder outcomes

| Diagnostic code | Issue | Primary evidence | Manual check |
|---|---|---|---|
| `BIDDER_NO_BID` | Bidder returned no bid | `noBid` | Inspect `pbjs.getNoBids()`, the event, and network response |
| `BIDDER_TIMEOUT` | Bidder missed the deadline | `bidTimeout` | Inspect the event and Network timing |
| `BIDDER_LATE_RESPONSE` | Bid arrived after auction completion | Response timestamp is later than `auctionEnd` | Compare Network and event timestamps |
| `BIDDER_ERROR` | Adapter threw an error | `bidderError` | Inspect event error data and Console stack |
| `BIDDER_NOT_DONE` | Bidder never completed normally | Missing `bidderDone` | Inspect the bidder's complete event sequence |
| `PBS_SEAT_NON_BID` | PBS supplied a non-bid status | `seatNonBids` | Inspect the auction snapshot or PBS response |
| `BID_RESPONSE_PARTIAL` | Only some requested impressions received bids | Mixed response/no-bid results | Match results with request ID and ad-unit code |
| `BID_RESPONSE_DUPLICATE` | One request produced duplicate bids | Repeated response for the same request ID | Group `bidResponse` by request ID |
| `BIDDER_ALIAS_UNEXPECTED` | Bidder or alias differs from configuration | Response identity is unexpected | Compare `bidder`, `bidderCode`, and `adapterCode` |
| `BIDDER_SOURCE_DUPLICATION` | Same demand is requested client-side and S2S | Duplicate bidder appears under different sources | Inspect `src`, bidder configuration, and request IDs |

## 7. Bid validation and rejection

The `bidRejected` event and its `rejectionReason` are the strongest evidence for this stage.

| Diagnostic code | Issue | Manual check |
|---|---|---|
| `BID_REJECTED_INVALID_CPM` | CPM is absent, invalid, or unusable | Inspect `bidRejected`, the raw response, and `bid.cpm` |
| `BID_REJECTED_ZERO_CPM` | Bid has zero CPM and is ineligible | Inspect the response and targeting filters |
| `BID_REJECTED_MAX_BID` | CPM exceeds configured maximum | Inspect `pbjs.getConfig('maxBid')` and rejection reason |
| `BID_REJECTED_CURRENCY` | Currency is unsupported or cannot be converted | Inspect bid currency and currency-module configuration |
| `BID_REJECTED_BELOW_FLOOR` | Bid fails the applicable floor | Inspect `bid.floorData`, floor rules, and rejection reason |
| `BID_REJECTED_SIZE` | Returned dimensions do not match allowed sizes | Compare bid dimensions with requested sizes |
| `BID_REJECTED_MEDIA_TYPE` | Returned media type does not match request | Compare request and response media types |
| `BID_REJECTED_CREATIVE` | Required creative data is absent or invalid | Inspect banner markup, VAST/cache information, native data, or renderer metadata without retaining creative content |
| `BID_REJECTED_NATIVE` | Native response is incomplete or invalid | Inspect native asset validation and rejection reason |
| `BID_REJECTED_VIDEO` | Video response fails validation or caching | Inspect VAST, cache, renderer, and rejection evidence |
| `BID_REJECTED_REQUEST_ID` | Response cannot be associated with a request | Compare response request ID with eligible bid requests |
| `BID_REJECTED_TTL` | TTL is invalid or missing | Inspect bid TTL and validation logs |
| `BID_REJECTED_NET_REVENUE` | `netRevenue` is invalid | Inspect response fields and validation logs |
| `BID_REJECTED_VALIDATION` | Another core validation rule failed | Preserve the full `rejectionReason` and relevant sanitized fields |
| `BID_EXCLUDED_FROM_TARGETING` | Custom targeting exclusion removed bid | Inspect `bidTargetingExclusion` and eligible bid set |
| `BID_ADJUSTED_OUT_OF_ELIGIBILITY` | Adjustment changed bid eligibility | Compare `bidAdjustment`, original CPM, and final CPM |

## 8. Bid selection and eligibility

| Diagnostic code | Issue | What developers observe | Manual check |
|---|---|---|---|
| `BID_RANK_UNEXPECTED` | Expected highest bid is not selected | Another bid becomes targeting candidate | Compare `getHighestCpmBids()` and all adjusted bids |
| `BID_RANK_CHANGED_BY_ADJUSTMENT` | CPM adjustment changes ranking | Original and final CPM differ | Inspect `bidAdjustment` and bid fields |
| `BID_RANK_CHANGED_BY_CURRENCY` | Currency conversion changes ranking | Converted CPM differs from original CPM | Inspect currencies, rates, and converted CPM |
| `DEAL_PRIORITIZATION_APPLIED` | Deal is selected ahead of higher open-market CPM | Lower CPM deal becomes candidate | Inspect `sendBidsControl.dealPrioritization` |
| `BID_EXPIRED_BEFORE_TARGETING` | Accepted bid is no longer usable | Old bid is absent from targeting | Inspect TTL, buffer, response timestamp, and current time |
| `STALE_BID_SELECTED` | Bid from an earlier auction appears relevant | Auction IDs do not match | Compare auction ID and timestamps |
| `SEND_ALL_BIDS_LIMIT_REACHED` | Valid bids are omitted from targeting | Candidate set is smaller than expected | Inspect `enableSendAllBids`, ad-unit `bidLimit`, and `sendBidsControl.bidLimit` |
| `TARGETING_CHARACTER_LIMIT_REACHED` | Targeting entries are truncated | Some keys or bidders are missing | Inspect `targetingControls.auctionKeyMaxChars` |

## 9. Ad-server targeting generation

Developers inspect targeting with:

```js
pbjs.getAdserverTargeting()
pbjs.getAdserverTargetingForAdUnitCode('slot-code')
```

| Diagnostic code | Issue | Manual check |
|---|---|---|
| `TARGETING_NOT_GENERATED` | Accepted bids exist but targeting is empty | Compare received/eligible bids with `getAdserverTargeting()` |
| `TARGETING_WRONG_AD_UNIT` | Targeting is attached to another ad-unit code | Inspect targeting grouped by ad-unit code |
| `TARGETING_AD_ID_MISSING` | `hb_adid` is missing | Inspect bid eligibility and allowed targeting keys |
| `TARGETING_PRICE_BUCKET_MISSING` | `hb_pb` is missing | Inspect price granularity and targeting controls |
| `TARGETING_BIDDER_MISSING` | `hb_bidder` is missing | Inspect bidder settings and allowed keys |
| `TARGETING_SIZE_MISSING` | `hb_size` is missing | Inspect bid dimensions and targeting configuration |
| `TARGETING_PRICE_BUCKET_INCORRECT` | Price bucket does not match expected CPM | Compare price granularity with the final bid CPM |
| `TARGETING_CUSTOM_KEY_MISSING` | Bidder-specific targeting is absent | Inspect `bidderSettings` and generated targeting |
| `TARGETING_KEY_OVERWRITTEN` | Custom targeting overwrote a standard key | Compare bidder settings with generated targeting |
| `TARGETING_KEY_FILTERED` | Targeting controls removed a required key | Inspect `targetingControls.allowTargetingKeys` and related settings |
| `TARGETING_STALE` | Targeting belongs to a prior auction | Compare auction ID, `hb_adid`, and response timestamp |
| `TARGETING_GENERATED_TOO_EARLY` | Targeting was calculated before auction completion | Compare `setTargeting`, bid response, and `auctionEnd` timestamps |

## 10. Prebid-to-GPT handoff

These issues occur at the publisher integration boundary, but they determine whether a Prebid bid is included in a GAM request.

```js
const prebidTargeting =
  pbjs.getAdserverTargetingForAdUnitCode('div-banner');

const slots = googletag.pubads().getSlots();

console.table(slots.map(slot => ({
  elementId: slot.getSlotElementId(),
  adUnitPath: slot.getAdUnitPath(),
  targeting: JSON.stringify(slot.getTargetingMap?.() || {})
})));
```

| Diagnostic code | Issue | Manual check |
|---|---|---|
| `GPT_NOT_AVAILABLE` | GPT is unavailable when targeting should be set | Inspect `window.googletag` and Console errors |
| `GPT_SLOT_NOT_DEFINED` | No GPT slot exists for the ad unit | Inspect `googletag.pubads().getSlots()` |
| `GPT_SLOT_NOT_MATCHED` | Prebid ad-unit code matches no GPT slot | Compare code with slot element ID and full ad-unit path |
| `GPT_SLOT_MATCH_AMBIGUOUS` | More than one slot matches the same code | Enumerate every candidate and require explicit selection |
| `GPT_CUSTOM_MATCH_FAILED` | `customGptSlotMatching` returns no or incorrect match | Inspect the configured matching function and candidate slots |
| `SET_TARGETING_NOT_CALLED` | Publisher never calls the targeting API | Look for the `setTargeting` event |
| `SET_TARGETING_TOO_EARLY` | Targeting runs before bid results are ready | Compare `setTargeting`, `bidResponse`, and `auctionEnd` |
| `GPT_TARGETING_MISSING` | Prebid generated targeting but the slot lacks it | Diff Prebid targeting against the slot targeting map |
| `GPT_TARGETING_DIFFERENT` | GPT slot contains different targeting values | Compare every relevant `hb_*` value |
| `GPT_REQUEST_BEFORE_TARGETING` | GAM request occurs before targeting is applied | Compare `slotRequested` with `setTargeting` |
| `GPT_TARGETING_OVERWRITTEN` | Publisher code replaces Prebid targeting | Snapshot slot targeting after set and immediately before request |
| `GPT_TARGETING_CLEARED` | Targeting is cleared before display or refresh | Observe clearing calls and the request-time snapshot |
| `GPT_STALE_TARGETING` | Refresh reuses targeting from an earlier auction | Compare request-time `hb_adid` with the current auction |
| `GPT_WRONG_SLOT_REFRESHED` | Publisher refreshes a slot unrelated to the auction | Compare refreshed slot IDs with requested ad-unit codes |
| `GPT_SLOT_NOT_REQUESTED` | Matching slot is never displayed or refreshed | Observe `display()`, `refresh()`, and `slotRequested` |
| `GPT_SIZE_MISMATCH` | GPT slot sizes differ from Prebid bid size | Compare GPT sizes, `hb_size`, and bid dimensions |

## 11. Prebid creative rendering

| Diagnostic code | Issue | Primary evidence/manual check |
|---|---|---|
| `AD_RENDER_NO_AD` | Creative is unavailable | `adRenderFailed` with `noAd` |
| `AD_RENDER_CANNOT_FIND_AD` | Prebid cannot resolve the ad ID | `adRenderFailed` with `cannotFindAd` |
| `AD_RENDER_MISSING_INPUT` | Document or ad ID is missing | `adRenderFailed` with `missingDocOrAdid` |
| `AD_RENDER_EXCEPTION` | Rendering throws an exception | `adRenderFailed` with `exception` and sanitized error data |
| `AD_RENDER_UNSAFE_DOCUMENT_WRITE` | Unsafe write to the main document is prevented | `preventWritingOnMainDocument` |
| `AD_RENDER_STALE` | Bid is stale at render time | `staleRender` |
| `AD_RENDER_EXPIRED` | Bid expired before render | `expiredRender` |
| `AD_RENDER_BROWSER_INTERVENTION` | Browser blocked or intervened in rendering | `browserIntervention` |
| `AD_RENDERER_FAILED` | Custom renderer fails | Renderer logs and `adRenderFailed` |
| `VIDEO_CACHE_FAILED` | Video cache entry is missing or expired | Cache request and render failure evidence |
| `AD_RENDER_SUCCEEDED` | Prebid reports successful creative rendering | `adRenderSucceeded` |
| `PREBID_BID_WON` | Prebid bid was actually rendered | `bidWon` and `pbjs.getAllWinningBids()` |

## Conditions that are not necessarily failures

The diagnostic engine must not automatically report these conditions as fatal errors:

- One bidder returned `noBid`, but another bidder produced an eligible bid.
- A bidder timed out, but the auction still produced a usable result.
- An accepted bid was not the highest eligible bid.
- A Prebid bid lost the GAM decision to another eligible line item.
- `impressionViewable` has not fired for a slot outside the viewport.
- The auction hit its timeout after enough usable bids had already returned.
- A bid was intentionally excluded by floors or publisher configuration.
- A non-empty GAM render occurred without a Prebid `bidWon` event. This proves that GAM rendered a creative, not that Prebid won.
- A slot is still progressing through its lifecycle and the diagnostic settlement window has not elapsed.

## Ownership classification

Every diagnosis should name the most likely ownership boundary.

| Owner | Example issues |
|---|---|
| Prebid initialization | Script missing, queue not processed, module missing |
| Publisher Prebid configuration | Invalid ad unit, bidder parameters, auction timeout |
| Bid adapter | Request construction or response interpretation |
| Bidder endpoint | HTTP error, malformed response, no-bid |
| Prebid module | Consent, floors, currency, user ID, or RTD behavior |
| Publisher GPT integration | Slot mismatch, call ordering, targeting overwritten |
| GAM | Empty response or line-item eligibility after correct targeting reached the request |
| Creative or renderer | Render exception, browser intervention, expired video cache |

## Recommended issue record

The automated debugger should produce a stable, serializable record for every finding:

```js
{
  code: 'GPT_SLOT_NOT_MATCHED',
  severity: 'error',
  owner: 'publisher-gpt-integration',
  stage: 'gpt-slot-matching',
  auctionId: 'auction-id',
  adUnitCode: 'div-banner',
  bidderCode: null,
  slotElementId: null,
  summary: 'No GPT slot matches this Prebid ad unit.',
  evidence: [
    'Auction completed with one eligible targeting candidate.',
    'No slot element ID or full ad-unit path equals div-banner.'
  ],
  checks: [
    'Compare adUnit.code with GPT slot element IDs and full ad-unit paths.',
    'Inspect customGptSlotMatching when the identifiers intentionally differ.'
  ],
  confidence: 'high'
}
```

Use deterministic rules to establish the finding. An AI model may summarize the evidence and recommend the next check, but it should not replace the rule engine or claim a cause that the captured evidence cannot prove.

## Recommended first implementation set

Start with high-confidence rules that can be established from public Prebid and GPT evidence:

1. `PBJS_NOT_LOADED`
2. `PBJS_MODULE_MISSING`
3. `AD_UNIT_NOT_CONFIGURED`
4. `AD_UNIT_NOT_REQUESTED`
5. `AD_UNIT_NO_BIDDERS`
6. `BIDDER_NOT_INSTALLED`
7. `BIDDER_PARAMS_INVALID`
8. `CMP_TIMEOUT`
9. `REQUEST_BIDS_NOT_CALLED`
10. `AUCTION_HAS_NO_BIDDER_REQUESTS`
11. `AUCTION_NOT_COMPLETED`
12. `BID_REQUEST_NOT_SENT`
13. `BID_REQUEST_HTTP_4XX`
14. `BID_REQUEST_HTTP_5XX`
15. `BIDDER_NO_BID`
16. `BIDDER_TIMEOUT`
17. `BIDDER_ERROR`
18. `BID_REJECTED_VALIDATION`
19. `BID_REJECTED_BELOW_FLOOR`
20. `BID_EXPIRED_BEFORE_TARGETING`
21. `TARGETING_NOT_GENERATED`
22. `TARGETING_STANDARD_KEY_MISSING`
23. `GPT_SLOT_NOT_DEFINED`
24. `GPT_SLOT_NOT_MATCHED`
25. `GPT_SLOT_MATCH_AMBIGUOUS`
26. `SET_TARGETING_NOT_CALLED`
27. `GPT_TARGETING_MISSING`
28. `GPT_REQUEST_BEFORE_TARGETING`
29. `GPT_STALE_TARGETING`
30. `AD_RENDER_EXCEPTION`
31. `AD_RENDER_STALE`
32. `AD_RENDER_EXPIRED`

Less certain conditions should be presented as possible causes with medium or low confidence and supporting evidence, rather than as confirmed errors.
