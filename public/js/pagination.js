export function readOffset(searchParams, limit = 20) {
  const offset = Number(searchParams.get('offset') || 0);
  return Number.isInteger(offset) && offset >= 0 ? Math.floor(offset / limit) * limit : 0;
}

export function renderPagination(node, total, offset, limit, onPage) {
  node.replaceChildren();
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Math.floor(offset / limit), pageCount - 1);
  if (pageCount === 1) return;
  const previous = document.createElement('button');
  previous.className = 'btn btn-ghost';
  previous.type = 'button';
  previous.textContent = 'Anterior';
  previous.disabled = page === 0;
  previous.addEventListener('click', () => onPage(Math.max(0, page - 1) * limit));
  const status = document.createElement('span');
  status.textContent = `Página ${page + 1} de ${pageCount}`;
  status.setAttribute('aria-label', `Página ${page + 1} de ${pageCount}`);
  const next = document.createElement('button');
  next.className = 'btn btn-ghost';
  next.type = 'button';
  next.textContent = 'Próxima';
  next.disabled = page >= pageCount - 1;
  next.addEventListener('click', () => onPage((page + 1) * limit));
  node.append(previous, status, next);
}
