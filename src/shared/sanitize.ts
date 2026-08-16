import { ARRAY_CAP, DEPTH_CAP, STRING_CAP, STRIP_KEYS } from './constants';

const STRIP = new Set<string>(STRIP_KEYS as readonly string[]);

/**
 * Produce a structured-clone-safe, size-bounded copy of an arbitrary value.
 * - drops functions, DOM nodes, window
 * - strips creative / consent keys (STRIP_KEYS)
 * - caps depth, array length, and string length
 * - breaks cycles
 * See spec.md section 4 (payload sanitize) and 12 (privacy).
 */
export function sanitize(value: unknown): unknown {
  const seen = new WeakSet<object>();

  function walk(val: unknown, depth: number, key?: string): unknown {
    if (key && STRIP.has(key)) {
      return '[stripped]';
    }
    if (val === null) return null;

    const t = typeof val;
    if (t === 'string') {
      const s = val as string;
      return s.length > STRING_CAP ? s.slice(0, STRING_CAP) + `…(+${s.length - STRING_CAP})` : s;
    }
    if (t === 'number' || t === 'boolean' || t === 'undefined') return val;
    if (t === 'bigint') return `${(val as bigint).toString()}n`;
    if (t === 'symbol') return String(val);
    if (t === 'function') return `[function ${(val as { name?: string }).name || 'anonymous'}]`;

    // Objects from here down.
    if (depth >= DEPTH_CAP) return '[max-depth]';

    // DOM nodes / window / events — avoid serializing huge/circular host objects.
    if (isHostObject(val)) return describeHostObject(val);

    if (val instanceof Date) return val.toISOString();
    if (val instanceof RegExp) return val.toString();
    if (val instanceof Error) {
      return { name: val.name, message: String(val.message).slice(0, STRING_CAP) };
    }

    if (Array.isArray(val)) {
      if (seen.has(val)) return '[circular]';
      seen.add(val);
      const out: unknown[] = [];
      const n = Math.min(val.length, ARRAY_CAP);
      for (let i = 0; i < n; i++) out.push(walk(val[i], depth + 1));
      if (val.length > ARRAY_CAP) out.push(`…(+${val.length - ARRAY_CAP} more)`);
      seen.delete(val);
      return out;
    }

    if (t === 'object') {
      const obj = val as Record<string, unknown>;
      if (seen.has(obj)) return '[circular]';
      seen.add(obj);
      const out: Record<string, unknown> = {};
      let count = 0;
      for (const k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        if (count >= ARRAY_CAP) {
          out['…'] = 'more-keys-omitted';
          break;
        }
        try {
          out[k] = walk(obj[k], depth + 1, k);
        } catch {
          out[k] = '[unserializable]';
        }
        count++;
      }
      seen.delete(obj);
      return out;
    }

    return String(val);
  }

  try {
    return walk(value, 0);
  } catch {
    return '[unserializable]';
  }
}

function isHostObject(val: unknown): boolean {
  if (typeof val !== 'object' || val === null) return false;
  const anyVal = val as any;
  if (typeof Node !== 'undefined' && val instanceof Node) return true;
  if (typeof Window !== 'undefined' && val instanceof Window) return true;
  if (typeof Event !== 'undefined' && val instanceof Event) return true;
  // googletag Slot objects expose getSlotElementId — treat as host-ish and summarize.
  if (typeof anyVal.getSlotElementId === 'function' && typeof anyVal.getAdUnitPath === 'function') {
    return true;
  }
  return false;
}

function describeHostObject(val: unknown): unknown {
  const anyVal = val as any;
  try {
    if (typeof anyVal.getSlotElementId === 'function') {
      return {
        __type: 'googletag.Slot',
        slotElementId: safe(() => anyVal.getSlotElementId()),
        adUnitPath: safe(() => anyVal.getAdUnitPath()),
      };
    }
    if (typeof Node !== 'undefined' && val instanceof Node) {
      const el = val as Element;
      return { __type: 'Node', nodeName: el.nodeName, id: (el as any).id };
    }
    if (typeof Window !== 'undefined' && val instanceof Window) return { __type: 'Window' };
    if (typeof Event !== 'undefined' && val instanceof Event) return { __type: `Event(${val.type})` };
  } catch {
    /* ignore */
  }
  return '[host-object]';
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
