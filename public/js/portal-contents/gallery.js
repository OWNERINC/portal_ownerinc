import { registerPageDialog } from '../ui.js';
import { assetURL } from './media-session.js';

let dialogSequence = 0;

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function hasUnavailableAncestor(node) {
  for (let current = node; current; current = current.parentElement || current.parentNode) {
    if (current.hidden || current.inert || current.disabled || current.getAttribute?.('aria-hidden') === 'true'
      || current.classList?.contains('hidden')) return true;
  }
  return false;
}

function styleValue(style, property) {
  const camel = property.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
  return style?.getPropertyValue?.(property) || style?.[camel] || '';
}

function saveStyle(element, property) {
  const style = element?.style;
  return { element, property, value: styleValue(style, property), priority: style?.getPropertyPriority?.(property) || '' };
}

function restoreStyle(snapshot) {
  const { element: target, property, value, priority } = snapshot;
  if (!target?.style) return;
  if (value) target.style.setProperty?.(property, value, priority);
  else target.style.removeProperty?.(property);
}

function isEditable(target) {
  return Boolean(target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName));
}

export function createContentsGallery({ page, rootHeading } = {}) {
  const document = globalThis.document;
  const window = globalThis.window;
  const galleries = [];
  let dialog = null;
  let unregister = null;
  let opened = null;
  let ownedInert = [];
  let savedStyles = [];
  let savedScroll = null;
  let backdropPointerDown = null;
  let imageGeneration = 0;
  let recoveryContext = null;
  const assetRecoveries = new Map();
  let disposed = false;

  function currentView(context, lease) {
    return !disposed && !context?.signal?.aborted && (!context?.isCurrent || context.isCurrent())
      && lease?.isPrepared?.();
  }

  function bindRecoveryContext(context) {
    if (recoveryContext && recoveryContext !== context) assetRecoveries.clear();
    recoveryContext = context;
  }

  function recoveryFor(dto, image) {
    const key = `${dto.id.toLowerCase()}:${dto.revision.id.toLowerCase()}:${image.asset_id.toLowerCase()}`;
    if (!assetRecoveries.has(key)) assetRecoveries.set(key, {
      lifecycleState: 'pendingInitialActivation', generation: 0, forcedAttempted: false,
      preparationFailures: 0, reloadCalled: false,
    });
    return assetRecoveries.get(key);
  }

  function markTerminal(recovery) {
    if (recovery.lifecycleState !== 'terminalAssetFailure') {
      recovery.lifecycleState = 'terminalAssetFailure';
      recovery.generation += 1;
    }
  }

  function contextIsLive(context) {
    if (disposed || context?.signal?.aborted) return false;
    try { return !context?.isCurrent || context.isCurrent(); } catch { return false; }
  }

  function appendReloadAction(status, recovery, context, className) {
    if (recovery.reloadCalled || typeof context?.onReload !== 'function' || !contextIsLive(context)) return;
    const reload = element(document, 'button', className, 'Recarregar conteúdo');
    reload.type = 'button'; reload.tabIndex = 0;
    reload.addEventListener('click', () => {
      if (recovery.reloadCalled || !contextIsLive(context) || typeof context.onReload !== 'function') return;
      recovery.reloadCalled = true;
      reload.disabled = true;
      try { void Promise.resolve(context.onReload()).catch(() => {}); }
      catch { /* Reload navigation cannot escape an image failure handler. */ }
    });
    status.append(reload);
  }

  function createDialog() {
    if (dialog) return dialog;
    dialogSequence += 1;
    const id = `contents-lightbox-${dialogSequence}`;
    dialog = element(document, 'dialog', 'portal-contents-lightbox');
    dialog.setAttribute('data-page-overlay', '');
    dialog.setAttribute('aria-labelledby', `${id}-title`);
    dialog.setAttribute('aria-describedby', `${id}-caption ${id}-status`);
    dialog.tabIndex = -1;

    const panel = element(document, 'div', 'contents-lightbox-panel');
    const heading = element(document, 'h2', 'contents-lightbox-title', 'Galeria de imagens');
    heading.id = `${id}-title`;
    const controls = element(document, 'div', 'contents-lightbox-controls');
    const close = element(document, 'button', 'contents-lightbox-close', 'Fechar');
    close.type = 'button'; close.tabIndex = 0; close.setAttribute('aria-label', 'Fechar galeria');
    const previous = element(document, 'button', 'contents-lightbox-previous', 'Anterior');
    previous.type = 'button'; previous.tabIndex = 0; previous.setAttribute('aria-label', 'Imagem anterior');
    const next = element(document, 'button', 'contents-lightbox-next', 'Próxima');
    next.type = 'button'; next.tabIndex = 0; next.setAttribute('aria-label', 'Próxima imagem');
    controls.append(close, previous, next);
    const image = element(document, 'img', 'contents-lightbox-image');
    image.id = `${id}-image`;
    image.decoding = 'async';
    image.loading = 'eager';
    const caption = element(document, 'p', 'contents-lightbox-caption');
    caption.id = `${id}-caption`;
    const status = element(document, 'p', 'contents-lightbox-status', 'Escolha uma imagem.');
    status.id = `${id}-status`;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    panel.append(heading, controls, image, caption, status);
    dialog.append(panel);
    document.body?.append(dialog);

    close.addEventListener('click', () => closeGallery());
    previous.addEventListener('click', () => { void move(-1); });
    next.addEventListener('click', () => { void move(1); });
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      closeGallery();
    });
    dialog.addEventListener('keydown', onDialogKeydown);
    dialog.addEventListener('pointerdown', event => {
      backdropPointerDown = event.target === dialog ? (event.pointerId ?? 0) : null;
    });
    dialog.addEventListener('pointerup', event => {
      const shouldClose = backdropPointerDown !== null && event.target === dialog
        && backdropPointerDown === (event.pointerId ?? 0);
      backdropPointerDown = null;
      if (shouldClose) closeGallery();
    });
    dialog.addEventListener('pointercancel', () => { backdropPointerDown = null; });
    unregister = registerPageDialog({ close: () => closeGallery({ restoreFocus: false }) });
    return dialog;
  }

  function enabledFocusables() {
    if (!dialog) return [];
    const nodes = Array.from(dialog.querySelectorAll('button, a, input, select, textarea, [tabindex]'));
    return nodes.filter(node => {
      if (node.hidden || node.disabled || node.tabIndex < 0 || hasUnavailableAncestor(node)) return false;
      if (node.tagName === 'A' && !node.hasAttribute('href')) return false;
      return ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName) || node.hasAttribute('tabindex');
    });
  }

  function onDialogKeydown(event) {
    if (!dialog?.open) return;
    if (event.key === 'Tab') {
      const focusables = enabledFocusables();
      if (!focusables.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (!dialog.contains(document.activeElement) || isEditable(event.target)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeGallery();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      void move(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      void move(1);
    }
  }

  function snapshotBackground() {
    ownedInert = [];
    for (const sibling of [...(document.body?.children || [])]) {
      if (sibling === dialog || sibling.tagName === 'SCRIPT') continue;
      ownedInert.push({ element: sibling, inert: Boolean(sibling.inert) });
      sibling.inert = true;
    }
    savedStyles = [
      saveStyle(document.documentElement, 'overflow'),
      saveStyle(document.body, 'overflow'),
      saveStyle(document.body, 'padding-inline-end'),
    ];
    savedScroll = { x: window.scrollX || 0, y: window.scrollY || 0 };
    const scrollbar = Math.max(0, (window.innerWidth || 0) - (document.documentElement?.clientWidth || 0));
    const computedPadding = Number.parseFloat(globalThis.getComputedStyle?.(document.body)?.paddingInlineEnd || '0') || 0;
    document.documentElement.style?.setProperty?.('overflow', 'hidden');
    document.body.style?.setProperty?.('overflow', 'hidden');
    document.body.style?.setProperty?.('padding-inline-end', `${computedPadding + scrollbar}px`);
  }

  function restoreBackground() {
    for (const saved of ownedInert) {
      if (saved.element?.isConnected) saved.element.inert = saved.inert;
    }
    ownedInert = [];
    for (const saved of savedStyles) restoreStyle(saved);
    savedStyles = [];
    if (savedScroll) window.scrollTo?.(savedScroll.x, savedScroll.y);
    savedScroll = null;
  }

  function releaseLightboxImage() {
    if (!dialog) return;
    const image = dialog.querySelector('.contents-lightbox-image');
    if (image) {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute('src');
    }
  }

  function galleryFor(dto, images) {
    return galleries.find(candidate => candidate.dto === dto && candidate.images === images);
  }

  function clearOpenError(view) {
    const gallery = galleryFor(view.dto, view.images);
    if (!gallery?.status) return;
    gallery.status.hidden = true;
    gallery.status.replaceChildren();
  }

  function showOpenError(view) {
    const gallery = galleryFor(view.dto, view.images);
    if (!gallery?.status || disposed) return;
    const retry = element(document, 'button', 'contents-gallery-retry', 'Tentar novamente');
    retry.type = 'button';
    retry.tabIndex = 0;
    retry.addEventListener('click', () => {
      clearOpenError(view);
      void open(view);
    });
    gallery.status.hidden = false;
    gallery.status.replaceChildren(
      document.createTextNode('Não foi possível preparar a galeria. Tente novamente. '), retry,
    );
  }

  function describeCurrent() {
    if (!opened || !dialog) return;
    const { images, index } = opened;
    const image = images[index];
    const large = dialog.querySelector('.contents-lightbox-image');
    const caption = dialog.querySelector('.contents-lightbox-caption');
    const status = dialog.querySelector('.contents-lightbox-status');
    const previous = dialog.querySelector('.contents-lightbox-previous');
    const next = dialog.querySelector('.contents-lightbox-next');
    imageGeneration += 1;
    const currentGeneration = imageGeneration;
    releaseLightboxImage();
    large.setAttribute('alt', image.alt);
    caption.textContent = image.caption ?? '';
    status.textContent = `Imagem ${index + 1} de ${images.length} — carregando.`;
    large.onload = () => {
      if (!opened || currentGeneration !== imageGeneration) return;
      const recovery = recoveryFor(opened.dto, opened.images[opened.index]);
      if (recovery.lifecycleState === 'terminalAssetFailure') return;
      recovery.lifecycleState = 'active';
      recovery.preparationFailures = 0;
      recovery.generation += 1;
      status.textContent = `Imagem ${index + 1} de ${images.length}`;
    };
    large.onerror = () => {
      if (!opened || currentGeneration !== imageGeneration) return;
      large.removeAttribute('src');
      const recovery = recoveryFor(opened.dto, opened.images[opened.index]);
      if (recovery.lifecycleState !== 'terminalAssetFailure') {
        recovery.lifecycleState = 'recovering';
        recovery.generation += 1;
      }
      showLightboxFailure(`Imagem ${index + 1} de ${images.length} — Não foi possível carregar esta imagem.`, currentGeneration);
    };
    previous.disabled = false;
    next.disabled = false;
    previous.setAttribute('aria-label', 'Imagem anterior');
    next.setAttribute('aria-label', 'Próxima imagem');
    void loadCurrentImage(false, currentGeneration);
  }

  async function loadCurrentImage(force, expectedGeneration = imageGeneration) {
    if (!opened) return;
    const view = opened;
    const image = view.images[view.index];
    const recovery = recoveryFor(view.dto, image);
    if (recovery.lifecycleState === 'terminalAssetFailure') {
      showLightboxFailure('Esta imagem não pôde ser recuperada.', expectedGeneration);
      return;
    }
    if (!force && recovery.lifecycleState === 'recovering') {
      showLightboxFailure('Não foi possível carregar esta imagem. Tente novamente ou recarregue o conteúdo.', expectedGeneration);
      return;
    }
    if (force) {
      if (recovery.forcedAttempted) return;
      recovery.forcedAttempted = true;
      recovery.lifecycleState = 'recovering';
      recovery.generation += 1;
    }
    const recoveryGeneration = recovery.generation;
    try {
      await view.lease.ensureFresh(force ? { force: true } : {});
      if (opened !== view || expectedGeneration !== imageGeneration || recoveryGeneration !== recovery.generation
        || recovery.lifecycleState === 'terminalAssetFailure' || !currentView(view.context, view.lease)) return;
      dialog.querySelector('.contents-lightbox-image').setAttribute('src', assetURL(view.dto, image.asset_id));
      if (recovery.lifecycleState === 'pendingInitialActivation') recovery.lifecycleState = 'active';
      recovery.preparationFailures = 0;
      dialog.querySelector('.contents-lightbox-status').textContent = `Imagem ${view.index + 1} de ${view.images.length} — carregando.`;
    } catch (error) {
      if (error?.name === 'AbortError' || opened !== view || expectedGeneration !== imageGeneration) return;
      recovery.preparationFailures += 1;
      if (force || recovery.forcedAttempted || recovery.preparationFailures >= 2) markTerminal(recovery);
      showLightboxFailure('Não foi possível preparar esta imagem. Tente novamente ou feche a galeria.', expectedGeneration);
    }
  }

  function showLightboxFailure(message, expectedGeneration) {
    if (!opened || !dialog || expectedGeneration !== imageGeneration) return;
    const view = opened;
    const image = view.images[view.index];
    const recovery = recoveryFor(view.dto, image);
    const status = dialog.querySelector('.contents-lightbox-status');
    status.textContent = message;
    if (recovery.lifecycleState === 'terminalAssetFailure' || recovery.forcedAttempted) {
      markTerminal(recovery);
      appendReloadAction(status, recovery, view.context, 'contents-lightbox-reload');
      return;
    }
    const retry = element(document, 'button', 'contents-lightbox-retry', 'Tentar novamente');
    retry.type = 'button'; retry.tabIndex = 0;
    retry.addEventListener('click', () => {
      if (!opened || expectedGeneration !== imageGeneration || recovery.forcedAttempted) return;
      void loadCurrentImage(true, expectedGeneration);
    });
    status.append(retry);
  }

  async function move(delta) {
    if (!opened) return;
    opened.index = (opened.index + delta + opened.images.length) % opened.images.length;
    describeCurrent();
  }

  function closeGallery({ restoreFocus = true } = {}) {
    if (!opened) return;
    const previous = opened;
    opened = null;
    backdropPointerDown = null;
    imageGeneration += 1;
    releaseLightboxImage();
    if (dialog?.open) {
      try { dialog.close(); } catch { dialog.removeAttribute('open'); }
    }
    restoreBackground();
    if (!restoreFocus) return;
    const opener = previous.opener;
    if (opener?.isConnected && !hasUnavailableAncestor(opener)) {
      opener.focus();
      return;
    }
    const fallback = rootHeading?.();
    if (fallback?.isConnected && !hasUnavailableAncestor(fallback)) fallback.focus();
  }

  async function open(view = {}) {
    const { dto, images, index = 0, opener, lease, context } = view;
    if (disposed || !Array.isArray(images) || !images.length || !lease) return;
    bindRecoveryContext(context);
    const targetIndex = Number.isInteger(index) ? (index % images.length + images.length) % images.length : 0;
    try {
      await lease.ensureFresh();
      if (disposed || context?.signal?.aborted || (context?.isCurrent && !context.isCurrent()) || !lease.isPrepared()) return;
      clearOpenError(view);
      if (opened) closeGallery({ restoreFocus: false });
      const target = createDialog();
      opened = { dto, images, index: targetIndex, opener, lease, context };
      document.dispatchEvent(new Event('portal:close-drawer'));
      snapshotBackground();
      target.showModal();
      describeCurrent();
      target.querySelector('.contents-lightbox-close').focus();
    } catch (error) {
      if (error?.name !== 'AbortError') showOpenError(view);
    }
  }

  function mount({ dto, images, host, lease, context } = {}) {
    if (disposed || !host || !Array.isArray(images)) return;
    bindRecoveryContext(context);
    createDialog();
    const list = element(document, 'ol', 'contents-gallery-list');
    const status = element(document, 'p', 'contents-gallery-status');
    status.hidden = true;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const gallery = { dto, images, lease, context, list, status, items: [] };
    images.forEach((image, index) => {
      const item = element(document, 'li', 'contents-gallery-item');
      const figure = element(document, 'figure', 'contents-gallery-figure');
      const button = element(document, 'button', 'contents-gallery-trigger');
      button.type = 'button'; button.tabIndex = 0;
      button.setAttribute('data-contents-gallery-trigger', '');
      button.setAttribute('aria-label', `Abrir imagem ${index + 1} de ${images.length} — ${image.alt}`);
      const thumbnail = element(document, 'img', 'contents-gallery-thumbnail');
      thumbnail.setAttribute('alt', image.alt);
      thumbnail.decoding = 'async';
      thumbnail.loading = 'lazy';
      button.append(thumbnail);
      if (image.caption !== undefined) figure.append(button, element(document, 'figcaption', 'contents-caption', image.caption));
      else figure.append(button);
      item.append(figure);
      list.append(item);
      const record = { image, button, thumbnail, index, retryButton: null, failureStatus: null,
        loadHandler: null, errorHandler: null };
      gallery.items.push(record);
      button.addEventListener('click', () => {
        void open({ dto, images, index, opener: button, lease, context });
      });
      record.errorHandler = () => {
        if (disposed || !contextIsLive(context)) return;
        thumbnail.removeAttribute('src');
        button.setAttribute('aria-label', `Imagem ${index + 1} de ${images.length}: ${image.alt}. Não foi possível carregar.`);
        const recovery = recoveryFor(dto, image);
        if (recovery.lifecycleState !== 'terminalAssetFailure') {
          recovery.lifecycleState = 'recovering';
          recovery.generation += 1;
        }
        showThumbnailFailure(gallery, record, figure, `Não foi possível carregar a imagem ${index + 1} de ${images.length}.`);
      };
      record.loadHandler = () => {
        if (disposed || !contextIsLive(context)) return;
        const recovery = recoveryFor(dto, image);
        if (recovery.lifecycleState === 'terminalAssetFailure') return;
        recovery.lifecycleState = 'active';
        recovery.preparationFailures = 0;
        recovery.generation += 1;
        record.retryButton?.remove();
        record.failureStatus?.remove();
        record.retryButton = null;
        record.failureStatus = null;
        button.setAttribute('aria-label', `Abrir imagem ${index + 1} de ${images.length} — ${image.alt}`);
      };
      thumbnail.addEventListener('error', record.errorHandler);
      thumbnail.addEventListener('load', record.loadHandler);
    });
    galleries.push(gallery);
    host.replaceChildren(list, status);
    return gallery;
  }

  async function prepareThumbnail(gallery, record, force = false) {
    const recovery = recoveryFor(gallery.dto, record.image);
    if (recovery.lifecycleState === 'terminalAssetFailure') return false;
    if (!force && recovery.lifecycleState !== 'pendingInitialActivation') return false;
    if (force) {
      if (recovery.forcedAttempted) return false;
      recovery.forcedAttempted = true;
      recovery.lifecycleState = 'recovering';
      recovery.generation += 1;
    }
    const recoveryGeneration = recovery.generation;
    try {
      await gallery.lease.ensureFresh(force ? { force: true } : {});
      if (disposed || gallery.context?.signal?.aborted || (gallery.context?.isCurrent && !gallery.context.isCurrent())
        || !gallery.lease.isPrepared() || !record.thumbnail.isConnected
        || recovery.generation !== recoveryGeneration || recovery.lifecycleState === 'terminalAssetFailure') return false;
      const url = assetURL(gallery.dto, record.image.asset_id);
      if (record.thumbnail.getAttribute('src') !== url) record.thumbnail.setAttribute('src', url);
      if (recovery.lifecycleState === 'pendingInitialActivation') recovery.lifecycleState = 'active';
      recovery.preparationFailures = 0;
      return true;
    } catch (error) {
      if (error?.name !== 'AbortError' && !disposed && record.thumbnail.isConnected) {
        recovery.preparationFailures += 1;
        if (force || recovery.forcedAttempted || recovery.preparationFailures >= 2) markTerminal(recovery);
        const figure = record.button.parentElement;
        showThumbnailFailure(gallery, record, figure, 'Não foi possível preparar esta imagem.');
      }
      return false;
    }
  }

  function showThumbnailFailure(gallery, record, figure, message) {
    if (!figure || disposed) return;
    record.failureStatus?.remove();
    record.retryButton?.remove();
    const status = element(document, 'p', 'contents-gallery-image-status', message);
    status.setAttribute('role', 'status');
    record.failureStatus = status;
    const recovery = recoveryFor(gallery.dto, record.image);
    if (recovery.lifecycleState === 'terminalAssetFailure' || recovery.forcedAttempted) {
      markTerminal(recovery);
      appendReloadAction(status, recovery, gallery.context, 'contents-gallery-reload');
      figure.append(status);
      return;
    }
    const retry = element(document, 'button', 'contents-media-retry', 'Tentar novamente');
    retry.type = 'button'; retry.tabIndex = 0;
    retry.addEventListener('click', event => {
      event.stopPropagation?.();
      if (recovery.forcedAttempted) {
        showThumbnailFailure(gallery, record, figure, message);
        return;
      }
      void prepareThumbnail(gallery, record, true);
    });
    record.retryButton = retry;
    figure.append(status, retry);
  }

  function prepare(descriptor, lease, context) {
    bindRecoveryContext(context);
    const gallery = galleries.find(candidate => candidate.dto === descriptor.dto && candidate.list.parentNode
      && candidate.images === descriptor.images);
    if (!gallery) return;
    gallery.lease = lease;
    gallery.context = context;
    for (const record of gallery.items) void prepareThumbnail(gallery, record);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    closeGallery({ restoreFocus: false });
    unregister?.();
    unregister = null;
    for (const gallery of galleries) {
      for (const record of gallery.items) {
        record.thumbnail.removeEventListener('load', record.loadHandler);
        record.thumbnail.removeEventListener('error', record.errorHandler);
        record.thumbnail.onload = null;
        record.thumbnail.onerror = null;
        record.thumbnail.removeAttribute('src');
        record.button.replaceChildren();
      }
      gallery.list.remove();
      gallery.status.remove();
    }
    galleries.length = 0;
    assetRecoveries.clear();
    dialog?.remove();
    dialog = null;
  }

  return { open, close: closeGallery, dispose, mount, prepare };
}
