# Ad Serving Failure Catalog

This document is the diagnostic rule catalog for BidShitter. It describes failures and suspicious conditions that can occur in:

- Prebid-only rendering
- GPT/GAM-only serving
- Prebid + GPT/GAM serving
- The surrounding browser, network, privacy, and observation layers

Each rule explains the observable symptom, likely cause, what to inspect, and the appropriate corrective action. The extension is **observe-only**: the actions below are recommendations for the publisher or integration owner; BidShitter must never reconfigure Prebid, GPT, bidders, or GAM.

Primary references:

- `[../01_practice/pbjs-master-reference.md](../01_practice/pbjs-master-reference.md)`
- `[../01_practice/gpt-events-master-reference.md](../01_practice/gpt-events-master-reference.md)`



## Diagnostic principles



### Absence of an event is not automatically a failure

Report a missing event as a failure only when all of the following are true:

1. BidShitter was attached before the relevant lifecycle began.
2. The event is expected for the observed media type and render path.
3. The wait threshold has elapsed.
4. No page navigation, slot destruction, or new lifecycle superseded the operation.

Examples of legitimate absences:

- `slotOnload` may not fire for synchronous or rich-media rendering without an iframe.
- `impressionViewable` does not fire until Active View criteria are met; a below-the-fold ad may never qualify.
- `bidWon` is not expected when GAM selects non-Prebid demand.
- `adRenderSucceeded` and `adRenderFailed` are Prebid rendering events and are not the authoritative GPT render signals.
- Module-specific events exist only when their modules are included in the Prebid build.



### Correlate before diagnosing

Never compare events solely by arrival time. Correlate them using as many of these identifiers as are available:

- Prebid `auctionId`
- Prebid `bidderRequestId`
- bid `requestId`
- bid `adId`
- Prebid `adUnitCode`
- GPT `slot.getSlotElementId()`
- GPT `slot.getAdUnitPath()`
- GAM `responseIdentifier`
- BidShitter page-session and request-cycle IDs

For a normal integration, Prebid `adUnit.code` usually matches GPT `slot.getSlotElementId()`. A configured custom GPT slot registry or matching function is a valid exception.

### Severity meanings

- **Critical:** the request or creative cannot complete, or the wrong ad may render.
- **High:** demand or targeting is lost, duplicate requests occur, or privacy behavior is wrong.
- **Medium:** degraded revenue, latency, viewability, or incomplete debugging evidence.
- **Low:** suspicious or deprecated behavior that should be reviewed but may be intentional.
- **Info:** a state that is often mistaken for a failure but can be valid.



## Expected lifecycle invariants



### Prebid-only

```text
requestBids
  -> beforeRequestBids
  -> auctionInit
  -> bidRequested
  -> beforeBidderHttp (client-side HTTP only)
  -> bidResponse | noBid | bidRejected | bidTimeout | bidderError
  -> bidderDone
  -> auctionEnd
  -> renderAd(adId)
  -> bidWon
  -> adRenderSucceeded | adRenderFailed
```

The exact response events vary by bidder and module. A timeout can add `auctionTimeout` and `bidTimeout` before `auctionEnd`.

### GPT/GAM-only

```text
GPT ready
  -> slot defined and attached to PubAdsService
  -> enableServices
  -> display
  -> slotRequested
  -> slotResponseReceived
  -> slotRenderEnded
  -> slotOnload (when an iframe load applies)
  -> impressionViewable (only after viewability criteria are met)
```

With `disableInitialLoad`, `display()` registers the slot and `refresh()` initiates the first request.

### Prebid + GPT/GAM

```text
disableInitialLoad
  -> display (register slot without fetching)
  -> requestBids
  -> auctionEnd or controlled failsafe
  -> setTargetingForGPTAsync
  -> setTargeting
  -> refresh
  -> slotRequested
  -> slotResponseReceived
  -> slotRenderEnded
  -> slotOnload / impressionViewable when applicable
```

GPT snapshots targeting and configuration when `display()` or `refresh()` starts a request. Changes made after that snapshot apply only to a later request.

---



## Observation and correlation issues



### OBS-01 — BidShitter attached after the lifecycle started

- **Severity:** Medium
- **Signal:** The first observed event is in the middle of an auction or GPT request; prerequisite events are absent.
- **Why it happens:** DevTools or the extension was opened after the page had already requested an ad.
- **Check:** Compare the extension session start with `performance.timeOrigin`, Prebid event history, navigation timing, and the first captured network request.
- **Do:** Mark earlier stages as **not observed**, not failed. Reload the page with BidShitter recording from `document_start` for a complete diagnosis.



### OBS-02 — Events from different auctions are combined

- **Severity:** High
- **Signal:** Bid responses, targeting, or timeouts have different `auctionId` values but appear in one lifecycle.
- **Why it happens:** Multiple auctions overlap, or the debugger groups only by slot ID.
- **Check:** Compare `auctionId`, request timestamps, `requestId`, and refresh invocation time.
- **Do:** Partition Prebid state by `auctionId`; associate each GPT request with the most recent targeting/refresh cycle for that slot.



### OBS-03 — Events from different slots are combined

- **Severity:** High
- **Signal:** Bid `adUnitCode`, GPT element ID, or GAM ad unit path changes within one displayed lifecycle.
- **Why it happens:** GPT event listeners are service-level and were not filtered by `event.slot`, or an all-slot auction/refresh was treated as a single-slot operation.
- **Check:** Compare `adUnitCode`, `getSlotElementId()`, `getAdUnitPath()`, and object identity of `event.slot`.
- **Do:** Filter and correlate per slot. Show cross-slot activity separately.



### OBS-04 — A missing optional event is reported as an error

- **Severity:** Info
- **Signal:** The only complaint is missing `slotOnload`, `impressionViewable`, `bidWon`, or a module-specific Prebid event.
- **Why it happens:** The detector assumes every event fires on every render path.
- **Check:** Identify media type, render mode, winning demand source, slot visibility, and `pbjs.installedModules`.
- **Do:** Classify the event as not applicable or pending unless its documented preconditions are satisfied.



### OBS-05 — Duplicate listeners produce duplicate records

- **Severity:** Medium
- **Signal:** Identical events with effectively identical timestamps and payload identifiers appear multiple times.
- **Why it happens:** The extension or publisher registered listeners more than once after panel reopen, SPA navigation, or refresh.
- **Check:** Count listener-registration cycles and compare payload object IDs/sequence values.
- **Do:** Make collector registration idempotent and retain the exact handler reference for removal.



### OBS-06 — Listener removed with a different function reference

- **Severity:** Low
- **Signal:** GPT or Prebid events continue after code claims to have unsubscribed.
- **Why it happens:** `removeEventListener`/`offEvent` receives a new function rather than the function originally registered.
- **Check:** Inspect registration and removal call sites.
- **Do:** Store and reuse the original callback reference.



### OBS-07 — Page spoofing or malformed diagnostic messages

- **Severity:** High
- **Signal:** Extension messages contain unknown event names, invalid types, oversized payloads, or impossible identifiers.
- **Why it happens:** Main-world messages are visible to and can be imitated by the inspected page.
- **Check:** Validate schema, source marker, size limit, allowed event names, and sequence monotonicity.
- **Do:** Treat all page-originated data as untrusted; sanitize in both the bridge and panel and label unverifiable data.



### OBS-08 — Refresh or transaction identifiers overlap across cycles

- **Severity:** High
- **Signal:** Events with different auctions or refreshes share a transaction/cycle identifier, or one refresh is associated with bids from another lifecycle.
- **Why it happens:** Publisher-generated transaction IDs are reused, refresh correlation relies on slot ID alone, or concurrent cycles overwrite shared state.
- **Check:** Compare `auctionId`, transaction ID, `adUnitCode`, bid `requestId`, refresh time, and BidShitter cycle ID.
- **Do:** Generate unique identifiers per logical lifecycle and correlate using auction, slot, request, and time boundaries rather than one publisher field alone.

---



## Prebid-only issues



### PB-01 — Prebid never becomes ready

- **Severity:** Critical
- **Signal:** `window.pbjs` is absent or queued callbacks never execute; there are no Prebid lifecycle events.
- **Why it happens:** The script failed to load, was blocked, loaded from a bad URL, threw during initialization, or was delayed indefinitely.
- **Check:** Inspect the Prebid script request, console errors, `pbjs.libLoaded`, `pbjs.version`, and the `pbjs.que` length.
- **Do:** Fix the script URL/load error or blocking policy. Do not call public APIs until the Prebid queue runs.



### PB-02 — `requestBids` called before ad units exist

- **Severity:** Critical
- **Signal:** `requestBids`/`auctionInit` occurs with no applicable `adUnits` or `adUnitCodes`; no `bidRequested` follows.
- **Why it happens:** `pbjs.addAdUnits()` ran later, the request used the wrong local variable, or initialization order changed.
- **Check:** Inspect `pbjs.adUnits`, `RequestBidsOptions.adUnits`, and `adUnitCodes` at request time.
- **Do:** Add and validate ad units before starting the auction.



### PB-03 — Requested ad unit code does not exist

- **Severity:** Critical
- **Signal:** `requestBids.adUnitCodes` contains a code absent from the current ad-unit definitions.
- **Why it happens:** Typo, renamed DOM slot, stale configuration, or case mismatch.
- **Check:** Compare exact strings, including case and punctuation.
- **Do:** Use one canonical ad-unit identifier throughout the page.



### PB-04 — Ad unit has no usable bidders

- **Severity:** High
- **Signal:** Auction starts but no `bidRequested` is emitted for the slot.
- **Why it happens:** Empty `bids`, adapter absent from the build, labels filtered the bids, invalid bidder name, or conditional configuration removed them.
- **Check:** Inspect the final ad unit after `beforeRequestBids`, installed modules/adapters, labels, and bidder codes.
- **Do:** Correct the publisher configuration or build. BidShitter should report the absence without adding bidders.



### PB-05 — Invalid or unsupported media-type configuration

- **Severity:** High
- **Signal:** Bid is never requested or is rejected; the requested media type differs from bidder support.
- **Why it happens:** Missing `mediaTypes`, malformed sizes, unsupported banner/video/native/audio format, or legacy `sizes` usage.
- **Check:** Compare the final ad-unit media types with bidder-supported media types and emitted rejection/debug details.
- **Do:** Correct the ad-unit media-type declaration and use current public configuration fields.



### PB-06 — Bid request created but bidder HTTP request never starts

- **Severity:** High
- **Signal:** `bidRequested` occurs but no corresponding `beforeBidderHttp`, PBS request, response, no-bid, or error is observed.
- **Why it happens:** Adapter validation rejected the request, consent enforcement blocked the bidder, an adapter threw before transport, or the path is server-side rather than client-side.
- **Check:** Inspect `auctionDebug`, `tcf2Enforcement`, bidder errors, `beforePBSHttp`, and whether the bidder is client or S2S.
- **Do:** Fix the invalid configuration/adapter error or consent setup. Do not require `beforeBidderHttp` for S2S paths.



### PB-07 — Bidder network request fails

- **Severity:** High
- **Signal:** `beforeBidderHttp` occurs, followed by `bidderError`, a failed network entry, or no response until timeout.
- **Why it happens:** DNS/TLS failure, offline state, ad blocker, CSP, CORS, proxy, non-success HTTP status, or connection timeout.
- **Check:** Inspect request URL, status/error text, initiator, blocked reason, duration, and console.
- **Do:** Address the specific network/policy failure or bidder endpoint issue. See the network rules below.



### PB-08 — Bidder returns no bid

- **Severity:** Info
- **Signal:** `noBid` fires for a requested bidder.
- **Why it happens:** The bidder intentionally declined, had no eligible demand, or returned no usable seat/bid.
- **Check:** Confirm `noBid` versus transport failure, timeout, or rejection.
- **Do:** Treat as a valid commercial outcome unless the bidder was expected to return demand; investigate bidder-side logs if unexpected.



### PB-09 — Bidder times out

- **Severity:** Medium
- **Signal:** `auctionTimeout` and/or `bidTimeout` includes the bidder; response arrives after the deadline or never arrives.
- **Why it happens:** Slow bidder/network, timeout too short, main-thread congestion, or consent/identity work consumed the auction budget.
- **Check:** Compare request start, `timeToRespond`, configured timeout, auction duration, and late network completion.
- **Do:** Investigate latency and timeout allocation. Do not automatically increase timeout without considering page latency and revenue trade-offs.



### PB-10 — Auction timeout is excessively long

- **Severity:** Medium
- **Signal:** Ad serving waits a long time for one or more bidders, materially delaying render.
- **Why it happens:** Oversized `bidderTimeout`, slow dependencies before bidder calls, or a bidder never completes.
- **Check:** Compare configured timeout, bidder latency distribution, auction critical path, and GPT request delay.
- **Do:** Tune the timeout based on measured bidder value and latency; fix stuck bidder paths.



### PB-11 — Auction timeout is too short

- **Severity:** Medium
- **Signal:** Many bidders consistently time out just before valid responses arrive.
- **Why it happens:** Timeout does not reflect network conditions, consent/ID overhead, or server-side latency.
- **Check:** Compare late-response timing with the deadline across repeated auctions.
- **Do:** Reduce upstream delay or adjust the timeout based on evidence.



### PB-12 — Bid has missing or invalid properties

- **Severity:** High
- **Signal:** `bidRejected` reports `Bid has missing or invalid properties`.
- **Why it happens:** Adapter response lacks required price, creative, currency, size, media type, or other required fields.
- **Check:** Inspect the sanitized rejected bid and adapter response mapping.
- **Do:** Correct the bidder adapter or response contract.



### PB-13 — Bid response has an invalid request ID

- **Severity:** High
- **Signal:** `bidRejected` reports `Invalid request ID`.
- **Why it happens:** Response cannot be matched to an outbound bid, IDs were mutated, or a stale/duplicate response arrived.
- **Check:** Compare bid `requestId` with all bid IDs in the same `auctionId` and bidder request.
- **Do:** Correct adapter ID propagation and prevent stale response reuse.



### PB-14 — Alternate or unknown bidder code is rejected

- **Severity:** High
- **Signal:** `bidRejected` says the bidder code is not allowed.
- **Why it happens:** Response bidder code differs from the requested bidder and is not permitted by alternate-bidder configuration.
- **Check:** Compare requested bidder, response bidder/bidderCode, aliases, and allow-list configuration.
- **Do:** Correct the response code or explicitly configure a legitimate alias/alternate bidder.



### PB-15 — Bid is below the price floor

- **Severity:** Info
- **Signal:** `bidRejected` reports `Bid does not meet price floor`.
- **Why it happens:** Bid CPM is lower than the effective floor after currency and floor resolution.
- **Check:** Inspect bid CPM/currency, floor value/currency, media type, size, and floor source.
- **Do:** Verify floor configuration and currency; otherwise treat the rejection as expected.



### PB-16 — Bid currency cannot be converted

- **Severity:** High
- **Signal:** `bidRejected` reports `Unable to convert currency`.
- **Why it happens:** Missing currency module/rate, unsupported currency, stale rate data, or malformed currency code.
- **Check:** Compare `currency`, configured ad-server currency, installed currency module, and rate-provider network activity.
- **Do:** Provide a supported conversion path or correct the bidder currency.



### PB-17 — Bid exceeds the maximum accepted value

- **Severity:** Medium
- **Signal:** `bidRejected` reports `Bid price exceeds maximum value`.
- **Why it happens:** Bid CPM exceeds Prebid `maxBid`, often due to bad units, malformed response, or intentionally defensive configuration.
- **Check:** Inspect `cpm`, `originalCpm`, currency, and `maxBid`.
- **Do:** Correct the bidder response if unrealistic; change `maxBid` only when the high price is legitimate.



### PB-18 — Bid fails DSA requirements

- **Severity:** High
- **Signal:** `bidRejected` reports missing DSA transparency or inappropriate DSA rendering method.
- **Why it happens:** Required DSA data is absent or conflicts with publisher rendering requirements.
- **Check:** Inspect the rejection reason and relevant bid `meta`/DSA fields.
- **Do:** Correct bidder DSA support or publisher DSA configuration.



### PB-19 — Unexpected CPM adjustment changes auction ranking

- **Severity:** Medium
- **Signal:** `bidAdjustment` fires and `cpm` differs materially from `originalCpm`; the apparent raw-price winner loses.
- **Why it happens:** `bidderSettings`, currency conversion, or a bid adjustment hook changes the comparable CPM.
- **Check:** Compare `originalCpm`, adjusted `cpm`, currency, adjustment source, and final price bucket.
- **Do:** Validate adjustment rules and explain the adjusted value in diagnostics; rank by the effective CPM used by Prebid.



### PB-20 — Auction ends with no eligible bid

- **Severity:** Medium
- **Signal:** `auctionEnd` occurs with no usable bid for the slot.
- **Why it happens:** Every bidder returned no-bid, timed out, errored, or was rejected.
- **Check:** Account for every `bidRequested` using response/no-bid/rejection/timeout/error state.
- **Do:** Surface the per-bidder cause; do not reduce all outcomes to “no bids.”



### PB-21 — Render attempted before auction completion

- **Severity:** High
- **Signal:** `renderAd()` is invoked before `auctionEnd`/bids-back completion.
- **Why it happens:** Publisher selects a provisional bid while other bidders are still active.
- **Check:** Compare render invocation time, bid `auctionId`, and auction end time.
- **Do:** Render from the auction completion callback or another explicitly finalized decision point.



### PB-22 — Render called with a missing or unknown `adId`

- **Severity:** Critical
- **Signal:** `adRenderFailed` reason is `missingDocOrAdid` or `cannotFindAd`.
- **Why it happens:** Missing argument, wrong auction’s ID, expired/cleared auction state, typo, or creative lookup after cache cleanup.
- **Check:** Match the render `adId` to a bid in the same slot and auction; inspect whether `clearAllAuctions()` ran.
- **Do:** Pass the selected bid’s current `adId` and retain the auction state until rendering completes.



### PB-23 — Render attempted on the main page document

- **Severity:** Critical
- **Signal:** `adRenderFailed` reason is `preventWritingOnMainDocument`.
- **Why it happens:** Publisher passed `window.document` instead of an iframe document.
- **Check:** Inspect the first `renderAd` argument and iframe creation timing.
- **Do:** Render into the intended iframe document or use the supported renderer for the media type.



### PB-24 — Winning bid has no renderable creative

- **Severity:** Critical
- **Signal:** `adRenderFailed` reason is `noAd`, or selected bid lacks required markup/cache/renderer information.
- **Why it happens:** Adapter returned incomplete creative data, video cache failed, or the wrong render path was selected.
- **Check:** Inspect media type, `ad`, VAST/cache fields, renderer metadata, and prior validation events without exposing raw creative content.
- **Do:** Correct the adapter response or use the media-type-specific renderer.



### PB-25 — Creative render throws an exception

- **Severity:** Critical
- **Signal:** `adRenderFailed` reason is `exception`.
- **Why it happens:** Malformed creative, inaccessible document, browser security restriction, or renderer bug.
- **Check:** Inspect the sanitized exception, console, CSP violations, iframe state, and media type.
- **Do:** Correct the creative/renderer or security configuration; never blindly retry the same failing markup.



### PB-26 — Bid is rendered more than once

- **Severity:** High
- **Signal:** `staleRender` fires for a previously rendered bid.
- **Why it happens:** Refresh reused an old `adId`, bid caching was mishandled, or duplicate render callbacks executed.
- **Check:** Compare bid status, previous `bidWon`/render events, request cycle, and refresh guards.
- **Do:** Select an unused bid for each render and make render callbacks idempotent.



### PB-27 — Bid is rendered after TTL expiry

- **Severity:** High
- **Signal:** `expiredRender` fires or render time exceeds `responseTimestamp + buffered TTL`.
- **Why it happens:** Long delay before render, stale bid cache, background tab delay, or incorrect TTL handling.
- **Check:** Inspect response time, `ttl`, `ttlBuffer`, render time, and auction cycle.
- **Do:** Run a new auction or choose a non-expired bid.



### PB-28 — Browser blocks the creative

- **Severity:** High
- **Signal:** `browserIntervention`, CSP report, blocked frame/script, or ad-blocker evidence occurs.
- **Why it happens:** Browser intervention, extension blocking, sandbox/SafeFrame restrictions, mixed content, or CSP.
- **Check:** Inspect intervention details, console security messages, blocked network requests, and iframe attributes.
- **Do:** Correct the blocked resource/security incompatibility or test without the interfering extension to isolate the cause.



### PB-29 — Deferred billing never triggers

- **Severity:** High
- **Signal:** Ad unit uses `deferBilling`, render succeeds, but no expected billable action/event follows.
- **Why it happens:** Publisher never called `triggerBilling()` at the agreed billable moment.
- **Check:** Inspect ad-unit `deferBilling`, render status, `billableEvent`, and trigger call.
- **Do:** Invoke billing according to the module/partner contract; avoid duplicate billing triggers.



### PB-30 — Consent enforcement blocks demand or data

- **Severity:** High
- **Signal:** `tcf2Enforcement` reports blocked bidders, storage, analytics, UFPD, EIDs, or geo data.
- **Why it happens:** Consent is unavailable, insufficient, late, or the enforcement configuration disallows the operation.
- **Check:** Inspect consent timing, `getConsentMetadata()`, enforcement payload, CMP status, and affected bidders/modules.
- **Do:** Fix CMP/consent integration or accept the restricted auction. Never bypass consent in the debugger.



### PB-31 — Prebid Server request does not complete

- **Severity:** High
- **Signal:** `beforePBSHttp` occurs but no corresponding usable PBS response/analytics or bids arrive before timeout.
- **Why it happens:** PBS endpoint/network failure, malformed OpenRTB request, authentication/account error, or server latency.
- **Check:** Inspect endpoint, HTTP status, duration, sanitized request metadata, response errors, and `seatnonbid` data.
- **Do:** Correct endpoint/account/request configuration or investigate PBS availability.



### PB-32 — Latest-auction APIs are mistaken for historical data

- **Severity:** Medium
- **Signal:** `getBidResponses()` or no-bid APIs appear to “lose” prior auction data after refresh.
- **Why it happens:** These APIs are scoped to the latest auction, while the UI expects page-lifetime history.
- **Check:** Compare API call time and current/latest `auctionId` with captured event history.
- **Do:** Preserve normalized events per auction in BidShitter rather than repeatedly reconstructing history from latest-auction APIs.



### PB-33 — Page uses a custom Prebid global

- **Severity:** High
- **Signal:** `window.pbjs` is missing or inactive, but another registered Prebid global owns auctions and events.
- **Why it happens:** The build was configured with a custom global name, often visible through `window._pbjsGlobals`.
- **Check:** Inspect `window._pbjsGlobals`, candidate globals, versions, installed modules, queues, and event histories.
- **Do:** Configure the observer to follow the active registered global; do not report Prebid as absent solely because `window.pbjs` is missing.



### PB-34 — Unexpected or obsolete Prebid build is deployed

- **Severity:** High
- **Signal:** Expected public APIs, events, bidder adapters, or modules are absent or behave differently from the intended release.
- **Why it happens:** Old bundle cached/deployed, wrong custom build selected, or deployment points to another artifact.
- **Check:** Inspect `pbjs.version`, `pbjs.installedModules`, script URL/content, release expectations, and cache source.
- **Do:** Deploy the intended compatible build and invalidate incorrect cached artifacts.



### PB-35 — Page prerendering delays the auction

- **Severity:** Info
- **Signal:** Prebid loads but its queue/auction waits until page activation; no bidder transport begins during prerender.
- **Why it happens:** Prebid delays prerender activity unless configured to allow it.
- **Check:** Inspect `document.prerendering`, `pbjs.delayPrerendering`, `allowPrerendering`, and the activation timestamp.
- **Do:** Mark the delay as intentional unless publisher requirements explicitly call for prerender auctions; evaluate privacy and performance implications before changing behavior.



### PB-36 — Configured ad unit is excluded from `requestBids`

- **Severity:** High
- **Signal:** The slot exists in `pbjs.adUnits`, but the `requestBids`/`auctionInit` selection omits it while other slots auction.
- **Why it happens:** `adUnitCodes` filters it out, per-call ad units replace the global set, labels exclude it, or stale component state supplies the wrong list.
- **Check:** Compare configured ad units with `RequestBidsOptions.adUnitCodes`, per-call `adUnits`, labels, and `auctionInit.adUnitCodes`.
- **Do:** Include the intended ad unit in the auction selection or correct the intentional filtering logic.



### PB-37 — Multiple ad-unit definitions use the same code

- **Severity:** High
- **Signal:** More than one current ad-unit definition has the same `code`; bidder requests or results from separate definitions become ambiguous.
- **Why it happens:** Duplicate component registration, SPA remount, or configuration merge appends instead of replacing.
- **Check:** Group `pbjs.adUnits` and auction ad units by exact `code`; compare media types, bidders, and transaction IDs.
- **Do:** Keep one authoritative live definition per ad-unit code and remove stale definitions before re-registration.



### PB-38 — Bidder parameters are missing or invalid

- **Severity:** High
- **Signal:** Configured bidder is omitted, adapter validation fails, warning/debug output appears, or an invalid outbound request is built.
- **Why it happens:** Required bidder-specific parameter is missing, has the wrong type/value, or was placed in the wrong configuration level.
- **Check:** Inspect sanitized `adUnit.bids[].params`, adapter validation/debug output, and the final `bidRequested` entry.
- **Do:** Correct the publisher’s bidder parameters according to the adapter’s public contract.



### PB-39 — Video ad-unit configuration is invalid

- **Severity:** High
- **Signal:** Video bidder is omitted, response is rejected, cache/renderer data is absent, or the video path cannot complete.
- **Why it happens:** Invalid/missing video context, sizes, protocols, placement, player fields, renderer, or required cache configuration.
- **Check:** Inspect `mediaTypes.video`, bidder request, rejection reason, cache activity, and renderer metadata.
- **Do:** Correct the video declaration and use the supported instream/outstream render path.



### PB-40 — Native ad-unit or asset configuration is invalid

- **Severity:** High
- **Signal:** Native bidder is omitted or native request/response validation fails.
- **Why it happens:** Required native assets are absent, malformed, duplicated, or incompatible with the bidder/render path.
- **Check:** Inspect the sanitized native request, requested asset IDs/types, response assets, and rejection details.
- **Do:** Correct the native asset declaration and response mapping.



### PB-41 — OpenRTB or first-party data configuration is malformed

- **Severity:** High
- **Signal:** Outbound `ortb2`/`ortb2Imp` differs from publisher intent, adapter rejects it, or request construction fails.
- **Why it happens:** Invalid OpenRTB shape/type, fields placed at the wrong scope, or unsafe merging overwrites required data.
- **Check:** Inspect `readConfig`/auction data, final bid request `ortb2` and `ortb2Imp`, debug errors, and adapter request.
- **Do:** Correct the OpenRTB structure and place global versus impression fields at their documented scopes.



### PB-42 — Configured CMP is unavailable

- **Severity:** High
- **Signal:** Auction waits, is canceled, or loses bidders while the configured CMP API cannot be found or queried.
- **Why it happens:** CMP script failed/loaded late, wrong consent API/framework configured, iframe locator is absent, or page context prevents access.
- **Check:** Inspect consent configuration, CMP globals/locator, script/network errors, Prebid debug output, and auction start delay.
- **Do:** Fix CMP loading/API integration or explicitly define the publisher’s desired no-CMP fallback behavior.



### PB-43 — CMP response exceeds its timeout

- **Severity:** High
- **Signal:** Auction begins late or is canceled after the consent timeout; bidders may be missing despite the CMP eventually responding.
- **Why it happens:** Slow CMP initialization, messaging failure, blocked script, or overly short consent timeout.
- **Check:** Compare CMP request/response, consent timeout, `auctionInit`, and bidder-request timestamps.
- **Do:** Fix CMP latency/messaging or tune the consent timeout based on evidence and compliance requirements.



### PB-44 — GPP data or configuration is invalid

- **Severity:** High
- **Signal:** Bidder requests contain absent/unexpected GPP fields, applicable bidders are blocked, or consent debug output reports GPP problems.
- **Why it happens:** Missing/invalid GPP string, incorrect applicable-section IDs, late CMP data, or wrong consent-management configuration.
- **Check:** Inspect consent metadata, `gppConsent` on bidder requests, applicable sections, timing, and enforcement output.
- **Do:** Correct the CMP/GPP integration; never synthesize or bypass privacy signals in the debugger.



### PB-45 — Activity controls block an auction operation

- **Severity:** High
- **Signal:** Storage, user sync, transmission, enrichment, or another activity is skipped even though the responsible module is present.
- **Why it happens:** Prebid activity-control rules deny the operation for the current component, purpose, or consent state.
- **Check:** Inspect debug/auctionDebug output, activity-control configuration, component identity, and consent context.
- **Do:** Verify that the restriction is intentional; correct publisher rules only when policy and consent permit the activity.



### PB-46 — User ID resolution delays bidder requests

- **Severity:** Medium
- **Signal:** Long gap before `bidRequested` aligns with user-ID module work or ID network/storage activity.
- **Why it happens:** ID submodule callback/network is slow, waits for consent, or uses an excessive module timeout.
- **Check:** Compare user-ID initialization/requests, consent readiness, module timeout, `auctionInit`, and bidder-request times.
- **Do:** Optimize or correctly time-box the ID module; assess whether the identity value justifies auction delay.



### PB-47 — RTD enrichment delays bidder requests

- **Severity:** Medium
- **Signal:** Long pre-bid gap aligns with real-time-data provider work; requests start only after enrichment settles/times out.
- **Why it happens:** RTD callback/network is slow, provider timeout is excessive, or multiple providers serialize work.
- **Check:** Inspect RTD configuration/logs/events, provider requests, timeout, and bidder-request start.
- **Do:** Optimize/time-box enrichment and prevent unnecessary serial waits.



### PB-48 — Publisher never calls `requestBids()`

- **Severity:** Critical
- **Signal:** Prebid is ready and ad units exist, but no `requestBids` or `auctionInit` event ever occurs.
- **Why it happens:** Integration branch did not execute, component did not mount, exception interrupted control flow, or another system requested GAM directly.
- **Check:** Inspect Prebid event history, requestBids instrumentation/call site, console, and page conditions.
- **Do:** Correct the publisher control flow so the intended auction is explicitly started.



### PB-49 — Auction continuation callback fails

- **Severity:** High
- **Signal:** `auctionEnd` occurs, but the publisher’s expected render, targeting, or next-step callback does not complete.
- **Why it happens:** Invalid `bidsBackHandler`, exception, stale closure, destroyed component, or promise/callback branch exits early.
- **Check:** Inspect callback invocation, console stack, component lifetime, auction ID, and subsequent events/calls.
- **Do:** Make the continuation error-safe, cycle-bound, and idempotent.



### PB-50 — Effective auction timeout differs from expected configuration

- **Severity:** Medium
- **Signal:** Runtime auction timeout does not equal the global `bidderTimeout` the publisher expects.
- **Why it happens:** `requestBids.timeout`, module/hook behavior, or another runtime configuration overrides the global value.
- **Check:** Treat `auctionInit.timeout`/request options as the effective value and trace the applicable override.
- **Do:** Remove unintended overrides or update expectations/documentation to the actual per-auction timeout.



### PB-51 — Auction never completes

- **Severity:** Critical
- **Signal:** `auctionInit` and bidder activity occur, but no `auctionEnd` appears after the auction deadline plus a bounded settlement allowance.
- **Why it happens:** Core/adapter exception, stuck completion accounting, page lifecycle interruption, or observer loss.
- **Check:** Inspect `bidderDone`, errors, timeouts, console, navigation, Prebid readiness, and event history.
- **Do:** Fix the exception/stuck adapter; mark unknown rather than confirmed if observation ended or began late.



### PB-52 — Auction terminates prematurely or is canceled

- **Severity:** High
- **Signal:** Auction ends/callback continues substantially before expected bidder completion without a normal result, timeout, or intentional fast-completion explanation.
- **Why it happens:** Consent/activity cancellation, thrown exception, component cleanup, explicit cancellation behavior, or broken bidder accounting.
- **Check:** Inspect consent/activity events, console, bidder states, page lifecycle, and auction status/metrics.
- **Do:** Correct the cancellation source or label an intentional cancellation explicitly.



### PB-53 — Bidder response is malformed or cannot be parsed

- **Severity:** High
- **Signal:** HTTP response arrives, but adapter emits an error, console parse exception, no bid, or validation rejection.
- **Why it happens:** Invalid JSON/schema, unexpected content type/body, backend contract change, or adapter parsing bug.
- **Check:** Inspect sanitized response metadata/body shape, content type, adapter error, and rejection reason.
- **Do:** Correct the bidder endpoint response or adapter parser; avoid retaining sensitive/raw creative data in BidShitter.



### PB-54 — Duplicate bidder request is sent

- **Severity:** High
- **Signal:** Same logical bidder/ad-unit request appears more than once with duplicate/reused request IDs or near-identical payloads in one auction.
- **Why it happens:** Duplicate ad units, duplicate adapter invocation, overlapping auctions, duplicate library load, or retry without identity change.
- **Check:** Group network and `bidRequested` data by auction, bidder request ID, bid ID, bidder, ad unit, and payload fingerprint.
- **Do:** Remove duplicate registration/invocation and ensure legitimate retries have explicit independent identity.



### PB-55 — Expected S2S bidder is absent from the server request

- **Severity:** High
- **Signal:** Bidder expected through Prebid Server has no S2S request/seat and may appear only client-side or nowhere.
- **Why it happens:** Missing/incorrect `s2sConfig`, bidder not included, account configuration mismatch, testing flag, or bidder routed to the wrong source.
- **Check:** Inspect `s2sConfig`, bidder source, `beforePBSHttp`, sanitized OpenRTB seats/impressions, and client bidder requests.
- **Do:** Correct the publisher/PBS routing configuration.



### PB-56 — Bidder never reaches `bidderDone`

- **Severity:** Medium
- **Signal:** Bidder has request/response/error activity but no corresponding `bidderDone` after the auction settles.
- **Why it happens:** Adapter callback/accounting bug, exception, unresolved multi-request path, or missing observation.
- **Check:** Reconstruct the full bidder sequence using `bidderRequestId`, network completions, errors, timeouts, and observer start.
- **Do:** Escalate reproducible incomplete adapter lifecycle evidence; do not fail solely on a late observer.



### PB-57 — Prebid Server reports a seat non-bid

- **Severity:** Info
- **Signal:** `seatNonBids`/PBS analytics records a non-bid reason for a server-side seat.
- **Why it happens:** Server bidder intentionally declines or PBS records a protocol-level non-bid status.
- **Check:** Inspect seat, status/reason, request impression, and whether other seats returned bids.
- **Do:** Present the PBS reason as the bidder outcome; do not classify it as transport failure without network evidence.



### PB-58 — Only some requested impressions receive bidder outcomes

- **Severity:** Medium
- **Signal:** A multi-impression/multi-bid request returns bids or no-bids for only a subset; other request IDs remain unresolved.
- **Why it happens:** Partial bidder response, adapter mapping omission, timeout, malformed item, or PBS seat behavior.
- **Check:** Reconcile every outbound bid/request ID against bid response, no-bid, rejection, timeout, and error evidence.
- **Do:** Report per-impression outcomes and escalate unresolved request IDs rather than treating the whole bidder as one result.



### PB-59 — One request produces duplicate bid responses

- **Severity:** High
- **Signal:** Multiple `bidResponse` records share the same `requestId` and auction, especially with inconsistent values.
- **Why it happens:** Adapter invokes the response callback twice, duplicate backend rows are mapped incorrectly, or duplicate event observation occurs.
- **Check:** Compare event sequence IDs, object identity, network response, bidder request ID, and all bid fields.
- **Do:** Deduplicate observer artifacts; if genuinely emitted twice, correct the adapter mapping/callback behavior.



### PB-60 — Bidder alias or response identity is unexpected

- **Severity:** Medium
- **Signal:** `bidder`, `bidderCode`, `adapterCode`, or configured alias differs from the expected identity without a clear alias relationship.
- **Why it happens:** Legitimate aliasing, alternate bidder code, server-side seat mapping, or incorrect adapter response identity.
- **Check:** Compare requested bidder, alias registry, adapter code, source, and alternate-bidder configuration.
- **Do:** Explain valid aliases; correct or reject unapproved identity mismatches.



### PB-61 — Same demand source is requested client-side and server-side

- **Severity:** High
- **Signal:** Same bidder/inventory appears under `client` and `s2s` sources for the same slot/auction.
- **Why it happens:** Duplicated bidder routing, test configuration left active, or aliases hide equivalent demand.
- **Check:** Compare bidder/adapter/alias, `src`/`hb_source`, request IDs, endpoints, and `s2sConfig`.
- **Do:** Remove unintended duplicate routing or explicitly document intentional hybrid testing.



### PB-62 — Bid CPM is missing, invalid, or zero

- **Severity:** High
- **Signal:** Bid is rejected or excluded because `cpm` is absent, non-numeric, negative, non-finite, or zero when positive value is required.
- **Why it happens:** Malformed bidder response, unit/conversion bug, default value, or adapter mapping error.
- **Check:** Inspect rejection reason, sanitized raw/effective CPM, `originalCpm`, currency, and adapter response mapping.
- **Do:** Correct the bidder/adapter value; treat an intentional zero bid as ineligible rather than usable demand.



### PB-63 — Bid dimensions fail size validation

- **Severity:** High
- **Signal:** Bid is rejected/excluded because returned width/height is missing, malformed, or not allowed for the request.
- **Why it happens:** Wrong creative size, responsive mapping mismatch, adapter dimension bug, or multi-format confusion.
- **Check:** Compare bid width/height with request media sizes and the exact rejection details.
- **Do:** Return/configure an eligible size and align all size declarations.



### PB-64 — Bid media type does not match the request

- **Severity:** High
- **Signal:** Bid is rejected or rendered through the wrong path because response media type differs from the requested/accepted format.
- **Why it happens:** Adapter misclassification, multiformat mapping bug, missing media type, or bidder returns an unsupported format.
- **Check:** Compare ad-unit media types, individual bid request media type, response `mediaType`, creative fields, and rejection reason.
- **Do:** Correct adapter/bidder media-type mapping.



### PB-65 — Bid creative data fails validation

- **Severity:** High
- **Signal:** Bid is rejected before targeting because required banner markup, renderer, cache, VAST, native, or creative metadata is absent/invalid.
- **Why it happens:** Incomplete endpoint response or adapter fails to translate the format into Prebid’s bid contract.
- **Check:** Inspect media type, sanitized presence/type of creative fields, renderer/cache metadata, and rejection reason.
- **Do:** Correct the response/adapter contract without storing raw creative content in diagnostics.



### PB-66 — Native bid response fails asset validation

- **Severity:** High
- **Signal:** Native bid is rejected because required assets, IDs, event trackers, or values are missing/invalid.
- **Why it happens:** Response does not satisfy the native request or adapter maps assets incorrectly.
- **Check:** Reconcile requested native assets with sanitized response assets and rejection evidence.
- **Do:** Correct bidder/adapter native response construction.



### PB-67 — Video bid fails validation or caching

- **Severity:** High
- **Signal:** Video bid is rejected or excluded because VAST, duration/protocol/context, cache, or renderer requirements are not satisfied.
- **Why it happens:** Invalid video response, cache request failure, unsupported format, or missing renderer/cache key.
- **Check:** Inspect video request/response metadata, rejection reason, cache network/status, and renderer fields.
- **Do:** Correct the video response and required caching/render path.



### PB-68 — Bid TTL is missing or invalid

- **Severity:** High
- **Signal:** Bid is rejected, immediately expires, or cannot be considered because `ttl` is absent, non-positive, or malformed.
- **Why it happens:** Bidder/adapter contract error or invalid default.
- **Check:** Inspect `ttl`, response timestamp, buffer, rejection/debug details, and adapter mapping.
- **Do:** Return a valid TTL and ensure selection/rendering respects buffered expiry.



### PB-69 — Bid `netRevenue` value is invalid

- **Severity:** High
- **Signal:** Validation rejects the bid or revenue interpretation is ambiguous because `netRevenue` is missing/wrongly typed when required.
- **Why it happens:** Adapter returns an invalid field or fails to state gross-versus-net semantics.
- **Check:** Inspect sanitized `netRevenue`, validation output, and adapter mapping.
- **Do:** Correct the adapter response to provide the required boolean semantics.



### PB-70 — Deal prioritization changes the selected candidate

- **Severity:** Info
- **Signal:** A lower-CPM deal bid becomes the targeting candidate ahead of a higher open-market bid.
- **Why it happens:** `sendBidsControl.dealPrioritization` or another intentional deal-selection rule is active.
- **Check:** Compare deal IDs, effective CPMs, selection config, and targeting candidate.
- **Do:** Explain the configured prioritization; report a problem only if the behavior contradicts publisher configuration.



### PB-71 — Custom renderer fails

- **Severity:** Critical
- **Signal:** Bid is selected but its custom renderer throws, does not complete, or leaves the slot blank; generic Prebid render events may be incomplete.
- **Why it happens:** Renderer code/load failure, unsupported environment, missing renderer metadata, or renderer callback bug.
- **Check:** Inspect renderer URL/state, console, bid renderer metadata, DOM, and any render events.
- **Do:** Correct the custom renderer and provide explicit success/failure observability.



### PB-72 — Video cache entry is missing, failed, or expired

- **Severity:** Critical
- **Signal:** Video bid was accepted/targeted but the cache UUID/URL cannot be resolved at render time.
- **Why it happens:** Cache upload failed, cache response malformed, TTL expired, wrong cache host/ID, or stale targeting.
- **Check:** Inspect cache request/status, `hb_uuid`/`hb_cache_id`/host, bid TTL, and video player/creative errors.
- **Do:** Fix cache integration or run a new auction; never reuse an expired cache entry.



### PB-73 — Selected bid ranking is unexpected

- **Severity:** Medium
- **Signal:** `getHighestCpmBids()`/targeting candidate is not the bid an engineer expects after comparing visible CPMs.
- **Why it happens:** Adjustment, currency conversion, deal prioritization, floor/expiry/status, media-type desirability, or tie-breaking changes eligibility/rank.
- **Check:** Compare all bids’ adjusted CPM, currency, deals, status, expiry, source, media type, and selection configuration.
- **Do:** Explain the exact eligibility/ranking factor; report a defect only if the result contradicts effective configuration.



### PB-74 — Currency conversion changes bid ranking

- **Severity:** Info
- **Signal:** A bid with a higher original numeric CPM loses after conversion into the comparison/ad-server currency.
- **Why it happens:** Original CPMs in different currencies are not directly comparable.
- **Check:** Compare original CPM/currency, rate, converted/effective CPM, timestamp, and final rank.
- **Do:** Rank using converted effective values and verify the conversion rate when the result appears wrong.



### PB-75 — Banner sizes are missing

- **Severity:** High
- **Signal:** Banner ad unit has no usable `mediaTypes.banner.sizes`; bidder request is omitted/malformed or responses cannot be validated.
- **Why it happens:** Legacy/incorrect field placement, empty responsive configuration, or component failed to supply sizes.
- **Check:** Inspect the final ad unit at `beforeRequestBids`, banner sizes, labels, and bidder request.
- **Do:** Declare valid banner sizes in the supported media-type configuration.



### PB-76 — Prebid becomes ready only after ad-server serving begins

- **Severity:** High
- **Signal:** GPT `slotRequested` or another ad-server flow starts before Prebid initialization/queue processing.
- **Why it happens:** Prebid script loads late, async orchestration is missing, or publisher does not wait for the intended header-bidding path.
- **Check:** Compare Prebid script/ready time with GPT setup, display/refresh, and slot request.
- **Do:** Load and coordinate Prebid early enough for auctions intended to participate; otherwise label the request as GPT-only.



### PB-77 — Accepted bid expires before targeting is generated

- **Severity:** High
- **Signal:** A previously accepted bid is absent from the eligible/targeting set because targeting occurs after `responseTimestamp + buffered TTL`.
- **Why it happens:** Long handoff delay, unusually short/invalid TTL, background throttling, stale cache, or targeting is generated for an old auction.
- **Check:** Compare bid acceptance/response time, `ttl`, `ttlBuffer`, targeting time, status, and auction ID.
- **Do:** Generate targeting promptly for the current auction or run a fresh auction instead of sending an expired bid.



### PB-78 — CPM adjustment makes a bid ineligible

- **Severity:** Medium
- **Signal:** `bidAdjustment` changes a previously plausible bid so it fails a floor, becomes zero/invalid, or disappears from selection/targeting.
- **Why it happens:** Bidder adjustment rule is incorrect, overly aggressive, applied twice, or interacts unexpectedly with currency/floor logic.
- **Check:** Compare `originalCpm`, adjusted `cpm`, adjustment configuration/calls, floor, currency, rejection/eligibility, and targeting set.
- **Do:** Correct the adjustment rule and ensure it is applied once at the intended stage.

---



## GPT/GAM-only issues



### GPT-01 — GPT library fails to load

- **Severity:** Critical
- **Signal:** GPT script request fails; queued commands never execute; `googletag.apiReady` is absent.
- **Why it happens:** Network failure, blocked official script, CSP, ad blocker, or incorrect URL.
- **Check:** Inspect the GPT script request and console errors.
- **Do:** Load GPT from the supported source and correct the blocking/network condition.



### GPT-02 — GPT command queue is initialized incorrectly

- **Severity:** Critical
- **Signal:** `googletag.cmd.push` is unavailable or queued commands are overwritten.
- **Why it happens:** Page replaces `window.googletag`/`cmd` instead of preserving an existing queue.
- **Check:** Inspect assignments before GPT load and queue contents.
- **Do:** Initialize with `window.googletag = window.googletag || { cmd: [] }` and never replace a populated queue.



### GPT-03 — GPT APIs called before readiness or outside the command queue

- **Severity:** High
- **Signal:** Undefined-method exceptions, inconsistent setup, or calls occur before `apiReady`.
- **Why it happens:** Asynchronous GPT loading is ignored.
- **Check:** Inspect call stacks and whether setup ran in `googletag.cmd.push`.
- **Do:** Queue GPT API calls until the library is ready.



### GPT-04 — Slot definition returns `null`

- **Severity:** Critical
- **Signal:** `defineSlot`/`defineOutOfPageSlot` returns `null`; later code dereferences or displays it.
- **Why it happens:** Invalid arguments, unsupported out-of-page format/device, or duplicate/conflicting definition.
- **Check:** Inspect ad unit path, sizes/format, div ID, return value, and browser support.
- **Do:** Validate the slot before use and handle unsupported formats explicitly.



### GPT-05 — Slot is not attached to PubAdsService

- **Severity:** Critical
- **Signal:** Slot exists but never participates in PubAds requests.
- **Why it happens:** `.addService(googletag.pubads())` was omitted or applied to another slot.
- **Check:** Inspect slot creation chain and `pubads().getSlots()`.
- **Do:** Attach the defined slot to PubAdsService before enabling/requesting services.



### GPT-06 — Slot element is missing when displayed

- **Severity:** Critical
- **Signal:** `display(divId)` is called but no matching DOM element exists; no request or render follows.
- **Why it happens:** Display ran before DOM creation, SPA removed the element, or the ID is wrong.
- **Check:** Evaluate `document.getElementById(divId)` at display time and inspect DOM mutations.
- **Do:** Create the unique slot element before calling `display()`.



### GPT-07 — Duplicate slot element IDs

- **Severity:** High
- **Signal:** More than one DOM element has the same ID; render appears in the wrong element or correlation is ambiguous.
- **Why it happens:** Reused component templates, SPA remounts, or stale DOM nodes.
- **Check:** Count exact ID matches and compare registered slot objects.
- **Do:** Ensure each live GPT slot has one unique element ID; destroy old slots before replacement.



### GPT-08 — `display()` uses an ID different from the defined slot

- **Severity:** Critical
- **Signal:** Defined `getSlotElementId()` and display argument differ; no expected slot request follows.
- **Why it happens:** Typo, renamed element, or code passes GAM path instead of div ID.
- **Check:** Compare define-slot div ID, DOM ID, and display argument exactly.
- **Do:** Use the same element ID for definition, DOM, and `display()`.



### GPT-09 — Services enabled before required page configuration

- **Severity:** High
- **Signal:** SRA, `disableInitialLoad`, privacy, or other settings are applied after `enableServices()` and do not affect the first request.
- **Why it happens:** GPT initialization order is incorrect.
- **Check:** Compare configuration call timestamps with `enableServices`, `display`, and request start.
- **Do:** Apply request-affecting configuration before enabling services and before the request snapshot.



### GPT-10 — Slot is defined but never displayed

- **Severity:** Critical
- **Signal:** Slot appears in `getSlots()` but no `display()` invocation or request occurs.
- **Why it happens:** Render component did not mount, conditional logic skipped display, or an exception interrupted setup.
- **Check:** Inspect display instrumentation, DOM presence, and console errors.
- **Do:** Call `display()` once when the slot element is ready.



### GPT-11 — Initial load disabled but `refresh()` never called

- **Severity:** Critical
- **Signal:** `display()` occurs with `disableInitialLoad: true`, but no refresh and no `slotRequested` follow.
- **Why it happens:** Header-bidding callback/failsafe failed, early return, or refresh call was lost.
- **Check:** Inspect page config, display time, callback execution, failsafe, and refresh instrumentation.
- **Do:** Ensure a guarded ad-server request path eventually calls `refresh()`.



### GPT-12 — `refresh()` called before `display()`

- **Severity:** High
- **Signal:** Refresh invocation precedes slot registration/display; behavior is absent or inconsistent.
- **Why it happens:** Async component/order race.
- **Check:** Compare define, DOM creation, display, and refresh timestamps for the same slot.
- **Do:** Call `display()` first, then refresh after required targeting/configuration.



### GPT-13 — Unexpected duplicate initial requests

- **Severity:** High
- **Signal:** `display()` triggers a request and an immediate `refresh()` triggers another for the same slot.
- **Why it happens:** Initial load was not disabled but the integration also uses a refresh-based first request.
- **Check:** Inspect `disableInitialLoad`, two `slotRequested` events, and two GAM network requests.
- **Do:** Choose one first-request strategy. Header bidding normally disables initial load and uses refresh after targeting.



### GPT-14 — Refresh unintentionally requests every slot

- **Severity:** High
- **Signal:** `refresh()` without a slot array produces `slotRequested` events for unrelated slots.
- **Why it happens:** Publisher intended a single-slot refresh but omitted `[slot]`.
- **Check:** Inspect refresh arguments and affected slots.
- **Do:** Pass the intended slot array when refreshing a subset.



### GPT-15 — Wrong or destroyed slot object passed to refresh

- **Severity:** Critical
- **Signal:** Refresh argument does not match a current PubAds slot; no request or wrong-slot request follows.
- **Why it happens:** SPA retained a stale reference after `destroySlots()` or recreated the DOM without recreating GPT state.
- **Check:** Compare refresh object identity with `pubads().getSlots()` and destruction events.
- **Do:** Refresh only current registered slot objects; define a new slot after destruction.



### GPT-16 — `slotRequested` fires but no GAM network request is visible

- **Severity:** High
- **Signal:** GPT reports `slotRequested`, but no plausible GAM ad request appears.
- **Why it happens:** Request was blocked/canceled before transport, network observation started late, service worker/proxy obscured it, or the request was batched under SRA.
- **Check:** Search all relevant GAM request patterns, blocked-reason metadata, SRA batch requests, console, and observer start time.
- **Do:** Classify as blocked/unknown only after accounting for SRA and late attachment; fix the underlying browser/network block.



### GPT-17 — GAM network request fails

- **Severity:** Critical
- **Signal:** GAM ad request has DNS/TLS/connection failure, blocked reason, cancellation, or failing status and no slot response.
- **Why it happens:** Offline network, ad blocker, CSP, proxy/VPN, DNS/TLS issue, navigation, or server failure.
- **Check:** Inspect URL, status, error, duration, initiator, blocked reason, and page lifecycle.
- **Do:** Address the concrete network or policy failure. See the network section.



### GPT-18 — GAM request sent but response never completes

- **Severity:** Critical
- **Signal:** Request remains pending or ends without `slotResponseReceived` beyond the diagnostic threshold.
- **Why it happens:** Connection stall, server/proxy timeout, aborted navigation, browser cancellation, or observer loss.
- **Check:** Inspect network end state, timing phases, page navigation, and whether GPT remained active.
- **Do:** Fix network/server conditions; mark the result unknown if observation ended first.



### GPT-19 — Response received but render never ends

- **Severity:** Critical
- **Signal:** `slotResponseReceived` occurs but `slotRenderEnded` does not occur within the threshold.
- **Why it happens:** Rendering exception, blocked creative processing, slot destruction/navigation, main-thread stall, or missed listener.
- **Check:** Inspect console, long tasks, slot lifetime, DOM, listener timing, and creative/network activity.
- **Do:** Fix the render/slot lifecycle issue or repeat with early instrumentation to exclude a missed event.



### GPT-20 — GAM returns an empty slot

- **Severity:** Info
- **Signal:** `slotRenderEnded.isEmpty === true`.
- **Why it happens:** No eligible GAM line item/demand, targeting mismatch, policy restriction, inventory/configuration issue, or intentional no-fill.
- **Check:** Record ad unit path, targeting snapshot, size, request identifiers, and GAM delivery diagnostics. Null creative/line-item IDs are expected for empty results.
- **Do:** Investigate GAM eligibility/delivery; do not describe this as a network or render failure.



### GPT-21 — Creative metadata is null

- **Severity:** Info
- **Signal:** `creativeId`, `lineItemId`, advertiser, or campaign fields are null even though the slot may be filled.
- **Why it happens:** Empty result, backfill, or a non-reservation/non-PubAds render path.
- **Check:** Inspect `isEmpty`, `isBackfill`, source-agnostic IDs, and response information.
- **Do:** Avoid false alarms; use source-agnostic identifiers where available.



### GPT-22 — Creative iframe never reports load

- **Severity:** Medium
- **Signal:** Filled `slotRenderEnded` occurs but no `slotOnload` appears.
- **Why it happens:** Creative asset stall/failure, iframe removal, navigation, or a valid synchronous/rich-media mode with no iframe load event.
- **Check:** Determine render mode; inspect iframe DOM and creative subresource failures.
- **Do:** Report a load failure only when an iframe load is expected; otherwise mark not applicable.



### GPT-23 — Creative loads very slowly

- **Severity:** Medium
- **Signal:** Large delay between `slotRenderEnded` and `slotOnload`.
- **Why it happens:** Heavy/slow third-party assets, long tasks, blocked subresources, redirect chains, or creative code problems.
- **Check:** Inspect creative resource waterfall, CPU long tasks, iframe timing, and failures.
- **Do:** Escalate to the creative/vendor with response identifier and sanitized timing evidence.



### GPT-24 — Impression never becomes viewable

- **Severity:** Info
- **Signal:** Render/load succeeds but `impressionViewable` never fires.
- **Why it happens:** Slot remains below the fold, has insufficient visible area/time, is covered/hidden, tab is backgrounded, or the session ends first.
- **Check:** Inspect `slotVisibilityChanged`, CSS/layout, viewport, tab visibility, and observation duration.
- **Do:** Diagnose layout/viewability; do not call it a serving failure by default.



### GPT-25 — Slot visibility remains unexpectedly at zero

- **Severity:** Medium
- **Signal:** Repeated `slotVisibilityChanged.inViewPercentage` is `0` while the publisher expects the slot onscreen.
- **Why it happens:** Hidden/collapsed ancestor, offscreen positioning, zero size, overlay, detached DOM, or measurement conditions.
- **Check:** Inspect bounding rectangle, computed style, ancestors, overlays, and slot content size.
- **Do:** Correct layout/visibility conditions.



### GPT-26 — Responsive size mapping does not match the active viewport

- **Severity:** High
- **Signal:** Requested/rendered size is absent from the expected viewport mapping, or GAM returns empty despite otherwise valid setup.
- **Why it happens:** Mapping order/values are wrong or the slot sizes do not cover the viewport.
- **Check:** Compare viewport dimensions, GPT size mapping, base sizes, and rendered `event.size`.
- **Do:** Correct the responsive mapping and ensure eligible creative sizes exist.



### GPT-27 — Targeting is changed after the request snapshot

- **Severity:** High
- **Signal:** Targeting call occurs after `display()`/`refresh()` and is absent from that GAM request.
- **Why it happens:** Async targeting completed too late or invocation order is wrong.
- **Check:** Compare targeting update time with request invocation and `slotRequested`.
- **Do:** Apply targeting before the request; refresh again only if a new request is actually intended.



### GPT-28 — Targeting applied at the wrong scope

- **Severity:** High
- **Signal:** A key intended for one slot appears on other slots, or a page-level key overrides/combines unexpectedly.
- **Why it happens:** Page-level targeting was used instead of slot-level targeting, or stale values were not cleared.
- **Check:** Compare page config, slot config, and actual slot keys per request.
- **Do:** Put targeting at the intended level and explicitly clear obsolete values.



### GPT-29 — SRA batches unintended or incomplete slots

- **Severity:** High
- **Signal:** One display/request causes multiple unfetched slots to request, or a slot misses the intended SRA batch.
- **Why it happens:** With Single Request Architecture, display timing and unfetched-slot state affect batching.
- **Check:** Inspect SRA configuration, display order, slot request timestamps, and shared GAM network request.
- **Do:** Define/configure intended slots before triggering the SRA request or use deliberate per-slot requests.



### GPT-30 — Lazy loading is mistaken for a missing request

- **Severity:** Info
- **Signal:** Defined/displayed slot has no request until it approaches the configured fetch margin.
- **Why it happens:** GPT lazy loading intentionally delays fetch/render.
- **Check:** Inspect lazy-load config, viewport distance, and later `slotRequested`.
- **Do:** Mark the request as deferred; investigate only if it still fails after entering the fetch margin.



### GPT-31 — Privacy settings are applied too late

- **Severity:** High
- **Signal:** Privacy configuration occurs after display/refresh for the request it was intended to govern.
- **Why it happens:** CMP callback or publisher privacy code resolves after the request snapshot.
- **Check:** Compare CMP/privacy-setting time with request start.
- **Do:** Resolve and apply applicable privacy settings before the request. Changes are not retroactive.



### GPT-32 — Slot destroyed while request/render is active

- **Severity:** High
- **Signal:** Slot disappears between request and response/render; downstream events are missing or reference stale DOM.
- **Why it happens:** SPA unmount, route change, or cleanup races an in-flight request.
- **Check:** Compare DOM removal/`destroySlots` timing with request lifecycle.
- **Do:** Coordinate component cleanup with slot lifecycle and treat post-destruction results as canceled.



### GPT-33 — Rewarded or manual interstitial is ready but never shown

- **Severity:** Medium
- **Signal:** `rewardedSlotReady` or `gameManualInterstitialSlotReady` fires, but the corresponding visibility method is never called.
- **Why it happens:** User declined, consent UI failed, publisher logic skipped the method, or the event handler was late.
- **Check:** Inspect user decision, ready handler, and `makeRewardedVisible()`/`makeGameManualInterstitialVisible()` result.
- **Do:** If appropriate and consented, call the event method from the supported user flow; otherwise treat not shown as intentional.



### GPT-34 — Reward granted based on the wrong event

- **Severity:** High
- **Signal:** Application grants a reward on video completion or close without `rewardedSlotGranted`.
- **Why it happens:** Publisher treats `rewardedSlotVideoCompleted` or `rewardedSlotClosed` as proof of reward eligibility.
- **Check:** Compare application reward time with `rewardedSlotGranted` and its payload.
- **Do:** Grant the reward only from `rewardedSlotGranted`; use close solely for UI cleanup/resume.



### GPT-35 — Auto-refresh or publisher refresh occurs too frequently

- **Severity:** Medium
- **Signal:** Repeated request cycles occur at an unexpectedly short interval, sometimes before viewability or previous render completion.
- **Why it happens:** Multiple refresh timers, duplicate listeners, auto-refresh plus manual refresh, or missing debounce/guard.
- **Check:** Identify every refresh initiator and interval; correlate viewability and previous cycle completion.
- **Do:** Consolidate refresh ownership and follow applicable GAM policy and publisher requirements.

---



## Prebid + GPT/GAM integration issues



### INT-01 — GAM refresh occurs before the Prebid auction ends

- **Severity:** High
- **Signal:** `refresh()`/`slotRequested` occurs after `auctionInit` but before the matching `auctionEnd`.
- **Why it happens:** Publisher starts GPT independently, uses an incorrectly timed callback, or a failsafe fires too early.
- **Impact:** GAM snapshots the slot before the auction result is available; the auction consumes time but its result cannot compete in that request.
- **Check:** Correlate refresh, `slotRequested`, `auctionId`, auction deadline, and any later `setTargeting`.
- **Do:** Trigger the GAM request from the matching bids-back/auction-complete path, with a guarded failsafe for genuine Prebid failure.



### INT-02 — Targeting is generated before auction completion

- **Severity:** High
- **Signal:** `setTargeting` occurs before `auctionEnd` for the same auction/slot.
- **Why it happens:** Publisher calls targeting immediately after `requestBids` or from an early bidder callback.
- **Impact:** Late valid bids are excluded from the ad-server candidate.
- **Check:** Compare `setTargeting` payload, time, and auction state.
- **Do:** Apply targeting only after the auction decision is finalized.



### INT-03 — Auction ends but targeting is never applied

- **Severity:** High
- **Signal:** Eligible bids exist at `auctionEnd`, but no `setTargeting` occurs before the GAM request.
- **Why it happens:** Missing `setTargetingForGPTAsync`, callback exception, wrong branch, or GPT unavailable at handoff.
- **Check:** Inspect callback execution, console, `getAdserverTargetingForAdUnitCode`, and GPT readiness.
- **Do:** Ensure the completed-auction path applies targeting before requesting GAM.



### INT-04 — Targeting is applied after refresh

- **Severity:** High
- **Signal:** Refresh/`slotRequested` precedes `setTargeting` or the GPT targeting snapshot.
- **Why it happens:** Async ordering mistake or misunderstanding of the GPT request snapshot.
- **Impact:** New keys apply only to a later request.
- **Check:** Compare refresh, `slotRequested`, `setTargeting`, and slot key timestamps.
- **Do:** Apply and verify targeting first, then refresh.



### INT-05 — Prebid and GPT slot identifiers do not match

- **Severity:** Critical
- **Signal:** Prebid `adUnitCode` differs from GPT `getSlotElementId()` and no valid custom matcher explains it; `setTargeting` data does not reach the GPT slot.
- **Why it happens:** Typo, path-versus-div confusion, renamed DOM ID, or different naming conventions.
- **Check:** Compare exact Prebid code, GPT element ID, DOM ID, and configured custom GPT slot registry/matcher.
- **Do:** Align identifiers or correct the intentional custom mapping.



### INT-06 — Custom GPT slot matching maps to the wrong slot

- **Severity:** Critical
- **Signal:** Prebid targeting appears on a GPT slot with a different intended ad unit.
- **Why it happens:** Custom matching function/registry is too broad, stale, or uses GAM path where element ID was expected.
- **Check:** Evaluate the matcher against every live slot and ad-unit code.
- **Do:** Make mapping one-to-one and deterministic; test duplicate paths/div IDs.



### INT-07 — Targeting payload is empty despite eligible bids

- **Severity:** High
- **Signal:** `auctionEnd` has valid bids but `setTargeting[adUnitCode]` is empty or absent.
- **Why it happens:** Bid expired, targeting exclusion filtered it, media-type/size mismatch, bid already used, or wrong auction/ad-unit scope.
- **Check:** Inspect bid status, expiry, exclusion config, selected media type, and targeting API output.
- **Do:** Correct the exclusion/scope/timing issue or run a fresh auction.



### INT-08 — Required `hb_*` keys are incomplete

- **Severity:** High
- **Signal:** A Prebid candidate has some but not all expected keys such as `hb_bidder`, `hb_pb`, `hb_adid`, `hb_size`, or `hb_format` when applicable.
- **Why it happens:** Incomplete bid metadata, custom targeting rules, key-length constraints, or incorrect targeting application.
- **Check:** Compare bid fields, `setTargeting` payload, actual GPT slot keys, and GAM request targeting.
- **Do:** Fix the bid/targeting configuration and verify the exact keys required by the GAM line-item/creative setup.



### INT-09 — Prebid targeting is computed but absent on the GPT slot

- **Severity:** Critical
- **Signal:** `setTargeting` contains values, but `getTargetingKeys()`/`getTargeting(key)` or supported slot config does not show them.
- **Why it happens:** Slot matching failure, slot not yet defined, wrong GPT instance, targeting cleared immediately, or unsupported wrapper/integration behavior.
- **Check:** Compare targeting payload to actual slot state immediately before refresh.
- **Do:** Define/match the slot before handoff and stop later code from clearing the keys.



### INT-10 — Stale Prebid targeting leaks into a no-bid refresh

- **Severity:** Critical
- **Signal:** Current auction has no eligible bid, but GPT still carries previous cycle’s `hb_`* values.
- **Why it happens:** Old targeting was not cleared, refresh bypassed the current targeting path, or slot state was reused incorrectly.
- **Check:** Compare current `auctionId`, current bids, bid `adId`, and GPT keys with the previous cycle.
- **Do:** Ensure the standard targeting handoff clears obsolete Prebid keys and that every refresh has an associated current auction decision.



### INT-11 — Targeting from one slot leaks into another

- **Severity:** Critical
- **Signal:** GPT slot contains `hb_adid`/bidder/size belonging to another Prebid `adUnitCode`.
- **Why it happens:** Page-level application, bad custom matcher, shared IDs, or all-slot state incorrectly flattened.
- **Check:** Resolve `hb_adid` back to its bid and compare that bid’s `adUnitCode` with the GPT slot.
- **Do:** Apply targeting per correctly matched slot and fix duplicate IDs/mapping.



### INT-12 — `hb_pb` does not equal the exact bid CPM

- **Severity:** Info
- **Signal:** Bid `cpm` differs from `hb_pb`.
- **Why it happens:** `hb_pb` is normally a configured price bucket, not the exact CPM; adjustment/currency conversion may also precede bucketing.
- **Check:** Inspect `originalCpm`, adjusted `cpm`, currency, price granularity, and `hb_pb`.
- **Do:** Explain the transformation. Report an error only if bucketing is inconsistent with configuration.



### INT-13 — GAM line-item buckets do not cover Prebid price buckets

- **Severity:** High
- **Signal:** Correct `hb_pb` reaches GAM, but Prebid demand consistently does not match/serve for particular values.
- **Why it happens:** GAM line-item targeting lacks the emitted bucket, uses another granularity, currency, bidder, or media-type condition.
- **Check:** Compare actual GAM request keys with the relevant line-item targeting setup and price-granularity configuration.
- **Do:** Align GAM delivery targeting with emitted Prebid keys. BidShitter should diagnose evidence, not modify GAM.



### INT-14 — All-bids targeting collides or exceeds practical key limits

- **Severity:** Medium
- **Signal:** Bidder-suffixed keys are missing/truncated, collide after bidder-code normalization, or inflate the GAM request.
- **Why it happens:** `enableSendAllBids`, many bidders, custom targeting, or long bidder/key names produce excessive targeting.
- **Check:** Count and measure `hb_`* keys/values, inspect suffix uniqueness, request size, and actual transmitted targeting.
- **Do:** Reduce unnecessary targeting and ensure suffix/key conventions match GAM setup.



### INT-15 — Prebid candidate is incorrectly labeled as the final winner

- **Severity:** Medium
- **Signal:** UI calls the highest CPM/`setTargeting` bid “rendered winner” before GPT/GAM outcome.
- **Why it happens:** Prebid’s candidate is confused with GAM’s final line-item selection.
- **Check:** Wait for `bidWon` and `slotRenderEnded`; inspect GAM metadata and the Prebid creative path.
- **Do:** Use distinct labels: **Prebid candidate**, **targeting sent**, and **rendered outcome**.



### INT-16 — GAM selects non-Prebid demand

- **Severity:** Info
- **Signal:** Prebid targeting was present, but GPT renders a direct/backfill/non-Prebid result and no matching `bidWon` occurs.
- **Why it happens:** GAM demand legitimately outranked or otherwise beat the Prebid line item.
- **Check:** Inspect `slotRenderEnded`, backfill/source-agnostic IDs, `bidWon`, and whether the rendered creative resolves to `hb_adid`.
- **Do:** Report the outcome as valid unless GAM delivery was unexpected; do not claim Prebid rendering failed.



### INT-17 — GAM selects Prebid demand but the creative cannot resolve `hb_adid`

- **Severity:** Critical
- **Signal:** GAM appears to select the Prebid line item, but Prebid emits `cannotFindAd`, no matching bid exists, or creative remains blank.
- **Why it happens:** Stale/wrong `hb_adid`, bid expired/cleared, universal creative misconfiguration, or wrong global Prebid instance.
- **Check:** Match GPT `hb_adid` to a current bid, inspect TTL/status, creative console, and auction cleanup timing.
- **Do:** Preserve correct bid state through render and correct the GAM Prebid creative/handoff configuration.



### INT-18 — Failsafe and auction callback both request GAM

- **Severity:** High
- **Signal:** Two near-adjacent refreshes/`slotRequested` events follow one auction—one from failsafe and one from completion.
- **Why it happens:** Missing shared idempotency guard or guard is set too late.
- **Check:** Inspect refresh call stacks, timer firing, callback time, and request-sent flag.
- **Do:** Route both paths through one function that sets the guard before queuing/calling GPT.



### INT-19 — Failsafe fires before the configured auction deadline

- **Severity:** High
- **Signal:** Failsafe refresh occurs while the auction is still legitimately active and before its timeout.
- **Why it happens:** Failsafe duration is shorter than Prebid timeout plus expected scheduling overhead.
- **Check:** Compare failsafe delay, auction start, bidder timeout, and refresh time.
- **Do:** Set the failsafe beyond the normal auction deadline while keeping it bounded for true failure recovery.



### INT-20 — Failsafe path requests GAM without available targeting

- **Severity:** Medium
- **Signal:** Prebid is unavailable/stalled, failsafe refreshes GAM, and no Prebid targeting is present.
- **Why it happens:** This is the intended fallback when header bidding cannot complete.
- **Check:** Confirm Prebid readiness/failure and that the fallback fired once.
- **Do:** Label as **fallback GAM request**, not a targeting bug, unless usable targeting existed but was skipped.



### INT-21 — New auction starts before the prior GPT cycle completes

- **Severity:** High
- **Signal:** Second `auctionInit`/targeting handoff occurs before the first slot’s response/render, causing ambiguous targeting or outcome correlation.
- **Why it happens:** Aggressive refresh timer, overlapping components, or missing in-flight guard.
- **Check:** Compare auction, targeting, refresh, response, and render cycle IDs.
- **Do:** Serialize a single slot’s auction/request lifecycle unless overlapping operation is explicitly designed and safely correlated.



### INT-22 — Refresh uses targeting from the wrong auction

- **Severity:** Critical
- **Signal:** GPT `hb_adid` maps to a bid whose `auctionId` is not the auction intended for that refresh.
- **Why it happens:** Overlap, stale targeting, cached callback, or latest-auction APIs were read at the wrong time.
- **Check:** Resolve `hb_adid` and compare auction IDs/timestamps.
- **Do:** Bind targeting and refresh to the same explicit lifecycle cycle.



### INT-23 — Auction covers one slot set while refresh covers another

- **Severity:** High
- **Signal:** `requestBids.adUnitCodes`, `setTargeting` keys, and refresh slot array do not describe the same intended set.
- **Why it happens:** Global auction combined with component-level refresh, omitted filter, or stale slot list.
- **Check:** Compare all three sets exactly.
- **Do:** Align auction, targeting handoff, and refresh scope.



### INT-24 — Prebid and GPT size configurations disagree

- **Severity:** High
- **Signal:** Winning `hb_size` is not eligible in GPT’s active size mapping or GAM inventory.
- **Why it happens:** Ad-unit sizes and GPT sizes evolved independently or viewport mappings differ.
- **Check:** Compare Prebid media sizes, bid width/height, `hb_size`, GPT mapping, viewport, and rendered size.
- **Do:** Align eligible sizes across Prebid, GPT, and GAM delivery.



### INT-25 — Prebid and GPT privacy state disagree

- **Severity:** High
- **Signal:** Prebid bidders are allowed/blocked under one consent state while GPT request uses another or receives privacy settings later.
- **Why it happens:** Separate CMP callbacks, race conditions, inconsistent interpretation, or one system starts before consent resolution.
- **Check:** Compare consent metadata/enforcement and GPT privacy-setting timestamps against both requests.
- **Do:** Coordinate both systems from the same resolved consent state while respecting each system’s API requirements.



### INT-26 — Late Prebid response arrives after GAM request

- **Severity:** Info
- **Signal:** Bid response/network completion happens after auction timeout and/or `slotRequested`.
- **Why it happens:** Bidder exceeded the auction budget.
- **Check:** Compare response timestamp, timeout, `auctionEnd`, targeting, and GAM request.
- **Do:** Do not attribute the late bid to the current GAM request; investigate recurring bidder latency.



### INT-27 — GPT request succeeds but no Prebid `bidWon` appears

- **Severity:** Info
- **Signal:** `slotRenderEnded` is filled, targeting existed, but no `bidWon` event occurs.
- **Why it happens:** GAM selected non-Prebid demand, the render path does not mark the bid as used as expected, or observation began late.
- **Check:** Determine rendered demand source and resolve `hb_adid` to the creative path.
- **Do:** Report `bidWon` missing as an error only when evidence shows the Prebid creative actually rendered and the listener was active.



### INT-28 — Prebid reports render success but GPT outcome is missing

- **Severity:** Medium
- **Signal:** `adRenderSucceeded`/`bidWon` appears without the expected GPT response/render lifecycle.
- **Why it happens:** It may be a valid Prebid-only render, a custom renderer, direct `renderAd`, or GPT observation was late; otherwise correlation is wrong.
- **Check:** Identify the render path and whether GPT was responsible for the slot.
- **Do:** Classify by render owner before reporting an integration failure.



### INT-29 — SafeFrame or iframe policy blocks the Prebid creative

- **Severity:** High
- **Signal:** GAM selects a Prebid creative but render fails/blank, with sandbox, SafeFrame, cross-origin, or CSP evidence.
- **Why it happens:** Creative behavior is incompatible with the configured frame restrictions or required messaging/lookup cannot run.
- **Check:** Inspect iframe/SafeFrame configuration, console, blocked resources, and creative execution path.
- **Do:** Correct the creative or supported frame configuration; do not weaken security without understanding the impact.



### INT-30 — Duplicate Prebid or GPT library instances split state

- **Severity:** Critical
- **Signal:** Events/slots/bids appear in different globals or versions; targeting uses one instance while render lookup uses another.
- **Why it happens:** Library loaded twice, bundle embeds a second copy, or a custom Prebid global name is used.
- **Check:** Inspect script tags, versions, globals, queue replacement, and which object emitted each event.
- **Do:** Use one intentional instance/global per integration and configure BidShitter to observe the correct custom global when supported.



### INT-31 — Send-all-bids limit removes eligible bids from targeting

- **Severity:** Medium
- **Signal:** More valid bids exist than bidder-suffixed targeting entries; omissions align with ad-unit `bidLimit` or `sendBidsControl.bidLimit`.
- **Why it happens:** Publisher intentionally caps the number of bids exposed to the ad server.
- **Check:** Compare eligible bids, targeting set, `enableSendAllBids`, per-ad-unit limit, and global send-bids control.
- **Do:** Explain intentional limiting; adjust limits only if GAM genuinely requires the omitted bids.



### INT-32 — Auction targeting character limit truncates entries

- **Severity:** High
- **Signal:** Later/lower-priority targeting keys or bidder entries are absent and generated targeting approaches `targetingControls.auctionKeyMaxChars`.
- **Why it happens:** Prebid caps targeting characters to keep the ad-server request within practical limits.
- **Check:** Measure serialized targeting, inspect the configured max, key priority/order, and omitted entries.
- **Do:** Remove unnecessary keys or deliberately adjust the limit while monitoring request size.



### INT-33 — Expected custom targeting key is missing

- **Severity:** Medium
- **Signal:** Standard `hb_`* targeting exists, but a bidder/publisher custom key expected from bid `adserverTargeting`/settings is absent.
- **Why it happens:** Bidder settings did not generate it, bid was not eligible for that key, custom-targeting controls excluded it, or send-all-bids limiting removed the bid.
- **Check:** Compare bid custom targeting, bidder settings, generated Prebid map, allowed keys, and actual GPT slot state.
- **Do:** Correct the custom targeting rule or expectation; avoid requiring undocumented adapter internals.



### INT-34 — Custom targeting overwrites a standard Prebid key

- **Severity:** Critical
- **Signal:** A standard key such as `hb_adid`, `hb_pb`, or `hb_bidder` has an unexpected value after custom bidder/publisher targeting runs.
- **Why it happens:** Custom targeting reuses a reserved standard key or later publisher code writes the same key.
- **Check:** Compare targeting-generation stages, bidder settings, custom maps, GPT writes, and request-time value.
- **Do:** Rename custom keys and preserve standard Prebid key ownership.



### INT-35 — Targeting allow-list/filter removes a required key

- **Severity:** High
- **Signal:** Bid contains/generated targeting value, but `targetingControls.allowTargetingKeys` or related controls omit it before GPT handoff.
- **Why it happens:** Allow-list is incomplete, uses the wrong key name, or was changed without updating GAM requirements.
- **Check:** Compare bid/generation map, allowed/filtered keys, `setTargeting` payload, and required GAM line-item keys.
- **Do:** Add the genuinely required key to the publisher allow-list or update GAM expectations.



### INT-36 — GPT is unavailable at the targeting handoff

- **Severity:** Critical
- **Signal:** Auction completes with an eligible candidate, but `googletag.pubads()` is unavailable and targeting cannot be applied.
- **Why it happens:** GPT script failed/loaded late, global was replaced, command queue failed, or handoff ran outside GPT readiness.
- **Check:** Inspect GPT script/network, `window.googletag`, command queue, console, and handoff timestamp.
- **Do:** Coordinate the handoff through GPT readiness and fix the underlying GPT load/global failure.



### INT-37 — No GPT slot is defined for the Prebid ad unit

- **Severity:** Critical
- **Signal:** Prebid auction/targeting exists, but `pubads().getSlots()` contains no intended slot for that inventory.
- **Why it happens:** GPT setup did not run, slot definition returned `null`, component failed to mount, or the page is intentionally Prebid-only.
- **Check:** Inspect live GPT slots, definition calls/return values, DOM, and intended render owner.
- **Do:** If GPT should serve it, define/attach the slot before handoff; otherwise classify the path as Prebid-only.



### INT-38 — More than one GPT slot matches one Prebid ad unit

- **Severity:** Critical
- **Signal:** Multiple live GPT slots satisfy the same element/path/custom matching rule for one `adUnitCode`.
- **Why it happens:** Duplicate slot IDs/definitions, ambiguous custom matcher, or SPA left a stale slot alive.
- **Check:** Enumerate all candidates with object identity, element ID, ad unit path, DOM presence, and custom-match result.
- **Do:** Make matching one-to-one, destroy stale slots, and require explicit selection when ambiguity remains.



### INT-39 — GPT targeting values differ from Prebid’s generated values

- **Severity:** Critical
- **Signal:** Same `hb_`* key exists in Prebid’s targeting map and on the matched GPT slot but the values differ before request.
- **Why it happens:** Later overwrite, wrong slot/auction, value normalization, custom targeting collision, or stale state.
- **Check:** Diff every relevant key at generation, after application, immediately before refresh, and in the request.
- **Do:** Identify and remove the unintended writer/state mismatch; document legitimate normalization.



### INT-40 — Publisher code overwrites Prebid targeting after handoff

- **Severity:** Critical
- **Signal:** GPT slot matches Prebid immediately after `setTargeting`, then one or more `hb_`* values change before `slotRequested`.
- **Why it happens:** Publisher targeting routine, another header bidder, duplicate Prebid instance, or generic slot reset writes the same keys.
- **Check:** Snapshot keys after handoff and before request; inspect targeting setter call stacks and timestamps.
- **Do:** Establish key ownership/order so Prebid’s final values remain intact for the intended request.



### INT-41 — Prebid targeting is cleared before the GAM request

- **Severity:** Critical
- **Signal:** Expected `hb_`* keys are present after handoff but missing/null immediately before refresh or at request time.
- **Why it happens:** `clearTargeting`, `setConfig` replacement semantics, slot reset, no-bid cleanup for the wrong cycle, or another integration clears them.
- **Check:** Observe clearing/replacement calls, config snapshots, cycle IDs, and request-time keys.
- **Do:** Clear only obsolete cycle targeting and only after the request that needs the current values has snapped them.

---



## Browser and network issues



### NET-01 — Browser is offline or connection drops

- **Severity:** Critical
- **Signal:** Multiple unrelated Prebid/GPT requests fail together; `navigator.onLine` may be false; network errors indicate disconnection.
- **Why it happens:** Device/network loss or captive portal transition.
- **Check:** Compare failures across origins and browser network state.
- **Do:** Restore connectivity and rerun; do not diagnose each bidder/GAM endpoint independently when failures are systemic.



### NET-02 — DNS resolution failure

- **Severity:** Critical
- **Signal:** Request fails before connection with a DNS/name-resolution error.
- **Why it happens:** Bad hostname, DNS outage/filter, VPN, or local resolver issue.
- **Check:** Record hostname and browser error code; compare other requests to the same domain.
- **Do:** Correct the URL/DNS environment or escalate to the endpoint owner.



### NET-03 — TLS/certificate failure

- **Severity:** Critical
- **Signal:** HTTPS request fails during SSL/TLS negotiation or certificate validation.
- **Why it happens:** Expired/untrusted certificate, interception proxy, hostname mismatch, or protocol problem.
- **Check:** Inspect browser security details and error code.
- **Do:** Fix the certificate/endpoint or trusted enterprise proxy configuration.



### NET-04 — Request blocked by an ad blocker or browser privacy feature

- **Severity:** High
- **Signal:** Requests are marked blocked by client/extension; scripts or creatives disappear when a blocking extension is enabled.
- **Why it happens:** URL/domain/path matches a blocking rule or browser tracking protection.
- **Check:** Inspect blocked reason and reproduce in a clean Chrome profile.
- **Do:** Report environmental blocking; do not attempt to evade user-selected privacy/blocking tools.



### NET-05 — Content Security Policy blocks script, connection, frame, or creative

- **Severity:** High
- **Signal:** Console reports `script-src`, `connect-src`, `frame-src`, or related CSP violation.
- **Why it happens:** Publisher CSP does not allow a required Prebid/GPT/bidder/creative origin or execution mode.
- **Check:** Capture the violated directive and blocked origin/resource type.
- **Do:** Review and narrowly update the publisher CSP if the resource is intended and trusted.



### NET-06 — Mixed-content blocking

- **Severity:** High
- **Signal:** HTTPS page attempts an HTTP bidder, script, creative, or tracking request and the browser blocks/upgrades it.
- **Why it happens:** Insecure endpoint or creative URL.
- **Check:** Inspect scheme and mixed-content console warning.
- **Do:** Use HTTPS throughout the serving chain.



### NET-07 — Request canceled by navigation, unload, or slot destruction

- **Severity:** Medium
- **Signal:** Network request is canceled while page/route/slot lifecycle ends.
- **Why it happens:** Navigation, SPA rerender, `destroySlots`, or abort logic superseded the request.
- **Check:** Compare cancellation with navigation and component cleanup timestamps.
- **Do:** Treat as canceled rather than endpoint failure; fix premature cleanup if the ad should have remained active.



### NET-08 — Proxy, VPN, firewall, or enterprise policy interferes

- **Severity:** High
- **Signal:** Failures reproduce only on a particular network/profile; requests are reset, rewritten, or blocked without page-level cause.
- **Why it happens:** Network middleware filters advertising domains or modifies TLS/HTTP traffic.
- **Check:** Compare a clean network/profile and inspect proxy/security software logs where available.
- **Do:** Escalate to the network administrator or test in an approved unrestricted environment.



### NET-09 — HTTP response is successful but semantically unusable

- **Severity:** High
- **Signal:** HTTP 2xx response exists, but Prebid reports no-bid/rejection or GPT reports an empty slot.
- **Why it happens:** Transport success does not guarantee eligible demand or a valid payload.
- **Check:** Use Prebid/GPT outcome events and sanitized response metadata, not HTTP status alone.
- **Do:** Investigate bidder response validation or GAM delivery/targeting rather than the network.



### NET-10 — Main-thread blocking distorts lifecycle timing

- **Severity:** Medium
- **Signal:** Network completes but JS callbacks/events are delayed; large gaps align with long tasks.
- **Why it happens:** Heavy page JavaScript, synchronous work, layout, or third-party code blocks event processing.
- **Check:** Correlate performance long tasks with request completion and event timestamps.
- **Do:** Reduce/block-schedule heavy work and distinguish network duration from callback delivery delay.



### NET-11 — Service worker or cache changes the observed request path

- **Severity:** Medium
- **Signal:** Request appears served/intercepted by a service worker or cache, or normal network timing/status is absent.
- **Why it happens:** Publisher service worker, browser cache, or test tooling intercepts traffic.
- **Check:** Inspect request source, service-worker initiator, cache flags, and reproduce with bypass enabled.
- **Do:** Account for the interception in diagnosis; correct unintended service-worker handling.



### NET-12 — Request or targeting URL becomes excessively large

- **Severity:** Medium
- **Signal:** GAM/bidder request has unusually large query/body, is rejected/truncated, or fails only with many targeting keys.
- **Why it happens:** Send-all-bids, excessive custom targeting, oversized consent/identity data, or duplicate parameters.
- **Check:** Measure request size and compare successful versus failing cycles.
- **Do:** Minimize unnecessary targeting and request data while preserving required fields.



### NET-13 — CORS prevents the bidder response from being read

- **Severity:** High
- **Signal:** Bidder server responds or appears in Network, but browser reports a CORS violation and Prebid cannot consume the response.
- **Why it happens:** Missing/incorrect `Access-Control-Allow-Origin`, credentials mismatch, disallowed headers/methods, or failed preflight.
- **Check:** Inspect console CORS error, request origin/mode/credentials, response CORS headers, and any OPTIONS request.
- **Do:** Correct bidder endpoint CORS policy and adapter request requirements.



### NET-14 — CORS preflight consumes the auction budget

- **Severity:** Medium
- **Signal:** OPTIONS request precedes the bidder request and uses a substantial fraction of the timeout; bid often arrives late.
- **Why it happens:** Non-simple method, headers, or content type triggers preflight, and endpoint/network latency is high.
- **Check:** Inspect OPTIONS timing, requested headers/method, content type, cacheability, actual request start, and auction deadline.
- **Do:** Where the adapter/endpoint contract permits, use a simple request such as `text/plain` and minimize custom headers; otherwise optimize/cache preflight handling.



### NET-15 — Bidder endpoint rejects the request with HTTP 4xx

- **Severity:** High
- **Signal:** Bidder/PBS request completes with a 4xx status and produces `bidderError`, no usable bid, or error payload.
- **Why it happens:** Invalid parameters/payload, authentication/account error, wrong endpoint/path, rate limit, or forbidden request.
- **Check:** Record status, endpoint, sanitized response/error, request schema, account identifiers, and adapter error.
- **Do:** Correct publisher/adapter request configuration or escalate account/rate-limit issues to the endpoint owner.



### NET-16 — Bidder endpoint fails with HTTP 5xx

- **Severity:** High
- **Signal:** Bidder/PBS request returns 5xx; one bidder or all S2S bidders fail.
- **Why it happens:** Endpoint/backend/PBS outage, overload, upstream dependency failure, or server bug.
- **Check:** Record status, timing, endpoint, sanitized error/response, affected bidders, and recurrence.
- **Do:** Retry only through the normal future auction policy and escalate evidence to the service owner; do not retry inside the same settled auction without design support.

---



## Cross-check checklist for each failed slot

When diagnosing one slot, collect these facts in order:

1. **Observer readiness:** Was BidShitter active before page initialization?
2. **Page identity:** URL, top frame, page-session ID, navigation/reload time.
3. **Slot identity:** DOM ID, Prebid ad-unit code, GPT element ID, GAM ad unit path.
4. **Auction identity:** `auctionId`, start/end/timeout, requested bidders.
5. **Per-bidder outcome:** response, no-bid, rejection reason, error, or timeout.
6. **Candidate:** selected Prebid bid, `adId`, CPM/currency, price bucket, size, TTL.
7. **Targeting:** Prebid-computed map, actual GPT slot map, and request-time snapshot.
8. **Request invocation:** display/refresh call, slot scope, guard/failsafe initiator.
9. **Network:** GPT script, bidder/PBS calls, GAM request, statuses, blocked reasons, durations.
10. **GAM outcome:** response received, empty/filled, line item/creative identifiers where exposed.
11. **Render outcome:** render ended, iframe load, Prebid win/render events, console/security failures.
12. **Viewability:** visibility changes and `impressionViewable`, when applicable.



## What BidShitter must not claim

- `hb_*` targeting on a slot does not prove Prebid won in GAM.
- Highest Prebid CPM does not reveal GAM’s winning price or complete decision process.
- HTTP 200 does not prove a valid bid or filled GAM response.
- Missing `slotOnload` does not always mean render failure.
- Missing `impressionViewable` does not mean the ad failed to render.
- Null line-item or creative IDs do not always mean an empty slot.
- A bidder timeout does not prove the bidder endpoint was down.
- A no-bid is not a network error.
- A late bid must not be attributed to a GAM request that already started.
- Events from different auctions, slots, frames, or refresh cycles must never be merged into one explanation.



## Suggested diagnostic output contract

Each detected issue should expose:

```ts
interface DiagnosticIssue {
  ruleId: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  confidence: 'confirmed' | 'likely' | 'possible';
  scope: 'observation' | 'prebid' | 'gpt' | 'integration' | 'network';
  slotId?: string;
  auctionId?: string;
  cycleId?: string;
  detectedAt: number;
  evidence: Array<{
    eventType?: string;
    timestamp: number;
    summary: string;
  }>;
  explanation: string;
  checks: string[];
  recommendations: string[];
}
```

Use **confirmed** only for direct evidence such as an explicit rejection, render failure, blocked network request, ID mismatch, or impossible event order. Use **likely** for strongly supported missing-stage diagnoses after a threshold. Use **possible** when observation began late or the API does not expose enough information to establish the cause.