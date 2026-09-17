(function () {
  var KEY = 'ownerinc-sidebar-collapsed';
  var mobileMedia = null;
  var drawerOpen = false;
  var drawerReturnFocus = null;

  function applyCollapsed(collapsed) {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    localStorage.setItem(KEY, collapsed ? '1' : '');
    var toggle = document.getElementById('sidebar-toggle');
    if (toggle) {
      toggle.setAttribute('aria-expanded', String(mobileMedia?.matches ? drawerOpen : !collapsed));
      toggle.setAttribute('aria-label', mobileMedia?.matches
        ? (drawerOpen ? 'Fechar menu' : 'Abrir menu')
        : (collapsed ? 'Expandir menu' : 'Recolher menu'));
    }
  }

  // Restaurar estado salvo antes de qualquer render
  applyCollapsed(!!localStorage.getItem(KEY));
  document.body.classList.add('sidebar-ready');

  var toggle = document.getElementById('sidebar-toggle');

  var sidebar = document.querySelector('.sidebar');
  var topbar = document.querySelector('.topbar');
  if (sidebar && topbar) {
    var mainContent = document.querySelector('.main-content');
    mobileMedia = window.matchMedia('(max-width: 768px)');
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
    overlay.setAttribute('aria-hidden', 'true');
    overlay.inert = true;
    overlay.tabIndex = -1;
    function setDrawer(open, restoreFocus, restoreInside) {
      var isMobile = mobileMedia.matches;
      var active = document.activeElement;
      var focusInSidebar = isMobile && active?.closest?.('#portal-navigation') === sidebar;
      if (open && isMobile) drawerReturnFocus = document.activeElement;
      drawerOpen = Boolean(open && isMobile);
      document.body.classList.remove('sidebar-open');
      document.body.classList.toggle('sidebar-open', drawerOpen);
      var expanded = isMobile ? drawerOpen : !document.body.classList.contains('sidebar-collapsed');
      var label = isMobile ? (drawerOpen ? 'Fechar menu' : 'Abrir menu') : (expanded ? 'Recolher menu' : 'Expandir menu');
      toggle?.setAttribute('aria-expanded', String(expanded));
      toggle?.setAttribute('aria-label', label);
      mobileToggle.setAttribute('aria-expanded', String(drawerOpen));
      mobileToggle.setAttribute('aria-label', drawerOpen ? 'Fechar menu' : 'Abrir menu');
      sidebar.inert = isMobile && !drawerOpen;
      sidebar.setAttribute('aria-hidden', String(isMobile && !drawerOpen));
      if (mainContent) mainContent.inert = isMobile && drawerOpen;
      overlay.tabIndex = drawerOpen ? 0 : -1;
      overlay.inert = !drawerOpen;
      overlay.setAttribute('aria-hidden', String(!drawerOpen));
      if (drawerOpen) sidebar.querySelector('a, button')?.focus();
      else if (restoreFocus || (restoreInside && focusInSidebar)) {
        var target = drawerReturnFocus;
        drawerReturnFocus = null;
        if (target?.isConnected && !target.closest?.('#portal-navigation')) target.focus();
        else mobileToggle.focus();
      } else drawerReturnFocus = null;
    }
    if (toggle) toggle.addEventListener('click', function () {
      if (mobileMedia.matches) setDrawer(false, true);
      else applyCollapsed(!document.body.classList.contains('sidebar-collapsed'));
    });
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
    mobileMedia.addEventListener('change', function () { setDrawer(false, false, true); });
    setDrawer(false, false);
  }

  document.querySelectorAll('.sidebar-logout').forEach(function (button) {
    button.addEventListener('click', function (event) {
      if (event.defaultPrevented) return;
      import('./auth.js').then(function (module) { module.logout(); });
    });
  });

  document.querySelectorAll('.sidebar-nav a.active').forEach(function (link) {
    link.setAttribute('aria-current', 'page');
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
