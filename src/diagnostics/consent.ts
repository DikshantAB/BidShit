import type { SessionState } from '../shared/types';
import { arr, evidenceFrom, issue, named, rec, str } from './helpers';
import type { DiagnosticIssue } from './types';

export const TCF_LISTS = [
  { key: 'biddersBlocked', label: 'Bidders' },
  { key: 'analyticsBlocked', label: 'Analytics adapters' },
  { key: 'storageBlocked', label: 'Storage / user IDs' },
  { key: 'eidsBlocked', label: 'Extended user IDs (EIDs)' },
  { key: 'ufpdBlocked', label: 'User first-party data' },
  { key: 'geoBlocked', label: 'Precise geolocation' },
] as const;

const META = {
  ruleId: 'COMMON-CMP-01',
  title: 'TCF2 enforcement blocked demand, storage, or data',
  severity: 'critical' as const,
  scope: 'consent' as const,
  signal:
    'Prebid tcf2Enforcement reports a non-empty biddersBlocked, analyticsBlocked, storageBlocked, eidsBlocked, ufpdBlocked, or geoBlocked list.',
  explanation:
    'The CMP did not provide sufficient TCF2 legal basis for the purpose, vendor signal, or special feature; consent arrived late; or consentManagement.gdpr / tcfControl rules disallow the activity. tcfControl emits this event on auctionEnd.',
  checks: [
    'Read the tcf2Enforcement payload lists and pbjs.getConsentMetadata().',
    'Confirm the CMP is ready before requestBids, that tcfControl is in the build, and which purpose/vendor rules are configured.',
  ],
  recommendations: [
    'Fix CMP/consent timing and configuration, or accept the restricted auction.',
    'Never bypass, rewrite, or fabricate consent in the debugger.',
  ],
};

export function tcfBlockedNames(payload: Record<string, unknown>, key: string): string[] {
  return arr(payload[key])
    .map((v) => str(v))
    .filter((v): v is string => !!v);
}

export function tcfHasBlocks(payload: Record<string, unknown>): boolean {
  return TCF_LISTS.some((list) => tcfBlockedNames(payload, list.key).length > 0);
}

export function findConsentIssues(session: SessionState): DiagnosticIssue[] {
  const out: DiagnosticIssue[] = [];
  for (const env of named(session, 'prebid', 'tcf2Enforcement')) {
    const p = rec(env.payload);
    if (!tcfHasBlocks(p)) continue;
    const evidence = TCF_LISTS.map((list) => {
      const names = tcfBlockedNames(p, list.key);
      if (!names.length) return undefined;
      return evidenceFrom(env, `${list.label} blocked (${names.length}): ${names.join(', ')}`, env.name);
    }).filter((e): e is NonNullable<typeof e> => !!e);
    out.push(
      issue({
        ...META,
        confidence: 'confirmed',
        auctionId: env.auctionId,
        evidence,
      })
    );
  }
  return out;
}
