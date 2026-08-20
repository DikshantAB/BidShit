/** GAM / GPT ad-request URL detection and query parsing for the DevTools HAR. */

const GAM_HOST_PARTS = [
  'securepubads.g.doubleclick.net',
  'pubads.g.doubleclick.net',
  'pagead2.googlesyndication.com',
  'googleads.g.doubleclick.net',
  'ad.doubleclick.net',
];

const AD_PATHS = ['/gampad/ads', '/gampad/adx', '/pagead/ads', '/pagead/adview'];

const INTERESTING_QUERY = new Set([
  'iu',
  'sz',
  'cust_params',
  'prev_scp',
  'scp',
  'correlator',
  'output',
  'impl',
  'gdfp_req',
  'adk',
  'adks',
  'ifi',
  'prev_iu_szs',
  'fluid',
  'gpid',
  'pvsid',
  'ptt',
  'npa',
  'rdp',
  'tfcd',
  'tfua',
  'ltd',
  'lmt',
  'dt',
  'url',
  'ref',
  'dssz',
  'msz',
  'psz',
  'format',
  'unviewed_position_start',
]);

const REDACT_QUERY = new Set(['cookie', 'cookies', 'puid', 'nid']);

/** Origin + path only; query identifiers are stripped for NET evidence. */
export function originPath(url: string): { host: string; path: string; originPath: string } {
  try {
    const u = new URL(url);
    return { host: u.hostname, path: u.pathname, originPath: `${u.origin}${u.pathname}` };
  } catch {
    return { host: '', path: url, originPath: url.split('?')[0] || url };
  }
}

export function isPrebidOrGptScript(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (path.includes('prebid') && (path.endsWith('.js') || path.includes('.js'))) return true;
    if (path.endsWith('/gpt.js') || path.includes('/tag/js/gpt.js')) return true;
    if (path.includes('pubads_impl') || path.includes('/gpt/pubads')) return true;
    if (host.includes('googletagservices') || host.includes('securepubads.g.doubleclick.net')) {
      return path.includes('gpt') || path.includes('pubads');
    }
    return false;
  } catch {
    return /prebid|\bgpt\.js\b|pubads_impl/i.test(url);
  }
}

export function isGamAdRequest(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (!GAM_HOST_PARTS.some((h) => host === h || host.endsWith('.' + h))) {
      if (!host.includes('doubleclick.net') && !host.includes('googlesyndication.com')) return false;
    }
    const path = u.pathname.toLowerCase();
    if (AD_PATHS.some((p) => path.includes(p))) return true;
    if (path.includes('/gampad/')) return true;
    return false;
  } catch {
    return false;
  }
}

export function parseQueryMap(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const u = new URL(url);
    u.searchParams.forEach((value, key) => {
      if (REDACT_QUERY.has(key.toLowerCase())) {
        out[key] = '[redacted]';
        return;
      }
      out[key] = value;
    });
  } catch {
    /* ignore */
  }
  return out;
}

export function parseCustParams(raw?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  try {
    const decoded = decodeURIComponent(raw.replace(/\+/g, ' '));
    for (const part of decoded.split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const k = eq >= 0 ? part.slice(0, eq) : part;
      const v = eq >= 0 ? part.slice(eq + 1) : '';
      if (!k) continue;
      out[k] = out[k] ? `${out[k]},${v}` : v;
    }
  } catch {
    return { raw };
  }
  return out;
}

export function summarizeGamRequest(url: string): {
  host: string;
  path: string;
  query: Record<string, string>;
  iuPaths: string[];
  sizes?: string;
  correlator?: string;
  custParams: Record<string, string>;
  slotParams: Record<string, string>;
  hbKeys: string[];
} {
  let host = '';
  let path = '';
  try {
    const u = new URL(url);
    host = u.hostname;
    path = u.pathname;
  } catch {
    /* ignore */
  }
  const all = parseQueryMap(url);
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (INTERESTING_QUERY.has(k) || k.startsWith('prev_') || k.startsWith('cust')) query[k] = v;
  }
  const iuPaths = collectIuPaths(all);
  const custParams = parseCustParams(all.cust_params);
  const slotParams = { ...parseCustParams(all.prev_scp), ...parseCustParams(all.scp) };
  const hbKeys = [
    ...Object.keys(custParams).filter((k) => k.startsWith('hb_')),
    ...Object.keys(slotParams).filter((k) => k.startsWith('hb_')),
  ];
  return {
    host,
    path,
    query,
    iuPaths,
    sizes: all.sz || all.prev_iu_szs,
    correlator: all.correlator,
    custParams,
    slotParams,
    hbKeys: Array.from(new Set(hbKeys)),
  };
}

function collectIuPaths(query: Record<string, string>): string[] {
  const out: string[] = [];
  const push = (raw?: string) => {
    if (!raw) return;
    for (const part of raw.split(',')) {
      const p = part.trim();
      if (p.startsWith('/')) out.push(p.split('|')[0]);
    }
  };
  push(query.iu);
  push(query.iu_parts);
  if (query.prev_iu_szs) {
    for (const chunk of query.prev_iu_szs.split(',')) {
      const path = chunk.split('|')[0]?.trim();
      if (path?.startsWith('/')) out.push(path);
    }
  }
  return Array.from(new Set(out));
}

export function hbFromMap(map: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!map) return out;
  for (const [k, v] of Object.entries(map)) {
    if (k.startsWith('hb_')) out[k] = v;
  }
  return out;
}

export function requestMatchesSlot(
  iuPaths: string[] | undefined,
  slotAdUnitPath: string | undefined
): boolean {
  if (!iuPaths?.length || !slotAdUnitPath) return false;
  return iuPaths.some((p) => p === slotAdUnitPath || p.includes(slotAdUnitPath) || slotAdUnitPath.includes(p));
}
