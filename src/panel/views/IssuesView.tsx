import { useMemo, useState, type ReactNode } from 'react';
import { Badge, Card, EmptyState, Input, Json } from '../components/ui';
import { cn } from '../lib/cn';
import {
  countBy,
  diagnoseSession,
  filterIssues,
  issueConfidenceVariant,
  ISSUE_CONFIDENCES,
  ISSUE_SCOPES,
  ISSUE_SEVERITIES,
  scopeLabel,
  severityVariant,
  type DiagnosticIssue,
  type IssueScope,
  type Severity,
} from '../selectors';
import { useSession } from '../store';

export function IssuesView({
  entity,
  search,
  issues,
}: {
  entity: string;
  search: string;
  /** Precomputed by App to avoid running the rule engine twice; falls back locally. */
  issues?: DiagnosticIssue[];
}) {
  const session = useSession();
  const [scopes, setScopes] = useState<IssueScope[]>([]);
  const [severities, setSeverities] = useState<Severity[]>([]);
  const [confidences, setConfidences] = useState<DiagnosticIssue['confidence'][]>([]);
  const [localText, setLocalText] = useState('');
  const [entityMode, setEntityMode] = useState<'entity' | 'all'>('entity');

  const fallback = useMemo(() => (issues ? [] : diagnoseSession(session)), [issues, session]);
  const allIssues = issues ?? fallback;

  // Effective scope for entity filtering: only applies when a slot/unit is selected.
  const effectiveMode = entity ? entityMode : 'all';
  const text = (localText || search || '').trim();

  const scopeFiltered = useMemo(
    () => filterIssues(allIssues, { entity, entityMode: effectiveMode, session }),
    [allIssues, entity, effectiveMode, session]
  );

  const visible = useMemo(
    () =>
      filterIssues(allIssues, {
        scopes,
        severities,
        confidences,
        text,
        entity,
        entityMode: effectiveMode,
        session,
      }),
    [allIssues, scopes, severities, confidences, text, entity, effectiveMode, session]
  );

  const sevCounts = useMemo(() => countBy(scopeFiltered, (i) => i.severity), [scopeFiltered]);
  const scopeCounts = useMemo(() => countBy(scopeFiltered, (i) => i.scope), [scopeFiltered]);
  const confCounts = useMemo(() => countBy(scopeFiltered, (i) => i.confidence), [scopeFiltered]);

  const toggle = <T,>(list: T[], value: T, set: (next: T[]) => void) => {
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  };

  if (!allIssues.length && !session.status.prebidPresent && !session.status.gptPresent) {
    return <EmptyState title="No issues to analyze yet." hint="Reload the page with the panel open so BidShitter can observe the lifecycle." />;
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Filter bar */}
      <div className="space-y-2 border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Scope</span>
          {ISSUE_SCOPES.map((s) => (
            <FilterPill
              key={s}
              active={scopes.includes(s)}
              onClick={() => toggle(scopes, s, setScopes)}
              count={scopeCounts[s] || 0}
            >
              {scopeLabel(s)}
            </FilterPill>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Severity</span>
          {ISSUE_SEVERITIES.map((s) => (
            <FilterPill
              key={s}
              active={severities.includes(s)}
              onClick={() => toggle(severities, s, setSeverities)}
              count={sevCounts[s] || 0}
              variant={severityVariant(s)}
            >
              {s}
            </FilterPill>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Confidence</span>
          {ISSUE_CONFIDENCES.map((c) => (
            <FilterPill
              key={c}
              active={confidences.includes(c)}
              onClick={() => toggle(confidences, c, setConfidences)}
              count={confCounts[c] || 0}
            >
              {c}
            </FilterPill>
          ))}
          <div className="ml-auto w-52">
            <Input placeholder="Filter issues…" value={localText} onChange={(e) => setLocalText(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {entity ? (
            <div className="inline-flex overflow-hidden rounded-md border border-border">
              <ModeButton active={entityMode === 'entity'} onClick={() => setEntityMode('entity')}>
                This slot · {entity}
              </ModeButton>
              <ModeButton active={entityMode === 'all'} onClick={() => setEntityMode('all')}>
                All issues
              </ModeButton>
            </div>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              Showing global issues. Select an ad unit / slot on the left to focus on its issues.
            </span>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground">
            {visible.length} of {scopeFiltered.length} shown
          </span>
          {(scopes.length > 0 || severities.length > 0 || confidences.length > 0 || localText.length > 0) && (
            <button
              className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => {
                setScopes([]);
                setSeverities([]);
                setConfidences([]);
                setLocalText('');
              }}
            >
              clear filters
            </button>
          )}
        </div>
      </div>

      {/* Issue list */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {visible.length === 0 ? (
          <EmptyState
            title={scopeFiltered.length === 0 ? 'No issues detected.' : 'No issues match the current filters.'}
            hint={
              scopeFiltered.length === 0
                ? entity
                  ? 'No rule fired for this slot yet. Switch to “All issues” to see the whole page.'
                  : 'The rule engine found nothing suspicious in the observed lifecycle so far.'
                : 'Adjust or clear the filters above.'
            }
          />
        ) : (
          <ul className="space-y-2">
            {visible.map((issue, i) => (
              <IssueRow key={`${issue.ruleId}-${issue.slotId || ''}-${issue.auctionId || ''}-${i}`} issue={issue} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function IssueRow({ issue }: { issue: DiagnosticIssue }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <Card className="min-w-0 overflow-hidden">
        <button className="flex w-full items-start gap-2 px-3 py-2 text-left" onClick={() => setOpen((o) => !o)}>
          <Badge variant={severityVariant(issue.severity)} className="mt-0.5 shrink-0 uppercase">
            {issue.severity}
          </Badge>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[10px] text-muted-foreground">{issue.ruleId}</span>
              <span className="text-xs font-medium">{issue.title}</span>
            </div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {issue.evidence[0]?.summary || issue.explanation}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <div className="flex flex-wrap items-center justify-end gap-1">
              <Badge variant="secondary">{scopeLabel(issue.scope)}</Badge>
              <Badge variant={issueConfidenceVariant(issue.confidence)}>{issue.confidence}</Badge>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-1">
              {issue.slotId && <Badge variant="outline">slot · {issue.slotId}</Badge>}
              {issue.adUnitCode && issue.adUnitCode !== issue.slotId && (
                <Badge variant="outline">unit · {issue.adUnitCode}</Badge>
              )}
              {issue.auctionId && <Badge variant="outline">auction · {issue.auctionId.slice(0, 8)}</Badge>}
            </div>
          </div>
          <span className="ml-1 shrink-0 text-muted-foreground">{open ? '−' : '+'}</span>
        </button>

        {open && (
          <div className="space-y-3 border-t border-border px-3 py-2 text-[11px]">
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Signal</div>
              <p className="text-foreground/90">{issue.signal}</p>
            </div>
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Why it happens</div>
              <p className="text-foreground/90">{issue.explanation}</p>
            </div>

            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">
                Evidence ({issue.evidence.length})
              </div>
              <ul className="space-y-1">
                {issue.evidence.map((e, i) => (
                  <li key={i} className="flex items-start gap-2 rounded border border-border/60 px-2 py-1">
                    <span className="w-16 shrink-0 font-mono text-[10px] text-muted-foreground">
                      {e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '—'}
                    </span>
                    {e.eventType && <Badge variant="secondary">{e.eventType}</Badge>}
                    <span className="min-w-0 flex-1">{e.summary}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Check</div>
                <ul className="list-disc space-y-0.5 pl-4 text-foreground/90">
                  {issue.checks.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Do</div>
                <ul className="list-disc space-y-0.5 pl-4 text-foreground/90">
                  {issue.recommendations.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            </div>

            <details>
              <summary className="cursor-pointer text-muted-foreground">raw diagnostic object</summary>
              <Json value={issue} className="mt-1 max-h-64" />
            </details>
          </div>
        )}
      </Card>
    </li>
  );
}

function FilterPill({
  active,
  onClick,
  count,
  variant,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  variant?: ReturnType<typeof severityVariant>;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium capitalize transition-colors',
        active ? 'border-primary bg-primary/15 text-primary' : 'border-border bg-transparent text-muted-foreground hover:text-foreground'
      )}
    >
      {variant && <span className={cn('h-1.5 w-1.5 rounded-full', dotForVariant(variant))} />}
      {children}
      <span className={cn('rounded px-1 text-[9px]', active ? 'bg-primary/20' : 'bg-muted')}>{count}</span>
    </button>
  );
}

function dotForVariant(variant: ReturnType<typeof severityVariant>): string {
  switch (variant) {
    case 'destructive':
      return 'bg-destructive';
    case 'warning':
      return 'bg-[hsl(var(--warning))]';
    case 'secondary':
      return 'bg-muted-foreground';
    default:
      return 'bg-border';
  }
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-2 py-1 text-[11px] font-medium transition-colors',
        active ? 'bg-primary text-primary-foreground' : 'bg-transparent text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}
