(function () {
  var KEY = 'ownerinc-sidebar-collapsed';

  function applyCollapsed(collapsed) {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    localStorage.setItem(KEY, collapsed ? '1' : '');
  }

  // Restaurar estado salvo antes de qualquer render
  applyCollapsed(!!localStorage.getItem(KEY));

  // Botão de toggle
  var toggle = document.getElementById('sidebar-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      applyCollapsed(!document.body.classList.contains('sidebar-collapsed'));
    });
  }

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
