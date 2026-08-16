// Runs inside the inspected page via chrome.devtools.inspectedWindow.eval.
// Overlay only — never calls pbjs or googletag mutators.
function pageHighlight(id: string | null): { ok: boolean; reason?: string } {
  const OVERLAY_ID = '__bidshitter-overlay';
  const LABEL_ID = '__bidshitter-overlay-label';
  const w = window as any;

  const remove = () => {
    document.getElementById(OVERLAY_ID)?.remove();
    document.getElementById(LABEL_ID)?.remove();
    if (w.__bidshitterHighlightOff) {
      window.removeEventListener('scroll', w.__bidshitterHighlightOff, true);
      window.removeEventListener('resize', w.__bidshitterHighlightOff);
      w.__bidshitterHighlightOff = null;
    }
    w.__bidshitterHighlightId = null;
  };

  if (!id) {
    remove();
    return { ok: true, reason: 'cleared' };
  }

  const find = (): HTMLElement | null => {
    const byId = document.getElementById(id);
    if (byId) return byId;
    try {
      const q = document.querySelector('#' + CSS.escape(id));
      if (q instanceof HTMLElement) return q;
    } catch {
      /* invalid selector */
    }
    try {
      const gt = w.googletag;
      const slots = gt && gt.pubads && gt.pubads().getSlots ? gt.pubads().getSlots() : [];
      for (const slot of slots) {
        const sid = slot && slot.getSlotElementId && slot.getSlotElementId();
        if (sid === id) {
          const el = document.getElementById(sid);
          if (el) return el;
        }
      }
    } catch {
      /* GPT not ready */
    }
    return null;
  };

  const el = find();
  if (!el) {
    remove();
    return { ok: false, reason: 'not-found' };
  }

  w.__bidshitterHighlightId = id;

  const paint = () => {
    const target = find();
    if (!target) return;
    const r = target.getBoundingClientRect();
    let box = document.getElementById(OVERLAY_ID);
    if (!box) {
      box = document.createElement('div');
      box.id = OVERLAY_ID;
      box.setAttribute('data-bidshitter', 'overlay');
      box.style.cssText =
        'position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #22d3ee;background:rgba(34,211,238,0.14);box-sizing:border-box;border-radius:4px;';
      document.documentElement.appendChild(box);
    }
    const top = Math.max(0, r.top);
    const left = Math.max(0, r.left);
    const width = Math.max(r.width, 8);
    const height = Math.max(r.height, 8);
    box.style.top = `${top}px`;
    box.style.left = `${left}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;

    let label = document.getElementById(LABEL_ID);
    if (!label) {
      label = document.createElement('div');
      label.id = LABEL_ID;
      label.style.cssText =
        'position:fixed;z-index:2147483647;pointer-events:none;background:#0e7490;color:#fff;font:11px/1.2 ui-sans-serif,system-ui,sans-serif;padding:3px 6px;border-radius:3px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      document.documentElement.appendChild(label);
    }
    label.textContent = id;
    label.style.top = `${Math.max(0, top - 22)}px`;
    label.style.left = `${left}px`;
  };

  if (!w.__bidshitterHighlightOff) {
    const onMove = () => paint();
    w.__bidshitterHighlightOff = onMove;
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
  }

  paint();
  try {
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  } catch {
    el.scrollIntoView();
  }
  paint();
  return { ok: true };
}

export function highlightOnPage(id: string | null): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.devtools?.inspectedWindow?.eval) {
      resolve({ ok: false, reason: 'no-devtools' });
      return;
    }
    const expr = `(${pageHighlight.toString()})(${JSON.stringify(id)})`;
    chrome.devtools.inspectedWindow.eval(expr, (result: { ok: boolean; reason?: string }, exceptionInfo) => {
      if (exceptionInfo && (exceptionInfo as { isException?: boolean }).isException) {
        resolve({ ok: false, reason: 'eval-error' });
        return;
      }
      resolve(result || { ok: true });
    });
  });
}
