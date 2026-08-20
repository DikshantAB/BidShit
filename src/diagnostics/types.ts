import type { SessionState } from '../shared/types';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type IssueScope = 'observation' | 'prebid' | 'gpt' | 'integration' | 'network' | 'consent';
export type Confidence = 'confirmed' | 'likely' | 'possible';

export interface IssueEvidence {
  timestamp: number;
  eventType?: string;
  summary: string;
}

export interface DiagnosticIssue {
  ruleId: string;
  title: string;
  severity: Severity;
  scope: IssueScope;
  confidence: Confidence;
  slotId?: string;
  adUnitCode?: string;
  auctionId?: string;
  signal: string;
  explanation: string;
  checks: string[];
  recommendations: string[];
  evidence: IssueEvidence[];
}

export type RuleFn = (session: SessionState) => DiagnosticIssue[];
