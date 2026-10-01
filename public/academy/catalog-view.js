import { element } from '../js/ui.js';
import { brand, button, courseCard, errorState, hydrateBrandAssets } from './view-utils.js';
import { mountAcademyMotion } from './motion.js';

export function catalogView({ root, page, focusPage = page, api, navigate, entryMotion = true }) {
  let disposed = false, continuingLoading = false, categoriesLoading = false, brandAssets = page.brandAssets;
  const pendingFocus = focusPage.academyCatalogFocus;
  const query = new URL(page.location.href).searchParams;
  root.replaceChildren(brand(brandAssets));
  const motionDisposers = [];
  const continuing = element('section', { className: 'academy-section' }, [element('h2', { text: 'Continuar aprendendo' })]);
  const continued = element('div', { 'aria-busy': 'true' }, [element('p', { role: 'status', text: 'Carregando cursos em andamento…' })]);
  continuing.append(continued); root.append(continuing);
  const live = () => !disposed && page.active;
  async function loadContinue() {
    if (!live() || continuingLoading) return;
    continuingLoading = true;
    continued.setAttribute('aria-busy', 'true');
    try {
      const courses = await api.continueCourses();
      if (!live()) return;
      continued.replaceChildren(); continued.className = 'academy-grid';
      courses.forEach(course => continued.append(courseCard(course, page, navigate, brandAssets)));
      if (!motionDisposers.length && typeof mountAcademyMotion === 'function') motionDisposers.push(mountAcademyMotion(continued, { signal: page.signal, reducedMotion: !entryMotion }));
      if (!courses.length) continued.append(element('p', { text: 'Escolha um curso abaixo para começar.' }));
    } catch (error) { if (live()) errorState(continued, error, loadContinue); }
    finally { continuingLoading = false; if (live()) continued.setAttribute('aria-busy', 'false'); }
  }
  loadContinue();
  const filters = [];
  for (const [group, title] of [['initial', 'Comece por aqui'], ['role', 'Formação para seu cargo']]) {
    const legacy = query.get('group') === group;
    const category = query.get(`${group}_category`) ?? (legacy ? query.get('category') : '') ?? '';
    const raw = Number(query.get(`${group}_offset`) ?? (legacy ? query.get('offset') : 0));
    const offset = Number.isSafeInteger(raw) && raw > 0 ? Math.floor(raw / 20) * 20 : 0;
    const section = element('section', { className: 'academy-section', 'data-group': group });
    const select = element('select', { id: `academy-filter-${group}`, disabled: true }, [element('option', { value: '', text: 'Todas as categorias' })]);
    const label = element('label', { for: `academy-filter-${group}`, text: `Categoria · ${title}` });
    const cards = element('div', { className: 'academy-grid', 'aria-busy': 'true' }, [element('p', { role: 'status', text: 'Carregando cursos…' })]);
    const pagination = element('nav', { className: 'academy-pagination', 'aria-label': `Páginas · ${title}` });
    section.append(element('h2', { text: title }), label, select, cards, pagination); root.append(section);
    const change = (value, nextOffset, initiatingControl = document.activeElement) => {
      if (!live() || cards.getAttribute('aria-busy') === 'true') return;
      if (initiatingControl === select || initiatingControl?.parentNode === pagination) {
        focusPage.academyCatalogFocus = { group, source: initiatingControl, kind: initiatingControl === select ? 'select' : 'pagination', text: initiatingControl.textContent };
      }
      const next = new URLSearchParams(query);
      next.set(`${group}_category`, value); next.set(`${group}_offset`, String(nextOffset));
      // Canonical per-group keys preserve the other group's independent position.
      if (legacy) { next.delete('group'); next.delete('category'); next.delete('offset'); }
      navigate(Object.fromEntries(next));
    };
    select.addEventListener('change', () => change(select.value, 0, select));
    filters.push({ select, category });
    let loading = false;
    async function load() {
      if (!live() || loading) return;
      loading = true;
      cards.setAttribute('aria-busy', 'true'); select.disabled = true;
      pagination.replaceChildren();
      try {
        const result = await api.list({ group, category, offset: String(offset) });
        if (!live()) return;
        const focusBeforeRender = document.activeElement;
        const restoreFilterFocus = cards.contains(focusBeforeRender);
        cards.replaceChildren();
        const courses = result.data.filter(course => course.active !== false);
        courses.forEach(course => cards.append(courseCard(course, page, navigate, brandAssets)));
        if (!cards.dataset.motionMounted) { cards.dataset.motionMounted = 'true'; if (typeof mountAcademyMotion === 'function') motionDisposers.push(mountAcademyMotion(cards, { signal: page.signal, reducedMotion: !entryMotion })); }
        if (!courses.length) {
          cards.append(element('p', { text: 'Nenhum curso disponível nesta seleção.' }));
          if (offset || category) cards.append(button('Ver todos os cursos deste grupo', () => change('', 0)));
        }
        if (offset > 0) pagination.append(button('Anterior', () => change(category, Math.max(0, offset - 20), document.activeElement)));
        if (offset + 20 < result.total) pagination.append(button('Próxima', () => change(category, offset + 20, document.activeElement)));
        const active = document.activeElement;
        const focusWasNotMoved = pendingFocus?.group === group
          && (active === pendingFocus.source || active === document.body || !active);
        if (focusWasNotMoved) {
          const target = pendingFocus.kind === 'select'
            ? select
            : [...pagination.querySelectorAll('button')].find(control => control.textContent === pendingFocus.text);
          (target || root.querySelector('h1'))?.focus();
        }
        if (pendingFocus?.group === group) delete focusPage.academyCatalogFocus;
        if (restoreFilterFocus && (document.activeElement === focusBeforeRender || document.activeElement === document.body)) select.focus();
      } catch (error) { if (live()) errorState(cards, error, load); }
      finally { loading = false; if (live()) { cards.setAttribute('aria-busy', 'false'); select.disabled = false; } }
    }
    load();
  }
  const categoryStatus = element('div'); root.append(categoryStatus);
  async function loadCategories() {
    if (!live() || categoriesLoading) return;
    categoriesLoading = true;
    try {
      const values = await api.categories();
      if (!live()) return;
      const categories = [...new Set(values.filter(value => typeof value === 'string').map(value => value.trim()).filter(Boolean))];
      filters.forEach(({ select, category }) => {
        select.replaceChildren(element('option', { value: '', text: 'Todas as categorias' }));
        [...new Set([...categories, ...(category ? [category] : [])])].forEach(value => select.append(element('option', { value, text: /^(all|todos)$/i.test(value) ? `${value} (categoria)` : value })));
        select.value = category;
      });
      categoryStatus.replaceChildren();
    } catch (error) { if (live()) errorState(categoryStatus, error, loadCategories); }
    finally { categoriesLoading = false; }
  }
  loadCategories();
  return {
    setBrandAssets(assets) { if (!live()) return; brandAssets = assets; hydrateBrandAssets(root, assets); },
    dispose() { disposed = true; motionDisposers.forEach(dispose => dispose()); },
  };
}
