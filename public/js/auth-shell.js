(function restoreAuthSnapshot() {
  var root = document.documentElement;
  root.dataset.authState = 'pending';
  try {
    var raw = sessionStorage.getItem('ownerinc-auth-snapshot');
    var snapshot = raw ? JSON.parse(raw) : null;
    // This pre-paint hint is navigation only. Firebase and /users/me must still
    // confirm identity/access before page modules load authenticated content.
    var valid = snapshot && snapshot.version === 2
      && typeof snapshot.uid === 'string' && snapshot.uid
      && snapshot.user && snapshot.user.uid === snapshot.uid
      && Number.isFinite(snapshot.savedAt)
      && ['admin', 'viewer'].includes(snapshot.role)
      && typeof snapshot.firebaseStorageKey === 'string'
      && snapshot.firebaseStorageKey.indexOf('firebase:authUser:') === 0;
    var persistedUser = valid ? JSON.parse(localStorage.getItem(snapshot.firebaseStorageKey) || 'null') : null;
    if (!valid || !persistedUser || persistedUser.uid !== snapshot.uid) {
      sessionStorage.removeItem('ownerinc-auth-snapshot');
      sessionStorage.removeItem('ownerinc-verified-role');
      return;
    }
    root.dataset.authSnapshot = 'true';
    root.dataset.portalRole = snapshot.role;
    root.dataset.autocardAccess = String(snapshot.autocardAccess === true);
    root.dataset.posCardsAccess = String(snapshot.posCardsAccess === true);
    root.dataset.cmsAccess = String(snapshot.cmsAccess === true);
  } catch (_) {
    // Session storage can be unavailable in hardened browser modes.
  }
}());
