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
    if (reload) {
      if (resource.reloadCalled || !canReloadContext(resource.context)) return;
      resource.reloadCalled = true;
      button.disabled = true;
      try { void Promise.resolve(resource.context.onReload()).catch(() => {}); }
      catch { /* Reload navigation cannot escape a disposed media event handler. */ }
    }
    else action?.();
  };
  button.addEventListener('click', click);
  resource.cleanup.push(() => button.removeEventListener('click', click));
  status.append(button);
}

function canReloadContext(context) {
  if (typeof context?.onReload !== 'function' || context.signal?.aborted) return false;
  try { return !context.isCurrent || context.isCurrent(); } catch { return false; }
}

function removeStatus(resource) {
  resource.statusNode?.remove();
  resource.statusNode = null;
}

function appendNativeSource(element, url) {
  element.setAttribute('src', url);
}

function viewContextIsCurrent(context, disposed) {
  if (disposed.value || context?.signal?.aborted) return false;
  try { return !context?.isCurrent || context.isCurrent(); } catch { return false; }
}

function contextIsCurrent(context, lease, disposed) {
  return viewContextIsCurrent(context, disposed) && Boolean(lease?.isPrepared?.());
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
  const embeds = [];
  const galleryDescriptors = [];
  let lease = null;

  const listen = (node, type, callback) => {
    node.addEventListener(type, callback);
    listeners.push(() => node.removeEventListener(type, callback));
  };
  const resourceFor = descriptor => ({ descriptor, host: descriptor.host, context, lease, cleanup: [], statusNode: null,
    element: null, generation: 0, retryUsed: false, reloadCalled: false, source: '', playingIntent: false,
    pauseCause: null, pendingRestore: null, lifecycleState: 'pendingInitialActivation', pdfPreparationFailures: 0,
    pdfFailureIssues: new WeakSet() });

  function live(resource) { return contextIsCurrent(context, lease, disposed); }

  function setImageSource(resource) {
    if (!live(resource) || !resource.element || !lease.isPrepared()) return;
    const url = assetURL(resource.descriptor.dto, resource.descriptor.assetId);
    if (resource.element.getAttribute('src') === url) { removeStatus(resource); return; }
    resource.source = url;
    appendNativeSource(resource.element, url);
    removeStatus(resource);
  }

  function showPersistentFailure(resource) {
    if (resource.lifecycleState !== 'terminalAssetFailure') {
      resource.lifecycleState = 'terminalAssetFailure';
      resource.generation += 1;
      resource.pendingRestore = null;
    }
    visibleStatus(document, resource, 'Não foi possível carregar esta mídia nesta versão.', {
      reload: true,
    });
  }

  function recoverImage(resource) {
    if (disposed.value || !resource.element || resource.lifecycleState === 'terminalAssetFailure') return;
    if (resource.retryUsed) { showPersistentFailure(resource); return; }
    resource.retryUsed = true;
    resource.lifecycleState = 'recovering';
    const failureGeneration = ++resource.generation;
    void lease.ensureFresh({ force: true }).then(() => {
      if (!live(resource) || failureGeneration !== resource.generation || resource.lifecycleState !== 'recovering') return;
      if (!resource.element.hasAttribute('src')) setImageSource(resource);
    }).catch(error => {
      if (error?.name !== 'AbortError' && viewContextIsCurrent(context, disposed) && failureGeneration === resource.generation
        && resource.lifecycleState !== 'terminalAssetFailure') {
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
      if (resource.lifecycleState === 'terminalAssetFailure') return;
      if (resource.retryUsed) {
        showPersistentFailure(resource);
        return;
      }
      resource.lifecycleState = 'recovering';
      visibleStatus(document, resource, 'Não foi possível carregar esta imagem.', {
        retry: true,
        action: () => recoverImage(resource),
      });
    });
    listen(image, 'load', () => {
      if (resource.lifecycleState === 'terminalAssetFailure') return;
      resource.lifecycleState = 'active';
      resource.retryUsed = false;
      resource.generation += 1;
      removeStatus(resource);
    });
    resources.push(resource);
  }

  function setVideoSource(resource, { preserveTime = false } = {}) {
    if (!live(resource) || !resource.element || !lease.isPrepared()
      || resource.lifecycleState === 'terminalAssetFailure') return;
    const video = resource.element;
    const url = assetURL(resource.descriptor.dto, resource.descriptor.assetId);
    if (!preserveTime && video.getAttribute('src') === url) { removeStatus(resource); return; }
    resource.source = url;
    if (preserveTime) {
      video.removeAttribute('src');
      if (resource.pendingRestore?.generation === resource.generation) resource.pendingRestore.sourceReady = true;
    }
    appendNativeSource(video, url);
    if (preserveTime) video.load();
    removeStatus(resource);
  }

  async function resumeVideo(resource, generation) {
    if (!live(resource) || generation !== resource.generation
      || resource.lifecycleState === 'terminalAssetFailure') return;
    const video = resource.element;
    try {
      await Promise.resolve(video.play());
      if (!live(resource)) { pauseVideo(resource, 'stale'); return; }
      // A newer user action owns the element now. Do not let an older play()
      // completion pause or otherwise overwrite that newer intent.
      if (generation !== resource.generation) return;
      lease.setPlaying(true, resource);
    } catch {
      if (!live(resource) || generation !== resource.generation) return;
      lease.setPlaying(false, resource);
      visibleStatus(document, resource, 'A reprodução não pôde ser iniciada. Use os controles para tentar novamente.', {
        retry: true,
        action: () => { void resumeVideo(resource, resource.generation); },
      });
    }
  }

  function renewForVideoAction(resource, intendedPlaying, desiredTime = null) {
    if (resource.lifecycleState === 'terminalAssetFailure') return;
    const video = resource.element;
    const token = ++resource.generation;
    if (resource.lifecycleState !== 'pendingInitialActivation') resource.lifecycleState = 'recovering';
    resource.playingIntent = intendedPlaying;
    resource.pendingRestore = null;
    pauseVideo(resource, 'recovery');
    lease.setPlaying(false, resource);
    void lease.ensureFresh().then(() => {
      if (!live(resource) || token !== resource.generation) return;
      removeStatus(resource);
      if (resource.lifecycleState === 'pendingInitialActivation') activatePreparedResource(resource);
      if (desiredTime !== null) video.currentTime = clampTime(desiredTime, video.duration);
      resource.lifecycleState = 'active';
      if (resource.playingIntent) void resumeVideo(resource, token);
    }).catch(error => {
      if (error?.name !== 'AbortError' && viewContextIsCurrent(context, disposed) && token === resource.generation) {
        visibleStatus(document, resource, 'A sessão de mídia expirou. Tente novamente para continuar.', {
          retry: true,
          action: () => renewForVideoAction(resource, resource.playingIntent, desiredTime),
        });
      }
    });
  }

  function recoverVideo(resource) {
    const video = resource.element;
    if (resource.lifecycleState === 'terminalAssetFailure') return;
    const savedTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const resume = !video.paused || resource.playingIntent;
    if (resource.retryUsed) {
      resource.generation += 1;
      resource.playingIntent = false;
      resource.pendingRestore = null;
      pauseVideo(resource, 'failure');
      video.removeAttribute('src');
      video.load();
      lease.setPlaying(false, resource); showPersistentFailure(resource); return;
    }
    resource.retryUsed = true;
    const token = ++resource.generation;
    resource.lifecycleState = 'recovering';
    resource.pendingRestore = { time: savedTime, resume, generation: token, sourceReady: false };
    resource.playingIntent = resume;
    pauseVideo(resource, 'recovery'); lease.setPlaying(false, resource);
    video.removeAttribute('src');
    video.load();
    void lease.ensureFresh({ force: true }).then(() => {
      if (!live(resource) || token !== resource.generation) return;
      if (!video.hasAttribute('src')) setVideoSource(resource, { preserveTime: true });
      // Native loadedmetadata performs the clamped restore. No autoplay is introduced.
    }).catch(error => {
      if (error?.name !== 'AbortError' && viewContextIsCurrent(context, disposed) && token === resource.generation) {
        visibleStatus(document, resource, 'Não foi possível recuperar este vídeo.', { retry: true, action: () => recoverVideo(resource) });
      }
    });
  }

  function pauseVideo(resource, cause) {
    resource.pauseCause = cause;
    resource.element?.pause?.();
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
      if (resource.lifecycleState === 'terminalAssetFailure') {
        pauseVideo(resource, 'failure');
        return;
      }
      resource.pauseCause = null;
      resource.playingIntent = true;
      if (!lease.isPrepared() || lease.needsRenewal?.()) {
        renewForVideoAction(resource, true);
        return;
      }
      lease.setPlaying(true, resource);
    });
    listen(video, 'pause', () => {
      if (!video.paused) return;
      const cause = resource.pauseCause;
      resource.pauseCause = null;
      if (cause === 'recovery' || cause === 'stale') {
        lease.setPlaying(false, resource);
        return;
      }
      resource.generation += 1;
      resource.pendingRestore = null;
      resource.playingIntent = false;
      lease.setPlaying(false, resource);
    });
    listen(video, 'ended', () => {
      resource.generation += 1;
      resource.pendingRestore = null;
      resource.playingIntent = false;
      resource.pauseCause = null;
      lease.setPlaying(false, resource);
    });
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
      if (!restore || !restore.sourceReady || restore.generation !== resource.generation || !live(resource)) return;
      if (resource.lifecycleState === 'terminalAssetFailure') return;
      resource.pendingRestore = null;
      resource.retryUsed = false;
      resource.lifecycleState = 'active';
      resource.restoring = true;
      video.currentTime = clampTime(restore.time, video.duration);
      resource.restoring = false;
      if (restore.resume) void resumeVideo(resource, restore.generation);
      else removeStatus(resource);
    });
    resources.push(resource);
  }

  function exposePDF(resource) {
    if (!live(resource) || !lease.isPrepared() || resource.lifecycleState === 'terminalAssetFailure') return;
    const url = assetURL(resource.descriptor.dto, resource.descriptor.assetId);
    if (resource.anchors.every(anchor => anchor.getAttribute('href') === url)) {
      resource.lifecycleState = 'active';
      resource.pdfPreparationFailures = 0;
      removeStatus(resource);
      return;
    }
    resource.source = url;
    for (const anchor of resource.anchors) {
      anchor.setAttribute('href', url);
      anchor.setAttribute('aria-disabled', 'false');
    }
    resource.lifecycleState = 'active';
    resource.pdfPreparationFailures = 0;
    resource.status.textContent = 'PDF pronto. As ações usam a mídia nativa do Portal.';
    removeStatus(resource);
  }

  function failPDFPreparation(resource, issue, message = 'Não foi possível preparar este PDF.') {
    if (resource.lifecycleState === 'terminalAssetFailure') return;
    if (issue && resource.pdfFailureIssues.has(issue)) return;
    if (issue) resource.pdfFailureIssues.add(issue);
    resource.pdfPreparationFailures += 1;
    if (resource.pdfPreparationFailures >= 2) {
      for (const action of resource.anchors) {
        action.removeAttribute('href');
        action.setAttribute('aria-disabled', 'true');
      }
      showPersistentFailure(resource);
      return;
    }
    if (resource.lifecycleState !== 'pendingInitialActivation') resource.lifecycleState = 'recovering';
    visibleStatus(document, resource, message, {
      retry: true,
      action: () => preparePDF(resource, true),
    });
  }

  function preparePDFAction(resource, anchor, event) {
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0;
    if (resource.lifecycleState === 'terminalAssetFailure') { event.preventDefault(); return; }
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
    const token = ++resource.generation;
    if (resource.lifecycleState === 'active') resource.lifecycleState = 'recovering';
    const preparation = lease.ensureFresh();
    void preparation.then(() => {
      if (!live(resource) || token !== resource.generation || resource.lifecycleState === 'terminalAssetFailure') return;
      exposePDF(resource);
      resource.status.textContent = 'PDF pronto. Clique novamente para abrir.';
    }).catch(() => {});
  }

  function preparePDF(resource, force = false) {
    if (resource.lifecycleState === 'terminalAssetFailure') return;
    const token = ++resource.generation;
    if (resource.lifecycleState === 'active') resource.lifecycleState = 'recovering';
    const preparation = lease.ensureFresh(force ? { force: true } : {});
    void preparation.then(() => {
      if (!live(resource) || token !== resource.generation || resource.lifecycleState === 'terminalAssetFailure') return;
      exposePDF(resource);
    }).catch(() => {});
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
    embeds.push({ iframe, frame, link });
  }

  function activatePreparedResource(resource) {
    if (!live(resource)) return;
    if (resource.lifecycleState === 'terminalAssetFailure') return;
    if (resource.lifecycleState === 'active') return;
    if (resource.lifecycleState !== 'pendingInitialActivation') return;
    if (resource.descriptor.kind === 'image') {
      if (!resource.element.hasAttribute('src')) setImageSource(resource);
      if (resource.element.hasAttribute('src')) {
        resource.lifecycleState = 'active';
        removeStatus(resource);
      }
    } else if (resource.descriptor.kind === 'video') {
      if (resource.element.hasAttribute('src')) {
        resource.lifecycleState = 'active';
        removeStatus(resource);
        return;
      }
      const restore = resource.pendingRestore;
      setVideoSource(resource, { preserveTime: Boolean(restore && restore.generation === resource.generation) });
      if (resource.element.hasAttribute('src')) resource.lifecycleState = 'active';
    } else if (resource.descriptor.kind === 'pdf') exposePDF(resource);
  }

  function activatePreparedResources() {
    for (const resource of resources) activatePreparedResource(resource);
    for (const descriptor of galleryDescriptors) gallery?.prepare?.(descriptor, lease, context);
  }

  if (native.length) {
    lease = acquireContentsMediaLease({ signal: context.signal, isCurrent: context.isCurrent,
      onStatus: (status, details) => {
        if (status === 'ready') {
          activatePreparedResources();
          return;
        }
        for (const resource of resources) {
          if (resource.lifecycleState === 'terminalAssetFailure') continue;
          if (status === 'renewing') continue;
          if (status === 'expired') {
            if (resource.lifecycleState === 'active') resource.lifecycleState = 'pendingInitialActivation';
            if (resource.descriptor.kind === 'video') {
              resource.generation += 1;
              resource.pendingRestore = null;
              resource.playingIntent = false;
              pauseVideo(resource, 'expired');
              lease.setPlaying(false, resource);
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
            if (resource.descriptor.kind === 'pdf') {
              if (resource.lifecycleState === 'active') continue;
              failPDFPreparation(resource, details?.issue,
                status === 'denied'
                  ? 'Sua sessão precisa ser validada novamente para abrir este PDF.'
                  : 'Não foi possível preparar este PDF.');
              continue;
            }
            visibleStatus(document, resource,
              status === 'denied' ? 'Sua sessão precisa ser validada novamente para abrir esta mídia.' : 'Não foi possível preparar esta mídia.', {
                retry: true,
                action: () => {
                  if (resource.lifecycleState === 'recovering') {
                    if (resource.descriptor.kind === 'video') recoverVideo(resource);
                    else if (resource.descriptor.kind === 'image') recoverImage(resource);
                    return;
                  }
                  void lease.ensureFresh({ force: true }).then(() => {
                    if (live(resource)) activatePreparedResources();
                  }).catch(() => {});
                },
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
    const initialPreparation = lease.ensureFresh();
    void initialPreparation.then(() => {
      if (disposed.value || !contextIsCurrent(context, lease, disposed)) return;
      activatePreparedResources();
    }).catch(error => {
      if (error?.name === 'AbortError' || !viewContextIsCurrent(context, disposed)) return;
      for (const resource of resources) {
        if (resource.lifecycleState === 'terminalAssetFailure') continue;
        if (resource.descriptor.kind === 'pdf') {
          continue;
        }
        visibleStatus(document, resource, error?.status === 401 || error?.status === 403
          ? 'Sua sessão precisa ser validada novamente para abrir esta mídia.' : 'Não foi possível preparar esta mídia.', {
          retry: true,
          action: () => {
            if (resource.lifecycleState === 'recovering') {
              if (resource.descriptor.kind === 'video') recoverVideo(resource);
              else if (resource.descriptor.kind === 'image') recoverImage(resource);
              return;
            }
            void lease.ensureFresh({ force: true }).then(() => {
              if (contextIsCurrent(context, lease, disposed)) activatePreparedResources();
            }).catch(() => {});
          },
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
        lease?.setPlaying(false, resource);
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
    for (const embed of embeds.splice(0)) {
      embed.iframe.removeAttribute('src');
      embed.iframe.remove();
      embed.frame.remove();
      embed.link.remove();
    }
    gallery?.close?.({ restoreFocus: false });
    lease?.release();
  };
  context.signal?.addEventListener?.('abort', dispose, { once: true });
  return { dispose, lease };
}
