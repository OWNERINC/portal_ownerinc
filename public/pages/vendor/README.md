# Pages editor bundle

`editor.js` is a locally served, pinned ProseMirror bundle. No CDN runtime or
HTML serialization is used. The source is `../editor-source.js`; exact direct
and transitive versions are in the root `package-lock.json`.

After `npm ci`, run `npm run build:pages` to regenerate the bundle and MIT
license notices. `npm run check:pages-build` compares both outputs in memory
without silently writing files. Commit generated outputs with source changes.
