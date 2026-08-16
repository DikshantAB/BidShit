import { Fragment, useMemo, useState } from 'react';
import { Badge, EmptyState, Json, Table, TBody, TD, TH, THead, TR } from '../components/ui';
import { bidRowsForAuction } from '../selectors';
import { useSession } from '../store';
import type { BidRow } from '../../shared/types';

const outcomeVariant: Record<BidRow['outcome'], 'default' | 'success' | 'warning' | 'destructive' | 'secondary'> = {
  won: 'success',
  bid: 'default',
  noBid: 'secondary',
  timeout: 'warning',
  rejected: 'destructive',
  error: 'destructive',
};

export function BidsView({ auctionId, entity }: { auctionId: string; entity: string }) {
  const session = useSession();
  const rows = useMemo(() => {
    const all = auctionId ? bidRowsForAuction(session, auctionId) : [];
    return entity ? all.filter((r) => r.adUnitCode === entity) : all;
  }, [session, auctionId, entity]);

  if (!auctionId) return <EmptyState title="No auction selected." hint="Pick an auction from the selector above." />;
  if (rows.length === 0) {
    if (!session.status.prebidPresent) {
      return <EmptyState title="Header bidding was not observed." hint="No Prebid.js activity on this page — the Bids tab needs pbjs." />;
    }
    if (entity) {
      return (
        <EmptyState
          title="No bids for this ad unit in the selected auction."
          hint="The auction selector is limited to auctions that included this slot. Pick another auction above, or clear the slot filter."
        />
      );
    }
    return <EmptyState title="No bids captured for this auction yet." />;
  }

  return (
    <div className="h-full overflow-auto">
      <Table>
        <THead>
          <TR>
            <TH>Ad unit</TH>
            <TH>Bidder</TH>
            <TH>Media</TH>
            <TH>CPM</TH>
            <TH>Orig</TH>
            <TH>Cur</TH>
            <TH>Size</TH>
            <TH>TTL</TH>
            <TH>Deal</TH>
            <TH>Status</TH>
            <TH>TTR</TH>
            <TH>Outcome</TH>
            <TH>Reason</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r, i) => (
            <BidRowView key={`${r.adUnitCode}-${r.bidder}-${i}`} row={r} />
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function BidRowView({ row }: { row: BidRow }) {
  const [open, setOpen] = useState(false);
  const [showCreative, setShowCreative] = useState(false);
  const expandable = !!row.raw || !!row.rejectionReason;
  return (
    <Fragment>
      <TR className="cursor-pointer" onClick={() => expandable && setOpen((o) => !o)}>
        <TD className="font-medium">{row.adUnitCode || '—'}</TD>
        <TD>{row.bidder || '—'}</TD>
        <TD>{row.mediaType || '—'}</TD>
        <TD className="font-mono">{fmt(row.cpm)}</TD>
        <TD className="font-mono text-muted-foreground">{fmt(row.originalCpm)}</TD>
        <TD>{row.currency || '—'}</TD>
        <TD>{row.size || '—'}</TD>
        <TD>{row.ttl ?? '—'}</TD>
        <TD>{row.dealId || '—'}</TD>
        <TD>{row.status || '—'}</TD>
        <TD className="font-mono">{row.ttr != null ? `${row.ttr}ms` : '—'}</TD>
        <TD>
          <Badge variant={outcomeVariant[row.outcome]}>{row.outcome}</Badge>
        </TD>
        <TD className="max-w-[220px] text-[11px] text-destructive" title={row.rejectionReason || ''}>
          {row.rejectionReason || (row.outcome === 'error' || row.outcome === 'rejected' ? '—' : '')}
        </TD>
      </TR>
      {open && (
        <TR>
          <TD colSpan={13}>
            <div className="grid grid-cols-2 gap-3 py-1">
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Identity / reason</div>
                <Json
                  value={{
                    adId: row.adId,
                    requestId: row.requestId,
                    auctionId: row.auctionId,
                    outcome: row.outcome,
                    rejectionReason: row.rejectionReason,
                    meta: row.meta,
                  }}
                />
              </div>
              <div>
                <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase text-muted-foreground">
                  Full bid
                  <button
                    className="rounded border border-border px-1 py-0.5 text-[10px] normal-case text-foreground hover:bg-accent"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowCreative((s) => !s);
                    }}
                  >
                    {showCreative ? 'hide creative note' : 'show creative note'}
                  </button>
                </div>
                <Json value={row.raw ?? { note: 'No bid object captured; reason from event payload.' }} className="max-h-72" />
                {showCreative && (
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    Creative markup (`ad`/`vastXml`) is stripped by default for size/privacy (spec 12).
                  </div>
                )}
              </div>
            </div>
          </TD>
        </TR>
      )}
    </Fragment>
  );
}

function fmt(n?: number): string {
  return typeof n === 'number' ? n.toFixed(4) : '—';
}
