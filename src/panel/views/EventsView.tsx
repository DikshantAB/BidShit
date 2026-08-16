import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import { Badge, EmptyState, Input, Json, Select } from '../components/ui';
import { cn } from '../lib/cn';
import { filterEnvelopes } from '../selectors';
import { useSession } from '../store';

export function EventsView({ search }: { search: string }) {
  const session = useSession();
  const [channel, setChannel] = useState('all');
  const [name, setName] = useState('all');
  const [localSearch, setLocalSearch] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);

  const effectiveSearch = localSearch || search;

  const names = useMemo(() => {
    const set = new Set<string>();
    for (const e of session.envelopes) set.add(e.name);
    return Array.from(set).sort();
  }, [session]);

  const rows = useMemo(
    () => filterEnvelopes(session.envelopes, { channel, name, text: effectiveSearch }),
    [session, channel, name, effectiveSearch]
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 26,
    overscan: 20,
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="all">all sources</option>
          <option value="prebid">prebid</option>
          <option value="gpt">gpt</option>
          <option value="hook">hook</option>
        </Select>
        <Select value={name} onChange={(e) => setName(e.target.value)}>
          <option value="all">all events</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
        <div className="w-56">
          <Input placeholder="Filter (bidder, id, payload…)" value={localSearch} onChange={(e) => setLocalSearch(e.target.value)} />
        </div>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {rows.length} / {session.envelopes.length} events
          {session.dropped > 0 && ` · ${session.dropped} dropped`}
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No matching events." />
      ) : (
        <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const e = rows[vi.index];
              const isOpen = expanded === e.seq;
              return (
                <div
                  key={e.seq}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                >
                  <button
                    onClick={() => setExpanded(isOpen ? null : e.seq)}
                    className={cn(
                      'flex w-full items-center gap-2 border-b border-border/60 px-3 py-1 text-left hover:bg-accent/40',
                      isOpen && 'bg-accent/40'
                    )}
                  >
                    <span className="w-20 shrink-0 font-mono text-[10px] text-muted-foreground">
                      {new Date(e.ts).toLocaleTimeString()}
                    </span>
                    <Badge variant={e.channel === 'gpt' ? 'warning' : e.channel === 'prebid' ? 'default' : 'secondary'}>
                      {e.channel}
                    </Badge>
                    <Badge variant="outline">{e.kind}</Badge>
                    <span className="w-52 shrink-0 truncate font-medium">{e.name}</span>
                    <span className="truncate text-[10px] text-muted-foreground">
                      {e.auctionId ? `auction ${e.auctionId.slice(0, 8)}` : ''}
                      {e.slotElementId ? ` slot ${e.slotElementId}` : ''}
                      {e.adUnitCode && !e.slotElementId ? ` unit ${e.adUnitCode}` : ''}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="border-b border-border bg-card px-3 py-2">
                      <Json value={e.payload} className="max-h-80" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
