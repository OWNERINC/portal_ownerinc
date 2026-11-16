// Only transient disclosures belong here; panels and native dialogs own their
// own dismissal/unsaved-work contracts. Never attach this to FAQ/audience fields.
export function createEditorMenus({ page }) {
  const entries = new Map();
  let disposed = false;
  const opened = () => [...entries.keys()].filter(node => node.open);
  function close(node, restoreFocus) {
    node.open = false;
    const summary = node.querySelector('summary');
    if (restoreFocus && summary?.isConnected) summary.focus({ preventScroll: true });
  }
  function closeAll({ restoreFocus = false } = {}) {
    const nodes = opened(), last = nodes.at(-1);
    for (const node of nodes) close(node, restoreFocus && node === last);
  }
  const onPointer = event => {
    for (const node of opened()) if (!node.contains(event.target)) close(node, false);
  };
  const onKey = event => {
    if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229 || event.defaultPrevented || document.querySelector('dialog[open]')) return;
    const node = opened().at(-1);
    if (!node) return;
    event.preventDefault(); event.stopImmediatePropagation(); close(node, true);
  };
  window.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('keydown', onKey, true);
  function dispose() {
    if (disposed) return;
    disposed = true; closeAll();
    window.removeEventListener('pointerdown', onPointer, true);
    window.removeEventListener('keydown', onKey, true);
    for (const unregister of [...entries.values()]) unregister();
  }
  page.cleanup(dispose);
  return {
    register(details) {
      if (disposed) return () => {};
      if (entries.has(details)) return entries.get(details);
      const coordinate = () => { if (details.open) for (const node of opened()) if (node !== details) close(node, false); };
      const onClick = event => {
        if (details.querySelector('summary')?.contains(event.target) && !details.open) {
          for (const node of opened()) if (node !== details) close(node, false);
        }
      };
      details.addEventListener('toggle', coordinate);
      details.addEventListener('click', onClick);
      const unregister = () => {
        close(details, false); details.removeEventListener('toggle', coordinate);
        details.removeEventListener('click', onClick); entries.delete(details);
      };
      entries.set(details, unregister); coordinate(); return unregister;
    },
    closeAll,
    dispose,
  };
}
