import { element, safeHttpUrl } from '../js/ui.js';
import { fetchAPIAsset } from '../js/auth.js';
import { createBrandIcon } from './brand.js';

export const unavailable = 'Este conteúdo não está disponível para seu perfil.';
export const heading = text => element('h1', { text, tabindex: '-1', id: 'academy-title' });
export const button = (text, click) => element('button', { type: 'button', text, className: 'academy-button', on: { click } });
export function routeLink(text, params, navigate, options = {}) {
  return element('a', { text, href: `./academy.html${String(new URLSearchParams(params)) ? `?${new URLSearchParams(params)}` : ''}`, ...options,
    on: { click(event) {
      if (event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); event.stopPropagation(); navigate(params);
    } },
  });
}
export function brand(assets = null) {
  const mark = assets ? createBrandIcon(assets, 'logo-dark', { decorative: false, label: 'Ownerinc Academy' }) : element('img', { src: './assets/academy/logo-dark.svg', alt: '', width: '240', height: '80' });
  mark.className = 'academy-logo';
  return element('header', { className: 'academy-brand' }, [
    mark,
    element('div', {}, [heading('Ownerinc Academy'), element('p', { text: 'Conhecimento que faz parte do seu dia.' })]),
  ]);
}
export function errorState(root, error, retry) {
  const focus = root.contains(document.activeElement) || document.activeElement === document.body || document.activeElement?.isConnected === false;
  root.replaceChildren(element('p', { role: 'status', text: [401, 403, 404].includes(error.status) ? unavailable : 'Não foi possível carregar o conteúdo. Verifique sua conexão.' }));
  if (![401, 403, 404].includes(error.status)) {
    const action = button('Tentar novamente', retry);
    root.append(action);
    if (focus) action.focus();
  }
}
export function cover(course, page, assets = null) {
  const key = /^icon-0[1-6]$/.test(course.icon_key) ? course.icon_key : 'symbol';
  const image = assets ? createBrandIcon(assets, key) : element('img', { className: 'academy-cover', src: `./assets/academy/${key}.svg`, alt: '', width: '640', height: '360', loading: 'lazy' });
  image.className = 'academy-cover';
  if (course.cover_asset_id) {
    const { fetchAPIAsset: asset } = page.bindAPI({ fetchAPIAsset });
    asset(`/api/cms/assets/${encodeURIComponent(course.cover_asset_id)}`).then(url => {
      if (page.active) { image.src = url; image.classList.add('academy-cover-photo'); }
    }).catch(() => {});
  }
  return image;
}
export function courseCard(course, page, navigate, assets = null) {
  return element('article', { className: 'academy-course-card', 'data-motion-part': '' }, [cover(course, page, assets),
    element('h3', {}, [routeLink(course.title, { course: course.id }, navigate)]),
    element('p', { text: course.category || 'Formação' }),
    element('p', { text: course.delivery_mode === 'external' ? 'Curso externo' : `${course.completed_lessons || 0} de ${course.total_lessons || 0} aulas concluídas` }),
  ]);
}
export function curriculum(courseView, navigate, current, preview = false) {
  const nav = element('nav', { className: 'academy-curriculum', 'aria-label': 'Aulas do curso' });
  courseView.modules.forEach(module => {
    const list = element('ol');
    module.lessons.forEach(lesson => list.append(element('li', {}, [routeLink(
      `${lesson.title}${lesson.completed ? ' · Concluída' : ''}`,
      { course: courseView.course.id, lesson: lesson.id, ...(preview ? { preview: '1' } : {}) }, navigate,
      { ...(lesson.id === current ? { 'aria-current': 'page' } : {}), 'data-lesson': lesson.id },
    )])));
    nav.append(element('h3', { text: module.title }), list);
  });
  return nav;
}
export function externalLink(course) {
  const href = safeHttpUrl(course.url);
  return href ? element('a', { className: 'academy-button', text: 'Acessar curso externo ↗', href, target: '_blank', rel: 'noopener noreferrer' })
    : element('p', { text: 'Link externo indisponível.' });
}
