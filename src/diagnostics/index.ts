import { findObservationIssues } from './observation';
import { findPrebidIssues } from './prebid';
import { findGptIssues } from './gpt';
import { findIntegrationIssues } from './integration';
import { findNetworkIssues } from './network';
import { findConsentIssues } from './consent';
import type { DiagnosticIssue } from './types';
import type { SessionState } from '../shared/types';

export type { Confidence, DiagnosticIssue, IssueEvidence, IssueScope, Severity } from './types';

/** Run all issue families over the current session. Families are added as they are implemented. */
export function diagnose(session: SessionState): DiagnosticIssue[] {
  return [
    ...findObservationIssues(session),
    ...findPrebidIssues(session),
    ...findGptIssues(session),
    ...findIntegrationIssues(session),
    ...findNetworkIssues(session),
    ...findConsentIssues(session),
  ];
}
