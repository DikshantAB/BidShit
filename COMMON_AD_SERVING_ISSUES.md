# Common Ad Serving Issues

This document is the implementation plan for the selected diagnostic rules. The detector must remain observe-only: wrap public methods without changing arguments, return values, timing, or publisher state; subscribe to documented Prebid and GPT events; take read-only snapshots; and use sanitized DevTools network metadata.

## Shared backend model for issues section

- Store all observations as timestamped envelopes and retain both wall-clock and monotonic time.
- Build a Prebid auction record keyed by `auctionId`, a GPT slot record keyed by `slot.getSlotElementId()`, and an ad-serving cycle record that links one ad unit, auction, targeting handoff, GAM request, response, and render.
- Link Prebid to GPT with Prebid’s real matcher: `adUnit.code === slot.getSlotElementId()` **or** `adUnit.code === slot.getAdUnitPath()`, unless a captured `setConfig({ customGptSlotMatching })` function resolves a different slot. (`customSlotMatching` on `setTargetingForGPTAsync` was removed in Prebid 11.) Link a GAM request by slot/ad-unit path (`iu`) and account for SRA, where one `/gampad/ads` request represents several slots and one HTTP call still emits one `slotRequested` per slot.
- At each `slotRequested`, persist the slot targeting snapshot and the matching GAM request parameters (`iu`, sizes, `cust_params`/`scp`/`prev_scp`, `correlator`, HTTP status, timing, and blocked reason). Strip creatives, consent strings, identifiers, cookies, and response bodies.
- Absence-based rules must wait for the relevant timeout plus a grace period and lower confidence when the hook attached late, events were dropped, the page navigated, or the required precondition is unknown.
- Deduplicate findings by `ruleId + auctionId/cycleId + slot/adUnit`, retain the evidence envelopes, and emit one updated issue rather than repeated issues as more evidence arrives.

---



## Observation issues



### COMMON-OBS-01 — Missing optional event is reported as a failure.  

- **Severity:** Info
- **Signal:** The only “problem” is a missing `bidWon`, `slotOnload`, or `impressionViewable` on an otherwise valid path.
- **Why it happens:** Those events are optional. `bidWon` fires only when Prebid marks a bid as winning during render (GAM selected Prebid / `renderAd`), not when targeting is set. `slotOnload` fires only when a creative iframe loads and is skipped for sync/rich-media with no iframe. `impressionViewable` fires only when Active View criteria are met.
- **Check:** Confirm whether Prebid actually rendered, whether an iframe load applies, and whether the filled slot had a chance to become viewable.
- **Do:** Do not emit a failure for these absences. Mark them pending or not-applicable unless their documented preconditions were met.
- **Backend implementation:** This is a gating rule, not a lifecycle failure. Do not fail other rules solely because `bidWon`, `slotOnload`, or `impressionViewable` is missing. Expect `bidWon` only after Prebid render of that `adId`; expect `slotOnload` only after a filled iframe-based `slotRenderEnded`; expect `impressionViewable` only after a filled render plus enough time on-screen. Otherwise record pending/not-applicable, or emit nothing.

---



## Common Prebid-only issues



### COMMON-PB-01 — Prebid does not load or become ready

- **Severity:** Critical
- **Signal:** Prebid intent exists (queue, global, or script), but `pbjs.libLoaded` never becomes `true` and no Prebid events appear.
- **Why it happens:** Script failed/was blocked, the wrong global is observed, the queue was overwritten, or initialization threw.
- **Check:** Inspect the Prebid script request, console, `window._pbjsGlobals`, `pbjs.libLoaded`, and `pbjs.que`/`pbjs.cmd`.
- **Do:** Fix the script/global/initialization failure and wait for the Prebid queue before calling its APIs.
- **Backend implementation:** Require Prebid intent (`que`/`cmd` activity, `_pbjsGlobals`, or a Prebid script request). After the boot wait, report if `libLoaded` is still not `true`. Confirmed when the script is blocked/failed; likely when intent exists but readiness never appears. If `_pbjsGlobals` lists a different name than the observed global, say so. Do not require `version` for this check.



### COMMON-PB-02 — Auction is never started

- **Severity:** Critical
- **Signal:** Prebid is ready and ad units exist, but neither `requestBids` nor `auctionInit` occurs.
- **Why it happens:** Publisher control flow skipped `requestBids()`, a component did not mount, or an earlier exception interrupted execution.
- **Check:** Inspect Prebid event history, the wrapped `requestBids` call site, and console.
- **Do:** Correct the publisher flow so the intended auction starts once.
- **Backend implementation:** Require `libLoaded` and at least one registered ad unit. Report after a grace period if there is no wrapped `requestBids` call and no `requestBids`/`auctionInit` event. Lower confidence when observation started after page setup.



### COMMON-PB-03 — Requested ad unit is missing or excluded

- **Severity:** Critical
- **Signal:** `requestBids`/`auctionInit` references an unknown `code`, or an expected slot code is absent from `auctionInit.adUnitCodes`.
- **Why it happens:** Typo, stale/renamed slot code, per-call `adUnitCodes` filter, labels, or the unit was added after the request.
- **Check:** Compare exact strings: `pbjs.adUnits[].code` vs `requestBids` options vs `auctionInit.adUnitCodes`.
- **Do:** Register the ad unit before the auction and include its canonical code in the request.
- **Backend implementation:** Snapshot registered codes from `pbjs.adUnits` plus wrapped `addAdUnits`. Compare with `requestBids` `adUnits`/`adUnitCodes` and `auctionInit.adUnitCodes`. Emit for an unknown requested code, or for a live GPT slot whose element id/path is not in that auction’s `adUnitCodes`. Labels are explanation only, not part of the match.



### COMMON-PB-04 — Duplicate ad-unit code

- **Severity:** High
- **Signal:** The same `code` is registered twice as an accidental copy (SPA remount / duplicate `addAdUnits`), not as an intentional twin-code split.
- **Why it happens:** SPA remount, duplicate component registration, or configuration appends stale definitions. Prebid officially allows twin codes when the definitions differ (different bidders or media types); that is not this issue.
- **Check:** Group live `pbjs.adUnits` and each `auctionInit.adUnits` array by exact `code`. Treat identical repeated definitions as accidental; treat different bidder/media-type splits as twin codes.
- **Do:** Keep one live definition per code unless twin codes are intentional.
- **Backend implementation:** Reconstruct the live list from the initial `pbjs.adUnits` snapshot plus `addAdUnits`/`removeAdUnit`. Group by exact `code`. Emit only when two or more definitions for a code are effectively the same (same bidders and media types), which is the remount/duplicate-registration case. Do not flag official twin-code setups.



### COMMON-PB-05 — No usable bidder is configured

- **Severity:** High
- **Signal:** Auction starts for the slot but emits no `bidRequested` for that ad unit.
- **Why it happens:** Empty `bids`, missing adapter in the build, invalid bidder name, labels, unsupported media type, or consent filtering.
- **Check:** Inspect the auction ad unit’s `bids` array and whether any `bidRequested` fired for that `auctionId` + ad unit.
- **Do:** Correct the publisher configuration/build; BidShitter must not add bidders.
- **Backend implementation:** For each ad unit in `auctionInit`, look for a matching `bidRequested` in the same `auctionId`. If none, emit. If the unit’s `bids` array is empty (and it is not a stored-impression/`ortb2Imp` unit), that is sufficient explanation. Do not require `installedModules` or `tcf2Enforcement` to fire the issue; use them only as optional evidence.



### COMMON-PB-06 — Banner sizes are missing or invalid

- **Severity:** High
- **Signal:** A banner ad unit has no usable `mediaTypes.banner.sizes` (or `format`), so the auction cannot request valid banner dimensions.
- **Why it happens:** Empty/malformed `mediaTypes.banner.sizes`, sizes left only on the deprecated top-level `sizes`, or non-numeric/non-positive pairs.
- **Check:** Read `mediaTypes.banner.sizes` (or `format`) on the auction ad unit. Legacy top-level `sizes` is fallback only.
- **Do:** Declare valid sizes in `mediaTypes.banner.sizes` (or `format`).
- **Backend implementation:** On `addAdUnits` and `auctionInit`, for units with `mediaTypes.banner`, require `sizes` as a `[w,h]` pair or an array of pairs (or a `format` array). Reject empty, non-numeric, or non-positive values. Skip video/native-only units. Do not use `bidResponse` dimensions or `beforeBidderHttp` for this rule; invalid returned sizes are `bidRejected` (COMMON-PB-09).



### COMMON-PB-07 — Bidder returns no bid

- **Severity:** Info
- **Signal:** `noBid` fires for a requested bidder/ad unit.
- **Why it happens:** Bidder intentionally declined or had no eligible demand.
- **Check:** Distinguish `noBid` from `bidTimeout`, `bidderError`, and `bidRejected`.
- **Do:** Treat as a normal bidder outcome unless commercial expectations require investigation.
- **Backend implementation:** On `noBid`, store it as that request’s terminal outcome (`auctionId`, bidder, ad unit, request id). Skip emitting when the same request already has `bidTimeout`, `bidderError`, or `bidRejected`.



### COMMON-PB-08 — Bidder or auction times out

- **Severity:** Info
- **Signal:** `bidTimeout` and/or `auctionTimeout` fires.
- **Why it happens:** Slow bidder, all 13network, timeout too short, or other work consumed auction time.
- **Check:** Use the events plus `auctionInit.timeout` (or `bidderTimeout` config).
- **Do:** Fix upstream latency or tune timeout using measured value-versus-delay trade-offs.
- **Backend implementation:** Emit from `bidTimeout` (payload is the timed-out bid-request array) and `auctionTimeout`. Attach the auction’s `timeout` from `auctionInit`. Do not infer a cause. A late `bidResponse` after the deadline is optional evidence, not a second required check.



### COMMON-PB-09 — Bid response is malformed or rejected

- **Severity:** High
- **Signal:** `bidRejected` fires for a reason other than the price floor.
- **Why it happens:** Invalid CPM/currency/request ID/size/media type/creative fields, disallowed bidder code, DSA, `maxBid`, or adapter/backend contract mismatch.
- **Check:** Read `bidRejected` and its `REJECTION_REASON`.
- **Do:** Correct the bidder response or adapter mapping; do not retain raw creative or identity data.
- **Backend implementation:** Emit from `bidRejected` when the reason is not `Bid does not meet price floor`. Keep the documented reason and safe scalars only (`bidder`, `cpm`, `currency`, `requestId`, `mediaType`, width/height). Never persist response bodies, `ad`, `adm`, VAST, native assets, or identity/consent. Do not use `bidderError` here — that is a failed HTTP/adapter call (COMMON-NET-02 / COMMON-PB-11).



### COMMON-PB-10 — Bid is below the configured floor

- **Severity:** Info
- **Signal:** `bidRejected` reason is `Bid does not meet price floor`.
- **Why it happens:** Effective bid CPM is below the resolved floor after currency and rule selection.
- **Check:** Match that exact `REJECTION_REASON`. Attach CPM/currency/size from the payload when present.
- **Do:** Verify floor configuration; otherwise treat the rejection as intentional.
- **Backend implementation:** Match `bidRejected` whose reason is `Bid does not meet price floor` (the Prebid `REJECTION_REASON.FLOOR_NOT_MET` string). Attach CPM, currency, media type, and size from the payload if present. Do not infer a floor value Prebid did not expose.



### COMMON-PB-11 — Auction ends with no eligible bid

- **Severity:** Info
- **Signal:** `auctionEnd` occurs with no eligible/winning bid for the ad unit.
- **Why it happens:** Every bidder returned no-bid, timed out, errored, was blocked, or was rejected.
- **Check:** Reconcile requested bidders to a terminal outcome.
- **Do:** Show the individual causes instead of reporting only “no bids.”
- **Backend implementation:** At `auctionEnd`, if that ad unit has no usable `bidsReceived`/`winningBids`, emit a summary. Count matching `noBid`, `bidTimeout`, `bidderError`, and `bidRejected` for the same `auctionId` (and ad unit when the event carries one). That is the check; a full request-id ledger is unnecessary.



### COMMON-PB-12 — Auction never completes or continuation callback fails

- **Severity:** Critical
- **Signal:** `auctionInit` has no matching `auctionEnd` after the auction timeout, or the supplied `bidsBackHandler` throws.
- **Why it happens:** Adapter/core exception, stuck completion accounting, invalid callback, or page teardown.
- **Check:** Match `auctionInit` → `auctionEnd` by `auctionId`. Observe `bidsBackHandler` invocation/throw via a transparent wrap.
- **Do:** Fix the stuck lifecycle/callback and make continuation idempotent and bound to the correct auction.
- **Backend implementation:** For each `auctionInit`, wait `auction.timeout + grace` for the same `auctionId`’s `auctionEnd`. If it never arrives, emit a stall. Separately, if the wrapped `bidsBackHandler` threw, emit callback failure. Do not treat a missing GPT handoff as this rule (that is COMMON-INT-03).



### COMMON-PB-13 — Prebid render cannot resolve or use the selected creative

- **Severity:** Critical
- **Signal:** `adRenderFailed` fires.
- **Why it happens:** Unknown `adId`, missing markup, render on the main document, missing doc/adId, or a render exception.
- **Check:** Read `adRenderFailed.reason` and whether `adId` resolves to a known bid.
- **Do:** Use the current selected bid and supported iframe/renderer path; correct the underlying creative error.
- **Backend implementation:** Subscribe to `adRenderFailed`. Use the documented `AD_RENDER_FAILED_REASON` values: `cannotFindAd`, `noAd`, `preventWritingOnMainDocument`, `missingDocOrAdid`, `exception`. Resolve `adId` against captured `bidResponse` objects when present. Record whether creative data existed — never the creative itself. `staleRender` is COMMON-PB-14; `expiredRender` is a separate event, not this rule.



### COMMON-PB-14 — Bid is rendered more than once (staleRender)

- **Severity:** Critical
- **Signal:** The Prebid `staleRender` event fires (a bid whose status is already `rendered` is being rendered again). This is an event (`pbjs.onEvent('staleRender', ...)`), not a `pbjs.staleRender()` method.
- **Why it happens:** Refresh reused an old `adId`, bid caching was mishandled, duplicate render callbacks ran, or auto-refresh called `renderAd` / winning-bid render twice. Prebid emits `staleRender` before `bidWon`; the creative still renders unless `auctionOptions.suppressStaleRender` is `true`.
- **Check:** Read the `staleRender` bid payload: `adId`, `adUnitCode`, `auctionId`, `bidder`, `status`, CPM/size/mediaType when present. Compare with the earlier render/`bidWon` for that `adId`. Do not keep creative markup.
- **Do:** Use a fresh unused bid per render, make render callbacks idempotent, and consider `pbjs.setConfig({ auctionOptions: { suppressStaleRender: true } })`.
- **Backend implementation:** Subscribe to `staleRender`. Emit one Critical issue per event. Attach `adUnitCode` / `auctionId` from the bid payload and summarize those fields in evidence. Never persist `ad` / `adm` / native markup.

---



## Common GPT/GAM-only issues



### COMMON-GPT-01 — GPT does not load or become ready

- **Severity:** Critical
- **Signal:** GPT intent exists (command queue or gpt.js request), but `googletag.apiReady` never becomes true.
- **Why it happens:** Script was blocked/failed, wrong URL, queue overwritten, or the library never booted.
- **Check:** Inspect the official GPT script request, `googletag.cmd`, and `googletag.apiReady`.
- **Do:** Fix GPT loading and run API calls through the command queue.
- **Backend implementation:** Require GPT intent (`cmd` activity or a `gpt.js` / `securepubads` script request). After the boot wait, report if `apiReady` is still not true. Confirmed when that script is blocked/failed. `pubadsReady` is not the load signal — it flips only after `enableServices()`. Do not require `getVersion()`.



### COMMON-GPT-02 — GPT slot is not defined or attached correctly

- **Severity:** Critical
- **Signal:** `defineSlot` / `defineOutOfPageSlot` returns `null`, or the slot never receives `addService(googletag.pubads())`.
- **Why it happens:** Invalid arguments/size, unsupported definition, or PubAds was not attached.
- **Check:** Inspect the definition return value and whether `addService(pubads)` ran for that slot.
- **Do:** Define a valid slot and attach PubAdsService before requesting it.
- **Backend implementation:** Wrap `defineSlot` and `defineOutOfPageSlot`. If the return is `null`, emit. If a slot is created but no `addService` for PubAds is observed, emit. Optional: a later `destroySlots` explains absence from `pubads().getSlots()` and should not be reported as a failed definition.



### COMMON-GPT-03 — Initial load disabled but refresh never occurs

- **Severity:** Critical
- **Signal:** `display()` runs with initial load disabled, but no later `refresh()` or `slotRequested` occurs for that slot.
- **Why it happens:** Auction callback/failsafe failed, early return, or the refresh path was omitted.
- **Check:** Confirm disable-initial-load, then wait for `refresh` or `slotRequested` after `display()`.
- **Do:** Ensure one guarded path eventually refreshes the intended slot.
- **Backend implementation:** Detect disable-initial-load from `googletag.setConfig({ disableInitialLoad: true })` or legacy `pubads().disableInitialLoad()`, set before `enableServices`. After each `display`, wait the auction/failsafe window for a matching `refresh` or `slotRequested`. Skip while GPT lazy-load is active and the slot has not entered the fetch margin. Targeting handoff is not required for this GPT-only check.



### COMMON-GPT-04 — Refresh occurs before display

- **Severity:** High
- **Signal:** `refresh()` targets a slot that has not yet been `display()`ed.
- **Why it happens:** Async component/setup race. GPT only refreshes slots already registered with `display()`.
- **Check:** Compare per-slot `display` and `refresh` timestamps.
- **Do:** `display()` / register the slot before refreshing it.
- **Backend implementation:** Expand `refresh(slots?)` to the explicit slot IDs, or to all live PubAds slots when the argument is omitted. If a targeted slot has no prior `display()`, emit. Confirmed for an explicit slot list; likely when the target set is inferred from an unscoped `refresh()`.



### COMMON-GPT-05 — Duplicate initial GAM requests

- **Severity:** High
- **Signal:** With initial load still enabled, `display()` fetches the slot and an immediate `refresh()` fetches it again.
- **Why it happens:** Initial load remains enabled while the publisher also uses `refresh()` as the first-request mechanism. Prebid integrations should disable initial load.
- **Check:** `disableInitialLoad` was not set, then `display` + `refresh` for the same slot produce two GAM requests.
- **Do:** Choose one first-request strategy; Prebid integrations normally disable initial load.
- **Backend implementation:** Only when initial load was not disabled. Parse `hb_adid` from each `/gampad/ads` `prev_scp` (later request) and `scp` (first request). Map `hb_adid` → distinct correlators; emit when the same id appears on two GAMPAD calls within the short window. Fall back to the same `iu` path with two correlators when `hb_adid` is absent. One SRA HTTP call (shared correlator, multiple slots) is not a duplicate.



### COMMON-GPT-06 — Refresh requests the wrong or every slot

- **Severity:** High
- **Signal:** `refresh()` is called with a stale/destroyed/wrong slot, or with no slot array when only a subset was intended.
- **Why it happens:** Omitted slot array, stale component state, or a destroyed slot object. Unscoped `refresh()` is valid GPT API usage and refreshes every registered slot.
- **Check:** Compare `refresh` arguments with live `pubads().getSlots()` and the current auction’s intended ad units.
- **Do:** Refresh the explicit current slot array when only some slots should be requested.
- **Backend implementation:** If `refresh(slots)` has an explicit list, emit when a target is missing from the live PubAds set or is not the intended ad unit. If `refresh()` has no arguments, emit only when live slots include units outside the current auction/intended set. Do not flag a delayed lazy-loaded request as a wrong target.



### COMMON-GPT-07 — GAM request fails or never completes

- **Severity:** Critical
- **Signal:** `slotRequested` occurs but the GAM request is blocked/fails, or `slotResponseReceived` never follows.
- **Why it happens:** Ad blocker/browser policy, connection failure, cancellation/navigation, or a bad GAM request.
- **Check:** Matching `/gampad/ads` transport status, then `slotResponseReceived` for that slot.
- **Do:** Fix the observed browser/network/request failure; do not invent a cause when transport evidence is missing.
- **Backend implementation:** Correlate each `slotRequested` with a `/gampad/ads` (or `/gampad/ad`) call by timestamp, `iu`/slot path, and SRA membership. Confirmed on blocked transport, cancellation, or HTTP 4xx/5xx. Wait the GAM-response threshold for `slotResponseReceived` if transport looks fine. HTTP **200** is success even when the slot is empty; HTTP **204** is a successful no-fill, not this failure (COMMON-GPT-09). Downgrade confidence when no GAMPAD request was visible or the page navigated away.



### COMMON-GPT-08 — GAM responds but rendering never completes

- **Severity:** Critical
- **Signal:** `slotResponseReceived` occurs without a later matching `slotRenderEnded`.
- **Why it happens:** Render exception, slot destruction, blocked creative processing, main-thread stall, or a missed observer.
- **Check:** Wait a render threshold after `slotResponseReceived` for `slotRenderEnded` on the same slot.
- **Do:** Fix the render/slot lifecycle problem or reproduce with early instrumentation.
- **Backend implementation:** Start a per-slot timer at `slotResponseReceived` and cancel it on the next matching `slotRenderEnded`. After the threshold, emit a render timeout. Mention `destroySlots` if it happened in between; do not require console/long-task/DOM speculation to fire the issue.



### COMMON-GPT-09 — GAM returns no fill

- **Severity:** Info
- **Signal:** `slotRenderEnded.isEmpty === true`.
- **Why it happens:** No eligible GAM demand, targeting/size mismatch, policy restriction, or inventory/delivery configuration.
- **Check:** The `isEmpty` flag on `slotRenderEnded`. HTTP 200/204 on GAMPAD is not a network failure.
- **Do:** Investigate GAM eligibility/delivery; do not label this as network failure.
- **Backend implementation:** Emit from `slotRenderEnded.isEmpty === true` on the current request cycle. Attach ad-unit path, requested sizes, sanitized request-time targeting, and `responseIdentifier` when present. Do not infer the GAM delivery reason from empty alone.

---



## Common Prebid + GPT/GAM integration issues



### COMMON-INT-01 — GAM refresh occurs before Prebid auction completion

- **Severity:** High
- **Signal:** `refresh()` / `slotRequested` for the auction’s slot occurs after that auction’s `auctionInit` and before its `auctionEnd`.
- **Why it happens:** GPT starts independently, callback ordering is wrong, or failsafe fires too early.
- **Check:** Compare timestamps on the same `auctionId` and matched slot, not the latest global auction.
- **Do:** Request GAM from the matching auction-completion path with a properly delayed guarded failsafe.
- **Backend implementation:** For each `auctionInit`, take its `adUnitCodes` and matched GPT slots. If `refresh` or `slotRequested` for those slots has `auctionInit.ts < event.ts < auctionEnd.ts` (or `auctionEnd` never arrived), emit. Bind by `auctionId` + slot/ad unit. Configured timeout is optional evidence.



### COMMON-INT-02 — Targeting is generated before auction completion

- **Severity:** High
- **Signal:** `setTargetingForGPTAsync` / Prebid `setTargeting` runs before that auction’s `auctionEnd`.
- **Why it happens:** Targeting is called immediately after `requestBids()` or from an early bidder callback, so GPT may receive incomplete bids.
- **Check:** Timestamp of wrapped `setTargetingForGPTAsync` or the `setTargeting` event vs that `auctionId`’s `auctionEnd`.
- **Do:** Generate targeting only after the auction decision is finalized.
- **Backend implementation:** Link `setTargetingForGPTAsync` and the Prebid `setTargeting` event to the affected ad units, then compare with that cycle’s `auctionEnd`. Do not use “most recent auction” when auctions overlap. Ignore GPT `slot.setTargeting` / page targeting — those are not Prebid targeting generation.



### COMMON-INT-03 — Auction completes but targeting is never applied

- **Severity:** High
- **Signal:** Eligible bids exist at `auctionEnd`, but no `setTargetingForGPTAsync` / `setTargeting` runs before the slot’s next GAM request.
- **Why it happens:** Missing handoff call, callback exception, wrong branch, or GPT unavailable.
- **Check:** `auctionEnd` with bids, then absence of targeting apply before `slotRequested`.
- **Do:** Apply targeting on the completed-auction path before requesting GAM.
- **Backend implementation:** At `auctionEnd`, if the ad unit has eligible bids, require a matching `setTargetingForGPTAsync` call or `setTargeting` event before that slot’s next `slotRequested`. If GAM is requested with no targeting apply in between, emit. A `getAdserverTargeting`* snapshot is optional to distinguish “never generated” from “generated but not applied.”



### COMMON-INT-04 — Targeting is applied after refresh

- **Severity:** High
- **Signal:** `refresh()` / `slotRequested` happens before Prebid targeting is written, so the GAM request snapshot misses `hb_`*.
- **Why it happens:** Async ordering mistake. GPT snapshots targeting at `display()`/`refresh()` time; later writes miss that request.
- **Check:** Compare targeting-write time with `slotRequested` time and the slot targeting captured at request.
- **Do:** Apply targeting first, then refresh.
- **Backend implementation:** Treat `display`/`refresh` as GPT snapshot boundaries. If `setTargetingForGPTAsync` / `setTargeting` for this slot runs after `slotRequested`, and request-time slot targeting / GAMPAD `cust_params` lacked those `hb_`* keys, emit. Same ad-serving cycle only.



### COMMON-INT-05 — Prebid and GPT slot identifiers do not match

- **Severity:** Critical
- **Signal:** Prebid `adUnit.code` matches neither the GPT element id nor the GAM ad-unit path, and no custom matcher resolves it.
- **Why it happens:** Typo, renamed DOM id, or the publisher expected path matching / custom matching that is not configured.
- **Check:** Compare `adUnit.code` with `getSlotElementId()` and `getAdUnitPath()`. Honor `customGptSlotMatching` when captured.
- **Do:** Align identifiers, or configure `customGptSlotMatching` for an intentional one-to-one mapping.
- **Backend implementation:** For each auction ad-unit code, match live GPT slots with Prebid’s default (`code === getSlotElementId() || code === getAdUnitPath()`) or the captured `customGptSlotMatching` result. If zero slots match, emit this mismatch. Do not treat a path-only match as a failure. Do not require `hb_adid` checks here (COMMON-INT-08 / 09).



### COMMON-INT-06 — GPT slot is missing or matching is ambiguous

- **Severity:** Critical
- **Signal:** At handoff, zero GPT slots match the Prebid ad unit, or more than one slot matches.
- **Why it happens:** Slot setup did not run, definition failed, duplicate ids/slots exist, or the custom matcher is too broad.
- **Check:** Run the same matcher over `pubads().getSlots()` at targeting/refresh time.
- **Do:** Define one intended slot and make mapping deterministic.
- **Backend implementation:** At `setTargetingForGPTAsync` / `auctionEnd`, match as in COMMON-INT-05. Emit `missing` for zero candidates and `ambiguous` for more than one. Attach a null `defineSlot` or duplicate element id when that evidence already exists. Missing is this rule; identifier mismatch with slots present is COMMON-INT-05.



### COMMON-INT-07 — Targeting is empty despite eligible bids

- **Severity:** High
- **Signal:** The auction has valid bids for the ad unit, but the generated targeting map for that code has no `hb_`* keys.
- **Why it happens:** Wrong auction/slot scope, bid expired/used, `bidTargetingExclusion` / targeting key filters, or eligibility/size problem.
- **Check:** Eligible `bidResponse` at `auctionEnd` vs empty `setTargeting` payload / `getAdserverTargetingForAdUnitCode`.
- **Do:** Correct scope/filter/timing or run a fresh auction.
- **Backend implementation:** When the ad unit has an eligible bid at `auctionEnd` and targeting is applied or inspected, emit if that code’s targeting map has no `hb_`* keys. Optional evidence: bid `status`, TTL expiry, `bidTargetingExclusion`. Do not require those fields to fire the issue.



### COMMON-INT-08 — Required `hb_*` keys are missing or not applied to GPT

- **Severity:** Critical
- **Signal:** After targeting apply, the matched GPT slot’s request-time targeting is missing `hb_adid`, `hb_pb`, or `hb_bidder` (and `hb_size` for banner).
- **Why it happens:** Incomplete bid metadata, `targetingControls.allowTargetingKeys` / send-all-bids limits, slot-matching failure, or later clearing.
- **Check:** Diff Prebid `setTargeting` output with GPT slot targeting captured at `slotRequested`.
- **Do:** Fix metadata/filter/matching and ensure required keys reach the intended request unchanged.
- **Backend implementation:** After a targeting apply, at the next `slotRequested` for that slot, require `hb_adid`, `hb_pb`, and `hb_bidder`. Also require `hb_size` when the candidate is banner. Compare generated Prebid targeting vs the GPT slot snapshot at request time; emit at the first stage a required key is missing or changed. Do not require `hb_size` for native/video-only. GAMPAD `cust_params` is optional confirmation, not a required fourth stage.



### COMMON-INT-09 — Stale targeting from a previous auction is reused

- **Severity:** Critical
- **Signal:** The current GAM request still carries an `hb_adid` from an earlier auction, or carries `hb_`* after the current auction had no eligible bid.
- **Why it happens:** Old keys were not cleared, refresh bypassed current handoff, or overlapping cycles share GPT targeting.
- **Check:** Resolve request-time `hb_adid` to its bid’s `auctionId` and compare with the current cycle.
- **Do:** Bind targeting to the current cycle and clear obsolete keys before the new request.
- **Backend implementation:** Keep `adId → { auctionId, adUnitCode, responseTime, ttl }`. At `slotRequested`, resolve `hb_adid` from slot targeting. Emit if that bid’s `auctionId` is not the current cycle for this slot, or if the current cycle had no eligible bid but `hb_`* is still present.



### COMMON-INT-10 — Prebid and GPT sizes disagree

- **Severity:** High
- **Signal:** Winning `hb_size` is not in the GPT slot’s active size set.
- **Why it happens:** Prebid `mediaTypes.banner.sizes` and GPT `defineSlot` / `defineSizeMapping` sizes diverged. Official guidance is that Prebid sizes should match GPT sizes.
- **Check:** Compare `hb_size` with `defineSlot` sizes (and the active size-mapping entry if one was captured).
- **Do:** Align eligible sizes across Prebid, GPT, and GAM.
- **Backend implementation:** Parse `hb_size` at request time. Compare it with the slot’s `defineSlot` size array. If `defineSizeMapping` was used, use the mapping entry that applies at request time when viewport is known; otherwise use the declared slot sizes. Emit when `hb_size` is absent from that set. Do not require GAMPAD `sz` or `slotRenderEnded.size` for this rule.



### COMMON-INT-11 — Failsafe and auction callback both request GAM

- **Severity:** High
- **Signal:** Two near-adjacent `refresh()` calls or GAMPAD requests follow one auction for the same slot.
- **Why it happens:** Missing shared idempotency guard, or failsafe fires while/after the callback also refreshes.
- **Check:** Two distinct refreshes or two GAMPAD requests for the same slot shortly after `auctionEnd`.
- **Do:** Route callback and failsafe through one function that sets the guard before queuing GPT work.
- **Backend implementation:** After `auctionEnd` for a slot, if two `refresh` calls or two `/gampad/ads` requests hit that slot inside the duplicate window, emit. Require distinct HTTP requests — SRA’s multiple `slotRequested` events from one call are not this issue. Call stacks are optional.



### COMMON-INT-12 — New auction starts before prior GPT cycle finishes

- **Severity:** High
- **Signal:** A new `auctionInit` for the same ad unit arrives before the prior cycle’s `slotRenderEnded` (or empty/failed terminal).
- **Why it happens:** Aggressive refresh timer, multiple refresh owners, or missing in-flight guard.
- **Check:** Per slot, compare successive `auctionInit` times with the prior cycle’s GPT terminal event.
- **Do:** Serialize the slot lifecycle unless overlap is deliberate and safely correlated.
- **Backend implementation:** Per ad unit/slot, if a new `auctionInit` arrives before the previous cycle reaches `slotRenderEnded` (including `isEmpty`) or a recorded GAM failure, emit with both `auctionId`s. No extra state-machine stages are required.

---



## Common browser and request issues



### COMMON-NET-01 — Request blocked by ad blocker or browser policy

- **Severity:** High
- **Signal:** A Prebid/GPT script, bidder request, GAM request, or creative is blocked in DevTools, or Prebid emits `browserIntervention`.
- **Why it happens:** Ad-blocking extension, browser privacy protection, a URL matching a block list, or a Chrome intervention (for example heavy-ad unload). `browserIntervention` is not the same as an ad blocker.
- **Check:** DevTools blocked reason / `loadingFailed`; Prebid `browserIntervention` for rendered creatives.
- **Do:** Report environmental blocking; do not attempt to evade user-selected privacy tools.
- **Backend implementation:** Emit from DevTools blocked/failed-with-blocked-reason metadata, classified by script, bidder, GAM, or creative. Also emit from Prebid `browserIntervention` (`{ bid, adId, intervention }`) as a browser-policy unload of a rendered creative. Include origin/path and the browser reason; strip query identifiers. Never retry, rewrite, or bypass the request.



### COMMON-NET-02 — Bidder or GAM request returns an error or stalls

- **Severity:** High
- **Signal:** A bidder or GAMPAD request is pending too long, canceled, or returns a failing HTTP status, and the expected lifecycle does not continue.
- **Why it happens:** Endpoint/backend failure, invalid request, rate limiting, navigation, or connection problem.
- **Check:** Request status, duration, cancellation, plus `bidderError` for bidders and `slotResponseReceived` for GAM.
- **Do:** Fix or escalate the observed request/endpoint failure; avoid guessing a low-level cause without evidence.
- **Backend implementation:** Track start/finish/failure by DevTools request id. Emit for non-success HTTP status (bidder or GAMPAD 4xx/5xx), cancellation, or pending beyond the threshold. Link bidder calls with `beforeBidderHttp` / `bidderError`. GAMPAD 200/204 is not this issue. Distinguish an observed transport failure from a lifecycle timeout with no visible request.

---



## Common CMP / TCF issues



### COMMON-CMP-01 — TCF2 enforcement blocked demand, storage, or data

- **Severity:** Critical
- **Signal:** Prebid `tcf2Enforcement` reports a non-empty `biddersBlocked`, `analyticsBlocked`, `storageBlocked`, `eidsBlocked`, `ufpdBlocked`, or `geoBlocked` list.
- **Why it happens:** The CMP did not provide sufficient TCF2 legal basis (consent or legitimate interest) for the purpose, vendor signal, or special feature; consent arrived late; or `consentManagement.gdpr` / `tcfControl` rules disallow the activity. This event is emitted by the `tcfControl` module on `auctionEnd`.
- **Check:** Read the `tcf2Enforcement` payload lists and `pbjs.getConsentMetadata()`. Confirm the CMP is ready before `requestBids`, that `tcfControl` is in the build, and which purpose/vendor rules are configured.
- **Do:** Fix CMP/consent timing and configuration, or accept the restricted auction. Never bypass, rewrite, or fabricate consent in the debugger.
- **Backend implementation:** Subscribe to `tcf2Enforcement`. If any of the six lists is non-empty, emit one confirmed critical issue for that event. Attach `auctionId` from the preceding `auctionEnd`. Include sanitized names from each list as evidence. Do not store TCF strings, TC strings, or cookie identifiers from other snapshots. An empty event (all lists empty) is not this issue.


