(function () {
  var KEY = 'ownerinc-sidebar-collapsed';

  function applyCollapsed(collapsed) {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    localStorage.setItem(KEY, collapsed ? '1' : '');
    var toggle = document.getElementById('sidebar-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', String(!collapsed));
  }

  // Restaurar estado salvo antes de qualquer render
  applyCollapsed(!!localStorage.getItem(KEY));
  document.body.classList.add('sidebar-ready');

  // Botão de toggle
  var toggle = document.getElementById('sidebar-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      applyCollapsed(!document.body.classList.contains('sidebar-collapsed'));
    });
  }

  var sidebar = document.querySelector('.sidebar');
  var topbar = document.querySelector('.topbar');
  if (sidebar && topbar) {
    var mainContent = document.querySelector('.main-content');
    var mobileMedia = window.matchMedia('(max-width: 768px)');
    sidebar.id = 'portal-navigation';
    if (toggle) toggle.setAttribute('aria-controls', sidebar.id);
    var mobileToggle = document.createElement('button');
    mobileToggle.className = 'mobile-menu-toggle';
    mobileToggle.type = 'button';
    mobileToggle.setAttribute('aria-label', 'Abrir menu');
    mobileToggle.setAttribute('aria-controls', sidebar.id);
    mobileToggle.setAttribute('aria-expanded', 'false');
    mobileToggle.textContent = 'Menu';
    var overlay = document.createElement('button');
    overlay.className = 'sidebar-overlay';
    overlay.type = 'button';
    overlay.setAttribute('aria-label', 'Fechar menu');
    function setDrawer(open, restoreFocus) {
      document.body.classList.remove('sidebar-open');
      document.body.classList.toggle('sidebar-open', open);
      mobileToggle.setAttribute('aria-expanded', String(open));
      mobileToggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
      sidebar.inert = mobileMedia.matches && !open;
      sidebar.setAttribute('aria-hidden', String(mobileMedia.matches && !open));
      if (mainContent) mainContent.inert = mobileMedia.matches && open;
      overlay.tabIndex = open ? 0 : -1;
      if (open) sidebar.querySelector('a, button')?.focus();
      else if (restoreFocus) mobileToggle.focus();
    }
    function closeDrawer(restoreFocus) {
      setDrawer(false, restoreFocus !== false);
    }
    mobileToggle.addEventListener('click', function () {
      setDrawer(!document.body.classList.contains('sidebar-open'), true);
    });
    overlay.addEventListener('click', function () { closeDrawer(true); });
    sidebar.querySelectorAll('a').forEach(function (link) { link.addEventListener('click', function () { closeDrawer(false); }); });
    topbar.prepend(mobileToggle);
    document.body.append(overlay);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
        closeDrawer(true);
      } else if (event.key === 'Tab' && document.body.classList.contains('sidebar-open')) {
        var focusable = Array.from(sidebar.querySelectorAll('a[href], button:not([disabled])'));
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      }
    });
    mobileMedia.addEventListener('change', function () { setDrawer(false, false); });
    setDrawer(false, false);
  }

  document.querySelectorAll('.sidebar-logout').forEach(function (button) {
    button.addEventListener('click', function () { import('./auth.js').then(function (module) { module.logout(); }); });
  });

  document.querySelectorAll('.sidebar-nav a.active').forEach(function (link) {
    link.setAttribute('aria-current', 'page');
  });

  window.addEventListener('DOMContentLoaded', function () {
    if (window.lucide) window.lucide.createIcons();
  });

  // Clique no ícone redondo expande a sidebar
  var brand = document.querySelector('.sidebar-brand');
  if (brand) {
    brand.addEventListener('click', function (e) {
      if (document.body.classList.contains('sidebar-collapsed')) {
        e.preventDefault();
        applyCollapsed(false);
      }
    });
  }
})();
