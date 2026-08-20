import { useMemo } from 'react';
import { Badge, Card, EmptyState, Json, Table, TBody, TD, TH, THead, TR } from '../components/ui';
import { TCF_LISTS, tcfBlockedNames, tcfHasBlocks } from '../../diagnostics/consent';
import { auctionIdsForEntity } from '../selectors';
import { rec } from '../../diagnostics/helpers';
import { useSession } from '../store';
import type { Envelope } from '../../shared/types';

export function CmpView({ entity }: { entity: string }) {
  const session = useSession();

  const events = useMemo(() => {
    const all = session.envelopes.filter((e) => e.channel === 'prebid' && e.name === 'tcf2Enforcement');
    if (!entity) return all;
    const auctionIds = auctionIdsForEntity(session, entity);
    return all.filter((e) => !!e.auctionId && auctionIds.has(e.auctionId));
  }, [session, entity]);

  const tcfapiEvents = useMemo(
    () => session.envelopes.filter((e) => e.channel === 'cmp' && e.name === 'tcfapi'),
    [session]
  );

  const pingEvents = useMemo(
    () => session.envelopes.filter((e) => e.channel === 'cmp' && e.name === 'tcfapi-ping'),
    [session]
  );

  if (events.length === 0 && tcfapiEvents.length === 0 && pingEvents.length === 0) {
    return (
      <EmptyState
        title={entity ? `No CMP / TCF activity for ${entity}.` : 'No CMP / TCF activity yet.'}
        hint="The hook pings window.__tcfapi as soon as that function exists (stub must answer ping immediately) and subscribes with addEventListener. tcf2Enforcement still requires tcfControl in the Prebid build. Reload with the panel open."
      />
    );
  }

  return (
    <div className="h-full space-y-3 overflow-auto p-3">
      {pingEvents.length > 0 && (
        <Card dismissible className="p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 pr-4">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              __tcfapi ping
            </span>
            <Badge variant="secondary">{pingEvents.length}</Badge>
            <span className="text-[11px] text-muted-foreground">page-level · stub / load status</span>
          </div>
          <div className="space-y-2">
            {pingEvents.map((env) => (
              <TcfApiCard key={env.seq} env={env} />
            ))}
          </div>
        </Card>
      )}

      {events.length > 0 && (
        <Card dismissible className="p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 pr-4">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              tcf2Enforcement
            </span>
            <Badge variant="secondary">{events.length}</Badge>
            {entity && (
              <span className="text-[11px] text-muted-foreground">
                auctions that included <span className="font-medium text-foreground">{entity}</span>
              </span>
            )}
          </div>
          <div className="space-y-2">
            {events.map((env) => (
              <EnforcementCard key={env.seq} env={env} />
            ))}
          </div>
        </Card>
      )}

      {tcfapiEvents.length > 0 && (
        <Card dismissible className="p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 pr-4">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              __tcfapi addEventListener
            </span>
            <Badge variant="secondary">{tcfapiEvents.length}</Badge>
            <span className="text-[11px] text-muted-foreground">page-level · all callbacks</span>
          </div>
          <div className="space-y-2">
            {tcfapiEvents.map((env) => (
              <TcfApiCard key={env.seq} env={env} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function TcfApiCard({ env }: { env: Envelope }) {
  const p = rec(env.payload);
  const keys = Object.keys(p);
  return (
    <div className="rounded-md border border-border/70 p-2">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">
          {env.ts ? new Date(env.ts).toLocaleTimeString() : '—'}
        </span>
        {typeof p.eventStatus === 'string' && p.eventStatus && <Badge variant="warning">{p.eventStatus}</Badge>}
        {typeof p.cmpStatus === 'string' && p.cmpStatus && (
          <Badge variant={p.cmpStatus === 'stub' ? 'warning' : 'outline'}>{p.cmpStatus}</Badge>
        )}
        {p.cmpLoaded === false && <Badge variant="outline">cmpLoaded · false</Badge>}
        {'gdprApplies' in p && <Badge variant="outline">gdprApplies · {String(p.gdprApplies)}</Badge>}
      </div>
      {keys.length === 0 ? (
        <span className="text-[11px] text-muted-foreground">Empty payload.</span>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Field</TH>
              <TH>Value</TH>
            </TR>
          </THead>
          <TBody>
            {keys.map((key) => (
              <TR key={key}>
                <TD className="align-top font-mono text-[10px]">{key}</TD>
                <TD className="min-w-0 break-all">
                  <PayloadValue value={p[key]} />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}

function PayloadValue({ value }: { value: unknown }) {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <span className="font-mono text-[11px]">{value == null ? '—' : String(value)}</span>;
  }
  return <Json value={value} className="max-h-64" />;
}

function EnforcementCard({ env }: { env: Envelope }) {
  const p = rec(env.payload);
  const blocked = tcfHasBlocks(p);
  return (
    <div className="rounded-md border border-border/70 p-2">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">
          {env.ts ? new Date(env.ts).toLocaleTimeString() : '—'}
        </span>
        {env.auctionId && <Badge variant="outline">auction · {env.auctionId.slice(0, 8)}</Badge>}
        {blocked ? <Badge variant="destructive">blocked</Badge> : <Badge variant="success">no blocks</Badge>}
      </div>
      <Table>
        <THead>
          <TR>
            <TH>Category</TH>
            <TH className="w-16">Count</TH>
            <TH>Blocked</TH>
          </TR>
        </THead>
        <TBody>
          {TCF_LISTS.map((list) => {
            const names = tcfBlockedNames(p, list.key);
            return (
              <TR key={list.key}>
                <TD>
                  <div className="font-medium">{list.label}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{list.key}</div>
                </TD>
                <TD className="font-mono">{names.length}</TD>
                <TD className="break-all">
                  {names.length ? (
                    <div className="flex flex-wrap gap-1">
                      {names.map((n) => (
                        <Badge key={n} variant={list.key === 'biddersBlocked' ? 'destructive' : 'warning'}>
                          {n}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}
