import { useMemo, useState } from 'react';
import { Badge, EmptyState, Input, Json, MultiSelect, Select } from '../components/ui';
import { cn } from '../lib/cn';
import { filterEnvelopes } from '../selectors';
import { useSession } from '../store';
import type { Envelope } from '../../shared/types';

const channelTone: Record<string, string> = {
  prebid: 'border-l-primary',
  gpt: 'border-l-[hsl(var(--warning))]',
  hook: 'border-l-muted-foreground',
  network: 'border-l-[hsl(var(--success))]',
};

export function TimelineView({ auctionId, entity, search }: { auctionId: string; entity: string; search: string }) {
  const session = useSession();
  const [channel, setChannel] = useState('all');
  const [names, setNames] = useState<string[]>([]);
  const [localSearch, setLocalSearch] = useState('');
  const text = localSearch || search;
  const slotPath = entity ? session.slots.get(entity)?.adUnitPath : undefined;

  const namesOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of session.envelopes) set.add(e.name);
    return Array.from(set).sort();
  }, [session]);

  const nodes = useMemo(() => {
    return filterEnvelopes(session.envelopes, {
      channel,
      names,
      text,
      entity: entity || undefined,
      slotAdUnitPath: slotPath,
      keepUnscoped: true,
    }).filter((e) => !(auctionId && e.auctionId && e.auctionId !== auctionId));
  }, [session, auctionId, entity, slotPath, channel, names, text]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="all">all sources</option>
          <option value="prebid">prebid</option>
          <option value="gpt">gpt</option>
          <option value="hook">hook</option>
          <option value="network">network</option>
        </Select>
        <MultiSelect options={namesOptions} selected={names} onChange={setNames} allLabel="all events" />
        <div className="w-56">
          <Input
            placeholder="Filter (bidder, id, payload…)"
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
          />
        </div>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {nodes.length} / {session.envelopes.length}
        </span>
      </div>
      {nodes.length === 0 ? (
        <EmptyState
          title="No timeline activity yet."
          hint="Reload the page with the panel open to capture the full boot sequence, or clear filters."
        />
      ) : (
        <EventTimelineList nodes={nodes} />
      )}
    </div>
  );
}

export function EventTimelineList({ nodes }: { nodes: Envelope[] }) {
  const t0 = nodes[0]?.perf ?? 0;
  return (
    <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
      <div className="mb-2 flex items-center gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-primary" /> Prebid
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-[hsl(var(--warning))]" /> GPT
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-[hsl(var(--success))]" /> GAM HTTP
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

export function TimelineNode({ env, tOffset }: { env: Envelope; tOffset: number }) {
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
        <Badge
          variant={
            env.channel === 'gpt'
              ? 'warning'
              : env.channel === 'prebid'
                ? 'default'
                : env.channel === 'network'
                  ? 'success'
                  : 'secondary'
          }
        >
          {env.channel}
        </Badge>
        <Badge variant="outline">{env.kind}</Badge>
        <span className="font-medium">{env.name}</span>
        {env.slotElementId && (
          <span className="truncate text-[10px] text-muted-foreground">slot: {env.slotElementId}</span>
        )}
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
