import { buildContext, sessionClock } from './context';
import { runRules } from './engine';
import { gptRules } from './rules/gpt';
import { integrationRules } from './rules/integration';
import { networkRules } from './rules/network';
import { obsRules } from './rules/obs';
import { prebidRules } from './rules/prebid';
import type { DiagnosticIssue, Rule } from './types';
import type { SessionState } from '../shared/types';

export type {
  Confidence,
  DiagnosticIssue,
  DiagContext,
  EvidenceItem,
  IssueScope,
  Rule,
  RuleMeta,
  Severity,
} from './types';
export { buildContext, sessionClock } from './context';
export { runRules } from './engine';
export { THRESHOLDS } from './thresholds';

export const allRules: Rule[] = [...obsRules, ...prebidRules, ...gptRules, ...integrationRules, ...networkRules];

export function diagnose(session: SessionState, now?: number): DiagnosticIssue[] {
  const ctx = buildContext(session, now ?? sessionClock(session));
  return runRules(allRules, ctx);
}

export const catalogRuleCount = {
  observation: obsRules.length,
  prebid: prebidRules.length,
  gpt: gptRules.length,
  integration: integrationRules.length,
  network: networkRules.length,
  total: allRules.length,
} as const;
