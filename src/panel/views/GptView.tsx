import { useMemo, useState } from 'react';
import { Badge, Card, EmptyState, Json, Table, TBody, TD, TH, THead, TR } from '../components/ui';
import { useSession } from '../store';
import type { Envelope } from '../../shared/types';

const SERVICE_CALLS = new Set([
  'display',
  'refresh',
  'enableServices',
  'disableInitialLoad',
  'enableSingleRequest',
  'enableLazyLoad',
  'collapseEmptyDivs',
  'updateCorrelator',
  'setConfig',
  'setTargeting',
  'clearTargeting',
  'clear',
  'setPublisherProvidedId',
  'setForceSafeFrame',
  'setSafeFrameConfig',
  'destroySlots',
  'defineSlot',
  'defineOutOfPageSlot',
]);

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
        (e) => e.channel === 'gpt' && e.kind === 'api' && SERVICE_CALLS.has(e.name)
      ),
    [session]
  );

  if (!session.status.gptPresent) {
    return <EmptyState title="No GPT detected." hint="This page did not load the Google Publisher Tag (googletag)." />;
  }

  return (
    <div className="h-full min-w-0 space-y-3 overflow-auto p-3">
      <Card className="min-w-0 overflow-hidden p-3">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Slot registry ({slots.length})
        </div>
        {slots.length === 0 ? (
          <div className="text-muted-foreground">No slots defined yet.</div>
        ) : (
          <div className="max-w-full overflow-x-auto">
            <Table className="min-w-[640px]">
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
                    <TD className="max-w-[160px] truncate font-medium" title={s.slotElementId}>
                      {s.slotElementId}
                    </TD>
                    <TD className="max-w-[220px] truncate text-muted-foreground" title={s.adUnitPath || ''}>
                      {s.adUnitPath || '—'}
                    </TD>
                    <TD className="whitespace-nowrap">
                      {s.displayed && <Badge variant="secondary">display</Badge>}
                      {s.refreshed && (
                        <Badge variant="secondary" className="ml-1">
                          refresh
                        </Badge>
                      )}
                      {s.filled && (
                        <Badge variant="success" className="ml-1">
                          fill
                        </Badge>
                      )}
                      {s.isEmpty && (
                        <Badge variant="warning" className="ml-1">
                          empty
                        </Badge>
                      )}
                    </TD>
                    <TD className="whitespace-nowrap">{s.lastActivity || '—'}</TD>
                    <TD className="font-mono">{s.lineItemId ?? '—'}</TD>
                    <TD className="font-mono">{s.creativeId ?? '—'}</TD>
                    <TD className="font-mono">{s.advertiserId ?? '—'}</TD>
                    <TD className="font-mono">{s.inViewPercentage != null ? `${s.inViewPercentage}%` : '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>

      <Card className="min-w-0 overflow-hidden p-3">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          PubAds / GPT API calls
        </div>
        <CallList calls={serviceCalls} />
      </Card>

      {privacyCalls.length > 0 && (
        <Card className="min-w-0 overflow-hidden p-3">
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
        <CallRow key={c.seq} env={c} />
      ))}
    </ul>
  );
}

function CallRow({ env }: { env: Envelope }) {
  const [open, setOpen] = useState(false);
  const args = (env.payload as any)?.args;
  const summary = summarizeArgs(env.name, args);
  const hasArgs = Array.isArray(args) && args.length > 0;
  return (
    <li className="rounded-md border border-border/60">
      <button
        className="flex w-full items-start gap-2 px-2 py-1.5 text-left"
        onClick={() => hasArgs && setOpen((o) => !o)}
      >
        <span className="w-16 shrink-0 font-mono text-[10px] text-muted-foreground">
          {new Date(env.ts).toLocaleTimeString()}
        </span>
        <Badge variant="warning">{env.name}</Badge>
        {summary && <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{summary}</span>}
        {hasArgs && <span className="ml-auto text-muted-foreground">{open ? '−' : '+'}</span>}
      </button>
      {open && hasArgs && (
        <div className="border-t border-border px-2 py-2">
          <Json value={args} className="max-h-64" />
        </div>
      )}
    </li>
  );
}

function summarizeArgs(name: string, args: unknown): string {
  if (!Array.isArray(args) || args.length === 0) return '';
  const first = args[0];
  if (name === 'setConfig' && first && typeof first === 'object' && !Array.isArray(first)) {
    const keys = Object.keys(first as object);
    return keys.length ? keys.join(', ') : '{}';
  }
  if (name === 'setTargeting' && typeof first === 'string') {
    return `${first} = ${stringifyShort(args[1])}`;
  }
  if (name === 'display' || name === 'refresh') {
    return stringifyShort(first ?? 'all slots');
  }
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const keys = Object.keys(first as object);
    if (keys.length) return keys.slice(0, 8).join(', ') + (keys.length > 8 ? '…' : '');
  }
  return stringifyShort(first);
}

function stringifyShort(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const s = JSON.stringify(value);
    return s.length > 140 ? s.slice(0, 140) + '…' : s;
  } catch {
    return String(value);
  }
}
