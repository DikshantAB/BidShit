import { useMemo } from 'react';
import { PREBID_TARGETING_KEYS } from '../../shared/constants';
import { Alert, Badge, Card, EmptyState, Table, TBody, TD, TH, THead, TR } from '../components/ui';
import { cn } from '../lib/cn';
import { correlation, targetingRace } from '../selectors';
import { useSession } from '../store';

const HB = new Set<string>(PREBID_TARGETING_KEYS as readonly string[]);

export function TargetingView({ entity }: { entity: string }) {
  const session = useSession();
  const race = useMemo(() => targetingRace(session), [session]);
  const corr = useMemo(() => correlation(session), [session]);

  const prebidCodes = Object.keys(session.prebidTargeting).filter((c) => !entity || c === entity);
  const gptPage = session.gptPageTargeting;
  const hasPrebid = prebidCodes.length > 0;
  const hasGptPage = Object.keys(gptPage).length > 0;

  if (!hasPrebid && !hasGptPage) {
    return (
      <EmptyState
        title="No targeting observed yet."
        hint="Targeting appears after Prebid setTargeting / setTargetingForGPTAsync and GPT pubads().setTargeting."
      />
    );
  }

  return (
    <div className="h-full space-y-3 overflow-auto p-3">
      {race && (
        <Alert variant="warning">
          Race detected: GPT <code>refresh</code>/<code>display</code> ran before Prebid targeting was applied. The GAM
          request snapshot likely missed the <code>hb_*</code> keys.
        </Alert>
      )}
      {corr.unmatchedAdUnits.length + corr.unmatchedSlots.length > 0 && (
        <Alert variant="warning">
          Correlation mismatch: {corr.unmatchedAdUnits.length} ad unit code(s) and {corr.unmatchedSlots.length} GPT slot
          id(s) did not match. Prebid targeting may not reach the intended slot.
        </Alert>
      )}

      {hasPrebid && (
        <Card className="p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Prebid → ad server targeting (getAdserverTargeting / setTargeting)
          </div>
          {prebidCodes.map((code) => (
            <div key={code} className="mb-3 last:mb-0">
              <div className="mb-1 flex items-center gap-2">
                <span className="font-medium">{code}</span>
                {corr.matched.includes(code) ? (
                  <Badge variant="success">matched slot</Badge>
                ) : (
                  <Badge variant="warning">no matching slot</Badge>
                )}
              </div>
              <KvTable kv={session.prebidTargeting[code]} highlightHb />
            </div>
          ))}
        </Card>
      )}

      {hasGptPage && (
        <Card className="p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            GPT page-level targeting (pubads().setTargeting)
          </div>
          <KvTable kv={gptPage} />
        </Card>
      )}
    </div>
  );
}

function KvTable({ kv, highlightHb }: { kv: Record<string, unknown>; highlightHb?: boolean }) {
  const keys = Object.keys(kv || {}).sort();
  if (keys.length === 0) return <div className="text-muted-foreground">No keys.</div>;
  return (
    <Table>
      <THead>
        <TR>
          <TH>Key</TH>
          <TH>Value</TH>
        </TR>
      </THead>
      <TBody>
        {keys.map((k) => (
          <TR key={k}>
            <TD className={cn('font-mono', highlightHb && HB.has(k) && 'text-primary')}>{k}</TD>
            <TD className="font-mono break-all">{formatValue(kv[k])}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function formatValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(', ');
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
