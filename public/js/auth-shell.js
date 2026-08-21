(function restoreAuthSnapshot() {
  var root = document.documentElement;
  root.dataset.authState = 'pending';
  try {
    var raw = sessionStorage.getItem('ownerinc-auth-snapshot');
    var snapshot = raw ? JSON.parse(raw) : null;
    var fresh = snapshot && snapshot.version === 1
      && Number.isFinite(snapshot.savedAt)
      && Date.now() - snapshot.savedAt < 10 * 60 * 1000;
    if (!fresh || !['admin', 'viewer'].includes(snapshot.role)) return;
    root.dataset.authSnapshot = 'true';
    root.dataset.portalRole = snapshot.role;
    root.dataset.autocardAccess = String(snapshot.autocardAccess === true);
    root.dataset.posCardsAccess = String(snapshot.posCardsAccess === true);
    root.dataset.cmsAccess = String(snapshot.cmsAccess === true);
  } catch (_) {
    // Session storage can be unavailable in hardened browser modes.
  }
}());
