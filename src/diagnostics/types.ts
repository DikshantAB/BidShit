import type { Envelope, SessionState } from '../shared/types';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Confidence = 'confirmed' | 'likely' | 'possible';
export type IssueScope = 'observation' | 'prebid' | 'gpt' | 'integration' | 'network';

export interface EvidenceItem {
  eventType?: string;
  timestamp: number;
  summary: string;
}

/** Catalog output contract from AD_SERVING_FAILURE_CATALOG.md */
export interface DiagnosticIssue {
  ruleId: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  scope: IssueScope;
  slotId?: string;
  auctionId?: string;
  adUnitCode?: string;
  cycleId?: string;
  detectedAt: number;
  evidence: EvidenceItem[];
  explanation: string;
  checks: string[];
  recommendations: string[];
}

export interface RuleMeta {
  id: string;
  title: string;
  severity: Severity;
  scope: IssueScope;
  explanation: string;
  checks: string[];
  recommendations: string[];
}

export interface DiagContext {
  session: SessionState;
  now: number;
  envelopes: Envelope[];
  observedFromStart: boolean;
  named: (channel: Envelope['channel'] | '*', name: string) => Envelope[];
  apis: (channel: Envelope['channel'], name: string) => Envelope[];
  errors: (name?: string) => Envelope[];
  forAuction: (auctionId: string) => Envelope[];
  forSlot: (slotId: string) => Envelope[];
  forAdUnit: (code: string) => Envelope[];
  elapsedSince: (env: Envelope | undefined) => number;
  quietFor: (ms: number) => boolean;
}

export type RuleEvaluate = (ctx: DiagContext) => DiagnosticIssue[];

export interface Rule extends RuleMeta {
  evaluate: RuleEvaluate;
}
