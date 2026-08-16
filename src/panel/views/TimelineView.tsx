import { useMemo, useState } from 'react';
import { Badge, EmptyState, Json } from '../components/ui';
import { cn } from '../lib/cn';
import { useSession } from '../store';
import type { Envelope } from '../../shared/types';

const channelTone: Record<string, string> = {
  prebid: 'border-l-primary',
  gpt: 'border-l-[hsl(var(--warning))]',
  hook: 'border-l-muted-foreground',
};

export function TimelineView({ auctionId, entity, search }: { auctionId: string; entity: string; search: string }) {
  const session = useSession();

  const nodes = useMemo(() => {
    const text = search.trim().toLowerCase();
    return session.envelopes
      .filter((e) => {
        // Auction scoping: keep hook/gpt/api rows (often lack auctionId) plus
        // prebid rows for the selected auction.
        if (auctionId && e.auctionId && e.auctionId !== auctionId) return false;
        if (entity && e.adUnitCode !== entity && e.slotElementId !== entity) {
          // keep entity-less lifecycle rows so the boot sequence is visible
          if (e.adUnitCode || e.slotElementId) return false;
        }
        if (text) {
          const hay = `${e.channel} ${e.kind} ${e.name}`.toLowerCase();
          if (!hay.includes(text)) return false;
        }
        return true;
      })
      .sort((a, b) => a.seq - b.seq);
  }, [session, auctionId, entity, search]);

  if (nodes.length === 0) {
    return <EmptyState title="No timeline activity yet." hint="Reload the page with the panel open to capture the full boot sequence." />;
  }

  const t0 = nodes[0].perf;

  return (
    <div className="h-full overflow-auto px-3 py-3">
      <div className="mb-2 flex items-center gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-primary" /> Prebid
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-[hsl(var(--warning))]" /> GPT
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-muted-foreground" /> Hook
        </span>
      </div>
      <ol className="space-y-1">
        {nodes.map((n) => (
          <TimelineNode key={n.seq} env={n} tOffset={n.perf - t0} />
        ))}
      </ol>
    </div>
  );
}

function TimelineNode({ env, tOffset }: { env: Envelope; tOffset: number }) {
  const [open, setOpen] = useState(false);
  const hasPayload = env.payload != null && !(typeof env.payload === 'object' && Object.keys(env.payload as object).length === 0);
  return (
    <li className={cn('rounded-md border border-border border-l-2 bg-card', channelTone[env.channel])}>
      <button
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
        onClick={() => hasPayload && setOpen((o) => !o)}
      >
        <span className="w-16 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
          +{tOffset.toFixed(0)}ms
        </span>
        <Badge variant={env.channel === 'gpt' ? 'warning' : env.channel === 'prebid' ? 'default' : 'secondary'}>
          {env.channel}
        </Badge>
        <Badge variant="outline">{env.kind}</Badge>
        <span className="font-medium">{env.name}</span>
        {env.slotElementId && <span className="truncate text-[10px] text-muted-foreground">slot: {env.slotElementId}</span>}
        {env.adUnitCode && !env.slotElementId && (
          <span className="truncate text-[10px] text-muted-foreground">unit: {env.adUnitCode}</span>
        )}
        {hasPayload && <span className="ml-auto text-muted-foreground">{open ? '−' : '+'}</span>}
      </button>
      {open && hasPayload && (
        <div className="border-t border-border px-2 py-2">
          <Json value={env.payload} className="max-h-72" />
        </div>
      )}
    </li>
  );
}
