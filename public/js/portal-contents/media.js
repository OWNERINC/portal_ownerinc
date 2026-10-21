import { acquireContentsMediaLease, assetURL } from './media-session.js';

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isCanonicalEmbed(descriptor) {
  if (descriptor.provider === 'youtube') return /^https:\/\/www\.youtube\.com\/embed\/[A-Za-z0-9_-]{11}$/u.test(descriptor.url);
  if (descriptor.provider === 'vimeo') return /^https:\/\/player\.vimeo\.com\/video\/[1-9][0-9]*$/u.test(descriptor.url);
  return false;
}

function visibleStatus(document, resource, message, { retry = false, action = null, reload = false } = {}) {
  const host = resource.host;
  const parent = host?.parentElement || host?.parentNode;
  const target = parent || host;
  if (!target) return;
  let status = resource.statusNode;
  if (!status || !status.isConnected) {
    status = element(document, 'p', 'contents-media-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    target.append(status);
    resource.statusNode = status;
  }
  status.replaceChildren(document.createTextNode(message));
  if (!retry && !reload) return;
  const button = element(document, 'button', reload ? 'contents-media-reload' : 'contents-media-retry',
    reload ? 'Recarregar conteúdo' : 'Tentar novamente');
  button.type = 'button'; button.tabIndex = 0;
  const click = () => {
    if (reload) resource.context.onReload?.();
    else action?.();
  };
  button.addEventListener('click', click);
  resource.cleanup.push(() => button.removeEventListener('click', click));
  status.append(button);
}

function removeStatus(resource) {
  resource.statusNode?.remove();
  resource.statusNode = null;
}

function appendNativeSource(element, url) {
  element.setAttribute('src', url);
}

function contextIsCurrent(context, lease, disposed) {
  if (disposed.value || context?.signal?.aborted || !lease?.isPrepared?.()) return false;
  try { return !context?.isCurrent || context.isCurrent(); } catch { return false; }
}

function clampTime(value, duration) {
  const saved = Number.isFinite(value) && value >= 0 ? value : 0;
  return Number.isFinite(duration) && duration >= 0 ? Math.min(saved, duration) : saved;
}

export function activateContentsMedia(descriptors, { context = {}, gallery = null } = {}) {
  const document = globalThis.document;
  const items = Array.isArray(descriptors) ? descriptors : [];
  const native = items.filter(item => ['image', 'gallery', 'video', 'pdf'].includes(item?.kind));
  const disposed = { value: false };
  const listeners = [];
  const resources = [];
  const galleryDescriptors = [];
  let lease = null;

  const listen = (node, type, callback) => {
    node.addEventListener(type, callback);
    listeners.push(() => node.removeEventListener(type, callback));
  };
  const resourceFor = descriptor => ({ descriptor, host: descriptor.host, context, lease, cleanup: [], statusNode: null,
    element: null, generation: 0, retryUsed: false, source: '', playingIntent: false, pendingRestore: null });

  function live(resource) { return contextIsCurrent(context, lease, disposed); }

  function setImageSource(resource) {
    if (!live(resource) || !resource.element || !lease.isPrepared()) return;
    const url = assetURL(resource.descriptor.dto, resource.descriptor.assetId);
    resource.source = url;
    appendNativeSource(resource.element, url);
    removeStatus(resource);
  }

  function showPersistentFailure(resource) {
    visibleStatus(document, resource, 'Não foi possível carregar esta mídia nesta versão.', {
      reload: true,
    });
  }

  function recoverImage(resource) {
    if (disposed.value || !resource.element) return;
    if (resource.retryUsed) { showPersistentFailure(resource); return; }
    resource.retryUsed = true;
    const failureGeneration = resource.generation;
    void lease.ensureFresh({ force: true }).then(() => {
      if (!live(resource) || failureGeneration !== resource.generation) return;
      resource.element.removeAttribute('src');
      setImageSource(resource);
    }).catch(error => {
      if (error?.name !== 'AbortError' && live(resource)) {
        visibleStatus(document, resource, 'Não foi possível preparar a imagem.', { retry: true, action: () => recoverImage(resource) });
      }
    });
  }

  function buildImage(descriptor) {
    const resource = resourceFor(descriptor);
    const image = element(document, 'img', 'contents-native-image');
    image.setAttribute('alt', descriptor.alt || 'Imagem de conteúdo');
    image.decoding = 'async';
    image.loading = descriptor.eager ? 'eager' : 'lazy';
    resource.element = image;
    descriptor.host.replaceChildren(image);
    listen(image, 'error', () => {
      if (disposed.value) return;
      resource.generation += 1;
      image.removeAttribute('src');
      visibleStatus(document, resource, 'Não foi possível carregar esta imagem.', {
        retry: true,
        action: () => recoverImage(resource),
      });
    });
    listen(image, 'load', () => {
      resource.retryUsed = false;
      resource.generation += 1;
      removeStatus(resource);
    });
    resources.push(resource);
  }

  function setVideoSource(resource, { preserveTime = false } = {}) {
    if (!live(resource) || !resource.element || !lease.isPrepared()) return;
    const video = resource.element;
    const url = assetURL(resource.descriptor.dto, resource.descriptor.assetId);
    resource.source = url;
    if (preserveTime) video.removeAttribute('src');
    appendNativeSource(video, url);
    if (preserveTime) video.load();
    removeStatus(resource);
  }

  async function resumeVideo(resource, generation) {
    if (!live(resource) || generation !== resource.generation) return;
    const video = resource.element;
    try {
      await Promise.resolve(video.play());
      if (!live(resource) || generation !== resource.generation) { video.pause(); return; }
      lease.setPlaying(true);
    } catch {
      lease.setPlaying(false);
      visibleStatus(document, resource, 'A reprodução não pôde ser iniciada. Use os controles para tentar novamente.', {
        retry: true,
        action: () => { void resumeVideo(resource, resource.generation); },
      });
    }
  }

  function renewForVideoAction(resource, intendedPlaying, desiredTime = null) {
    const video = resource.element;
    const token = ++resource.generation;
    resource.playingIntent = intendedPlaying;
    video.pause();
    lease.setPlaying(false);
    void lease.ensureFresh().then(() => {
      if (!live(resource) || token !== resource.generation) return;
      removeStatus(resource);
      if (desiredTime !== null) video.currentTime = clampTime(desiredTime, video.duration);
      if (resource.playingIntent) void resumeVideo(resource, token);
    }).catch(error => {
      if (error?.name !== 'AbortError' && live(resource)) {
        visibleStatus(document, resource, 'A sessão de mídia expirou. Tente novamente para continuar.', {
          retry: true,
          action: () => renewForVideoAction(resource, resource.playingIntent, desiredTime),
        });
      }
    });
  }

  function recoverVideo(resource) {
    const video = resource.element;
    const savedTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const resume = !video.paused || resource.playingIntent;
    if (resource.retryUsed) {
      video.pause(); lease.setPlaying(false); showPersistentFailure(resource); return;
    }
    resource.retryUsed = true;
    const token = ++resource.generation;
    resource.pendingRestore = { time: savedTime, resume, generation: token };
    resource.playingIntent = resume;
    video.pause(); lease.setPlaying(false);
    video.removeAttribute('src');
    video.load();
    void lease.ensureFresh({ force: true }).then(() => {
      if (!live(resource) || token !== resource.generation) return;
      setVideoSource(resource, { preserveTime: true });
      // Native loadedmetadata performs the clamped restore. No autoplay is introduced.
    }).catch(error => {
      if (error?.name !== 'AbortError' && live(resource)) {
        visibleStatus(document, resource, 'Não foi possível recuperar este vídeo.', { retry: true, action: () => recoverVideo(resource) });
      }
    });
  }

  function buildVideo(descriptor) {
    const resource = resourceFor(descriptor);
    const video = element(document, 'video', 'contents-native-video');
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.setAttribute('controls', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('preload', 'metadata');
    video.setAttribute('aria-label', `Vídeo: ${descriptor.title}`);
    resource.element = video;
    descriptor.host.replaceChildren(video);
    listen(video, 'play', () => {
      if (disposed.value) return;
      resource.playingIntent = true;
      if (!lease.isPrepared() || lease.needsRenewal?.()) {
        renewForVideoAction(resource, true);
        return;
      }
      lease.setPlaying(true);
    });
    listen(video, 'pause', () => { if (video.paused) lease.setPlaying(false); });
    listen(video, 'ended', () => { resource.playingIntent = false; lease.setPlaying(false); });
    listen(video, 'seeking', () => {
      if (disposed.value || resource.pendingRestore || resource.restoring) return;
      if (!lease.isPrepared() || lease.needsRenewal?.()) {
        const target = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        renewForVideoAction(resource, !video.paused, target);
      }
    });
    listen(video, 'error', () => { if (!disposed.value && video.hasAttribute('src')) recoverVideo(resource); });
    listen(video, 'loadedmetadata', () => {
      const restore = resource.pendingRestore;
      if (!restore || restore.generation !== resource.generation || !live(resource)) return;
      resource.pendingRestore = null;
      resource.retryUsed = false;
      resource.restoring = true;
      video.currentTime = clampTime(restore.time, video.duration);
      resource.restoring = false;
      if (restore.resume) void resumeVideo(resource, restore.generation);
      else removeStatus(resource);
    });
    resources.push(resource);
  }

  function exposePDF(resource) {
    if (!live(resource) || !lease.isPrepared()) return;
    const url = assetURL(resource.descriptor.dto, resource.descriptor.assetId);
    resource.source = url;
    for (const anchor of resource.anchors) {
      anchor.setAttribute('href', url);
      anchor.setAttribute('aria-disabled', 'false');
    }
    resource.status.textContent = 'PDF pronto. As ações usam a mídia nativa do Portal.';
    removeStatus(resource);
  }

  function preparePDFAction(resource, anchor, event) {
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0;
    const current = lease.isPrepared();
    if (current) return;
    event.preventDefault();
    for (const action of resource.anchors) {
      action.removeAttribute('href');
      action.setAttribute('aria-disabled', 'true');
    }
    if (modified) {
      resource.status.textContent = 'Volte ao Portal para renovar o PDF antes de abri-lo em outra aba.';
      return;
    }
    void lease.ensureFresh().then(() => {
      if (!live(resource)) return;
      exposePDF(resource);
      resource.status.textContent = 'PDF pronto. Clique novamente para abrir.';
    }).catch(error => {
      if (error?.name !== 'AbortError' && live(resource)) {
        visibleStatus(document, resource, 'Não foi possível preparar este PDF.', {
          retry: true,
          action: () => preparePDF(resource, true),
        });
      }
    });
  }

  function preparePDF(resource, force = false) {
    void lease.ensureFresh(force ? { force: true } : {}).then(() => {
      if (live(resource)) exposePDF(resource);
    }).catch(error => {
      if (error?.name !== 'AbortError' && live(resource)) {
        visibleStatus(document, resource, 'Não foi possível preparar este PDF.', { retry: true, action: () => preparePDF(resource, true) });
      }
    });
  }

  function buildPDF(descriptor) {
    const resource = resourceFor(descriptor);
    const actions = element(document, 'div', 'contents-pdf-actions');
    const open = element(document, 'a', 'contents-pdf-open', `Abrir PDF — ${descriptor.title}`);
    open.setAttribute('target', '_blank');
    open.setAttribute('rel', 'noopener noreferrer');
    open.setAttribute('aria-disabled', 'true');
    const cue = element(document, 'span', 'contents-new-tab-cue', 'Abre em nova aba');
    open.append(cue);
    const download = element(document, 'a', 'contents-pdf-download', `Baixar PDF — ${descriptor.title}`);
    download.setAttribute('download', `${descriptor.title}.pdf`);
    download.setAttribute('aria-disabled', 'true');
    const status = element(document, 'p', 'contents-pdf-status', 'Preparando o PDF…');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const instructions = element(document, 'p', 'contents-pdf-instructions',
      'O navegador pode abrir o PDF em vez de baixá-lo; as ações seguem disponíveis sem um visualizador instalado. A visualização em outra aba pode expirar após cinco minutos sem renovação no Portal. Volte aqui e abra o PDF novamente.');
    actions.append(open, download);
    descriptor.host.replaceChildren(actions, status, instructions);
    resource.status = status;
    resource.instructions = instructions;
    resource.anchors = [open, download];
    resource.element = actions;
    for (const anchor of resource.anchors) {
      listen(anchor, 'focus', () => preparePDF(resource));
      listen(anchor, 'pointerenter', () => preparePDF(resource));
      listen(anchor, 'click', event => preparePDFAction(resource, anchor, event));
    }
    resources.push(resource);
  }

  function buildEmbed(descriptor) {
    if (!isCanonicalEmbed(descriptor)) return;
    const iframe = element(document, 'iframe', 'contents-embed-frame');
    iframe.setAttribute('loading', 'lazy');
    iframe.loading = 'lazy';
    iframe.setAttribute('title', descriptor.title);
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
    iframe.setAttribute('allow', 'fullscreen; picture-in-picture; encrypted-media');
    iframe.allowFullscreen = true;
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    iframe.setAttribute('src', descriptor.url);
    const frame = element(document, 'div', 'contents-embed');
    frame.append(iframe);
    const link = element(document, 'a', 'contents-embed-fallback', `Abrir no ${descriptor.provider === 'youtube' ? 'YouTube' : 'Vimeo'}: ${descriptor.title}`);
    link.setAttribute('href', descriptor.url);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
    descriptor.host.replaceChildren(frame, link);
  }

  if (native.length) {
    lease = acquireContentsMediaLease({ signal: context.signal, isCurrent: context.isCurrent,
      onStatus: status => {
        for (const resource of resources) {
          if (status === 'renewing' || status === 'ready') continue;
          if (status === 'expired') {
            if (resource.descriptor.kind === 'video') {
              resource.element.pause();
              lease.setPlaying(false);
            }
            if (resource.descriptor.kind === 'pdf') {
              for (const anchor of resource.anchors) {
                anchor.removeAttribute('href');
                anchor.setAttribute('aria-disabled', 'true');
              }
            }
            visibleStatus(document, resource, 'A sessão de mídia expirou. Tente novamente para continuar.', {
              retry: true,
              action: () => resource.descriptor.kind === 'video'
                ? renewForVideoAction(resource, resource.playingIntent)
                : resource.descriptor.kind === 'pdf' ? preparePDF(resource, true) : recoverImage(resource),
            });
          } else {
            visibleStatus(document, resource,
              status === 'denied' ? 'Sua sessão precisa ser validada novamente para abrir esta mídia.' : 'Não foi possível preparar esta mídia.', {
                retry: true,
                action: () => lease.ensureFresh({ force: true }).then(() => {
                  if (!live(resource)) return;
                  if (resource.descriptor.kind === 'image') setImageSource(resource);
                  else if (resource.descriptor.kind === 'video') setVideoSource(resource);
                  else if (resource.descriptor.kind === 'pdf') exposePDF(resource);
                }).catch(() => {}),
              });
          }
        }
      },
    });
  }

  for (const descriptor of items) {
    if (!descriptor?.host) continue;
    if (descriptor.kind === 'image') buildImage(descriptor);
    else if (descriptor.kind === 'video') buildVideo(descriptor);
    else if (descriptor.kind === 'pdf') buildPDF(descriptor);
    else if (descriptor.kind === 'gallery' && gallery) {
      gallery.mount({ dto: descriptor.dto, images: descriptor.images, host: descriptor.host, lease, context });
      galleryDescriptors.push(descriptor);
    } else if (descriptor.kind === 'embed') buildEmbed(descriptor);
  }

  if (lease) {
    void lease.ensureFresh().then(() => {
      if (disposed.value || !contextIsCurrent(context, lease, disposed)) return;
      for (const resource of resources) {
        if (resource.descriptor.kind === 'image') setImageSource(resource);
        else if (resource.descriptor.kind === 'video') setVideoSource(resource);
        else if (resource.descriptor.kind === 'pdf') exposePDF(resource);
      }
      for (const descriptor of galleryDescriptors) gallery.prepare(descriptor, lease, context);
    }).catch(error => {
      if (error?.name === 'AbortError' || disposed.value || context.signal?.aborted) return;
      for (const resource of resources) {
        visibleStatus(document, resource, error?.status === 401 || error?.status === 403
          ? 'Sua sessão precisa ser validada novamente para abrir esta mídia.' : 'Não foi possível preparar esta mídia.', {
          retry: true,
          action: () => lease.ensureFresh({ force: true }).then(() => {
            if (!contextIsCurrent(context, lease, disposed)) return;
            if (resource.descriptor.kind === 'image') setImageSource(resource);
            else if (resource.descriptor.kind === 'video') setVideoSource(resource);
            else if (resource.descriptor.kind === 'pdf') exposePDF(resource);
          }).catch(() => {}),
        });
      }
    });
  }

  const dispose = () => {
    if (disposed.value) return;
    disposed.value = true;
    for (const remove of listeners.splice(0)) remove();
    for (const resource of resources) {
      for (const remove of resource.cleanup.splice(0)) remove();
      if (resource.descriptor.kind === 'video' && resource.element) {
        resource.element.pause();
        lease?.setPlaying(false);
        resource.element.removeAttribute('src');
        resource.element.replaceChildren();
        resource.element.load();
      } else if (resource.descriptor.kind === 'image' && resource.element) {
        resource.element.removeAttribute('src');
        resource.element.replaceChildren();
      } else if (resource.descriptor.kind === 'pdf') {
        for (const anchor of resource.anchors || []) anchor.removeAttribute('href');
      }
      removeStatus(resource);
    }
    gallery?.close?.({ restoreFocus: false });
    lease?.release();
  };
  context.signal?.addEventListener?.('abort', dispose, { once: true });
  return { dispose, lease };
}
