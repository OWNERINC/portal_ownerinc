export function readOffset(searchParams, limit = 20) {
  const offset = Number(searchParams.get('offset') || 0);
  return Number.isInteger(offset) && offset >= 0 ? Math.floor(offset / limit) * limit : 0;
}

export function setPaginationBusy(node, busy) {
  if (!node) return;
  node.setAttribute('aria-busy', String(Boolean(busy)));
  node.querySelectorAll('button').forEach(button => {
    button.disabled = Boolean(busy) || button.dataset.paginationBoundaryDisabled === 'true';
  });
}

export function renderPagination(node, total, offset, limit, onPage) {
  if (!node) return;
  node.replaceChildren();
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Math.floor(offset / limit), pageCount - 1);
  if (pageCount === 1) return;
  const previous = document.createElement('button');
  previous.className = 'btn btn-ghost';
  previous.type = 'button';
  previous.textContent = 'Anterior';
  previous.disabled = page === 0;
  previous.dataset.paginationBoundaryDisabled = String(previous.disabled);
  previous.addEventListener('click', () => onPage(Math.max(0, page - 1) * limit));
  const status = document.createElement('span');
  status.textContent = `Página ${page + 1} de ${pageCount}`;
  status.setAttribute('aria-label', `Página ${page + 1} de ${pageCount}`);
  const next = document.createElement('button');
  next.className = 'btn btn-ghost';
  next.type = 'button';
  next.textContent = 'Próxima';
  next.disabled = page >= pageCount - 1;
  next.dataset.paginationBoundaryDisabled = String(next.disabled);
  next.addEventListener('click', () => onPage((page + 1) * limit));
  node.append(previous, status, next);
}
