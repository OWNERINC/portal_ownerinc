import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { canUseAutoCard } = require('../../api/middleware/policy');

const dho = (name, active = true) => ({
  role: 'viewer', job_title: name, job_title_active: active,
  job_title_access: { autocard: true }, permissions: {},
});

function createAutoCardElement(id, { decodeImage = async () => {}, onInnerHTML = null } = {}) {
  const listeners = new Map();
  const classes = new Set();
  let markup = '';
  let children = [];
  let mediaMarkup = null;
  let mediaFrame = null;
  let mediaImage = null;
  const readMediaNodes = () => {
    if (id !== 'cardCanvas') return null;
    if (mediaMarkup === markup) return mediaFrame ? { frame: mediaFrame, image: mediaImage } : null;
    mediaMarkup = markup;
    mediaFrame = null;
    mediaImage = null;
    const match = markup.match(/<div class="(card-media-frame|birthday-photo|employee-photo)"[^>]*>[\s\S]*?<img(?: class="([^"]*)")? src="([^"]+)" style="([^"]*)"/);
    if (!match) return null;
    mediaFrame = {
      id: 'rendered-media-frame',
      clientWidth: 200,
      clientHeight: 200,
      querySelector(selector) {
        return selector === 'img' ? mediaImage : null;
      },
      getBoundingClientRect() {
        return { width: this.clientWidth, height: this.clientHeight };
      },
    };
    mediaImage = {
      id: 'rendered-media-image',
      src: match[3],
      className: match[2] || '',
      naturalWidth: 1000,
      naturalHeight: 500,
      complete: true,
      decode: decodeImage,
      parentElement: mediaFrame,
      attributes: { style: match[4] },
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      getAttribute(name) {
        return this.attributes[name] || null;
      },
    };
    return { frame: mediaFrame, image: mediaImage };
  };
  return {
    id,
    classList: {
      add(...names) { names.forEach(name => classes.add(name)); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : force;
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
      contains(name) { return classes.has(name); },
    },
    dataset: {},
    get innerHTML() {
      return markup || children.map(child => child.textContent || '').join('');
    },
    set innerHTML(value) {
      markup = String(value);
      children = [];
      onInnerHTML?.(markup);
      mediaMarkup = null;
      mediaFrame = null;
      mediaImage = null;
    },
    replaceChildren(...nodes) {
      markup = '';
      children = nodes;
    },
    append(...nodes) {
      children.push(...nodes);
    },
    textContent: '',
    value: '',
    style: {
      values: {},
      setProperty(name, value) { this.values[name] = value; },
      getPropertyValue(name) { return this.values[name] || ''; },
    },
    attributes: {},
    clientWidth: id === 'cropFrame' ? 200 : id === 'cardCanvas' ? 420 : 0,
    clientHeight: id === 'cropFrame' ? 200 : id === 'cardCanvas' ? 420 : 0,
    rectWidth: id === 'cropFrame' ? 200 : id === 'cardCanvas' ? 420 : 0,
    rectHeight: id === 'cropFrame' ? 200 : id === 'cardCanvas' ? 420 : 0,
    naturalWidth: id === 'cropImage' ? 1000 : 0,
    naturalHeight: id === 'cropImage' ? 500 : 0,
    complete: id === 'cropImage',
    files: [],
    disabled: false,
    hidden: false,
    parentElement: null,
    open: false,
    focused: false,
    pointerId: null,
    onclick: null,
    onchange: null,
    oninput: null,
    click() {
      this.clicks = (this.clicks || 0) + 1;
      this.onclick?.();
      listeners.get('click')?.forEach(handler => handler({ type: 'click', currentTarget: this, target: this }));
    },
    dispatchEvent(event) {
      if (event.type === 'input') this.oninput?.(event);
      listeners.get(event.type)?.forEach(handler => handler({ ...event, currentTarget: this }));
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, character) => character.toUpperCase())] = String(value);
    },
    setPointerCapture(pointerId) {
      this.pointerId = pointerId;
    },
    releasePointerCapture(pointerId) {
      if (this.pointerId === pointerId) this.pointerId = null;
    },
    focus() {
      this.focused = true;
      this.ownerDocument.activeElement = this;
    },
    getAttribute(name) {
      if (name !== 'style') return this.attributes[name] || null;
      const source = this.innerHTML.match(/<img class="card-media" src="[^"]+" style="([^"]*)"/);
      return this.attributes.style || source?.[1] || null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name);
    },
    getBoundingClientRect() {
      return { width: this.rectWidth || this.clientWidth, height: this.rectHeight || this.clientHeight };
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      listeners.get('close')?.forEach(handler => handler({ type: 'close', currentTarget: this }));
    },
    querySelector(selector) {
      if (id === 'cardCanvas') {
        const nodes = readMediaNodes();
        if (selector === '.card-media') return nodes?.image?.className.split(' ').includes('card-media') ? nodes.image : null;
        if (selector === 'img') return nodes?.image || null;
      }
      if (selector !== '.card-media') return null;
      const source = this.innerHTML.match(/<img class="card-media" src="([^"]+)"(?: style="([^"]*)")?/);
      return source ? { src: source[1], getAttribute: name => name === 'style' ? source[2] || null : null } : null;
    },
    querySelectorAll(selector) {
      if (selector === 'button') return children.filter(child => child.type === 'button');
      if (id !== 'cardCanvas') return [];
      const nodes = readMediaNodes();
      if (!nodes) return [];
      if (selector.includes('card-media-frame') || (selector.includes('birthday-photo') && !selector.includes(' img')) || (selector.includes('employee-photo') && !selector.includes(' img'))) {
        return [nodes.frame];
      }
      if (selector === 'img' || selector.includes('.card-media') || selector.includes(' img')) return [nodes.image];
      return [];
    },
  };
}

async function createAutoCardLifecycleHarness({ resizeObserver = false, deferAssetImages = false, deferLocalImages = false } = {}) {
  const [app, employee, pagination] = await Promise.all([
    readFile('public/autocard/app.js', 'utf8'),
    readFile('public/autocard/vacancy-enhancements.js', 'utf8'),
    readFile('public/js/pagination.js', 'utf8'),
  ]);
  const elements = new Map();
  const listeners = new Map();
  const observers = [];
  const resizeObservers = [];
  const requests = [];
  const apiRequests = [];
  const filterElements = [];
  const assetUrls = new Set();
  const deferredAssetImages = [];
  const deferredLocalImages = [];
  const createdUrls = [];
  const revokedUrls = [];
  const events = [];
  const captures = [];
  let imageDecodeError = null;
  let decodeCalls = 0;
  let downloadClicks = 0;
  let promptValue = null;
  let confirmValue = true;
  const rebuildFilters = markup => {
    filterElements.splice(0, filterElements.length);
    for (const match of String(markup).matchAll(/<button class="filter( active)?" data-template="([^"]*)">/g)) {
      const classes = new Set(['filter', ...(match[1] ? ['active'] : [])]);
      filterElements.push({
        dataset: { template: match[2] },
        classList: {
          add(...names) { names.forEach(name => classes.add(name)); },
          remove(...names) { names.forEach(name => classes.delete(name)); },
          contains(name) { return classes.has(name); },
        },
        onclick: null,
        click() { this.onclick?.(); },
      });
    }
  };
  const document = {
    activeElement: null,
    fonts: { get ready() { events.push('fonts'); return Promise.resolve(); } },
    getElementById(id) {
      if (!elements.has(id)) {
        const element = createAutoCardElement(id, {
          decodeImage: async () => {
            events.push('decode');
            decodeCalls += 1;
            if (imageDecodeError) throw imageDecodeError;
          },
          onInnerHTML: id === 'savedFilters' ? rebuildFilters : null,
        });
        element.ownerDocument = document;
        if (id === 'cropImage') element.parentElement = elements.get('cropFrame');
        elements.set(id, element);
      }
      return elements.get(id);
    },
    createElement(name) {
      if (name !== 'a') return createAutoCardElement(name);
      return { click() { downloadClicks += 1; } };
    },
    querySelector(selector) {
      if (selector === '.filter.active') return filterElements.find(filter => filter.classList.contains('active')) || null;
      return null;
    },
    addEventListener(type, handler) {
      if (!listeners.has(`document:${type}`)) listeners.set(`document:${type}`, []);
      listeners.get(`document:${type}`).push(handler);
    },
    dispatchEvent(event) {
      listeners.get(`document:${event.type}`)?.forEach(handler => handler(event));
    },
    querySelectorAll(selector) {
      if (selector === '.filter') return filterElements;
      if (selector.includes('#cardCanvas')) return elements.get('cardCanvas')?.querySelectorAll(selector) || [];
      return [];
    },
  };
  const window = {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatchEvent(event) {
      listeners.get(event.type)?.forEach(handler => handler(event));
    },
    lucide: null,
    location: { origin: 'http://localhost' },
    confirm() {
      return confirmValue;
    },
  };
  const URL = {
    createObjectURL() {
      const url = `blob:asset-${createdUrls.length + 1}`;
      createdUrls.push(url);
      return url;
    },
    revokeObjectURL(url) {
      revokedUrls.push(url);
    },
  };
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }

    observe() {}
  }
  class ResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      resizeObservers.push(this);
    }

    observe(target) {
      this.targets.add(target);
    }

    unobserve(target) {
      this.targets.delete(target);
    }
  }
  class Event {
    constructor(type) {
      this.type = type;
    }
  }
  class Image {
    constructor() {
      this.naturalWidth = 1000;
      this.naturalHeight = 1000;
      this.complete = false;
      this.onload = null;
      this.onerror = null;
    }

    set src(value) {
      this._src = value;
      this.complete = true;
      if (assetUrls.has(value) && deferAssetImages) deferredAssetImages.push(this);
      else if (!assetUrls.has(value) && deferLocalImages) deferredLocalImages.push(this);
      else this.onload?.();
    }

    get src() {
      return this._src || '';
    }
  }
  const fetchAPIAsset = (path) => new Promise((resolve, reject) => {
    requests.push({ path, resolve, reject });
  });
  const fetchAPI = (path, options = {}) => new Promise((resolve, reject) => {
    apiRequests.push({ path, options, resolve, reject });
  });
  const fetchAPIPage = fetchAPI;
  const drain = () => new Promise(resolve => setImmediate(resolve));
  const context = vm.createContext({
    Event,
    Image,
    MutationObserver,
    ...(resizeObserver ? { ResizeObserver } : {}),
    URL,
    clearTimeout,
    console,
    document,
    fetchAPI,
    fetchAPIPage,
    fetchAPIAsset,
    html2canvas: async (element, options) => {
      events.push('capture');
      captures.push({ element, options });
      return { toDataURL: () => 'data:image/png;base64,test' };
    },
    setTimeout(callback) {
      callback();
      return 0;
    },
    prompt() {
      return promptValue;
    },
    confirm() {
      return confirmValue;
    },
    window,
  });
  const cropSource = (await readFile('public/autocard/crop.js', 'utf8')).replace(/^export /gm, '');
  const paginationSource = pagination.replace(/^export /gm, '');
  const appSource = app.replace(/^import[^\n]+\n/gm, '');
  vm.runInContext(`${cropSource}\n${paginationSource}\n${appSource}\n${employee}\nglobalThis.__autocardTest = { current: () => current, cropDraft: () => cropDraft, selectTemplate, renderCard, exportCard, saveCard, loadSaved, showTab };`, context);
  return {
    cardCanvas: elements.get('cardCanvas'),
    createdUrls,
    dispatch(type, event = { type }) {
      listeners.get(type)?.forEach(handler => handler(event));
    },
    flushMutations() {
      observers.forEach(observer => observer.callback());
    },
    flushResizes(target) {
      resizeObservers.forEach(observer => {
        const entries = [...observer.targets]
          .filter(item => !target || item === target)
          .map(item => ({ target: item }));
        if (entries.length) observer.callback(entries);
      });
    },
    async reject(index, error) {
      requests[index].reject(error);
      await drain();
    },
    async rejectAPI(index, error) {
      apiRequests[index].reject(error);
      await drain();
    },
    requests,
    apiRequests,
    async resolve(index) {
      return this.resolveAsset(index);
    },
    async resolveAsset(index) {
      const url = URL.createObjectURL({});
      assetUrls.add(url);
      requests[index].resolve(url);
      await drain();
      return url;
    },
    async resolveImageLoad(index) {
      deferredAssetImages[index]?.onload?.();
      await drain();
    },
    async rejectImageLoad(index, error = new Error('asset unavailable')) {
      const image = deferredAssetImages[index];
      if (image) {
        image.error = error;
        image.onerror?.(error);
      }
      await drain();
    },
    async resolveLocalImage(index) {
      deferredLocalImages[index]?.onload?.();
      await drain();
    },
    async resolveAPI(index, value) {
      apiRequests[index].resolve(value);
      await drain();
      return value;
    },
    revokedUrls,
    state: () => context.__autocardTest.current(),
    selectTemplate: (key, card) => context.__autocardTest.selectTemplate(key, card),
    showTab: tab => context.__autocardTest.showTab(tab),
    clickBack() {
      elements.get('backButton').click();
    },
    clickUpload() {
      elements.get('imageButton').click();
    },
    fileInputClicks: () => elements.get('imageInput').clicks || 0,
    fileInputValue: () => elements.get('imageInput').value,
    async chooseFile(file) {
      const input = elements.get('imageInput');
      input.files = [file];
      input.value = file.name;
      input.onchange?.({ type: 'change', target: input });
      await drain();
      return this.flushAsync();
    },
    mediaStatus: () => elements.get('mediaStatus').getAttribute('data-state'),
    mediaStatusText: () => elements.get('mediaStatus').textContent,
    savedList: () => elements.get('savedList'),
    savedPagination: () => elements.get('savedPagination'),
    setSavedSearch(value) {
      const input = elements.get('savedSearch');
      input.value = value;
      input.oninput?.({ target: input });
    },
    async selectSavedFilter(template) {
      const filter = filterElements.find(item => item.dataset.template === template);
      assert.ok(filter, `expected saved filter ${template}`);
      filter.click();
      await drain();
    },
    async clickSavedPage(label) {
      const button = elements.get('savedPagination').querySelectorAll('button')
        .find(item => item.textContent === label);
      assert.ok(button, `expected saved pagination button ${label}`);
      button.click();
      await drain();
    },
    setPrompt(value) {
      promptValue = value;
    },
    saveCard: () => context.__autocardTest.saveCard(),
    loadSaved: offset => context.__autocardTest.loadSaved(offset),
    dispatchClick(anchor = {}) {
      const target = anchor;
      const event = {
        type: 'click',
        target,
        button: 0,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      if (!target.closest) target.closest = selector => selector === 'a[href]' ? target : null;
      document.dispatchEvent(event);
      return !event.defaultPrevented;
    },
    confirmNavigation(answer) {
      confirmValue = answer;
      return this.dispatchClick({
        href: './dashboard.html',
        origin: 'http://localhost',
        target: '',
        getAttribute(name) { return name === 'href' ? this.href : null; },
        hasAttribute() { return false; },
        closest(selector) { return selector === 'a[href]' ? this : null; },
      });
    },
    beforeUnloadBlocked() {
      const event = {
        type: 'beforeunload',
        returnValue: null,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      window.dispatchEvent(event);
      return event.returnValue === '';
    },
    async flushAsync() {
      await drain();
      await drain();
    },
    isHidden: id => elements.get(id).classList.contains('hidden'),
    openCrop() {
      const button = elements.get('cropButton');
      button.focus();
      button.onclick();
    },
    dragCrop(dx, dy) {
      const frame = elements.get('cropFrame');
      frame.dispatchEvent({ type: 'pointerdown', pointerId: 1, clientX: 0, clientY: 0 });
      frame.dispatchEvent({ type: 'pointermove', pointerId: 1, clientX: dx, clientY: dy });
      frame.dispatchEvent({ type: 'pointerup', pointerId: 1, clientX: dx, clientY: dy });
    },
    setZoom(zoom) {
      const input = elements.get('cropZoom');
      input.value = String(zoom);
      input.dispatchEvent({ type: 'input' });
    },
    setCropImageSize(width, height) {
      const image = elements.get('cropImage');
      image.naturalWidth = width;
      image.naturalHeight = height;
    },
    setCropFrameSize(width, height, rectWidth = width, rectHeight = height) {
      const frame = elements.get('cropFrame');
      frame.clientWidth = width;
      frame.clientHeight = height;
      frame.rectWidth = rectWidth;
      frame.rectHeight = rectHeight;
    },
    setCardRect(width, height) {
      const canvas = elements.get('cardCanvas');
      canvas.clientWidth = width;
      canvas.clientHeight = height;
      canvas.rectWidth = width;
      canvas.rectHeight = height;
    },
    setField(id, value) {
      const field = elements.get(`field-${id}`);
      field.value = value;
      field.dispatchEvent(new Event('input'));
    },
    async exportCard() {
      await context.__autocardTest.exportCard();
      return { captures, decodeCalls, downloadClicks, events };
    },
    setImageDecodeError(error) {
      imageDecodeError = error;
    },
    captures,
    decodeCalls: () => decodeCalls,
    downloadClicks: () => downloadClicks,
    events,
    resizeRenderedFrame(width, height) {
      const frame = elements.get('cardCanvas')?.querySelectorAll('.birthday-photo, .employee-photo, .card-media-frame')[0];
      assert.ok(frame, 'expected a rendered media frame');
      frame.clientWidth = width;
      frame.clientHeight = height;
      this.flushResizes(frame);
    },
    renderedMediaStyle() {
      const image = elements.get('cardCanvas')?.querySelectorAll('.birthday-photo img, .employee-photo img, .card-media')[0];
      return image?.getAttribute('style') || '';
    },
    cropImageStyle() {
      return elements.get('cropImage')?.getAttribute('style') || '';
    },
    cropDialogOpen: () => Boolean(elements.get('cropDialog')?.open),
    cropFrameRatio() {
      return elements.get('cropFrame')?.style.getPropertyValue('--crop-frame-ratio') || '';
    },
    applyCrop() {
      elements.get('cropApply').onclick();
    },
    cancelCrop() {
      elements.get('cropCancel').onclick();
    },
    resetCrop() {
      elements.get('cropReset').onclick();
    },
    draft: () => JSON.parse(JSON.stringify(context.__autocardTest.cropDraft())),
    focusedId: () => document.activeElement?.id || null,
    toast: () => elements.get('toast'),
    exportButtonDisabled: () => Boolean(elements.get('exportButton').disabled),
    cardBounds: () => elements.get('cardCanvas').getBoundingClientRect(),
  };
}

function cssDeclarations(styles, selector) {
  const declarations = {};
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`, 'g');
  for (const match of styles.matchAll(pattern)) {
    for (const declaration of match[1].split(';')) {
      const separator = declaration.indexOf(':');
      if (separator > 0) declarations[declaration.slice(0, separator).trim()] = declaration.slice(separator + 1).trim();
    }
  }
  return declarations;
}

function cssBox(value) {
  const values = value.split(/\s+/).map(Number.parseFloat);
  if (values.length === 1) return { top: values[0], right: values[0], bottom: values[0], left: values[0] };
  if (values.length === 2) return { top: values[0], right: values[1], bottom: values[0], left: values[1] };
  if (values.length === 3) return { top: values[0], right: values[1], bottom: values[2], left: values[1] };
  return { top: values[0], right: values[1], bottom: values[2], left: values[3] };
}

function cssFlex(value) {
  const [, grow, shrink, basis] = value.match(/^([\d.]+)\s+([\d.]+)\s+([\d.]+)%$/) || [];
  assert.ok(grow !== undefined && shrink !== undefined && basis !== undefined, `expected percentage flex shorthand, got ${value}`);
  return { grow: Number(grow), shrink: Number(shrink), basis: Number(basis) };
}

function cssFontSize(value, width) {
  const clamp = value.match(/^clamp\(([^,]+),([^,]+),([^\)]+)\)$/);
  if (!clamp) return Number.parseFloat(value);
  const resolve = part => part.trim().endsWith('cqw') ? Number.parseFloat(part) * width / 100 : Number.parseFloat(part);
  return Math.min(resolve(clamp[3]), Math.max(resolve(clamp[1]), resolve(clamp[2])));
}

function cssLineHeight(value, fontSize, fallback) {
  return value ? (value.endsWith('px') ? Number.parseFloat(value) : Number.parseFloat(value) * fontSize) : fontSize * fallback;
}

function employeeMobileLayoutBounds(harness, styles) {
  const markup = harness.cardCanvas.innerHTML;
  const bodyStart = markup.indexOf('<p class="body">');
  const footerStart = markup.indexOf('<div class="card-footer"', bodyStart);
  assert.ok(bodyStart >= 0, 'employee description must render');
  assert.ok(footerStart > bodyStart, 'employee footer must follow the description');

  const card = harness.cardBounds();
  const shell = cssDeclarations(styles, '.card-shell');
  const layout = cssDeclarations(styles, '.employee-layout');
  const photo = cssDeclarations(styles, '.employee-photo');
  const copy = cssDeclarations(styles, '.employee-copy');
  const kicker = cssDeclarations(styles, '.employee-copy .card-kicker');
  const title = cssDeclarations(styles, '.employee-copy h2');
  const subtitle = cssDeclarations(styles, '.employee-copy .sub');
  const start = cssDeclarations(styles, '.employee-start');
  const startLabel = cssDeclarations(styles, '.employee-start span');
  const startValue = cssDeclarations(styles, '.employee-start strong');
  const body = cssDeclarations(styles, '.employee-copy .body');
  const bodyBase = cssDeclarations(styles, '.card-shell .body');
  const footer = cssDeclarations(styles, '.employee-copy .card-footer');
  const globalBody = cssDeclarations(styles, 'body');
  const global = cssDeclarations(styles, '*');

  assert.equal(global['box-sizing'], 'border-box', 'employee bounds require border-box sizing');
  assert.equal(shell.overflow, 'hidden', 'card shell must contain employee content');
  assert.equal(layout.display, 'flex', 'employee layout must be a flex column');
  assert.equal(layout['flex-direction'], 'column', 'employee layout must stack photo and copy');
  assert.equal(photo['min-height'], '0', 'employee photo must be shrinkable');
  assert.equal(copy.overflow, 'visible', 'employee copy must not clip fixed metadata');
  assert.equal(copy['min-height'], '0', 'employee copy must be shrinkable');
  assert.equal(body.overflow, 'hidden', 'employee description must be the clipping boundary');
  assert.equal(body['min-height'], '0', 'employee description must be shrinkable');
  assert.equal(footer.flex, '0 0 auto', 'employee footer must remain fixed after the body');
  assert.equal(title.display, '-webkit-box', 'employee title must have a bounded layout');
  assert.equal(Number(title['-webkit-line-clamp']), 2, 'mobile employee title must be bounded to two lines');

  const photoFlex = cssFlex(photo.flex);
  const copyFlex = cssFlex(copy.flex);
  photoFlex.basis = Number.parseFloat(photo['flex-basis'] || photoFlex.basis);
  assert.ok(copyFlex.grow > 0, 'employee copy must receive remaining height');
  assert.ok(photoFlex.grow + copyFlex.grow > 0, 'employee flex layout must distribute remaining height');
  const photoHeight = card.height * photoFlex.basis / 100;
  const copyBasis = card.height * copyFlex.basis / 100;
  const freeHeight = card.height - photoHeight - copyBasis;
  assert.ok(freeHeight >= 0, 'employee mobile flex basis must fit the card');
  const copyHeight = copyBasis + freeHeight * copyFlex.grow / (photoFlex.grow + copyFlex.grow);
  const globalLineHeight = Number(globalBody['line-height']);
  const copyPadding = cssBox(copy.padding);
  const kickerSize = cssFontSize(kicker['font-size'], card.width);
  const titleSize = cssFontSize(title['font-size'], card.width);
  const subtitleSize = cssFontSize(subtitle['font-size'], card.width);
  const startLabelSize = cssFontSize(startLabel['font-size'], card.width);
  const startValueSize = cssFontSize(startValue['font-size'], card.width);
  const footerSize = cssFontSize(footer['font-size'], card.width);
  const titleMargin = cssBox(title.margin);
  const subtitleMargin = cssBox(subtitle.margin);
  const startMargin = cssBox(start.margin);
  const startPadding = cssBox(start.padding);
  const footerPadding = { top: Number.parseFloat(footer['padding-top'] || 0) };
  const startLabelHeight = cssLineHeight(startLabel['line-height'], startLabelSize, globalLineHeight);
  const startValueHeight = cssLineHeight(startValue['line-height'], startValueSize, globalLineHeight);
  const footerHeight = Math.max(Number.parseFloat(footer['min-height']), footerSize * globalLineHeight + footerPadding.top);
  const fixedHeight = copyPadding.top + copyPadding.bottom
    + cssLineHeight(kicker['line-height'], kickerSize, globalLineHeight)
    + Number(title['-webkit-line-clamp']) * cssLineHeight(title['line-height'], titleSize, globalLineHeight) + titleMargin.top + titleMargin.bottom
    + cssLineHeight(subtitle['line-height'], subtitleSize, globalLineHeight) + subtitleMargin.bottom
    + startPadding.top + startPadding.bottom + Number(start.gap.replace('px', '')) + startLabelHeight + startValueHeight + startMargin.top + startMargin.bottom
    + footerHeight;
  const bodyMargin = cssBox(bodyBase.margin);
  const bodyHeight = copyHeight - fixedHeight - bodyMargin.top - bodyMargin.bottom;

  assert.ok(bodyHeight > 0, `employee body budget must remain positive: ${bodyHeight}`);
  return { card, copyHeight, fixedHeight, bodyHeight };
}

async function createAutoCardCropHarness() {
  const source = await readFile('public/autocard/crop.js', 'utf8');
  const context = vm.createContext({});
  const cropSource = source.replace(/^export /gm, '');
  vm.runInContext(`${cropSource}\nglobalThis.__autocardCropTest = { DEFAULT_MEDIA_CROP, normalizeMediaCrop, cropStyle, cropLayout, cropRenderStyle, dragMediaCrop };`, context);
  const crop = context.__autocardCropTest;
  return {
    DEFAULT_MEDIA_CROP: JSON.parse(JSON.stringify(crop.DEFAULT_MEDIA_CROP)),
    normalizeMediaCrop: value => JSON.parse(JSON.stringify(crop.normalizeMediaCrop(value))),
    cropStyle: crop.cropStyle,
    cropLayout: (value, metrics) => JSON.parse(JSON.stringify(crop.cropLayout(value, metrics))),
    cropRenderStyle: crop.cropRenderStyle,
    dragMediaCrop: (value, metrics) => JSON.parse(JSON.stringify(crop.dragMediaCrop(value, metrics))),
  };
}

test('AutoCard crop utility normalizes, styles, and drags media safely', async () => {
  const { DEFAULT_MEDIA_CROP, normalizeMediaCrop, cropStyle, cropLayout, cropRenderStyle, dragMediaCrop } = await createAutoCardCropHarness();

  assert.deepEqual(DEFAULT_MEDIA_CROP, { x: 0.5, y: 0.5, zoom: 1 });
  assert.deepEqual(normalizeMediaCrop(), { x: 0.5, y: 0.5, zoom: 1 });
  assert.deepEqual(normalizeMediaCrop({ x: 2, y: -1, zoom: 8 }), { x: 1, y: 0, zoom: 3 });
  assert.deepEqual(normalizeMediaCrop({ x: 'bad' }), { x: 0.5, y: 0.5, zoom: 1 });
  assert.equal(cropStyle({ x: 0.25, y: 0.75, zoom: 2 }), '--crop-x:25%;--crop-y:75%;--crop-zoom:2');

  const squareMetrics = { frameWidth: 200, frameHeight: 200, imageWidth: 1000, imageHeight: 1000 };
  assert.notEqual(
    cropRenderStyle({ x: 0, y: 0.5, zoom: 2 }, squareMetrics),
    cropRenderStyle({ x: 1, y: 0.5, zoom: 2 }, squareMetrics),
  );
  const portraitMetrics = { frameWidth: 180, frameHeight: 320, imageWidth: 800, imageHeight: 1200 };
  assert.notEqual(
    cropRenderStyle({ x: 0.5, y: 0, zoom: 2 }, portraitMetrics),
    cropRenderStyle({ x: 0.5, y: 1, zoom: 2 }, portraitMetrics),
  );
  assert.match(cropRenderStyle({ x: 0.5, y: 0, zoom: 2 }, portraitMetrics), /transform:translate\(/);

  const moved = dragMediaCrop({ x: 0.5, y: 0.5, zoom: 2 }, {
    dx: 100,
    dy: 0,
    frameWidth: 200,
    frameHeight: 200,
    imageWidth: 1000,
    imageHeight: 500,
  });
  assert.ok(moved.x < 0.5);
  assert.equal(moved.y, 0.5);

  assert.deepEqual(dragMediaCrop({ x: 0.25, y: 0.75, zoom: 1 }, {
    dx: 100,
    dy: -100,
    frameWidth: 200,
    frameHeight: 200,
    imageWidth: 200,
    imageHeight: 200,
  }), { x: 0.25, y: 0.75, zoom: 1 });
});

test('AutoCard media lifecycle revokes stale and hidden blobs and keeps variants safe', async () => {
  const harness = await createAutoCardLifecycleHarness();

  harness.selectTemplate('aniversariante', { mediaId: 'old-media' });
  harness.selectTemplate('aniversariante', { mediaId: 'new-media' });
  assert.equal(harness.requests.map(request => request.path).join(','), '/api/autocard/media/old-media,/api/autocard/media/new-media');
  assert.match(harness.cardCanvas.innerHTML, /birthday-photo/);
  assert.match(harness.cardCanvas.innerHTML, /data-lucide="cake"/);
  assert.doesNotMatch(harness.cardCanvas.innerHTML, /birthday-photo"><img|undefined|\/api\/autocard\/media/);

  const staleUrl = await harness.resolve(0);
  assert.deepEqual(harness.revokedUrls, [staleUrl]);
  assert.equal(harness.state().mediaUrl, null);

  const currentUrl = await harness.resolve(1);
  assert.equal(harness.state().mediaUrl, currentUrl);
  assert.match(harness.cardCanvas.innerHTML, new RegExp(`src="${currentUrl}"`));
  assert.equal(harness.isHidden('cropButton'), false);

  harness.openCrop();
  assert.equal(harness.cropDialogOpen(), true);
  assert.deepEqual(harness.draft(), { x: 0.5, y: 0.5, zoom: 1 });

  harness.dispatch('pagehide');
  assert.equal(harness.state().mediaUrl, null);
  assert.deepEqual(harness.revokedUrls, [staleUrl, currentUrl]);
  assert.equal(harness.isHidden('cropButton'), true);
  assert.equal(harness.cropDialogOpen(), false);
  assert.equal(harness.draft(), null);

  harness.dispatch('pageshow', { type: 'pageshow', persisted: true });
  assert.equal(harness.requests[2].path, '/api/autocard/media/new-media');
  const restoredUrl = await harness.resolve(2);
  assert.equal(harness.state().mediaUrl, restoredUrl);
  assert.equal(harness.isHidden('cropButton'), false);

  harness.selectTemplate('aniversariante', { mediaId: 'hidden-media' });
  harness.dispatch('pagehide');
  const hiddenUrl = await harness.resolve(3);
  assert.equal(harness.state().mediaUrl, null);
  assert.deepEqual(harness.revokedUrls, [staleUrl, currentUrl, restoredUrl, hiddenUrl]);

  harness.selectTemplate('evento', { mediaId: 'failed-media' });
  await harness.reject(4, new Error('asset unavailable'));
  assert.equal(harness.state().mediaUrl, null);
  assert.equal(harness.isHidden('cropButton'), true);
  assert.match(harness.cardCanvas.innerHTML, /card-placeholder/);
  assert.doesNotMatch(harness.cardCanvas.innerHTML, /undefined|\/api\/autocard\/media/);
  assert.match(harness.toast().textContent, /Não foi possível carregar a imagem: asset unavailable/);

  harness.selectTemplate('novo_funcionario', { mediaId: 'employee-media', mediaCrop: { x: 0.2, y: 0.8, zoom: 2 } });
  harness.flushMutations();
  assert.doesNotMatch(harness.cardCanvas.innerHTML, /<img[^>]+src="undefined"|\/api\/autocard\/media/);
  assert.match(harness.cardCanvas.innerHTML, /employee-photo"><i data-lucide="user-plus"/);

  const employeeUrl = await harness.resolve(5);
  harness.flushMutations();
  assert.match(harness.cardCanvas.innerHTML, new RegExp(`employee-photo"><img src="${employeeUrl}"`));
  assert.match(harness.cardCanvas.innerHTML, /employee-photo"><img src="[^"]+" style="--crop-x:20%;--crop-y:80%;--crop-zoom:2(?:;|")/);
  assert.doesNotMatch(harness.cardCanvas.innerHTML, /undefined|\/api\/autocard\/media/);
});

test('AutoCard crop editor keeps drafts isolated until apply and restores focus', async () => {
  const harness = await createAutoCardLifecycleHarness();

  harness.selectTemplate('aniversariante', { mediaId: 'photo', mediaCrop: { x: 0.2, y: 0.8, zoom: 2 } });
  assert.equal(harness.state().mediaCrop.x, 0.2);
  await harness.resolve(0);
  harness.openCrop();
  harness.dragCrop(40, 0);
  harness.setZoom(2.5);
  harness.applyCrop();
  assert.equal(harness.state().mediaCrop.zoom, 2.5);
  assert.notEqual(harness.state().mediaCrop.x, 0.2);
  assert.equal(harness.focusedId(), 'cropButton');

  const confirmed = { ...harness.state().mediaCrop };
  harness.openCrop();
  harness.setZoom(1.4);
  assert.equal(harness.draft().zoom, 1.4);
  assert.equal(harness.state().mediaCrop.zoom, 2.5);
  harness.cancelCrop();
  assert.deepEqual(JSON.parse(JSON.stringify(harness.state().mediaCrop)), confirmed);

  harness.openCrop();
  harness.setZoom(2.4);
  harness.resetCrop();
  harness.applyCrop();
  assert.deepEqual(JSON.parse(JSON.stringify(harness.state().mediaCrop)), { x: 0.5, y: 0.5, zoom: 1 });
});

test('AutoCard crop editor ignores movement until the preview image is ready', async () => {
  const harness = await createAutoCardLifecycleHarness();

  harness.selectTemplate('aniversariante', { mediaId: 'photo' });
  await harness.resolve(0);
  harness.openCrop();
  const before = harness.draft();
  harness.setCropImageSize(0, 0);
  harness.dragCrop(80, 40);
  assert.deepEqual(harness.draft(), before);
});

test('AutoCard reapplies confirmed crop when a rendered media frame resizes', async () => {
  const harness = await createAutoCardLifecycleHarness({ resizeObserver: true });

  harness.selectTemplate('aniversariante', { mediaId: 'photo', mediaCrop: { x: 0.2, y: 0.8, zoom: 2 } });
  await harness.resolve(0);
  const before = harness.renderedMediaStyle();

  harness.resizeRenderedFrame(140, 260);

  const after = harness.renderedMediaStyle();
  assert.notEqual(after, before);
  assert.match(after, /transform:translate\(/);
});

test('AutoCard reapplies the draft crop when the open dialog frame resizes', async () => {
  const harness = await createAutoCardLifecycleHarness({ resizeObserver: true });

  harness.selectTemplate('aniversariante', { mediaId: 'photo' });
  await harness.resolve(0);
  harness.openCrop();
  const before = harness.cropImageStyle();

  harness.setCropFrameSize(140, 260);
  harness.flushResizes();

  const after = harness.cropImageStyle();
  assert.notEqual(after, before);
  assert.match(after, /transform:translate\(/);
});

test('AutoCard crop geometry uses content-box dimensions when a frame has a border', async () => {
  const harness = await createAutoCardLifecycleHarness();

  harness.selectTemplate('aniversariante', { mediaId: 'photo' });
  await harness.resolve(0);
  harness.setCropFrameSize(200, 200, 220, 220);
  harness.openCrop();

  const style = harness.cropImageStyle();
  assert.match(style, /width:400px;height:200px/);
  assert.doesNotMatch(style, /width:440px;height:220px/);
});

test('AutoCard employee crop ratio follows the rendered frame and mobile resize', async () => {
  const harness = await createAutoCardLifecycleHarness({ resizeObserver: true });

  harness.selectTemplate('novo_funcionario', { mediaId: 'employee-photo' });
  await harness.resolve(0);
  harness.openCrop();
  assert.equal(harness.cropFrameRatio(), '200 / 200');

  harness.flushMutations();
  assert.equal(harness.cropFrameRatio(), '200 / 200');
  harness.resizeRenderedFrame(100, 200);
  assert.equal(harness.cropFrameRatio(), '100 / 200');
});

test('AutoCard export executes rendered geometry and blocks undecodable images', async () => {
  const harness = await createAutoCardLifecycleHarness();

  harness.selectTemplate('aniversariante', { mediaId: 'photo' });
  await harness.resolve(0);
  harness.setCardRect(360, 540);

  await harness.exportCard();
  const { scale, width, height, backgroundColor } = harness.captures[0].options;
  assert.equal(scale, 3);
  assert.equal(width, 360);
  assert.equal(height, 540);
  assert.equal(backgroundColor, null);
  assert.deepEqual(harness.events.slice(0, 4), ['fonts', 'fonts', 'decode', 'capture']);
  assert.equal(harness.downloadClicks(), 1);
  assert.equal(harness.exportButtonDisabled(), false);

  harness.setImageDecodeError(new Error('decode failed'));
  await harness.exportCard();
  assert.equal(harness.captures.length, 1);
  assert.equal(harness.downloadClicks(), 1);
  assert.equal(harness.exportButtonDisabled(), false);
  assert.match(harness.toast().textContent, /A imagem ainda não está pronta para exportação/);
});

test('AutoCard upload trigger is keyboard reachable and accepts the same file twice', async () => {
  const harness = await createAutoCardLifecycleHarness();
  harness.selectTemplate('aniversariante');
  harness.clickUpload();
  harness.clickUpload();
  assert.equal(harness.fileInputClicks(), 2);
  await harness.chooseFile({ name: 'photo.png', type: 'image/png', size: 1024 });
  assert.equal(harness.fileInputValue(), '');
  assert.equal(harness.mediaStatus(), 'uploading');
  assert.match(harness.mediaStatusText(), /Enviando imagem/);
});

test('AutoCard keeps previous media visible while replacement is pending', async () => {
  const harness = await createAutoCardLifecycleHarness();
  harness.selectTemplate('aniversariante', { mediaId: 'old-media' });
  await harness.resolveAsset(0);
  await harness.chooseFile({ name: 'new.png', type: 'image/png', size: 1024 });
  assert.equal(harness.mediaStatus(), 'uploading');
  assert.match(harness.mediaStatusText(), /Enviando imagem/);
  assert.match(harness.cardCanvas.innerHTML, /src="[^"]+"/);
});

test('AutoCard commits replacement media only after its blob loads and restores failures', async () => {
  const harness = await createAutoCardLifecycleHarness();
  harness.selectTemplate('aniversariante', { mediaId: 'old-media', mediaCrop: { x: 0.2, y: 0.8, zoom: 2 } });
  const oldUrl = await harness.resolveAsset(0);
  harness.openCrop();
  harness.cancelCrop();
  await harness.chooseFile({ name: 'new.png', type: 'image/png', size: 1024 });
  await harness.resolveAPI(0, { id: 'new-media' });
  await harness.flushAsync();
  assert.equal(harness.state().mediaId, 'old-media');
  assert.equal(harness.mediaStatus(), 'loading');
  assert.match(harness.cardCanvas.innerHTML, new RegExp(`src="${oldUrl}"`));
  const newUrl = await harness.resolveAsset(1);
  assert.equal(harness.state().mediaId, 'new-media');
  assert.equal(harness.state().mediaUrl, newUrl);
  assert.equal(harness.mediaStatus(), 'ready');
  assert.ok(harness.revokedUrls.includes(oldUrl));

  const failed = await createAutoCardLifecycleHarness();
  failed.selectTemplate('aniversariante', { mediaId: 'old-media' });
  const failedOldUrl = await failed.resolveAsset(0);
  await failed.chooseFile({ name: 'bad.png', type: 'image/png', size: 1024 });
  await failed.resolveAPI(0, { id: 'failed-media' });
  await failed.flushAsync();
  await failed.reject(1, new Error('asset unavailable'));
  assert.equal(failed.state().mediaId, 'old-media');
  assert.equal(failed.state().mediaUrl, failedOldUrl);
  assert.equal(failed.mediaStatus(), 'error');
  assert.match(failed.cardCanvas.innerHTML, new RegExp(`src="${failedOldUrl}"`));
});

test('AutoCard snapshots media confirmed during replacement validation', async () => {
  const harness = await createAutoCardLifecycleHarness({ deferLocalImages: true });
  harness.selectTemplate('aniversariante', {
    mediaId: 'old-media',
    mediaCrop: { x: 0.15, y: 0.75, zoom: 2 },
  });
  const replacement = harness.chooseFile({ name: 'new.png', type: 'image/png', size: 1024 });
  const oldUrl = await harness.resolveAsset(0);
  await harness.resolveLocalImage(0);
  await harness.flushAsync();
  await harness.rejectAPI(0, new Error('upload failed'));
  await replacement;

  assert.equal(harness.state().mediaId, 'old-media');
  assert.equal(harness.state().mediaUrl, oldUrl);
  assert.equal(harness.state().mediaCrop.x, 0.15);
  assert.equal(harness.state().mediaCrop.y, 0.75);
  assert.equal(harness.state().mediaCrop.zoom, 2);
  assert.equal(harness.mediaStatus(), 'error');
  assert.match(harness.cardCanvas.innerHTML, new RegExp(`src="${oldUrl}"`));
  assert.ok(harness.revokedUrls.includes(harness.createdUrls[0]));
  assert.ok(!harness.revokedUrls.includes(oldUrl));
});

test('AutoCard ignores a replacement response after a newer crop revision', async () => {
  const harness = await createAutoCardLifecycleHarness();
  harness.selectTemplate('aniversariante', { mediaId: 'old-media' });
  const oldUrl = await harness.resolveAsset(0);
  await harness.chooseFile({ name: 'new.png', type: 'image/png', size: 1024 });
  await harness.resolveAPI(0, { id: 'new-media' });
  await harness.flushAsync();
  harness.openCrop();
  harness.setZoom(2.5);
  harness.applyCrop();
  await harness.resolveAsset(1);
  assert.equal(harness.state().mediaId, 'old-media');
  assert.equal(harness.state().mediaCrop.zoom, 2.5);
  assert.equal(harness.state().mediaUrl, oldUrl);
  assert.equal(harness.mediaStatus(), 'ready');
  assert.match(harness.cardCanvas.innerHTML, new RegExp(`src="${oldUrl}"`));
});

test('AutoCard abandons an upload response after a newer editor revision', async () => {
  const harness = await createAutoCardLifecycleHarness();
  harness.selectTemplate('aniversariante', { mediaId: 'old-media' });
  const oldUrl = await harness.resolveAsset(0);
  await harness.chooseFile({ name: 'new.png', type: 'image/png', size: 1024 });
  harness.setField('titulo', 'Nome atualizado');
  await harness.resolveAPI(0, { id: 'new-media' });
  await harness.flushAsync();
  assert.equal(harness.state().mediaId, 'old-media');
  assert.equal(harness.state().mediaUrl, oldUrl);
  assert.equal(harness.mediaStatus(), 'ready');
  assert.equal(harness.requests.length, 1);
  assert.match(harness.cardCanvas.innerHTML, new RegExp(`src="${oldUrl}"`));
});

test('AutoCard clears an abandoned replacement when tab navigation is confirmed', async () => {
  const harness = await createAutoCardLifecycleHarness();
  harness.selectTemplate('aniversariante', { mediaId: 'old-media' });
  const oldUrl = await harness.resolveAsset(0);
  await harness.chooseFile({ name: 'new.png', type: 'image/png', size: 1024 });
  assert.equal(harness.mediaStatus(), 'uploading');
  harness.showTab('saved');
  await harness.resolveAPI(0, { id: 'new-media' });
  await harness.flushAsync();
  assert.equal(harness.state().mediaId, 'old-media');
  assert.equal(harness.state().mediaUrl, null);
  assert.equal(harness.mediaStatus(), 'idle');
  assert.ok(harness.revokedUrls.includes(oldUrl));
  harness.showTab('create');
  assert.equal(harness.mediaStatus(), 'loading');
  await harness.resolveAsset(1);
  assert.equal(harness.state().mediaId, 'old-media');
  assert.equal(harness.mediaStatus(), 'ready');
});

test('AutoCard restarts media after confirmed back navigation abandons loading', async () => {
  const harness = await createAutoCardLifecycleHarness({ deferAssetImages: true });
  harness.selectTemplate('aniversariante', { mediaId: 'pending-media' });
  harness.clickBack();
  await harness.resolveAsset(0);
  assert.equal(harness.state().mediaUrl, null);
  assert.equal(harness.mediaStatus(), 'idle');
  harness.showTab('create');
  await harness.resolveAsset(1);
  assert.equal(harness.mediaStatus(), 'loading');
  await harness.resolveImageLoad(0);
  assert.equal(harness.mediaStatus(), 'ready');
  assert.match(harness.cardCanvas.innerHTML, /src="blob:asset-/);
});

test('AutoCard rolls back when a delayed authenticated blob image fails', async () => {
  const harness = await createAutoCardLifecycleHarness({ deferAssetImages: true });
  harness.selectTemplate('aniversariante', { mediaId: 'old-media' });
  const oldUrl = await harness.resolveAsset(0);
  await harness.resolveImageLoad(0);
  await harness.chooseFile({ name: 'new.png', type: 'image/png', size: 1024 });
  await harness.resolveAPI(0, { id: 'new-media' });
  await harness.flushAsync();
  const newUrl = await harness.resolveAsset(1);
  assert.equal(harness.mediaStatus(), 'loading');
  await harness.rejectImageLoad(1, new Error('blob decode failed'));
  assert.equal(harness.mediaStatus(), 'error');
  assert.equal(harness.state().mediaId, 'old-media');
  assert.equal(harness.state().mediaUrl, oldUrl);
  assert.match(harness.cardCanvas.innerHTML, new RegExp(`src="${oldUrl}"`));
  assert.ok(harness.revokedUrls.includes(newUrl));
});

test('AutoCard blocks export until media loading finishes', async () => {
  const harness = await createAutoCardLifecycleHarness();
  harness.selectTemplate('aniversariante', { mediaId: 'pending-media' });
  await harness.exportCard();
  assert.equal(harness.mediaStatus(), 'loading');
  assert.match(harness.mediaStatusText(), /Carregando imagem/);
  assert.equal(harness.captures.length, 0);
  assert.equal(harness.downloadClicks(), 0);
});

test('AutoCard ignores a save response after the editor document changes', async () => {
  const harness = await createAutoCardLifecycleHarness();
  harness.selectTemplate('comunicado');
  harness.setField('titulo', 'Comunicado antigo');
  harness.setPrompt('Card antigo');
  const save = harness.saveCard();
  harness.selectTemplate('vaga');
  await harness.resolveAPI(0, { id: 'old-card', template: 'comunicado', values: {} });
  await save;
  assert.equal(harness.state().editingId, null);
});

test('AutoCard accepts an older same-document save identity without clearing newer edits', async () => {
  const harness = await createAutoCardLifecycleHarness();
  harness.selectTemplate('comunicado');
  harness.setField('titulo', 'Versão inicial');
  harness.setPrompt('Card inicial');
  const save = harness.saveCard();
  harness.setField('titulo', 'Versão mais nova');
  await harness.resolveAPI(0, { id: 'saved-card', template: 'comunicado', values: {} });
  await save;
  assert.equal(harness.state().editingId, 'saved-card');
  assert.equal(harness.state().values.titulo, 'Versão mais nova');
  assert.match(harness.mediaStatusText(), /Nenhuma imagem/);
  const followUp = harness.saveCard();
  assert.equal(harness.apiRequests[1].path, '/api/autocard/cards/saved-card');
  await harness.resolveAPI(1, { id: 'saved-card', template: 'comunicado', values: {} });
  await followUp;
});

test('AutoCard ignores stale history and export responses', async () => {
  const harness = await createAutoCardLifecycleHarness();
  const oldHistory = harness.loadSaved(0);
  const newHistory = harness.loadSaved(20);
  await harness.resolveAPI(1, { data: [{ id: 'new-card', name: 'Novo', template: 'comunicado', updatedAt: '2026-09-17' }], total: 21 });
  await harness.resolveAPI(0, { data: [{ id: 'old-card', name: 'Antigo', template: 'comunicado', updatedAt: '2026-09-17' }], total: 21 });
  await Promise.all([oldHistory, newHistory]);
  assert.match(harness.savedList().innerHTML, /Novo/);
  assert.doesNotMatch(harness.savedList().innerHTML, /Antigo/);
});

test('AutoCard loads history pages with a stable query and keeps the visible page while pending', async () => {
  const harness = await createAutoCardLifecycleHarness();
  const firstPage = harness.loadSaved();
  assert.equal(harness.apiRequests[0].path, '/api/autocard/cards?search=&template=&limit=20&offset=0');
  await harness.resolveAPI(0, { data: [{ id: 'first-card', name: 'Primeiro', template: 'comunicado', updatedAt: '2026-09-17' }], total: 21 });
  await firstPage;
  assert.match(harness.savedPagination().innerHTML, /Página 1 de 2/);

  await harness.clickSavedPage('Próxima');
  assert.equal(harness.apiRequests[1].path, '/api/autocard/cards?search=&template=&limit=20&offset=20');
  assert.match(harness.savedList().innerHTML, /Primeiro/);
  assert.equal(harness.savedPagination().getAttribute('aria-busy'), 'true');

  await harness.resolveAPI(1, { data: [{ id: 'second-card', name: 'Segundo', template: 'comunicado', updatedAt: '2026-09-17' }], total: 21 });
  assert.match(harness.savedList().innerHTML, /Segundo/);
  assert.doesNotMatch(harness.savedList().innerHTML, /Primeiro/);
  assert.match(harness.savedPagination().innerHTML, /Página 2 de 2/);
  assert.equal(harness.savedPagination().getAttribute('aria-busy'), 'false');
});

test('AutoCard rebuilds live history pagination after a page request fails', async () => {
  const harness = await createAutoCardLifecycleHarness();
  const firstPage = harness.loadSaved();
  await harness.resolveAPI(0, { data: [{ id: 'first-card', name: 'Primeiro', template: 'comunicado', updatedAt: '2026-09-17' }], total: 21 });
  await firstPage;

  await harness.clickSavedPage('Próxima');
  await harness.rejectAPI(1, new Error('histórico indisponível'));
  assert.match(harness.savedList().innerHTML, /Primeiro/);
  assert.equal(harness.savedPagination().getAttribute('aria-busy'), 'false');
  assert.match(harness.toast().textContent, /histórico indisponível/);

  await harness.clickSavedPage('Anterior');
  assert.equal(harness.apiRequests[2].path, '/api/autocard/cards?search=&template=&limit=20&offset=0');
  await harness.resolveAPI(2, { data: [{ id: 'retry-card', name: 'Retry', template: 'comunicado', updatedAt: '2026-09-17' }], total: 21 });
  assert.match(harness.savedList().innerHTML, /Retry/);
});

test('AutoCard resets history pagination after search and filter changes', async () => {
  const harness = await createAutoCardLifecycleHarness();
  const initial = harness.loadSaved(20);
  await harness.resolveAPI(0, { data: [{ id: 'page-two', name: 'Página dois', template: 'comunicado', updatedAt: '2026-09-17' }], total: 41 });
  await initial;

  harness.setSavedSearch('Novo & card');
  assert.equal(harness.apiRequests[1].path, '/api/autocard/cards?search=Novo%20%26%20card&template=&limit=20&offset=0');
  await harness.resolveAPI(1, { data: [{ id: 'search-card', name: 'Novo card', template: 'comunicado', updatedAt: '2026-09-17' }], total: 1 });
  await harness.flushAsync();

  await harness.selectSavedFilter('vaga');
  assert.equal(harness.apiRequests[2].path, '/api/autocard/cards?search=Novo%20%26%20card&template=vaga&limit=20&offset=0');
  await harness.resolveAPI(2, { data: [{ id: 'filtered-card', name: 'Vaga', template: 'vaga', updatedAt: '2026-09-17' }], total: 1 });
});

test('AutoCard ignores a stale history query after search changes', async () => {
  const harness = await createAutoCardLifecycleHarness();
  const oldQuery = harness.loadSaved();
  harness.setSavedSearch('novo');
  const newQuery = harness.apiRequests[1];
  assert.equal(newQuery.path, '/api/autocard/cards?search=novo&template=&limit=20&offset=0');
  await harness.resolveAPI(1, { data: [{ id: 'new-query', name: 'Novo', template: 'comunicado', updatedAt: '2026-09-17' }], total: 1 });
  await harness.resolveAPI(0, { data: [{ id: 'old-query', name: 'Antigo', template: 'comunicado', updatedAt: '2026-09-17' }], total: 1 });
  await oldQuery;
  assert.match(harness.savedList().innerHTML, /Novo/);
  assert.doesNotMatch(harness.savedList().innerHTML, /Antigo/);
});

test('AutoCard recovers an empty non-first history page at the last valid offset', async () => {
  const harness = await createAutoCardLifecycleHarness();
  const firstPage = harness.loadSaved();
  await harness.resolveAPI(0, { data: [{ id: 'first-card', name: 'Primeiro', template: 'comunicado', updatedAt: '2026-09-17' }], total: 21 });
  await firstPage;

  const stalePage = harness.loadSaved(40);
  assert.equal(harness.apiRequests[1].path, '/api/autocard/cards?search=&template=&limit=20&offset=40');
  await harness.resolveAPI(1, { data: [], total: 21 });
  assert.equal(harness.apiRequests.length, 3);
  assert.equal(harness.apiRequests[2].path, '/api/autocard/cards?search=&template=&limit=20&offset=20');
  assert.match(harness.savedList().innerHTML, /Primeiro/);

  await harness.resolveAPI(2, { data: [{ id: 'last-card', name: 'Último', template: 'comunicado', updatedAt: '2026-09-17' }], total: 21 });
  await stalePage;
  assert.match(harness.savedList().innerHTML, /Último/);
  assert.doesNotMatch(harness.savedList().innerHTML, /Primeiro/);
});

test('AutoCard rejects invalid manual names before saving and trims valid names', async () => {
  const harness = await createAutoCardLifecycleHarness();
  harness.selectTemplate('comunicado');

  harness.setPrompt('   ');
  await harness.saveCard();
  assert.equal(harness.apiRequests.length, 0);
  assert.match(harness.toast().textContent, /nome do card/);

  harness.setPrompt('x'.repeat(121));
  await harness.saveCard();
  assert.equal(harness.apiRequests.length, 0);

  harness.setPrompt('  Nome válido  ');
  const save = harness.saveCard();
  assert.equal(harness.apiRequests.length, 1);
  assert.equal(JSON.parse(harness.apiRequests[0].options.body).name, 'Nome válido');
  await harness.resolveAPI(0, { id: 'named-card' });
  await save;

  harness.setPrompt('a'.repeat(119));
  const save119 = harness.saveCard();
  assert.equal(harness.apiRequests.length, 2);
  assert.equal(JSON.parse(harness.apiRequests[1].options.body).name.length, 119);
  await harness.resolveAPI(1, { id: 'named-card-119' });
  await save119;

  harness.setPrompt('b'.repeat(120));
  const save120 = harness.saveCard();
  assert.equal(harness.apiRequests.length, 3);
  assert.equal(JSON.parse(harness.apiRequests[2].options.body).name.length, 120);
  await harness.resolveAPI(2, { id: 'named-card-120' });
  await save120;
});

test('AutoCard does not download an export after the document changes', async () => {
  const harness = await createAutoCardLifecycleHarness();
  harness.selectTemplate('comunicado');
  const exporting = harness.exportCard();
  harness.selectTemplate('vaga');
  await exporting;
  assert.equal(harness.captures.length, 0);
  assert.equal(harness.downloadClicks(), 0);
  assert.equal(harness.exportButtonDisabled(), false);
});

test('AutoCard protects dirty editor navigation and beforeunload', async () => {
  const harness = await createAutoCardLifecycleHarness();
  harness.selectTemplate('comunicado');
  harness.setField('titulo', 'Alterado');
  assert.equal(harness.confirmNavigation(false), false);
  assert.equal(harness.confirmNavigation(true), true);
  assert.equal(harness.beforeUnloadBlocked(), false);
});

test('AutoCard employee mobile layout bounds long names and preserves the footer', async () => {
  const styles = await readFile('public/autocard/styles.css', 'utf8');
  const harness = await createAutoCardLifecycleHarness();

  harness.selectTemplate('novo_funcionario');
  harness.setField('titulo', 'Nome de colaborador com uma identificacao muito longa');
  harness.setField('subtitulo', 'Cargo com unidade e descricao extensa');
  harness.setField('data', '01/09');
  harness.setField('corpo', 'Mensagem de boas-vindas com texto suficiente para ocupar o espaco flexivel.');
  harness.flushMutations();
  harness.setCardRect(320, 320);

  const bounds = employeeMobileLayoutBounds(harness, styles);
  assert.ok(bounds.bodyHeight > 0, `employee body budget must remain positive: ${bounds.bodyHeight}`);
  assert.match(harness.cardCanvas.innerHTML, /employee-copy/);
  assert.match(harness.cardCanvas.innerHTML, /Nome de colaborador com uma identificacao muito longa/);
  assert.match(harness.cardCanvas.innerHTML, /<p class="body">[\s\S]*<div class="card-footer"/);

  const brokenOverflow = styles.replace('overflow:hidden;font-size:12px;line-height:1.45', 'overflow:visible;font-size:12px;line-height:1.45');
  assert.throws(() => employeeMobileLayoutBounds(harness, brokenOverflow), /employee description must be the clipping boundary/);
  const brokenFlex = styles.replace('flex:1 1 60%;min-width:0;min-height:0;', 'flex:0 0 60%;min-width:0;min-height:0;');
  assert.throws(() => employeeMobileLayoutBounds(harness, brokenFlex), /employee copy must receive remaining height/);
  const brokenSpace = styles.replace('.employee-copy{padding:10px 14px 12px}', '.employee-copy{padding:80px 14px 80px}');
  assert.throws(() => employeeMobileLayoutBounds(harness, brokenSpace), /employee body budget must remain positive/);
});

test('AutoCard access follows the configured job title page', () => {
  assert.equal(canUseAutoCard(dho('Analista de DHO Sênior')), true);
  assert.equal(canUseAutoCard(dho('Gerente de DHO')), true);
  assert.equal(canUseAutoCard(dho('Analista Administrativo')), true);
  assert.equal(canUseAutoCard(dho('Analista de DHO Sênior', false)), false);
  assert.equal(canUseAutoCard({ role: 'viewer' }), false);
  assert.equal(canUseAutoCard({ role: 'admin', permissions: { manageUsers: true } }), false);
  assert.equal(canUseAutoCard({ role: 'admin', permissions: { superAdmin: true } }), true);
});

test('AutoCard API is protected and uses shared PostgreSQL storage', async () => {
  const [auth, route, migration, dhoMigration, cropMigration, schema, index, nginx, retention, provision, verifyMigrations] = await Promise.all([
    readFile('public/js/auth.js', 'utf8'),
    readFile('api/routes/autocard.js', 'utf8'),
    readFile('api/db/migrations/010_autocard.sql', 'utf8'),
    readFile('api/db/migrations/030_dho_job_title_catalog.sql', 'utf8'),
    readFile('api/db/migrations/012_autocard_media_crop.sql', 'utf8'),
    readFile('api/db/schema.sql', 'utf8'),
    readFile('api/index.js', 'utf8'),
    readFile('nginx/nginx.conf', 'utf8'),
    readFile('cron/autocard-media-retention.js', 'utf8'),
    readFile('api/db/provision.js', 'utf8'),
    readFile('api/db/verify-migrations.js', 'utf8'),
  ]);
  assert.match(auth, /export async function fetchAPIAsset\(/);
  assert.match(auth, /await response\.blob\(\)/);
  assert.match(auth, /URL\.createObjectURL\(blob\)/);
  assert.match(route, /router\.use\(authMiddleware, requireAutoCard\)/);
  assert.match(route, /router\.get\('\/media\/:id'/);
  assert.match(route, /autocard_cards/);
  assert.match(route, /autocard_media/);
  assert.match(route, /withAudit/);
  assert.match(route, /mediaCrop/);
  assert.match(route, /media_crop AS "mediaCrop"/);
  assert.match(route, /body\.mediaCrop/);
  assert.match(route, /media_crop = \$11::jsonb/);
  assert.match(route, /ORDER BY updated_at DESC, id DESC/);
  assert.match(route, /let normalized;[\s\S]*try \{[\s\S]*normalizeImage\(content\)[\s\S]*\} catch \{[\s\S]*return invalid\(req, res\);/);
  assert.match(route, /SELECT LEFT\(COALESCE\(NULLIF\(BTRIM\(name\), ''\), 'Card'\), 117\) \|\| ' v2',[\s\S]*media_crop/);
  assert.match(route, /LEFT\(COALESCE\(NULLIF\(BTRIM\(name\), ''\), 'Card'\), 117\) \|\| ' v2'/);
  assert.equal(('x'.repeat(119).slice(0, 117) + ' v2').length, 120);
  assert.equal(('x'.repeat(120).slice(0, 117) + ' v2').length, 120);
  assert.equal(('Card'.slice(0, 116) + ' v2').length, 7);
  assert.match(route, /CASE WHEN icon = ANY\(\$3::text\[\]\) THEN icon ELSE NULL END/);
  assert.match(route, /CASE WHEN illustration = ANY\(\$4::text\[\]\) THEN illustration ELSE NULL END/);
  assert.match(route, /\[req\.params\.id, req\.user\.uid, \[\.\.\.icons\], \[\.\.\.illustrations\]\]/);
  assert.equal((route.match(/SELECT pg_advisory_xact_lock\(7193003\)/g) || []).length, 5);
  assert.match(route, /async function removeMediaIfUnused[\s\S]*BEGIN[\s\S]*pg_advisory_xact_lock\(7193003\)[\s\S]*NOT EXISTS[\s\S]*DELETE FROM autocard_media[\s\S]*COMMIT/);
  assert.match(retention, /pg_try_advisory_lock/);
  assert.doesNotMatch(retention, /LOCK TABLE autocard_cards IN SHARE MODE/);
  assert.match(provision, /GRANT SELECT ON autocard_cards TO portal_cron/);
  assert.match(provision, /GRANT SELECT, DELETE ON autocard_media TO portal_cron/);
  assert.match(provision, /GRANT SELECT, INSERT, UPDATE, DELETE ON audit_log TO portal_cron/);
  assert.match(verifyMigrations, /has_table_privilege\('portal_cron', 'public\.autocard_cards', 'SELECT'\)/);
  assert.match(verifyMigrations, /has_table_privilege\('portal_cron', 'public\.autocard_media', 'SELECT'\)[\s\S]*has_table_privilege\('portal_cron', 'public\.autocard_media', 'DELETE'\)/);
  assert.match(verifyMigrations, /has_table_privilege\('portal_cron', 'public\.audit_log', 'SELECT'\)[\s\S]*has_table_privilege\('portal_cron', 'public\.audit_log', 'DELETE'\)/);
    assert.match(dhoMigration, /migrated_name := btrim\(item\.name\)/);
    assert.match(dhoMigration, /regexp_replace\([\s\S]*E'\\\\1DHO\\\\2'[\s\S]*'i'/);
   assert.match(dhoMigration, /btrim\(name\) ~\* '\(\^\|\[\^\[:alnum:\]_\]\)RH\(\[\^\[:alnum:\]_\]\|\$\)'/);
   assert.match(dhoMigration, /DHO job title migration aborted before mutation:/);
   assert.ok(dhoMigration.indexOf('before mutation') < dhoMigration.indexOf('DROP INDEX IF EXISTS job_titles_name_lower_unique'));
   assert.match(dhoMigration, /page_access/);
   assert.match(dhoMigration, /UPDATE users SET job_title_id = target_id/);
   assert.match(dhoMigration, /DROP INDEX IF EXISTS job_titles_name_lower_unique/);
   assert.match(dhoMigration, /CREATE UNIQUE INDEX IF NOT EXISTS job_titles_name_lower_unique/);
   assert.match(dhoMigration, /Analista de DHO Sênior/);
   assert.match(dhoMigration, /Gerente de DHO/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS autocard_cards/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS autocard_media/);
  assert.match(cropMigration, /ADD COLUMN IF NOT EXISTS media_crop/);
  assert.match(cropMigration, /SET media_crop = '\{"x":0\.5,"y":0\.5,"zoom":1\}'::jsonb/);
  assert.match(cropMigration, /ALTER COLUMN media_crop SET DEFAULT/);
  assert.match(cropMigration, /ALTER COLUMN media_crop SET NOT NULL/);
  assert.match(cropMigration, /autocard_cards_media_crop_check/);
  assert.match(schema, /media_crop\s+JSONB/);
  assert.match(schema, /autocard_cards_media_crop_check/);
  assert.match(schema, /010_autocard/);
  assert.match(index, /app\.use\('\/api\/autocard', autocardRoutes\)/);
  assert.match(nginx, /location = \/api\/autocard\/media[\s\S]*client_max_body_size 3m;[\s\S]*proxy_request_buffering off;[\s\S]*limit_req zone=uploads/);
  assert.match(nginx, /location \^~ \/api\/autocard\/media\/[\s\S]*limit_req zone=media_reads/);
});

test('AutoCard UI is guarded before loading the editor', async () => {
  const [entry, guard, html, legacy, dashboard, sidebar, crop, styles] = await Promise.all([
    readFile('public/autocard/entry.js', 'utf8'),
    readFile('public/autocard/guard.js', 'utf8'),
    readFile('public/autocard.html', 'utf8'),
    readFile('public/autocard/index.html', 'utf8'),
    readFile('public/dashboard.html', 'utf8'),
    readFile('public/js/sidebar.js', 'utf8'),
    readFile('public/autocard/crop.js', 'utf8'),
    readFile('public/autocard/styles.css', 'utf8'),
  ]);
  assert.match(entry, /await requireAutoCard\(\)/);
  assert.match(entry, /import\('\.\/app\.js'\)/);
  assert.match(guard, /user\.autocard_access === true/);
  assert.doesNotMatch(guard, /fetchAPI\(|\/api\/autocard\/access/);
   assert.match(guard, /Acesso restrito/);
   assert.match(guard, /cargos ativos do DHO autorizados/);
  assert.match(html, /class="portal-wrapper"/);
  assert.match(html, /class="sidebar"/);
  assert.match(html, /class="topbar"/);
  assert.match(html, /class="page-body"[^>]+id="main-content"/);
  assert.match(html, /href="\.\/autocard\.html" class="active"/);
  assert.match(html, /src="\.\/autocard\/entry\.js"/);
  for (const path of [
    /<script src="\.\/js\/auth-shell\.js"><\/script>/,
    /<link rel="stylesheet" href="\.\/css\/tokens\.css">/,
    /<link rel="stylesheet" href="\.\/autocard\/styles\.css">/,
    /<link rel="stylesheet" href="\.\/css\/layout\.css">/,
    /<link rel="stylesheet" href="\.\/css\/components\.css">/,
    /<img src="\.\/assets\/logo-branco\.svg"/,
    /<img src="\.\/assets\/icon-branco\.svg"/,
    /<script src="\.\/js\/sidebar\.js"><\/script>/,
    /<script type="module" src="\.\/autocard\/entry\.js"><\/script>/,
  ]) assert.match(html, path);
  assert.match(html, /class="sidebar-toggle" id="sidebar-toggle"/);
  assert.match(html, /class="sidebar-logout"/);
  assert.match(sidebar, /mobileToggle\.className = 'mobile-menu-toggle'/);
  assert.match(sidebar, /querySelectorAll\('\.sidebar-logout'\)/);
  assert.match(sidebar, /import\('\.\/auth\.js'\)/);
  assert.match(html, /id="templateGallery"/);
  assert.match(html, /<button id="imageButton"[^>]*type="button"/);
  assert.match(html, /<input id="imageInput"[^>]*type="file"[^>]*hidden/);
  assert.match(html, /id="mediaStatus"[^>]*role="status"[^>]*aria-live="polite"[^>]*data-state="idle"/);
  assert.doesNotMatch(html, /Formato de exportação: 1080 × 1080 px/);
  const portalTopbar = html.match(/<header class="topbar">[\s\S]*?<\/header>/)?.[0] || '';
  assert.doesNotMatch(portalTopbar, /AutoCard DHO/);
  assert.match(html, /<span class="eyebrow">AutoCard<\/span>/);
  assert.doesNotMatch(html, /AutoCard DHO/);
  assert.match(legacy, /url=\.\.\/autocard\.html/);
  assert.match(legacy, /href="\.\.\/autocard\.html"/);
  assert.doesNotMatch(legacy, /<script\b/);
  assert.match(guard, /getElementById\('main-content'\)/);
  assert.match(guard, /main\.replaceChildren\(message\)/);
  assert.match(guard, /href: '\.\/dashboard\.html'/);
  const [app, vacancy, variant] = await Promise.all([
    readFile('public/autocard/app.js', 'utf8'),
    readFile('public/autocard/vacancy-enhancements.js', 'utf8'),
    readFile('public/autocard/variant-enhancements.js', 'utf8'),
  ]);
  assert.match(app, /\/api\/autocard\/cards/);
   assert.match(app, /import \{ fetchAPI, fetchAPIAsset, fetchAPIPage \} from '\.\.\/js\/auth\.js'/);
   assert.match(app, /import \{ renderPagination, setPaginationBusy \} from '\.\.\/js\/pagination\.js'/);
   assert.match(html, /id="savedPagination"/);
   assert.match(app, /fetchAPIPage/);
   assert.match(app, /limit=20/);
   assert.match(app, /renderPagination/);
  assert.match(app, /fetchAPIAsset\(`/);
  assert.match(app, /mediaUrl: null/);
  assert.match(app, /mediaStatus:'idle'/);
  assert.match(app, /let documentGeneration = 0;/);
  assert.match(app, /let editRevision = 0;/);
  assert.match(app, /let savedSnapshot = null;/);
  assert.match(app, /Há alterações do AutoCard que ainda não foram salvas\. Sair mesmo assim\?/);
  assert.match(app, /setAttribute\('aria-live','polite'\)/);
  assert.match(app, /setAttribute\('data-state',status\)/);
  assert.match(app, /mediaCrop:\s*\{\.\.\.DEFAULT_MEDIA_CROP\}/);
  assert.match(app, /mediaCrop:normalizeMediaCrop\(card\?\.mediaCrop\)/);
  assert.match(app, /function loadMedia\(mediaId,version,openCrop=false\)/);
  assert.match(app, /cropButton'\)\?\.classList\.remove\('hidden'\)/);
  assert.match(app, /if\(openCrop\)openCropEditor\(\)/);
  assert.match(app, /style="\$\{cropStyle\(current\.mediaCrop\)\}"/);
  assert.match(app, /cropRenderStyle/);
  assert.match(app, /card-media-frame/);
  assert.match(app, /employee-photo img/);
  assert.match(app, /window\.__autocardApplyMediaCropStyle=applyMediaCropStyle/);
  assert.match(app, /function onCropPointerDown\(event\)\{const \{frameWidth,frameHeight,imageWidth,imageHeight\}=cropMetrics\(\)/);
  assert.match(app, /mediaCrop:current\.mediaCrop/);
  assert.match(app, /image\.onload=\(\)=>\{cleanup\(\)/);
  assert.match(app, /image\.onerror=\(\)=>\{cleanup\(\)/);
  assert.match(app, /await img\.decode\(\)/);
  assert.match(app, /document\.fonts\?\.ready/);
  assert.match(app, /getBoundingClientRect\(\)/);
  assert.match(app, /const\s+height\s*=\s*rect\.height/);
  assert.match(app, /const\s+scale\s*=\s*1080\s*\/\s*width/);
  assert.match(app, /height,\s*backgroundColor:\s*null/);
  assert.doesNotMatch(app, /height\s*:\s*size/);
  assert.match(app, /button\.disabled=true/);
  assert.match(app, /button\.disabled=false/);
  assert.match(app, /Não foi possível exportar o card/);
  assert.match(app, /duplicate[\s\S]*catch\(\(\)=>toast\('Não foi possível duplicar o card\.'/);
  assert.match(app, /method:'DELETE'[\s\S]*catch\(\(\)=>toast\('Não foi possível excluir o card\.'/);
  assert.match(app, /URL\.revokeObjectURL/);
  assert.match(app, /startsWith\('blob:'\)/);
  assert.match(app, /addEventListener\('pagehide'/);
  assert.match(app, /addEventListener\('pageshow'/);
  assert.match(app, /current\.mediaUrl\s*\?/);
  assert.match(app, /birthday-photo">\$\{current\.mediaUrl\?/);
  assert.match(app, /birthday-photo[\s\S]*cropStyle\(current\.mediaCrop\)/);
  assert.match(crop, /transform:translate\(\$\{layout\.translateX\}px/);
  assert.doesNotMatch(app, /current\.mediaId\?`<img src="\$\{current\.mediaUrl\}/);
  assert.doesNotMatch(app, /current\.mediaUrl=data\.url/);
  assert.match(vacancy, /const photoElement = cardCanvas\.querySelector\('\.card-media'\)/);
  assert.match(vacancy, /const photoStyle = photoElement\?\.getAttribute\('style'\) \|\| ''/);
  assert.match(vacancy, /style="\$\{photoStyle\}"/);
  assert.match(vacancy, /__autocardApplyMediaCropStyle/);
  assert.doesNotMatch(vacancy, /\/api\/autocard\/media|mediaId|mediaUrl/);
  assert.match(vacancy, /employee-layout/);
  assert.match(vacancy, /employee-copy/);
  assert.match(vacancy, /Bem-vindo\(a\)/);
  assert.match(styles, /\.employee-card/);
  assert.match(styles, /\.employee-layout[^}]*flex-direction:\s*column/);
  assert.match(styles, /\.employee-copy[^}]*min-width:\s*0/);
  assert.match(styles, /overflow-wrap:\s*anywhere/);
  assert.match(styles, /\.card-footer img\{width:102px;height:auto;max-height:none;object-fit:contain/);
  assert.match(styles, /\.vacancy-card \.card-footer img\{height:auto;max-height:36px\}/);
  assert.doesNotMatch(styles, /\.card-footer img\{[^}]*height:50px/);
  assert.match(app, /ownerinc-wordmark-(?:black|white)\.webp/);
  assert.match(vacancy, /<span>Bem-vindo\(a\)<\/span>/);
  assert.match(variant, /ownerinc-wordmark-black\.webp/);
  assert.match(variant, /ownerinc-wordmark-white\.webp/);
  assert.match(app, /\/api\/autocard\/media/);
  assert.match(app, /file\.size>3\*1024\*1024/);
  assert.match(dashboard, /class="autocard-link"/);
});

test('AutoCard crop editor exposes accessible dialog and responsive frame contracts', async () => {
  const [html, styles] = await Promise.all([
    readFile('public/autocard.html', 'utf8'),
    readFile('public/autocard/styles.css', 'utf8'),
  ]);

  assert.match(html, /id="cropButton"/);
  assert.match(html, /id="cropDialog"/);
  assert.match(html, /id="cropFrame"/);
  assert.match(html, /id="cropImage"/);
  assert.match(html, /id="cropZoom"/);
  assert.match(html, /id="cropReset"/);
  assert.match(html, /id="cropCancel"/);
  assert.match(html, /id="cropApply"/);
  assert.match(html, /Ajustar enquadramento/);
  assert.match(html, /Aplicar enquadramento/);
  assert.match(html, /aria-labelledby="cropTitle"/);
  assert.match(html, /tabindex="0" role="img"/);
  assert.match(styles, /crop-frame/);
  assert.match(styles, /touch-action:none/);
  assert.match(styles, /prefers-reduced-motion/);
});
