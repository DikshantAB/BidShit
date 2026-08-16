// Pure derivations over the session state for the views.
import type { AuctionRecord, BidRow, Envelope, SessionState } from '../shared/types';

export function auctionList(s: SessionState): AuctionRecord[] {
  return Array.from(s.auctions.values()).sort((a, b) => (a.startTs || 0) - (b.startTs || 0));
}

/** True if this auction requested or received anything for `code`. */
export function auctionIncludesAdUnit(a: AuctionRecord, code: string): boolean {
  if (!code) return false;
  if (a.adUnitCodes.includes(code)) return true;
  const bags = [a.bidsReceived, a.noBids, a.bidsRejected, a.winningBids];
  for (const bag of bags) {
    for (const bid of bag as any[]) {
      if (bid?.adUnitCode === code) return true;
    }
  }
  for (const br of a.bidderRequests as any[]) {
    for (const bid of br?.bids || []) {
      if (bid?.adUnitCode === code) return true;
    }
  }
  return false;
}

export function auctionsForAdUnit(auctions: AuctionRecord[], code: string): AuctionRecord[] {
  if (!code) return auctions;
  return auctions.filter((a) => auctionIncludesAdUnit(a, code));
}

/** Most recent auction that includes this ad unit, if any. */
export function latestAuctionForAdUnit(auctions: AuctionRecord[], code: string): AuctionRecord | undefined {
  const matches = auctionsForAdUnit(auctions, code);
  return matches.length ? matches[matches.length - 1] : undefined;
}

function sizeStr(b: any): string | undefined {
  if (b?.size) return String(b.size);
  if (b?.width && b?.height) return `${b.width}x${b.height}`;
  return undefined;
}

function key(code?: string, bidder?: string): string {
  return `${code || '?'}::${bidder || '?'}`;
}

/**
 * Build the bid summary rows for one auction (FR2). Merges bidderRequests
 * (participants + TTR), bidsReceived, noBids, bidsRejected, and winningBids,
 * plus bidTimeout / bidderError events pulled from the raw log.
 */
export function bidRowsForAuction(s: SessionState, auctionId: string): BidRow[] {
  const a = s.auctions.get(auctionId);
  if (!a) return [];
  const rows = new Map<string, BidRow>();

  const wonIds = new Set<string>();
  for (const w of a.winningBids as any[]) {
    if (w?.adId) wonIds.add(w.adId);
    else if (w?.requestId) wonIds.add(w.requestId);
  }

  // Participants (also gives us adUnit coverage per bidder).
  for (const br of a.bidderRequests as any[]) {
    const bidder = br?.bidderCode || br?.bidder;
    for (const bid of br?.bids || []) {
      const code = bid?.adUnitCode;
      rows.set(key(code, bidder), {
        auctionId,
        adUnitCode: code,
        bidder,
        outcome: 'timeout', // provisional until we see a response/no-bid
        ttr: undefined,
      });
    }
  }

  for (const bid of a.bidsReceived as any[]) {
    const bidder = bid?.bidderCode || bid?.bidder;
    const code = bid?.adUnitCode;
    const won = (bid?.adId && wonIds.has(bid.adId)) || (bid?.requestId && wonIds.has(bid.requestId));
    rows.set(key(code, bidder), {
      auctionId,
      adUnitCode: code,
      bidder,
      mediaType: bid?.mediaType,
      cpm: bid?.cpm,
      originalCpm: bid?.originalCpm,
      currency: bid?.currency,
      size: sizeStr(bid),
      ttl: bid?.ttl,
      dealId: bid?.dealId,
      status: bid?.status,
      ttr: bid?.timeToRespond,
      outcome: won ? 'won' : 'bid',
      adId: bid?.adId,
      requestId: bid?.requestId,
      meta: bid?.meta,
      raw: bid,
    });
  }

  for (const nb of a.noBids as any[]) {
    const bidder = nb?.bidderCode || nb?.bidder;
    const code = nb?.adUnitCode;
    const k = key(code, bidder);
    if (!rows.has(k) || rows.get(k)!.outcome === 'timeout') {
      rows.set(k, { auctionId, adUnitCode: code, bidder, outcome: 'noBid' });
    }
  }

  for (const rj of a.bidsRejected as any[]) {
    const bidder = rj?.bidderCode || rj?.bidder;
    const code = rj?.adUnitCode;
    const existing = rows.get(key(code, bidder));
    rows.set(key(code, bidder), {
      ...existing,
      auctionId,
      adUnitCode: code,
      bidder,
      cpm: rj?.cpm ?? existing?.cpm,
      originalCpm: rj?.originalCpm ?? existing?.originalCpm,
      currency: rj?.currency ?? existing?.currency,
      size: sizeStr(rj) || existing?.size,
      mediaType: rj?.mediaType || existing?.mediaType,
      outcome: 'rejected',
      rejectionReason: pickRejectionReason(rj) || existing?.rejectionReason,
      adId: rj?.adId || existing?.adId,
      requestId: rj?.requestId || existing?.requestId,
      raw: rj,
    });
  }

  // Enrich with timeout / error / rejected events from the raw log for this auction.
  for (const env of s.envelopes) {
    if (env.channel !== 'prebid' || env.kind !== 'event') continue;
    if (env.auctionId && env.auctionId !== auctionId) continue;
    const p = env.payload as any;
    if (env.name === 'bidTimeout') {
      const list = Array.isArray(p) ? p : [p];
      for (const t of list) {
        const k = key(t?.adUnitCode, t?.bidderCode || t?.bidder);
        const existing = rows.get(k);
        if (!existing || existing.outcome === 'timeout') {
          rows.set(k, { auctionId, adUnitCode: t?.adUnitCode, bidder: t?.bidderCode || t?.bidder, outcome: 'timeout' });
        }
      }
    } else if (env.name === 'bidRejected') {
      const bidder = p?.bidderCode || p?.bidder;
      const code = p?.adUnitCode;
      const k = key(code, bidder);
      const existing = rows.get(k);
      rows.set(k, {
        ...existing,
        auctionId,
        adUnitCode: code,
        bidder,
        cpm: p?.cpm ?? existing?.cpm,
        originalCpm: p?.originalCpm ?? existing?.originalCpm,
        currency: p?.currency ?? existing?.currency,
        size: sizeStr(p) || existing?.size,
        mediaType: p?.mediaType || existing?.mediaType,
        status: p?.status || existing?.status,
        outcome: 'rejected',
        rejectionReason: pickRejectionReason(p) || existing?.rejectionReason,
        adId: p?.adId || existing?.adId,
        requestId: p?.requestId || existing?.requestId,
        meta: p?.meta || existing?.meta,
        raw: p || existing?.raw,
      });
    } else if (env.name === 'bidderError') {
      const req = p?.bidderRequest;
      const bidder = req?.bidderCode || p?.bidder;
      const reason = formatBidderError(p?.error);
      for (const bid of req?.bids || [{ adUnitCode: env.adUnitCode }]) {
        const k = key(bid?.adUnitCode, bidder);
        const existing = rows.get(k);
        // A later HTTP error should not hide a bid that already arrived / was rejected.
        if (existing && (existing.outcome === 'won' || existing.outcome === 'bid' || existing.outcome === 'rejected')) {
          if (!existing.rejectionReason) existing.rejectionReason = reason;
          continue;
        }
        rows.set(k, {
          ...existing,
          auctionId,
          adUnitCode: bid?.adUnitCode,
          bidder,
          outcome: 'error',
          rejectionReason: reason || existing?.rejectionReason,
          raw: existing?.raw || p,
        });
      }
    }
  }

  return Array.from(rows.values()).sort((x, y) => {
    if ((x.adUnitCode || '') !== (y.adUnitCode || '')) return (x.adUnitCode || '').localeCompare(y.adUnitCode || '');
    return (y.cpm || 0) - (x.cpm || 0);
  });
}

function pickRejectionReason(bid: any): string | undefined {
  return (
    bid?.rejectionReason ||
    bid?.statusMessage ||
    bid?.reason ||
    (typeof bid?.status === 'string' && bid.status !== 'bidRejected' ? bid.status : undefined)
  );
}

function formatBidderError(error: unknown): string {
  if (!error) return 'bidder HTTP error';
  if (typeof error === 'string') return error;
  if (typeof error !== 'object') return String(error);
  const e = error as Record<string, unknown>;
  const parts = [
    e.status != null ? `HTTP ${e.status}` : '',
    e.statusText,
    e.message,
    e.reason,
    e.statusMessage,
  ]
    .map((p) => (p == null ? '' : String(p)))
    .filter(Boolean);
  if (parts.length) return parts.join(' — ');
  try {
    const s = JSON.stringify(error);
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  } catch {
    return 'bidder HTTP error';
  }
}

/** Correlation between Prebid ad unit codes and GPT slot element ids (FR7). */
export function correlation(s: SessionState): {
  matched: string[];
  unmatchedAdUnits: string[];
  unmatchedSlots: string[];
} {
  const codes = new Set(s.adUnits.keys());
  const slotIds = new Set(s.slots.keys());
  const matched: string[] = [];
  const unmatchedAdUnits: string[] = [];
  const unmatchedSlots: string[] = [];
  for (const c of codes) (slotIds.has(c) ? matched : unmatchedAdUnits).push(c);
  for (const id of slotIds) if (!codes.has(id)) unmatchedSlots.push(id);
  return { matched, unmatchedAdUnits, unmatchedSlots };
}

/**
 * FR3 race check: did a GPT display/refresh happen before Prebid targeting
 * was pushed toward the ad server?
 */
export function targetingRace(s: SessionState): boolean {
  let firstTargetingSeq = Infinity;
  let firstAdServerCallSeq = Infinity;
  for (const env of s.envelopes) {
    if (env.channel === 'prebid' && (env.name === 'setTargeting' || env.name === 'setTargetingForGPTAsync')) {
      firstTargetingSeq = Math.min(firstTargetingSeq, env.seq);
    }
    if (env.channel === 'gpt' && env.kind === 'api' && (env.name === 'refresh' || env.name === 'display')) {
      firstAdServerCallSeq = Math.min(firstAdServerCallSeq, env.seq);
    }
  }
  return firstAdServerCallSeq < firstTargetingSeq && firstAdServerCallSeq !== Infinity;
}

export function filterEnvelopes(
  envelopes: Envelope[],
  opts: { channel?: string; name?: string; text?: string }
): Envelope[] {
  const text = opts.text?.trim().toLowerCase();
  return envelopes.filter((e) => {
    if (opts.channel && opts.channel !== 'all' && e.channel !== opts.channel) return false;
    if (opts.name && opts.name !== 'all' && e.name !== opts.name) return false;
    if (text) {
      const hay = `${e.channel} ${e.kind} ${e.name} ${e.auctionId || ''} ${e.slotElementId || ''} ${
        e.adUnitCode || ''
      }`.toLowerCase();
      let payloadStr = '';
      try {
        payloadStr = JSON.stringify(e.payload).toLowerCase();
      } catch {
        /* ignore */
      }
      if (!hay.includes(text) && !payloadStr.includes(text)) return false;
    }
    return true;
  });
}
