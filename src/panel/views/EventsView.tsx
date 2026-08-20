import { useMemo, useState } from 'react';
import { EmptyState, Input, MultiSelect, Select } from '../components/ui';
import { filterEnvelopes } from '../selectors';
import { useSession } from '../store';
import { EventTimelineList } from './TimelineView';

export function EventsView({ search, entity }: { search: string; entity: string }) {
  const session = useSession();
  const [channel, setChannel] = useState('all');
  const [names, setNames] = useState<string[]>([]);
  const [localSearch, setLocalSearch] = useState('');
  const effectiveSearch = localSearch || search;
  const slotPath = entity ? session.slots.get(entity)?.adUnitPath : undefined;

  const namesOptions = useMemo(() => {
    const scoped = filterEnvelopes(session.envelopes, {
      entity,
      slotAdUnitPath: slotPath,
      keepUnscoped: false,
    });
    const set = new Set<string>();
    for (const e of scoped) set.add(e.name);
    return Array.from(set).sort();
  }, [session, entity, slotPath]);

  const rows = useMemo(
    () =>
      filterEnvelopes(session.envelopes, {
        channel,
        names,
        text: effectiveSearch,
        entity: entity || undefined,
        slotAdUnitPath: slotPath,
        keepUnscoped: false,
      }),
    [session, channel, names, effectiveSearch, entity, slotPath]
  );

  if (!entity) {
    return (
      <EmptyState
        title="Select a slot for its event timeline."
        hint="Pick an ad unit / GPT slot in the left rail. The Events tab is a slot-level timeline of Prebid, GPT, and GAM HTTP for that slot."
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[11px] text-muted-foreground">Slot timeline · {entity}</span>
        <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="all">all sources</option>
          <option value="prebid">prebid</option>
          <option value="gpt">gpt</option>
          <option value="hook">hook</option>
          <option value="network">network</option>
          <option value="cmp">cmp</option>
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
          {rows.length} events
          {session.dropped > 0 && ` · ${session.dropped} dropped`}
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No matching events for this slot." hint="Clear filters, or reload with the panel open." />
      ) : (
        <EventTimelineList nodes={rows} />
      )}
    </div>
  );
}
