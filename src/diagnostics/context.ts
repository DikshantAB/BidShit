import type { Envelope, SessionState } from '../shared/types';
import type { DiagContext } from './types';

function key(channel: string, name: string): string {
  return `${channel}::${name}`;
}

export function sessionClock(session: SessionState, fallback = Date.now()): number {
  let max = 0;
  for (const env of session.envelopes) if (env.ts > max) max = env.ts;
  return max || fallback;
}

export function buildContext(session: SessionState, now = sessionClock(session)): DiagContext {
  const envelopes = session.envelopes;
  const byName = new Map<string, Envelope[]>();
  const byAuction = new Map<string, Envelope[]>();
  const bySlot = new Map<string, Envelope[]>();
  const byAdUnit = new Map<string, Envelope[]>();
  const errors: Envelope[] = [];

  const push = (map: Map<string, Envelope[]>, k: string | undefined, env: Envelope) => {
    if (!k) return;
    const list = map.get(k);
    if (list) list.push(env);
    else map.set(k, [env]);
  };

  for (const env of envelopes) {
    push(byName, key(env.channel, env.name), env);
    push(byName, key('*', env.name), env);
    push(byAuction, env.auctionId, env);
    push(bySlot, env.slotElementId, env);
    push(byAdUnit, env.adUnitCode, env);
    if (env.kind === 'error') errors.push(env);
  }

  const named = (channel: Envelope['channel'] | '*', name: string): Envelope[] =>
    byName.get(key(channel, name)) ?? [];

  const apis = (channel: Envelope['channel'], name: string): Envelope[] =>
    named(channel, name).filter((e) => e.kind === 'api');

  return {
    session,
    now,
    envelopes,
    observedFromStart: !!(session.status.hookReady && !session.status.hookLate),
    named,
    apis,
    errors: (name?: string) => (name ? errors.filter((e) => e.name === name) : errors),
    forAuction: (id) => byAuction.get(id) ?? [],
    forSlot: (id) => bySlot.get(id) ?? [],
    forAdUnit: (code) => byAdUnit.get(code) ?? [],
    elapsedSince: (env) => (env ? Math.max(0, now - env.ts) : 0),
    quietFor: (ms) => {
      const last = envelopes[envelopes.length - 1];
      if (!last) return false;
      return now - last.ts >= ms;
    },
  };
}
