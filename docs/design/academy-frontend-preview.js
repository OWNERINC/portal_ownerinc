import { mountAcademy } from '../../public/academy/app.js';
import { createPageLifecycle } from '../../public/js/page-lifecycle.js';

// Documentation only: the actual page markup and actual frontend modules with
// explicitly substituted auth/HTTP/media. No backend or Firebase is contacted.
const html = await (await fetch('/public/academy.html')).text();
const doc = new DOMParser().parseFromString(html, 'text/html');
doc.querySelectorAll('script').forEach(script => script.remove());
document.body.replaceChildren(...doc.body.childNodes);
document.documentElement.dataset.authState = 'authenticated';
document.getElementById('main-content').removeAttribute('data-route-pending');
const notice = document.createElement('p');
notice.textContent = 'Prévia estática · dados e player de teste · sem API, autenticação ou persistência real.';
notice.style.cssText = 'margin:0;padding:12px 24px;background:#97C21E;color:#141414;font:14px Helvetica,Arial,sans-serif';
document.querySelector('.main-content').prepend(notice);
const page = createPageLifecycle({ user: { uid: 'preview-fixture' }, history: {
  pushState(state, title, url) { window.history.pushState(state, title, `/docs/design/academy-frontend-preview.html${new URL(url).search}`); },
} });
Object.defineProperty(page, 'location', { get: () => new URL(`/public/academy.html${window.location.search}`, window.location.origin) });
mountAcademy(page);
// Shell script uses production markup and provides the real mobile disclosure.
const script = document.createElement('script'); script.src = '/public/js/sidebar.js'; document.body.append(script);
