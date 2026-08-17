import { useMemo } from 'react';
import { Badge, Card, EmptyState, Table, TBody, TD, TH, THead, TR } from '../components/ui';
import {
  classifyAllRenderCycles,
  classifyCreative,
  confidenceVariant,
  creativeSourceVariant,
  type ClassificationFacts,
  type CreativeClassification,
  type EvidenceItem,
} from '../selectors';
import { useSession } from '../store';

export function SourceView({ entity }: { entity: string }) {
  const session = useSession();

  const cycles = useMemo(() => classifyAllRenderCycles(session, entity || undefined), [session, entity]);

  const pending = useMemo(() => {
    // Slots / ad units with no slotRenderEnded yet still appear when filtered.
    if (!entity) return [] as CreativeClassification[];
    if (cycles.some((c) => c.facts.slotId === entity)) return [];
    return [classifyCreative(session, entity)];
  }, [session, entity, cycles]);

  const rows = cycles.length ? cycles : pending;

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No GPT render cycles to classify."
        hint="Reload the page with the panel open. Each slotRenderEnded becomes one classification cycle."
      />
    );
  }

  return (
    <div className="h-full space-y-3 overflow-auto p-3">
      <Card className="space-y-1 p-3 text-[11px] text-muted-foreground">
        <div>
          Classifies the <strong>demand source of the creative that actually rendered</strong> for each GPT render
          cycle (not permanently per slot).
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge variant="default">PREBID</Badge>
          <span>strong win/render evidence for this cycle (bidWon / adRenderSucceeded / renderAd / PUC + matching adId)</span>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge variant="warning">GAM</Badge>
          <span>
            non-Prebid creative rendered, Prebid coverage complete, auction settled or absent, no Prebid win/render
            evidence
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge variant="secondary">UNKNOWN</Badge>
          <span>
            incomplete coverage, weak hb_*/bid-only evidence, empty slot, or conflict — preferred over a wrong label
          </span>
        </div>
        <div>
          <code>hb_*</code>, <code>lineItemId</code>, <code>creativeId</code>, and GAM HTTP alone never decide the
          verdict. Prebid participated ≠ Prebid won.
        </div>
      </Card>
      {[...rows].reverse().map((cls) => (
        <SourceCard key={cls.cycleId} cls={cls} />
      ))}
    </div>
  );
}

function SourceCard({ cls }: { cls: CreativeClassification }) {
  return (
    <Card className="min-w-0 overflow-hidden p-3">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-medium">{cls.facts.slotId || cls.cycleId}</span>
        <Badge variant={creativeSourceVariant(cls.source)}>{cls.source}</Badge>
        <Badge variant={confidenceVariant(cls.confidence)}>{cls.confidence}</Badge>
        {cls.bidder && <Badge variant="outline">{cls.bidder}</Badge>}
        {cls.adId && <span className="font-mono text-[10px] text-muted-foreground">adId {cls.adId}</span>}
        <span className="font-mono text-[10px] text-muted-foreground">{cls.cycleId}</span>
      </div>
      <div className="mb-2 text-[11px] text-muted-foreground">{cls.reason}</div>
      <FactsStrip facts={cls.facts} />
      <EvidenceTable evidence={cls.evidence} />
    </Card>
  );
}

function FactsStrip({ facts }: { facts: ClassificationFacts }) {
  const chips: { k: string; v: string }[] = [
    { k: 'coverage', v: String(facts.prebidCoverageComplete) },
    { k: 'bidWon', v: String(facts.bidWonObserved) },
    { k: 'adRenderSucceeded', v: String(facts.adRenderSucceeded) },
    { k: 'renderAd', v: String(facts.renderAdObserved) },
    { k: 'puc', v: String(facts.pucObserved) },
    { k: 'rendered', v: String(facts.gptSlotRendered) },
    { k: 'empty', v: String(facts.isEmpty) },
  ];
  if (facts.auctionId) chips.push({ k: 'auctionId', v: facts.auctionId.slice(0, 10) });
  if (facts.transactionId) chips.push({ k: 'txn', v: String(facts.transactionId).slice(0, 10) });
  if (facts.hbAdId) chips.push({ k: 'hb_adid', v: facts.hbAdId });
  if (facts.lineItemId != null) chips.push({ k: 'lineItemId', v: String(facts.lineItemId) });
  if (facts.creativeId != null) chips.push({ k: 'creativeId', v: String(facts.creativeId) });

  return (
    <div className="mb-2 flex flex-wrap gap-1">
      {chips.map((c) => (
        <Badge key={c.k} variant="outline" className="font-mono text-[10px]">
          {c.k}={c.v}
        </Badge>
      ))}
    </div>
  );
}

export function EvidenceTable({ evidence }: { evidence: EvidenceItem[] }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH className="w-48">Evidence</TH>
          <TH className="w-16">Role</TH>
          <TH>Detail</TH>
        </TR>
      </THead>
      <TBody>
        {evidence.map((e, i) => (
          <TR key={`${e.label}-${i}`}>
            <TD className="align-top">
              <span className="font-medium">{e.label}</span>
              {e.supports === true && (
                <Badge variant="success" className="ml-1">
                  match
                </Badge>
              )}
              {e.supports === false && (
                <Badge variant="warning" className="ml-1">
                  no
                </Badge>
              )}
            </TD>
            <TD className="align-top">
              <Badge variant={e.role === 'context' ? 'outline' : 'secondary'}>{e.role || 'verdict'}</Badge>
            </TD>
            <TD className="break-all font-mono text-[11px]">{e.value}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
