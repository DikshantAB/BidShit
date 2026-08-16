import { useMemo } from 'react';
import { Badge, Card, EmptyState, Json, Table, TBody, TD, TH, THead, TR } from '../components/ui';
import { useSession } from '../store';
import type { Envelope } from '../../shared/types';

export function GptView({ entity }: { entity: string }) {
  const session = useSession();

  const slots = useMemo(() => {
    const list = Array.from(session.slots.values());
    return entity ? list.filter((s) => s.slotElementId === entity) : list;
  }, [session, entity]);

  const privacyCalls = useMemo(
    () =>
      session.envelopes.filter(
        (e) => e.channel === 'gpt' && e.kind === 'api' && e.name === 'setPrivacySettings'
      ),
    [session]
  );

  const serviceCalls = useMemo(
    () =>
      session.envelopes.filter(
        (e) =>
          e.channel === 'gpt' &&
          e.kind === 'api' &&
          ['display', 'refresh', 'enableServices', 'disableInitialLoad', 'enableSingleRequest', 'updateCorrelator', 'setConfig'].includes(
            e.name
          )
      ),
    [session]
  );

  if (!session.status.gptPresent) {
    return <EmptyState title="No GPT detected." hint="This page did not load the Google Publisher Tag (googletag)." />;
  }

  return (
    <div className="h-full space-y-3 overflow-auto p-3">
      <Card className="p-3">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Slot registry ({slots.length})
        </div>
        {slots.length === 0 ? (
          <div className="text-muted-foreground">No slots defined yet.</div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Element id</TH>
                <TH>Ad unit path</TH>
                <TH>State</TH>
                <TH>Last event</TH>
                <TH>Line item</TH>
                <TH>Creative</TH>
                <TH>Advertiser</TH>
                <TH>Viewable %</TH>
              </TR>
            </THead>
            <TBody>
              {slots.map((s) => (
                <TR key={s.slotElementId}>
                  <TD className="font-medium">{s.slotElementId}</TD>
                  <TD className="text-muted-foreground">{s.adUnitPath || '—'}</TD>
                  <TD className="space-x-1">
                    {s.displayed && <Badge variant="secondary">display</Badge>}
                    {s.refreshed && <Badge variant="secondary">refresh</Badge>}
                    {s.filled && <Badge variant="success">fill</Badge>}
                    {s.isEmpty && <Badge variant="warning">empty</Badge>}
                  </TD>
                  <TD>{s.lastActivity || '—'}</TD>
                  <TD className="font-mono">{s.lineItemId ?? '—'}</TD>
                  <TD className="font-mono">{s.creativeId ?? '—'}</TD>
                  <TD className="font-mono">{s.advertiserId ?? '—'}</TD>
                  <TD className="font-mono">{s.inViewPercentage != null ? `${s.inViewPercentage}%` : '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card className="p-3">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          PubAds service calls
        </div>
        <CallList calls={serviceCalls} />
      </Card>

      {privacyCalls.length > 0 && (
        <Card className="p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Privacy settings observed (flags only)
          </div>
          {privacyCalls.map((c) => (
            <Json key={c.seq} value={(c.payload as any)?.args?.[0]} className="mb-1" />
          ))}
        </Card>
      )}
    </div>
  );
}

function CallList({ calls }: { calls: Envelope[] }) {
  if (calls.length === 0) return <div className="text-muted-foreground">No service calls captured.</div>;
  return (
    <ul className="space-y-1">
      {calls.map((c) => (
        <li key={c.seq} className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-muted-foreground">{new Date(c.ts).toLocaleTimeString()}</span>
          <Badge variant="warning">{c.name}</Badge>
        </li>
      ))}
    </ul>
  );
}
