import { defineRule, fromEvent, num, payload, str } from '../helpers';
import { THRESHOLDS } from '../thresholds';
import type { DiagnosticIssue, Rule, RuleMeta } from '../types';

function meta(
  id: string,
  title: string,
  severity: RuleMeta['severity'],
  explanation: string,
  checks: string[],
  recommendations: string[]
): RuleMeta {
  return { id, title, severity, scope: 'network', explanation, checks, recommendations };
}

export const networkRules: Rule[] = [
  defineRule(
    meta('NET-01', 'Browser is offline or connection drops', 'critical', 'Multiple unrelated Prebid/GPT requests fail together.', ['Compare failures across origins'], ['Restore connectivity; do not diagnose each endpoint independently']),
    (ctx) => {
      const gamFails = ctx.named('network', 'gamRequest').filter((e) => payload(e).failed === true);
      const bidderFails = ctx.named('prebid', 'bidderError');
      if (gamFails.length + bidderFails.length < 3) return [];
      const sample = gamFails[0] || bidderFails[0];
      return [fromEvent(find('NET-01'), sample, ctx, 'possible', 'clustered request failures (possible offline)')];
    }
  ),
  defineRule(
    meta('NET-02', 'DNS resolution failure', 'critical', 'Request fails before connection with a DNS error.', ['Record hostname and browser error'], ['Correct the URL/DNS environment']),
    (ctx) => matchText(ctx, 'NET-02', /dns|name.?not.?resolved|err_name_not_resolved/i)
  ),
  defineRule(
    meta('NET-03', 'TLS/certificate failure', 'critical', 'HTTPS request fails during SSL/TLS negotiation.', ['Inspect security details'], ['Fix the certificate/endpoint']),
    (ctx) => matchText(ctx, 'NET-03', /tls|ssl|cert|err_cert|err_ssl/i)
  ),
  defineRule(
    meta('NET-04', 'Request blocked by an ad blocker or browser privacy feature', 'high', 'Requests are marked blocked by client/extension.', ['Inspect blocked reason'], ['Report environmental blocking; do not evade user tools']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('network', 'gamRequest')) {
        const blocked = str(payload(env).blockedReason) || str(payload(env).statusText);
        if (blocked && /block|err_blocked|adblock/i.test(blocked)) {
          out.push(fromEvent(find('NET-04'), env, ctx, 'confirmed', blocked));
        }
      }
      for (const env of ctx.named('prebid', 'browserIntervention')) {
        out.push(fromEvent(find('NET-04'), env, ctx, 'likely', 'browserIntervention (possible blocking)'));
      }
      return out;
    }
  ),
  defineRule(
    meta('NET-05', 'Content Security Policy blocks script, connection, frame, or creative', 'high', 'Console/CSP evidence on a required origin.', ['Capture violated directive'], ['Narrowly update publisher CSP if the resource is trusted']),
    (ctx) => matchText(ctx, 'NET-05', /content security policy|csp|violates the following/i)
  ),
  defineRule(
    meta('NET-06', 'Mixed-content blocking', 'high', 'HTTPS page attempts an HTTP bidder/script/creative request.', ['Inspect scheme'], ['Use HTTPS throughout']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('network', 'gamRequest')) {
        const url = str(payload(env).url) || '';
        if (url.startsWith('http://')) out.push(fromEvent(find('NET-06'), env, ctx, 'confirmed', url));
      }
      return out.concat(matchText(ctx, 'NET-06', /mixed content/i));
    }
  ),
  defineRule(
    meta('NET-07', 'Request canceled by navigation, unload, or slot destruction', 'medium', 'Network request is canceled while page/slot lifecycle ends.', ['Compare cancellation with navigation and destroySlots'], ['Treat as canceled rather than endpoint failure']),
    (ctx) => {
      const destroyed = ctx.apis('gpt', 'destroySlots');
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('network', 'gamRequest')) {
        const status = num(payload(env).status);
        const text = str(payload(env).statusText) || '';
        if (status === 0 && /cancel|abort|ns_binding_aborted/i.test(text)) {
          out.push(fromEvent(find('NET-07'), env, ctx, 'likely', text || 'canceled request'));
        }
      }
      if (destroyed.length && out.length) return out;
      return out.concat(matchText(ctx, 'NET-07', /ns_binding_aborted|net::err_aborted|canceled/i));
    }
  ),
  defineRule(
    meta('NET-08', 'Proxy, VPN, firewall, or enterprise policy interferes', 'high', 'Failures without page-level cause; often environment-specific.', ['Compare a clean network/profile'], ['Escalate to the network administrator']),
    () => []
  ),
  defineRule(
    meta('NET-09', 'HTTP response is successful but semantically unusable', 'high', 'HTTP 2xx exists, but Prebid reports no-bid/rejection or GPT reports empty.', ['Use outcome events, not HTTP status alone'], ['Investigate bidder validation or GAM delivery']),
    (ctx) => {
      const ok = ctx.named('network', 'gamRequest').filter((e) => {
        const s = num(payload(e).status);
        return s != null && s >= 200 && s < 300;
      });
      if (!ok.length) return [];
      const empty = ctx.named('gpt', 'slotRenderEnded').filter((e) => payload(e).isEmpty === true);
      if (!empty.length) return [];
      return [fromEvent(find('NET-09'), empty[0], ctx, 'confirmed', 'GAM HTTP 2xx but slotRenderEnded.isEmpty')];
    }
  ),
  defineRule(
    meta('NET-10', 'Main-thread blocking distorts lifecycle timing', 'medium', 'Network completes but JS callbacks/events are delayed.', ['Correlate long tasks with event timestamps'], ['Distinguish network duration from callback delay']),
    () => []
  ),
  defineRule(
    meta('NET-11', 'Service worker or cache changes the observed request path', 'medium', 'Request appears served/intercepted by a service worker or cache.', ['Inspect request source / cache flags'], ['Account for interception in diagnosis']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('network', 'gamRequest')) {
        const fromCache = payload(env).fromCache === true || str(payload(env).source) === 'service-worker';
        if (fromCache) out.push(fromEvent(find('NET-11'), env, ctx, 'confirmed', 'GAM request served from cache/service worker'));
      }
      return out;
    }
  ),
  defineRule(
    meta('NET-12', 'Request or targeting URL becomes excessively large', 'medium', 'GAM/bidder request has unusually large query/body.', ['Measure request size'], ['Minimize unnecessary targeting']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('network', 'gamRequest')) {
        const url = str(payload(env).url) || '';
        const size = num(payload(env).bodySize) || url.length;
        if (url.length >= THRESHOLDS.largeRequestChars || size >= THRESHOLDS.largeRequestChars) {
          out.push(fromEvent(find('NET-12'), env, ctx, 'confirmed', `request size ${Math.max(url.length, size)}`));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('NET-13', 'CORS prevents the bidder response from being read', 'high', 'Browser reports a CORS violation and Prebid cannot consume the response.', ['Inspect CORS error and OPTIONS'], ['Correct bidder endpoint CORS policy']),
    (ctx) => matchText(ctx, 'NET-13', /cors|access-control-allow-origin/i)
  ),
  defineRule(
    meta('NET-14', 'CORS preflight consumes the auction budget', 'medium', 'OPTIONS precedes the bidder request and uses a substantial fraction of the timeout.', ['Inspect OPTIONS timing vs auction deadline'], ['Prefer simple requests such as text/plain where the contract allows']),
    (ctx) => {
      const out: DiagnosticIssue[] = [];
      for (const env of ctx.named('network', 'gamRequest')) {
        if (str(payload(env).method) !== 'OPTIONS') continue;
        const time = num(payload(env).timeMs) || 0;
        const auction = ctx.named('prebid', 'auctionInit')[0];
        const timeout = auction ? Number(payload(auction).timeout) || 0 : 0;
        if (timeout && time / timeout >= THRESHOLDS.preflightBudgetShare) {
          out.push(fromEvent(find('NET-14'), env, ctx, 'likely', `OPTIONS ${time}ms of ${timeout}ms timeout`));
        }
      }
      return out;
    }
  ),
  defineRule(
    meta('NET-15', 'Bidder endpoint rejects the request with HTTP 4xx', 'high', 'Bidder/PBS/GAM request completes with 4xx.', ['Record status and sanitized error'], ['Correct request configuration or account issues']),
    (ctx) => statusClass(ctx, 'NET-15', 400, 499)
  ),
  defineRule(
    meta('NET-16', 'Bidder endpoint fails with HTTP 5xx', 'high', 'Bidder/PBS/GAM request returns 5xx.', ['Record status and recurrence'], ['Escalate to the service owner; do not retry inside the settled auction']),
    (ctx) => statusClass(ctx, 'NET-16', 500, 599)
  ),
];

const BY_ID = new Map(networkRules.map((r) => [r.id, r]));
function find(id: string): RuleMeta {
  return BY_ID.get(id)!;
}

function matchText(ctx: Parameters<Rule['evaluate']>[0], id: string, re: RegExp): DiagnosticIssue[] {
  const out: DiagnosticIssue[] = [];
  const pool = [...ctx.named('network', 'gamRequest'), ...ctx.named('prebid', 'bidderError'), ...ctx.errors()];
  for (const env of pool) {
    if (!re.test(JSON.stringify(payload(env)))) continue;
    out.push(fromEvent(find(id), env, ctx, 'confirmed', `${id} matched diagnostic text`));
  }
  return out;
}

function statusClass(ctx: Parameters<Rule['evaluate']>[0], id: string, lo: number, hi: number): DiagnosticIssue[] {
  const out: DiagnosticIssue[] = [];
  for (const env of ctx.named('network', 'gamRequest')) {
    const status = num(payload(env).status);
    if (status == null || status < lo || status > hi) continue;
    out.push(fromEvent(find(id), env, ctx, 'confirmed', `HTTP ${status}`));
  }
  for (const env of ctx.named('prebid', 'bidderError')) {
    const status = num(payload(env).status) ?? num(recStatus(payload(env)));
    if (status == null || status < lo || status > hi) continue;
    out.push(fromEvent(find(id), env, ctx, 'confirmed', `bidder HTTP ${status}`));
  }
  return out;
}

function recStatus(p: Record<string, unknown>): unknown {
  const err = p.error;
  if (err && typeof err === 'object') return (err as Record<string, unknown>).status;
  return undefined;
}
