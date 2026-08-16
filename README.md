# BidShitter — Prebid + GPT Debugger

A **passive** Chrome DevTools extension (Manifest V3) that visualizes the full
ad-serving lifecycle for pages using **Prebid.js** and the **Google Publisher
Tag (GPT / Google Ad Manager)**. It observes the page, correlates Prebid
auctions with GPT slots, and presents a chronological, slot-centric explanation
of how an advertisement rendered.

> Observe-only: BidShitter never starts auctions, applies targeting, refreshes
> ads, or changes any Prebid/GPT config. Every wrapper calls the original
> function unchanged.

Implements [`01_practice/spec.md`](../01_practice/spec.md).

## Features

- **Timeline** — hook boot → library readiness → slot define → auction → bids →
  targeting → GAM request/response → render → viewability, with expandable
  payloads (FR1).
- **Bids** — per auction × ad unit: participants, winner, CPM (orig vs adjusted),
  media type, size, deal, status, time-to-respond, and no-bid / timeout /
  rejected / error outcomes (FR2).
- **Targeting** — Prebid `hb_*` key-values plus GPT page targeting, with a
  race warning when `refresh`/`display` ran before Prebid targeting (FR3).
- **Events** — filterable, virtualized log of all Prebid (`pbjs.onEvent`) and
  GPT (`pubads().addEventListener`) events plus hook-observed API calls (FR4).
- **GPT** — slot registry, `display`/`refresh`, render result, viewability, and
  privacy flags (FR5).
- **Correlation** — joins Prebid `adUnit.code` to GPT `slot.getSlotElementId()`
  and flags mismatches (FR7).

## Architecture

```
inspected page (MAIN world)         extension
┌───────────────────────┐           ┌──────────────────────────────┐
│ page-hook.js          │ postMessage│ content-script.js (ISOLATED) │
│  wraps pbjs.que/cmd   │──────────▶ │  forwards to background      │
│  wraps googletag.cmd  │           │            │ runtime.sendMessage
│  onEvent / addEventL. │           │            ▼                  │
│  read-only snapshots  │           │ background.js (service worker)│
└───────────────────────┘           │  ring buffer per tab (5k cap) │
                                     │            │ port by tabId    │
                                     │            ▼                  │
                                     │ DevTools panel (React)        │
                                     └──────────────────────────────┘
```

- **`page-hook.ts`** runs at `document_start` in the page **MAIN world** so it
  wraps the Prebid/GPT command queues *before* the publisher's first `push`.
- **`content-script.ts`** (isolated world) validates and relays messages.
- **`background.ts`** keeps a per-tab in-memory ring buffer and fans out to the
  panel; a fresh navigation resets the buffer.
- **`panel/`** is a Vite + React + Tailwind app rendered inside the DevTools panel.

## Build

Requires Node.js >= 20.

```bash
cd BidShitter
npm install
npm run build
```

This produces `BidShitter/dist/` containing:

- `manifest.json`, `devtools.html`, `index.html` (panel)
- `background.js`, `content-script.js`, `page-hook.js` (single-file IIFE bundles)
- `assets/*` (panel + devtools JS/CSS)

The build runs four Vite passes (see `package.json`): the pages/panel app, then
the background, content script, and MAIN-world hook as standalone classic
scripts. The `dist/` is only fully populated after `npm run build` finishes.

For iterative work: `npm run build -- --watch` rebuilds the panel; re-run the
`build:hook` / `build:content` / `build:background` scripts when you change those
files, then hit the reload icon on the extension card.

## Load unpacked

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. **Load unpacked** → select `BidShitter/dist`.
4. Open any page that uses Prebid + GPT, open **DevTools** (F12), and select the
   **BidShitter** panel.
5. **Reload the page with the panel open** so the hook installs at
   `document_start` and captures the full boot sequence.

## Test with the repo's hello_world page

The repo ships a Prebid + GPT example at
[`integrationExamples/gpt/hello_world.html`](../integrationExamples/gpt/hello_world.html).
Serve the built Prebid bundle + example (from the repo root), e.g.:

```bash
# from the Prebid.js repo root
gulp serve            # or: gulp serve-fast
```

Then open the served `integrationExamples/gpt/hello_world.html`, open DevTools →
BidShitter, and reload. You should see (AT1):

`hook-ready → googletag disableInitialLoad → defineSlot → enableServices →
display → pbjs libLoaded → addAdUnits → requestBids → auctionInit → bid events →
auctionEnd → setTargeting / setTargetingForGPTAsync → refresh → slotRequested →
slotResponseReceived → slotRenderEnded`.

## Permissions

`host_permissions: ["<all_urls>"]` is required to hook arbitrary publisher
pages. `storage` is used only for `chrome.storage.session` (in-memory, not
written to disk): Chrome MV3 service workers are killed after ~30s idle, so the
per-tab event buffer is restored from session storage when the worker wakes.
The buffer is cleared when the tab closes, the page navigates, or Chrome exits.

## Privacy / safety

- Creative markup (`ad`, `vastXml`, `native`, …) is stripped from payloads by
  default.
- Consent strings (TCF/GPP/USP) are redacted; only `getConsentMetadata()` flags
  and GPT privacy-setting keys are shown.
- Payloads are depth/size-capped and cycle-safe before leaving the page.

## Known limitations (v1)

- Top inspected frame only (no Prebid inside ad iframes).
- Detects `window.pbjs` only (no custom Prebid global).
- No network HAR/waterfall; relies on events + `beforeBidderHttp`.
- UI primitives are shadcn-styled but self-contained (no `@radix-ui`) to keep the
  bundle small; they can be swapped for the official shadcn components later.
