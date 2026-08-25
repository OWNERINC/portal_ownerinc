import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../public/', import.meta.url);
const pages = [
  ['dashboard', 'Dashboard', 'home'],
  ['knowledge', 'Base de Conhecimento', 'book-open'],
  ['reminders', 'Lembretes', 'bell'],
  ['academy', 'Academy', 'graduation-cap'],
  ['benefits', 'Benefícios', 'gift'],
  ['announcements', 'Anúncios', 'megaphone'],
  ['profile', 'Meu Perfil', 'user'],
];

const generatedPages = [
  ['dashboard.html', 'dashboard', 'Dashboard'],
  ['knowledge.html', 'knowledge', 'Base de Conhecimento'],
  ['reminders.html', 'reminders', 'Lembretes'],
  ['academy.html', 'academy', 'Academy'],
  ['benefits.html', 'benefits', 'Benefícios'],
  ['announcements.html', 'announcements', 'Anúncios'],
  ['profile.html', 'profile', 'Meu Perfil'],
  ['admin.html', 'admin', 'Painel Admin'],
  ['cms.html', 'cms', 'Editor CMS'],
  ['autocard.html', 'autocard', 'AutoCard'],
  ['cards-pos.html', 'cards-pos', 'Cards Pós'],
  ['solides.html', 'solides', 'Sólides'],
];

const iconPaths = {
  'badge-check': '<path d="M3.85 8.62a4 4 0 0 1 4.77-4.77 4 4 0 0 1 6.76 0 4 4 0 0 1 4.77 4.77 4 4 0 0 1 0 6.76 4 4 0 0 1-4.77 4.77 4 4 0 0 1-6.76 0 4 4 0 0 1-4.77-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  'book-open': '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2Z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7Z"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3Z"/><circle cx="12" cy="13" r="3"/>',
  'chevrons-left': '<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>',
  eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7C3.38 8.55 7.22 5 12 5s8.62 3.55 9.94 6.65a1 1 0 0 1 0 .7C20.62 15.45 16.78 19 12 19s-8.62-3.55-9.94-6.65Z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="m3 3 18 18"/><path d="M10.58 10.58a2 2 0 0 0 2.83 2.83"/><path d="M9.88 4.24A9.7 9.7 0 0 1 12 4c4.78 0 8.62 3.55 9.94 6.65a1 1 0 0 1 0 .7 14.7 14.7 0 0 1-3.17 4.36M6.61 6.61A14.7 14.7 0 0 0 2.06 11.3a1 1 0 0 0 0 .7C3.38 15.45 7.22 19 12 19c1.04 0 2.05-.18 2.99-.5"/>',
  'file-edit': '<path d="M4 13.5V20h6.5L19 11.5 12.5 5Z"/><path d="m15 6 3 3"/><path d="M14 4h6v6"/>',
  gift: '<rect width="18" height="5" x="3" y="8" rx="1"/><path d="M12 8v13M3 13h18M12 8H7.5a2.5 2.5 0 1 1 2.5-2.5V8Zm0 0h4.5a2.5 2.5 0 1 0-2.5-2.5V8Z"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9 22V12h6v10"/>',
  'layout-template': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M9 21V9"/>',
  'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  megaphone: '<path d="m3 11 18-5v12L3 13v-2Z"/><path d="M11.6 16.8 13 21H9l-1.5-5"/>',
  'settings-2': '<path d="M20 7h-9M14 17H5M17 17a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  user: '<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/>',
  'graduation-cap': '<path d="m2 10 10-5 10 5-10 5Z"/><path d="M6 12v5c3 2 9 2 12 0v-5M22 10v6"/>',
};

function iconSprite() {
  const symbols = Object.entries(iconPaths).map(([name, body]) => `<symbol id="${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">${body}</symbol>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden"><defs>${symbols}</defs></svg>\n`;
}

function replaceIcons(source) {
  return source.replace(/<i\s+data-lucide="([^"]+)"[^>]*><\/i>/g, (_, name) => {
    if (!iconPaths[name]) throw new Error(`Missing local icon definition: ${name}`);
    return `<svg class="icon" aria-hidden="true"><use href="./assets/icons.svg#${name}"></use></svg>`;
  });
}

function removeLucideScript(source) {
  return source.replace(/\s*<script defer src="https:\/\/unpkg\.com\/lucide@0\.441\.0\/dist\/umd\/lucide\.min\.js"[^>]*><\/script>/g, '');
}

function activeClass(active) {
  return active ? ' class="active" aria-current="page"' : '';
}

function navItem(href, label, icon, className = '', active = false, id = '') {
  const classes = className ? ` class="${className}"` : '';
  const elementId = id ? ` id="${id}"` : '';
  return `      <li${elementId}${classes}><a href="./${href}"${activeClass(active)} title="${label}"><i data-lucide="${icon}"></i><span>${label}</span></a></li>`;
}

function sidebar(current) {
  const items = pages.map(([page, label, icon]) => navItem(`${page}.html`, label, icon, '', current === page)).join('\n');
  return `<!-- generated:portal-sidebar -->
    <ul class="sidebar-nav">
${items}
${navItem('admin.html', 'Admin', 'settings-2', 'admin-link', current === 'admin', 'admin-link')}
${navItem('cms.html', 'Editor CMS', 'file-edit', 'cms-link', current === 'cms')}
${navItem('autocard.html', 'AutoCard', 'layout-template', 'autocard-link', current === 'autocard')}
${navItem('cards-pos.html', 'Cards Pós', 'badge-check', 'pos-cards-link', current === 'cards-pos')}
    </ul>
    <!-- /generated:portal-sidebar -->`;
}

function topbar(current, title) {
  const actions = {
    admin: '<a href="./cms.html" class="cms-entry-link btn btn-ghost btn-sm">Abrir Editor CMS</a>',
    cms: '<span id="save-state" class="cms-save-state" role="status" aria-live="polite">Carregando…</span>',
    knowledge: '<label class="search-bar" for="search"><svg class="icon" aria-hidden="true"><use href="./assets/icons.svg#search"></use></svg><input type="search" id="search" name="search" autocomplete="off" placeholder="Buscar artigos." aria-label="Buscar artigos"></label><button id="btn-new" class="btn btn-primary" type="button" style="display:none">Novo artigo</button>',
    reminders: '<button id="btn-new-reminder" class="btn btn-primary" type="button" style="display:none">Novo lembrete</button>',
  }[current];
  const action = actions ? `<div class="topbar-actions">${actions}</div>` : '';
  return `<!-- generated:portal-topbar -->
    <header class="topbar"><span class="topbar-title">${title}</span>${action}</header>
    <!-- /generated:portal-topbar -->`;
}

async function generate(checkOnly = false) {
  const mismatches = [];
  for (const [filename, current, title] of generatedPages) {
    const file = new URL(filename, root);
    const source = await readFile(file, 'utf8');
    const sidebarPattern = /(?:<!-- generated:portal-sidebar -->\s*)?<ul class="sidebar-nav">[\s\S]*?<\/ul>(?:\s*<!-- \/generated:portal-sidebar -->)?/;
    const topbarPattern = /(?:<!-- generated:portal-topbar -->\s*)?<header class="topbar">[\s\S]*?<\/header>(?:\s*<!-- \/generated:portal-topbar -->)?/;
    if (!sidebarPattern.test(source) || !topbarPattern.test(source)) throw new Error(`${filename}: shell markers not found`);
    const generated = replaceIcons(source.replace(sidebarPattern, sidebar(current)).replace(topbarPattern, topbar(current, title)));
    const next = current === 'autocard' ? generated : removeLucideScript(generated);
    if (checkOnly) {
      if (next !== source) mismatches.push(filename);
    } else if (next !== source) {
      await writeFile(file, next);
    }
  }
  const loginFile = new URL('login.html', root);
  const loginSource = await readFile(loginFile, 'utf8');
  const loginNext = removeLucideScript(replaceIcons(loginSource));
  if (checkOnly && loginNext !== loginSource) mismatches.push('login.html');
  if (!checkOnly && loginNext !== loginSource) await writeFile(loginFile, loginNext);
  const spriteFile = new URL('assets/icons.svg', root);
  const sprite = iconSprite();
  const currentSprite = await readFile(spriteFile, 'utf8').catch(() => '');
  if (checkOnly && currentSprite !== sprite) mismatches.push('assets/icons.svg');
  if (!checkOnly && currentSprite !== sprite) await writeFile(spriteFile, sprite);
  if (checkOnly && mismatches.length) throw new Error(`Generated shell is stale: ${mismatches.join(', ')}`);
}

await generate(process.argv.includes('--check'));
