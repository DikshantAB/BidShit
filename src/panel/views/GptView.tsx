import { useMemo, useState } from 'react';
import { Badge, Card, EmptyState, Json, Table, TBody, TD, TH, THead, TR } from '../components/ui';
import { gptApiTouchesEntity, classifyCreative, confidenceVariant, creativeSourceVariant } from '../selectors';
import { hbFromMap, requestMatchesSlot } from '../../shared/gam-network';
import { useSession } from '../store';
import type { Envelope, SlotRecord } from '../../shared/types';
import { EvidenceTable } from './SourceView';

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

  const gamRequests = useMemo(
    () => session.envelopes.filter((e) => e.channel === 'network' && e.name === 'gamRequest'),
    [session]
  );

  const lifecycle = useMemo(
    () =>
      session.envelopes.filter(
        (e) =>
          e.channel === 'gpt' &&
          e.kind === 'event' &&
          [
            'slotRequested',
            'slotResponseReceived',
            'slotRenderEnded',
            'slotOnload',
            'impressionViewable',
            'rewardedSlotReady',
            'rewardedSlotGranted',
            'rewardedSlotClosed',
            'gameManualInterstitialSlotReady',
            'gameManualInterstitialSlotClosed',
          ].includes(e.name)
      ),
    [session]
  );

  const serviceCalls = useMemo(() => {
    const calls = session.envelopes.filter(
      (e) => e.channel === 'gpt' && e.kind === 'api' && SERVICE_CALLS.has(e.name)
    );
    if (!entity) return calls;
    const path = session.slots.get(entity)?.adUnitPath;
    return calls.filter((e) => gptApiTouchesEntity(e, entity, path));
  }, [session, entity]);

  const unmatchedRequests = useMemo(() => {
    return gamRequests.filter(
      (e) => !slots.some((s) => requestMatchesSlot((e.payload as any)?.iuPaths, s.adUnitPath))
    );
  }, [gamRequests, slots]);

  if (!session.status.gptPresent && gamRequests.length === 0) {
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
                  <TH>Source</TH>
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
                {slots.map((s) => {
                  const cls = classifyCreative(session, s.slotElementId);
                  return (
                  <TR key={s.slotElementId}>
                    <TD>
                      <Badge variant={creativeSourceVariant(cls.source)} title={cls.reason}>
                        {cls.source}
                      </Badge>
                      <Badge variant={confidenceVariant(cls.confidence)} className="ml-1">
                        {cls.confidence}
                      </Badge>
                    </TD>
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
                  );
                })}
              </TBody>
            </Table>
          </div>
        )}
      </Card>

      {unmatchedRequests.length > 0 && !entity && (
        <Card className="min-w-0 overflow-hidden p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            GAM HTTP not matched to a defined slot ({unmatchedRequests.length})
          </div>
          {unmatchedRequests.map((r) => (
            <details key={r.seq} className="mb-2 rounded-md border border-border/70 px-2 py-1">
              <summary className="cursor-pointer text-[11px]">
                {(r.payload as any)?.status} {(r.payload as any)?.path} iu={(r.payload as any)?.iuPaths?.join(', ')}
              </summary>
              <Json value={r.payload} className="mt-1 max-h-48" />
            </details>
          ))}
        </Card>
      )}

      {slots.map((s) => (
        <GamFillCard
          key={s.slotElementId}
          slot={s}
          lifecycle={lifecycle.filter((e) => e.slotElementId === s.slotElementId)}
          requests={gamRequests.filter((e) => requestMatchesSlot((e.payload as any)?.iuPaths, s.adUnitPath))}
        />
      ))}

      <Card className="min-w-0 overflow-hidden p-3">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          PubAds / GPT API calls{entity ? ` · ${entity}` : ''}
        </div>
        <CallList calls={serviceCalls} />
      </Card>

      {privacyCalls.length > 0 && !entity && (
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

function GamFillCard({
  slot,
  lifecycle,
  requests,
}: {
  slot: SlotRecord;
  lifecycle: Envelope[];
  requests: Envelope[];
}) {
  const session = useSession();
  const cls = classifyCreative(session, slot.slotElementId);
  const render = [...lifecycle].reverse().find((e) => e.name === 'slotRenderEnded');
  const rp = (render?.payload || {}) as any;
  const requested = lifecycle.find((e) => e.name === 'slotRequested');
  const targeting = (requested?.payload as any)?.targeting || slot.targetingAtRequest || slot.targeting;
  const hb = hbFromMap(targeting);
  const empty = slot.isEmpty === true || rp.isEmpty === true;

  return (
    <Card className="min-w-0 overflow-hidden p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          GAM fill · {slot.slotElementId}
        </div>
        <Badge variant={creativeSourceVariant(cls.source)}>{cls.source}</Badge>
        <Badge variant={confidenceVariant(cls.confidence)}>{cls.confidence}</Badge>
        {cls.bidder && <Badge variant="outline">{cls.bidder}</Badge>}
        {empty ? <Badge variant="warning">empty / no fill</Badge> : slot.filled ? <Badge variant="success">filled</Badge> : null}
        {slot.isBackfill && <Badge variant="secondary">backfill</Badge>}
        {slot.viewable && <Badge variant="success">viewable</Badge>}
      </div>
      <div className="mb-2 text-[11px] text-muted-foreground">{cls.reason}</div>
      <div className="mb-3">
        <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">
          Source evidence (ids / HTTP support only — never decide PREBID vs GAM alone)
        </div>
        <EvidenceTable evidence={cls.evidence} />
      </div>

      <ol className="mb-3 space-y-1 text-[11px]">
        <Stage done={!!slot.requested || lifecycle.some((e) => e.name === 'slotRequested')} label="slotRequested" hint="GPT asked GAM for this slot" />
        {requests.map((r) => (
          <GamHttpRow key={r.seq} env={r} />
        ))}
        {requests.length === 0 && (
          <li className="text-muted-foreground">No matching GAM HTTP request captured yet (open the panel before refresh).</li>
        )}
        <Stage done={!!slot.responseReceived || lifecycle.some((e) => e.name === 'slotResponseReceived')} label="slotResponseReceived" hint="GAM response arrived (before render)" />
        <Stage done={lifecycle.some((e) => e.name === 'slotRenderEnded')} label="slotRenderEnded" hint={empty ? 'No ad returned (isEmpty)' : 'Creative injected'} />
        <Stage done={!!slot.onloaded} label="slotOnload" hint="Creative iframe load (may skip for sync rich media)" />
        <Stage done={!!slot.viewable} label="impressionViewable" hint="Active View criteria met" />
      </ol>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">
            Winning GAM ad (supporting ids only — not used alone to classify PREBID vs GAM)
          </div>
          <Table>
            <TBody>
              <KV k="isEmpty" v={empty ? 'true' : 'false'} />
              <KV k="isBackfill" v={fmt(slot.isBackfill ?? rp.isBackfill)} />
              <KV k="size" v={fmtSize(slot.renderedSize ?? rp.size)} />
              <KV k="advertiserId" v={fmt(slot.advertiserId ?? rp.advertiserId)} />
              <KV k="campaignId" v={fmt(slot.campaignId ?? rp.campaignId)} />
              <KV k="lineItemId" v={fmt(slot.lineItemId ?? rp.lineItemId)} />
              <KV k="creativeId" v={fmt(slot.creativeId ?? rp.creativeId)} />
              <KV k="creativeTemplateId" v={fmt(slot.creativeTemplateId ?? rp.creativeTemplateId)} />
              <KV k="sourceAgnosticLineItemId" v={fmt(slot.sourceAgnosticLineItemId ?? rp.sourceAgnosticLineItemId)} />
              <KV k="sourceAgnosticCreativeId" v={fmt(slot.sourceAgnosticCreativeId ?? rp.sourceAgnosticCreativeId)} />
              <KV k="companyIds" v={fmt(slot.companyIds ?? rp.companyIds)} />
              <KV k="yieldGroupIds" v={fmt(slot.yieldGroupIds ?? rp.yieldGroupIds)} />
              <KV k="responseIdentifier" v={fmt(slot.responseIdentifier ?? rp.responseIdentifier)} />
              <KV k="slotContentChanged" v={fmt(slot.slotContentChanged ?? rp.slotContentChanged)} />
              <KV k="inViewPercentage" v={slot.inViewPercentage != null ? `${slot.inViewPercentage}%` : '—'} />
            </TBody>
          </Table>
        </div>
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">
            Targeting on the slot at GAM request (hb_* even if all noBid)
          </div>
          {targeting && Object.keys(targeting).length ? (
            <>
              {Object.keys(hb).length > 0 ? (
                <div className="mb-1 text-[11px] text-primary">Prebid keys present: {Object.keys(hb).join(', ')}</div>
              ) : (
                <div className="mb-1 text-[11px] text-[hsl(var(--warning))]">
                  No hb_* keys on the slot — GAM never saw a Prebid winner (all noBid, or targeting lost the race).
                </div>
              )}
              <Json value={targeting} className="max-h-56" />
            </>
          ) : (
            <div className="text-muted-foreground">No slot targeting captured on slotRequested.</div>
          )}
        </div>
      </div>
    </Card>
  );
}

function GamHttpRow({ env }: { env: Envelope }) {
  const p = (env.payload || {}) as any;
  const prevScp = p.prev_scp || p.query?.prev_scp;
  const scp = p.scp || p.query?.scp;
  const slotParams = p.slotParams && typeof p.slotParams === 'object' ? p.slotParams : {};
  const custParams = p.custParams && typeof p.custParams === 'object' ? p.custParams : {};
  const responseHeaders = p.responseHeaders && typeof p.responseHeaders === 'object' ? p.responseHeaders : {};
  const hasResponse =
    p.status != null ||
    p.bodyPreview ||
    p.bodySniff ||
    Object.keys(responseHeaders).length > 0;

  return (
    <li className="rounded-md border border-border/70 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="success">GAMPAD</Badge>
        <span className="font-mono">
          {p.method} {p.status || '…'}
        </span>
        <span className="text-muted-foreground">{p.timeMs != null ? `${Math.round(p.timeMs)}ms` : ''}</span>
        <span className="truncate text-muted-foreground" title={p.url}>
          {p.path}
        </span>
      </div>
      <div className="mt-1 text-muted-foreground">
        iu: {Array.isArray(p.iuPaths) && p.iuPaths.length ? p.iuPaths.join(', ') : '—'}
        {p.sizes ? ` · sz ${p.sizes}` : ''}
        {p.correlator ? ` · correlator ${p.correlator}` : ''}
        {p.hbKeys?.length ? ` · hb keys: ${p.hbKeys.join(', ')}` : ' · no hb_* on the wire'}
      </div>

      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <div className="min-w-0 rounded border border-border/60 p-2">
          <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Request</div>
          <div className="space-y-1 font-mono text-[11px]">
            <div>
              <span className="text-muted-foreground">prev_scp </span>
              {prevScp ? <span className="break-all">{String(prevScp)}</span> : <span className="text-muted-foreground">—</span>}
            </div>
            {scp ? (
              <div>
                <span className="text-muted-foreground">scp </span>
                <span className="break-all">{String(scp)}</span>
              </div>
            ) : null}
            {Object.keys(slotParams).length > 0 && (
              <div>
                <span className="text-muted-foreground">prev_scp parsed </span>
                <Json value={slotParams} className="mt-0.5 max-h-32" />
              </div>
            )}
            {Object.keys(custParams).length > 0 && (
              <div>
                <span className="text-muted-foreground">cust_params </span>
                <Json value={custParams} className="mt-0.5 max-h-32" />
              </div>
            )}
          </div>
        </div>
        <div className="min-w-0 rounded border border-border/60 p-2">
          <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Response</div>
          {hasResponse ? (
            <div className="space-y-1 font-mono text-[11px]">
              <div>
                <span className="text-muted-foreground">status </span>
                {p.status ?? '—'} {p.statusText || ''}
              </div>
              <div>
                <span className="text-muted-foreground">mime </span>
                {p.mimeType || p.bodyKind || '—'}
                {p.bodyChars != null ? ` · ${p.bodyChars} chars` : ''}
              </div>
              {Object.keys(responseHeaders).length > 0 && (
                <div>
                  <span className="text-muted-foreground">headers </span>
                  <Json value={responseHeaders} className="mt-0.5 max-h-24" />
                </div>
              )}
              {p.bodyPreview && (
                <div>
                  <span className="text-muted-foreground">body </span>
                  <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px]">
                    {String(p.bodyPreview)}
                  </pre>
                </div>
              )}
              {!p.bodyPreview && p.bodySniff && (
                <div>
                  <span className="text-muted-foreground">body sniff </span>
                  <span className="break-all text-muted-foreground">(creative HTML/JS not stored) {String(p.bodySniff)}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="text-muted-foreground">No response captured yet (open the panel before the GAMPAD call).</div>
          )}
        </div>
      </div>

      <details className="mt-1">
        <summary className="cursor-pointer text-muted-foreground">full request / response payload</summary>
        <Json value={p} className="mt-1 max-h-56" />
      </details>
    </li>
  );
}

function Stage({ done, label, hint }: { done: boolean; label: string; hint: string }) {
  return (
    <li className="flex items-start gap-2">
      <span className={done ? 'text-[hsl(var(--success))]' : 'text-muted-foreground'}>{done ? '●' : '○'}</span>
      <div>
        <span className="font-medium">{label}</span>
        <span className="ml-2 text-muted-foreground">{hint}</span>
      </div>
    </li>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <TR>
      <TD className="w-48 font-mono text-muted-foreground">{k}</TD>
      <TD className="break-all font-mono">{v}</TD>
    </TR>
  );
}

function fmt(v: unknown): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  return String(v);
}

function fmtSize(size: unknown): string {
  if (size == null) return '—';
  if (Array.isArray(size)) return size.join('x');
  return String(size);
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
