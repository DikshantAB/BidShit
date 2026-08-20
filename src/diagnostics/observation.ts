import type { SessionState } from '../shared/types';
import { absenceConfidence, evidenceFrom, hasPrebidTargeting, issue, lastNamed, named } from './helpers';
import type { DiagnosticIssue } from './types';

const META = {
  ruleId: 'COMMON-OBS-01',
  title: 'Missing optional event is reported as a failure',
  severity: 'info' as const,
  scope: 'observation' as const,
  signal:
    'The only “problem” is a missing bidWon, slotOnload, or impressionViewable on an otherwise valid path.',
  explanation:
    'Those events are optional. bidWon fires only when Prebid marks a bid as winning during render, slotOnload only when a creative iframe loads, and impressionViewable only when Active View criteria are met.',
  checks: [
    'Confirm whether Prebid actually rendered, whether an iframe load applies, and whether the filled slot had a chance to become viewable.',
  ],
  recommendations: [
    'Do not treat these absences as failures. They are pending or not-applicable unless their documented preconditions were met.',
  ],
};

/**
 * COMMON-OBS-01 — after a slot has rendered, missing bidWon / slotOnload /
 * impressionViewable is Info (pending or not-applicable), never a lifecycle failure.
 */
export function findObservationIssues(session: SessionState): DiagnosticIssue[] {
  const out: DiagnosticIssue[] = [];
  const confidence = absenceConfidence(session);

  for (const slot of session.slots.values()) {
    const render = lastNamed(session, 'gpt', 'slotRenderEnded', slot.slotElementId);
    if (!render) continue;

    const filled = slot.filled === true || slot.isEmpty === false;
    const empty = slot.isEmpty === true;
    const bidWon = named(session, 'prebid', 'bidWon').some(
      (e) => e.adUnitCode === slot.slotElementId || e.slotElementId === slot.slotElementId
    );
    const prebidSelected = hasPrebidTargeting(session, slot) || bidWon;

    if (!bidWon) {
      out.push(
        issue({
          ...META,
          confidence,
          slotId: slot.slotElementId,
          adUnitCode: slot.slotElementId,
          evidence: [
            evidenceFrom(
              render,
              prebidSelected
                ? 'hb_* targeting is present but bidWon was not observed — pending, not a failure. bidWon fires only if Prebid actually rendered this ad.'
                : 'No Prebid win/render for this slot — bidWon is not applicable.',
              'bidWon'
            ),
          ],
        })
      );
    }

    if (!slot.onloaded) {
      out.push(
        issue({
          ...META,
          confidence,
          slotId: slot.slotElementId,
          adUnitCode: slot.slotElementId,
          evidence: [
            evidenceFrom(
              render,
              empty || !filled
                ? 'No slotOnload after an empty or unfilled render — not applicable (no creative iframe).'
                : 'Filled render without slotOnload — pending. GPT skips this event for sync/rich-media with no iframe.',
              'slotOnload'
            ),
          ],
        })
      );
    }

    if (!slot.viewable) {
      out.push(
        issue({
          ...META,
          confidence,
          slotId: slot.slotElementId,
          adUnitCode: slot.slotElementId,
          evidence: [
            evidenceFrom(
              render,
              empty || !filled
                ? 'No impressionViewable on an empty slot — not applicable.'
                : 'impressionViewable not observed — pending until Active View criteria are met (below-the-fold slots may never fire).',
              'impressionViewable'
            ),
          ],
        })
      );
    }
  }

  return out;
}
