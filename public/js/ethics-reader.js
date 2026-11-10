// Reaching the end enables an explicit choice; it is not proof of reading.
export function createEthicsReader({ reader, checkbox, button, status, form }) {
  let readToEnd = false;
  let busy = false;
  function update() {
    checkbox.disabled = !readToEnd || busy;
    button.disabled = !readToEnd || !checkbox.checked || busy;
  }
  function measure() {
    if (!readToEnd && reader.clientHeight > 0
      && reader.scrollHeight - reader.clientHeight - Math.max(0, reader.scrollTop) <= 4) {
      readToEnd = true;
      status.textContent = 'Você chegou ao final. Marque a confirmação para continuar.';
      update();
    }
  }
  const onChange = () => update();
  reader.addEventListener('scroll', measure, { passive: true });
  checkbox.addEventListener('change', onChange);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
  observer?.observe(reader);
  if (reader.firstElementChild) observer?.observe(reader.firstElementChild);
  update();
  measure();
  return {
    canAccept: () => readToEnd && checkbox.checked && !busy,
    setBusy(value) { busy = value; form.setAttribute('aria-busy', String(value)); update(); },
    destroy() { reader.removeEventListener('scroll', measure); checkbox.removeEventListener('change', onChange); observer?.disconnect(); },
  };
}
