import type { DiagnosticIssue, DiagContext, Rule } from './types';

export function runRules(rules: readonly Rule[], ctx: DiagContext): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  for (const rule of rules) {
    try {
      const found = rule.evaluate(ctx);
      if (found.length) issues.push(...found);
    } catch {
      /* a single rule must never break diagnosis */
    }
  }
  issues.sort((a, b) => {
    const rank = severityRank(a.severity) - severityRank(b.severity);
    if (rank) return rank;
    return a.detectedAt - b.detectedAt;
  });
  return issues;
}

function severityRank(s: DiagnosticIssue['severity']): number {
  switch (s) {
    case 'critical':
      return 0;
    case 'high':
      return 1;
    case 'medium':
      return 2;
    case 'low':
      return 3;
    default:
      return 4;
  }
}
