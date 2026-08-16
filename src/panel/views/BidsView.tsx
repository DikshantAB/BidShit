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
  const expandable = !!row.raw;
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
          {row.rejectionReason && <span className="ml-1 text-[10px] text-destructive">{row.rejectionReason}</span>}
        </TD>
      </TR>
      {open && row.raw && (
        <TR>
          <TD colSpan={12}>
            <div className="grid grid-cols-2 gap-3 py-1">
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Identity</div>
                <Json
                  value={{
                    adId: row.adId,
                    requestId: row.requestId,
                    auctionId: row.auctionId,
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
                <Json value={row.raw} className="max-h-72" />
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
