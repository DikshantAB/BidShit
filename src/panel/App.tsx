import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge, EmptyState, Input, Select, Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui';
import { highlightOnPage } from './highlight';
import { cn } from './lib/cn';
import { auctionList, auctionsForAdUnit, classifyCreative, confidenceVariant, correlation, creativeSourceVariant, diagnoseSession, latestAuctionForAdUnit } from './selectors';
import { useSession } from './store';
import { BidsView } from './views/BidsView';
import { EventsView } from './views/EventsView';
import { GptView } from './views/GptView';
import { IssuesView } from './views/IssuesView';
import { SourceView } from './views/SourceView';
import { TargetingView } from './views/TargetingView';
import { CmpView } from './views/CmpView';
import { TimelineView } from './views/TimelineView';

export default function App({ inspectable }: { inspectable: boolean }) {
  const session = useSession();
  const [tab, setTab] = useState('timeline');
  const [auctionId, setAuctionId] = useState<string>('');
  const [selectedEntity, setSelectedEntity] = useState<string>('');
  const [search, setSearch] = useState('');
  const [highlightNote, setHighlightNote] = useState('');

  const auctions = useMemo(() => auctionList(session), [session]);
  const issues = useMemo(() => diagnoseSession(session), [session]);
  const issueCount = issues.length;
  const auctionsForSelected = useMemo(
    () => (selectedEntity ? auctionsForAdUnit(auctions, selectedEntity) : auctions),
    [auctions, selectedEntity]
  );

  // Default to the most recent auction as they arrive.
  useEffect(() => {
    if (!auctionId && auctions.length) setAuctionId(auctions[auctions.length - 1].auctionId);
  }, [auctions, auctionId]);

  // Clicking an ad unit selects the latest auction that actually ran for it.
  useEffect(() => {
    if (!selectedEntity || !auctions.length) return;
    const match = latestAuctionForAdUnit(auctions, selectedEntity);
    if (!match) return;
    setAuctionId((current) => {
      if (current && auctionsForAdUnit(auctions, selectedEntity).some((a) => a.auctionId === current)) {
        return current;
      }
      return match.auctionId;
    });
  }, [selectedEntity, auctions]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedEntity) {
      void highlightOnPage(null);
      setHighlightNote('');
      return () => {
        cancelled = true;
      };
    }
    void highlightOnPage(selectedEntity).then((result) => {
      if (cancelled) return;
      setHighlightNote(result.ok ? '' : 'No matching div on the page (id / slot element id).');
    });
    return () => {
      cancelled = true;
      void highlightOnPage(null);
    };
  }, [selectedEntity]);

  if (!inspectable) {
    return (
      <Shell status={session}>
        <EmptyState title="This page cannot be inspected." hint="Open BidShitter on a regular http(s) page, not chrome:// or the Web Store." />
      </Shell>
    );
  }

  const nothing =
    !session.status.prebidPresent &&
    !session.status.gptPresent &&
    !session.status.cmpPresent &&
    issues.length === 0;

  return (
    <Shell status={session}>
      <div className="flex min-h-0 flex-1">
        {/* Left rail */}
        <LeftRail selected={selectedEntity} onSelect={setSelectedEntity} highlightNote={highlightNote} />

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top bar */}
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <label className="text-muted-foreground">Auction</label>
            <Select value={auctionId} onChange={(e) => setAuctionId(e.target.value)}>
              {auctionsForSelected.length === 0 && <option value={auctionId || ''}>— none for this slot —</option>}
              {auctionsForSelected.map((a) => {
                const i = auctions.findIndex((x) => x.auctionId === a.auctionId);
                return (
                  <option key={a.auctionId} value={a.auctionId}>
                    #{i + 1} {a.auctionId.slice(0, 8)} · {a.startTs ? new Date(a.startTs).toLocaleTimeString() : '—'} ·{' '}
                    {a.status || 'inProgress'}
                  </option>
                );
              })}
            </Select>
            {selectedEntity && auctionsForSelected.length > 0 && (
              <span className="text-[10px] text-muted-foreground">
                {auctionsForSelected.length} auction{auctionsForSelected.length === 1 ? '' : 's'} for this slot
              </span>
            )}
            {selectedEntity && (
              <Badge variant="outline" className="gap-1">
                {selectedEntity}
                <button className="ml-1 text-muted-foreground hover:text-foreground" onClick={() => setSelectedEntity('')}>
                  ×
                </button>
              </Badge>
            )}
            <div className="ml-auto w-56">
              <Input placeholder="Search events / payloads…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>

          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <div className="border-b border-border px-3 py-2">
              <TabsList>
                <TabsTrigger value="issues">
                  <span className="inline-flex items-center gap-1">
                    Issues
                    {issueCount > 0 && (
                      <span className="inline-flex min-w-[16px] items-center justify-center rounded-full bg-destructive/15 px-1 text-[9px] font-semibold text-destructive">
                        {issueCount}
                      </span>
                    )}
                  </span>
                </TabsTrigger>
                <TabsTrigger value="timeline">Timeline</TabsTrigger>
                <TabsTrigger value="bids">Bids</TabsTrigger>
                <TabsTrigger value="targeting">Targeting</TabsTrigger>
                <TabsTrigger value="gpt">GPT</TabsTrigger>
                <TabsTrigger value="cmp">CMP</TabsTrigger>
                <TabsTrigger value="source">Source</TabsTrigger>
                <TabsTrigger value="events">Events</TabsTrigger>
              </TabsList>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              {nothing ? (
                <EmptyState
                  title="No Prebid.js or GPT detected."
                  hint="Reload the page with the panel open. If this is a custom Prebid global (not window.pbjs), v1 won't detect it."
                />
              ) : (
                <>
                  <TabsContent value="issues" className="h-full">
                    <IssuesView entity={selectedEntity} search={search} issues={issues} />
                  </TabsContent>
                  <TabsContent value="timeline" className="h-full">
                    <TimelineView auctionId={auctionId} entity={selectedEntity} search={search} />
                  </TabsContent>
                  <TabsContent value="bids" className="h-full">
                    <BidsView auctionId={auctionId} entity={selectedEntity} />
                  </TabsContent>
                  <TabsContent value="targeting" className="h-full">
                    <TargetingView entity={selectedEntity} />
                  </TabsContent>
                  <TabsContent value="gpt" className="h-full">
                    <GptView entity={selectedEntity} />
                  </TabsContent>
                  <TabsContent value="cmp" className="h-full">
                    <CmpView entity={selectedEntity} />
                  </TabsContent>
                  <TabsContent value="source" className="h-full">
                    <SourceView entity={selectedEntity} />
                  </TabsContent>
                  <TabsContent value="events" className="h-full">
                    <EventsView search={search} entity={selectedEntity} />
                  </TabsContent>
                </>
              )}
            </div>
          </Tabs>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ status, children }: { status: ReturnType<typeof useSession>; children: ReactNode }) {
  const s = status.status;
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-semibold tracking-tight">BidShitter</span>
        <span className="text-[10px] text-muted-foreground">Get Bid Done</span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Chip on={status.connected} label={status.connected ? 'CMP_Connected' : 'CMP_Disconnected'} tone={status.connected ? 'success' : 'destructive'} />
          <Chip on={s.hookReady} label="shit-hook" />
          {s.hookLate && <Badge variant="warning">hook late — reload</Badge>}
          <Chip on={s.libLoaded} label="pbjs" />
          <Chip on={s.apiReady} label="gpt" />
          <Chip on={s.pubadsReady} label="pubads" />
          {s.prebidVersion && <Badge variant="secondary">pbjs {s.prebidVersion}</Badge>}
          {s.gptVersion && <Badge variant="secondary">gpt {s.gptVersion}</Badge>}
          {status.dropped > 0 && <Badge variant="warning">dropped {status.dropped}</Badge>}
        </div>
      </header>
      {children}
    </div>
  );
}

function Chip({ on, label, tone }: { on: boolean; label: string; tone?: 'success' | 'destructive' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
        on
          ? tone === 'destructive'
            ? 'border-destructive/30 bg-destructive/15 text-destructive'
            : 'border-[hsl(var(--success))]/30 bg-[hsl(var(--success))]/15 text-[hsl(var(--success))]'
          : 'border-border bg-muted text-muted-foreground'
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', on ? 'bg-current' : 'bg-muted-foreground/50')} />
      {label}
    </span>
  );
}

function LeftRail({
  selected,
  onSelect,
  highlightNote,
}: {
  selected: string;
  onSelect: (v: string) => void;
  highlightNote: string;
}) {
  const session = useSession();
  const corr = useMemo(() => correlation(session), [session]);

  const entities = useMemo(() => {
    const ids = new Set<string>();
    for (const c of session.adUnits.keys()) ids.add(c);
    for (const id of session.slots.keys()) ids.add(id);
    return Array.from(ids).sort();
  }, [session]);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border">
      <div className="border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Ad units / Slots ({entities.length})
      </div>
      {selected && (
        <div className="border-b border-border px-3 py-1.5 text-[10px] text-muted-foreground">
          Highlighting on page{highlightNote ? ` — ${highlightNote}` : ''}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {entities.length === 0 && <div className="px-3 py-2 text-muted-foreground">No ad units or slots yet.</div>}
        {entities.map((id) => {
          const au = session.adUnits.get(id);
          const slot = session.slots.get(id);
          const isMatched = corr.matched.includes(id);
          const isUnmatched =
            (au && corr.unmatchedAdUnits.includes(id)) || (slot && corr.unmatchedSlots.includes(id));
          const cls = classifyCreative(session, id);
          return (
            <button
              key={id}
              onClick={() => onSelect(selected === id ? '' : id)}
              className={cn(
                'flex w-full flex-col gap-1 border-b border-border/50 px-3 py-2 text-left hover:bg-accent/40',
                selected === id && 'bg-accent'
              )}
            >
              <div className="truncate font-medium" title={id}>
                {id}
              </div>
              <div className="flex flex-wrap gap-1">
                <Badge variant={creativeSourceVariant(cls.source)} title={cls.reason}>
                  {cls.source}
                  {cls.bidder ? ` · ${cls.bidder}` : ''}
                </Badge>
                <Badge variant={confidenceVariant(cls.confidence)}>{cls.confidence}</Badge>
                {au?.mediaTypes?.map((mt) => (
                  <Badge key={mt} variant="secondary">
                    {mt}
                  </Badge>
                ))}
                {slot?.outOfPage && <Badge variant="secondary">oop</Badge>}
                {slot && (slot.filled ? <Badge variant="success">fill</Badge> : slot.isEmpty ? <Badge variant="warning">empty</Badge> : null)}
                {isMatched && <Badge variant="default">matched</Badge>}
                {isUnmatched && <Badge variant="warning">no match</Badge>}
              </div>
              {slot?.adUnitPath && (
                <div className="truncate text-[10px] text-muted-foreground" title={slot.adUnitPath}>
                  {slot.adUnitPath}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
