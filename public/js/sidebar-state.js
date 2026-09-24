// Runs immediately after <body>, before the shell can paint at the wrong width.
try {
  document.body.classList.toggle('sidebar-collapsed', !!localStorage.getItem('ownerinc-sidebar-collapsed'));
} catch (_) { /* Storage is optional. */ }
