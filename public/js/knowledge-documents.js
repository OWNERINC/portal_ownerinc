import { element, showState } from './ui.js';
import { renderEthicsDocument } from './ethics-document.js';

// One queue per view: only nearby images consume authenticated requests or blobs.
export function createDocumentImages({ fetchAsset }) {
  const entries = new Map();
  let active = true, running = 0;
  const release = item => {
    item.controller?.abort();
    item.epoch += 1;
    if (item.blob) URL.revokeObjectURL(item.blob);
    item.blob = null;
    item.image.removeAttribute('src');
    item.onState('idle');
  };
  function pump() {
    if (!active) return;
    for (const item of entries.values()) {
      if (running >= 2) break;
      if (!item.visible || item.pending || item.blob || item.failed) continue;
      item.pending = true;
      item.controller = new AbortController();
      const epoch = ++item.epoch;
      running += 1;
      item.onState('loading');
      Promise.resolve().then(() => fetchAsset(item.url, { signal: item.controller.signal })).then(blob => {
        if (!active || !item.visible || epoch !== item.epoch) { URL.revokeObjectURL(blob); return; }
        item.blob = blob;
        item.image.src = blob;
        item.onState('ready');
      }).catch(() => {
        if (active && item.visible && epoch === item.epoch) {
          item.failed = true;
          item.onState('error');
        }
      }).finally(() => { item.pending = false; running -= 1; pump(); });
    }
  }
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(changes => {
    for (const change of changes) {
      const item = entries.get(change.target);
      if (!item || !active) continue;
      const entered = !item.visible && change.isIntersecting;
      item.visible = change.isIntersecting;
      if (!item.visible) release(item);
      else if (entered) item.failed = false;
    }
    pump();
  }, { rootMargin: '800px 0px' }) : null;
  return {
    observe(image, url, onState = () => {}) {
      if (!active) return () => {};
      const item = { image, url, onState, epoch: 0, visible: !observer, pending: false, failed: false, blob: null };
      entries.set(image, item);
      image.onerror = () => {
        if (!active || !item.blob) return;
        release(item); item.failed = true; onState('error');
      };
      observer?.observe(image);
      pump();
      return () => { if (active) { item.failed = false; pump(); } };
    },
    dispose() {
      if (!active) return;
      active = false;
      observer?.disconnect();
      entries.forEach(item => { item.image.onerror = null; release(item); });
      entries.clear();
    },
  };
}

function magnifier(host) {
  const dialog = element('dialog', { className: 'knowledge-zoom', 'aria-label': 'Página ampliada' });
  const title = element('p', { className: 'knowledge-zoom-title' });
  const image = element('img', { alt: '' });
  const viewport = element('div', { className: 'knowledge-zoom-viewport', tabIndex: 0, 'aria-label': 'Imagem ampliada; use as setas para rolar' }, [image]);
  let opener, overflow, opened = false;
  const fit = element('button', { type: 'button', className: 'btn btn-ghost', text: 'Tamanho real',
    'aria-pressed': 'false', on: { click: () => {
      const real = viewport.classList.toggle('is-real-size');
      fit.textContent = real ? 'Ajustar à tela' : 'Tamanho real';
      fit.setAttribute('aria-pressed', String(real));
    } } });
  const close = element('button', { type: 'button', className: 'btn btn-primary', text: 'Fechar',
    on: { click: () => dialog.close() } });
  dialog.append(element('div', { className: 'knowledge-zoom-toolbar' }, [title, fit, close]), viewport);
  host.append(dialog);
  function restore() {
    if (!opened) return;
    opened = false;
    host.ownerDocument.body.style.overflow = overflow;
    image.removeAttribute('src');
    if (opener?.isConnected) opener.focus();
  }
  dialog.addEventListener('close', restore);
  return {
    open(source, button, label) {
      opener = button;
      overflow = host.ownerDocument.body.style.overflow;
      opened = true;
      title.textContent = label;
      image.alt = label;
      image.src = source.src;
      image.width = source.width; image.height = source.height;
      viewport.classList.remove('is-real-size');
      fit.textContent = 'Tamanho real'; fit.setAttribute('aria-pressed', 'false');
      host.ownerDocument.body.style.overflow = 'hidden';
      dialog.showModal(); close.focus();
    },
    dispose() { if (dialog.open) dialog.close(); restore(); dialog.remove(); },
  };
}

export function mountKnowledgeDocument({ host, article, fetchAPI, fetchAsset }) {
  const controller = new AbortController();
  const images = createDocumentImages({ fetchAsset });
  const zoom = magnifier(host);
  const body = element('div', { className: 'knowledge-document-body' });
  host.append(body);
  let attempt = 0;
  async function load() {
    const token = ++attempt;
    showState(body, 'Carregando documento…');
    try {
      if (article.document.kind === 'ethics') {
        const { term } = await fetchAPI('/api/ethics', { signal: controller.signal });
        if (controller.signal.aborted || token !== attempt) return;
        body.classList.add('knowledge-ethics');
        renderEthicsDocument(body, term);
        return;
      }
      const manifest = await fetchAPI(`/api/knowledge/${article.id}/document`, { signal: controller.signal });
      if (controller.signal.aborted || token !== attempt) return;
      body.replaceChildren();
      const tools = element('div', { className: 'knowledge-document-tools' }, [
        element('p', { text: `${manifest.pageCount} páginas · Amplie para ler os detalhes.` }),
      ]);
      if (/^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+\/view$/.test(manifest.sourceUrl)) {
        tools.append(element('a', { className: 'btn btn-ghost', href: manifest.sourceUrl,
          target: '_blank', rel: 'noopener noreferrer', text: 'PDF original ↗',
          'aria-label': `Abrir PDF original de ${article.title} no Drive (nova aba)` }));
      }
      body.append(tools);
      for (const page of manifest.pages) {
        const label = `Página ${page.number} de ${manifest.pageCount}`;
        const image = element('img', { className: 'knowledge-document-image',
          width: page.width, height: page.height, alt: `${article.title} — ${label}`, decoding: 'async' });
        const status = element('span', { className: 'knowledge-image-status', text: 'Aguardando leitura.' });
        const retry = element('button', { className: 'btn btn-ghost', type: 'button', text: 'Tentar novamente', hidden: true });
        const enlarge = element('button', { className: 'btn btn-ghost', type: 'button', text: 'Ampliar', disabled: true,
          'aria-label': `Ampliar ${label.toLocaleLowerCase('pt-BR')}`,
          on: { click: () => zoom.open(image, enlarge, `${article.title} — ${label}`) } });
        const text = element('details', { className: 'knowledge-page-text' }, [
          element('summary', { text: `Ler texto da página ${page.number}` }),
          element('p', { text: page.text || 'Esta página não disponibiliza texto extraível no PDF original.' }),
        ]);
        body.append(element('figure', { className: 'knowledge-document-page' }, [
          element('figcaption', {}, [element('span', { text: label }), enlarge]),
          image, element('div', { className: 'knowledge-image-feedback' }, [status, retry]), text,
        ]));
        const retryImage = images.observe(image, page.url, state => {
          enlarge.disabled = state !== 'ready';
          retry.hidden = state !== 'error';
          status.hidden = state === 'ready';
          status.textContent = ({ idle: 'Aguardando leitura.', loading: 'Carregando página…', error: 'Não foi possível carregar esta página.' })[state] || '';
        });
        retry.addEventListener('click', retryImage);
      }
    } catch {
      if (!controller.signal.aborted && token === attempt) {
        showState(body, 'Não foi possível abrir o documento. Tente novamente.', load);
      }
    }
  }
  void load();
  return () => { controller.abort(); attempt += 1; zoom.dispose(); images.dispose(); host.remove(); };
}
