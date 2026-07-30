(function restoreVerifiedNavigationRole() {
  try {
    var role = sessionStorage.getItem('ownerinc-verified-role');
    if (role === 'admin' || role === 'viewer') {
      document.documentElement.dataset.portalRole = role;
    }
  } catch (_) {
    // Session storage can be unavailable in hardened browser modes.
  }
}());
