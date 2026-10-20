# Portal Conteúdos — authenticated catalog and reader design

Date: 2026-10-20. Status: approved UX, specified for implementation; feature and
browser acceptance are not yet implemented or evidenced by this document.
Repository baseline: `830e90c895d8c1bdd91334a7bac6049191d6c2c4`.

## 1. Decision and scope

Build `public/contents.html` as a dedicated authenticated Portal area. Its default
view is a catalog; `contents.html?slug=<canonical-slug>` opens the published page
inside the normal sidebar/topbar shell. The reader is not an overlay. Galleries
always offer an accessible lightbox. Reuse Portal tokens, typography, buttons,
local icon sprite and shell conventions, with original implementation. No code,
images, fonts or other assets from the unlicensed inspiration project may enter
this repository.

The selected approach is a small page-local ES-module reader with independent
validation and native browser media transport. Extending the Owner News overlay
would couple unrelated DTOs and violate the approved dedicated-page interaction;
embedding the CMS preview would couple editorial authentication and preview scope
to published reading. Neither is part of this design.

This work may add one authenticated availability route, frontend modules, scoped
styles, shell integration, tests, documentation, and the narrow Vimeo frame CSP
allowance. It does not change publication, preview, upload, editor or storage
protocols, the Owner News domain, database schemas or production deploy scripts.
No deployment, running-service change or production operation is authorized.

### Grounding

Read alongside `README.md`, `docs/product/brief.md`,
`docs/architecture/overview.md`, and `docs/architecture/portal-pages-content.md`.
The normative existing contracts are:

- Task 1: `cms/src/portal-pages/{contracts,blocks,primitives,rich-text,validation}.ts`.
- Task 4: `api/routes/contents.js`, `api/portal-pages/payload-dto.js`,
  `api/portal-pages/media-cookie.js` and the private Payload read client.
- Shell: `public/js/{router,page-lifecycle,auth,auth-shell,sidebar}.js`,
  `scripts/generate-public-shell.mjs`, `public/css/{tokens,layout,components}.css`.
- Transport/policy: `nginx/nginx.conf`; existing assets location and CSP map.

## 2. Architecture and ownership

Register `/contents.html` in `router.js` with module
`./portal-contents/index.js`. Use the existing `export function mount(page)`
contract, authenticated router boot, `page.location`, `page.history`, cleanup,
request tracking and restoration. Do not add another Firebase initializer,
standalone router or document-wide page boot listener.

Focused modules under `public/js/portal-contents/`:

| Module | Responsibility |
| --- | --- |
| `index.js` | Mount, view/request generation, catalog/detail orchestration, page-local history handling and cleanup. |
| `api.js` | Existing auth helpers, exact endpoint construction, bounded response validation and sanitized errors. |
| `dto.js` | Pure browser-JS strict wire DTO/list/categories validators, with no DOM or CMS dependency. |
| `catalog.js` | Semantic catalog, category controls, pagination and state rendering. |
| `reader.js` | Article header, ten block renderers and approved layout classes; consumes validated data only. |
| `rich-text.js` | Structured text-to-DOM rendering using fixed element/attribute allowlists. |
| `gallery.js` | Gallery grid and one owned modal lightbox with complete disposal. |
| `media-session.js` | Persistent session coordinator, short-lived media lease, renewal and auth-exit clearing. |
| `availability.js` | Persistent shell availability state, fresh probes and gated-link updates. |

One feature stylesheet, `public/css/portal-contents.css`, scopes selectors to
`.portal-contents` and `.portal-contents-lightbox`. A small shared shell rule for
the hidden navigation item belongs in `layout.css`, because other Portal pages
must not load the reader stylesheet. No broad `article`, `figure`, `dialog`,
`img`, `.card` or `.main-content` overrides. DOM IDs use `contents-` prefixes.
Feature modules do not import Owner News renderers or CMS/native Payload types.

## 3. Availability and global navigation

### New endpoint (the only backend addition)

`GET /api/contents/availability`, registered before `/:slug`, uses the same
`authenticate` middleware, active-user revalidation, body rejection, cancellation,
error mapping and `Cache-Control: private,no-store` as the existing read routes.
It accepts no query parameters and no body. It invokes the existing Payload client
`list({limit: 1, offset: 0}, portalActor(req.user), requestContext)`, relying on its
strict validation and published eligibility filtering. Return exactly
`200 {"available": true}` when validated count is positive and the first row
exists, otherwise `200 {"available": false}` for validated zero count/empty rows.
An inconsistent positive count/empty first page fails closed with 503. Never return
DTOs, counts, user identity, configuration or CMS errors in this response.

No CMS connection/configuration, timeout or malformed response returns the existing
sanitized 503 `portal_pages_unavailable`, not false and not 200. Authentication
remains 401; inactive/forbidden accounts retain middleware status/reason. No new
public CMS endpoint, feature flag or permission is introduced. The existing
published reader is available to active Portal users; `manageKnowledge` is only
for editorial/preview operations.

### Shell state machine

Generate a `Conteúdos` item after Owner News in every generated Portal sidebar,
including `contents.html`, with a stable `.contents-link` marker and HTML `hidden`
on its list item. A shared `[hidden]` rule must win over sidebar display rules.
The item is neither visible nor keyboard-focusable before live confirmation.
Its icon is the existing local `book-open` symbol; active state and
`aria-current="page"` follow router/generator conventions. The topbar title is
`Conteúdos`; the article title is the reader's h1.

The singleton gate has `unknown`, `checking`, `available`, `empty`, `unavailable`
and `denied` states, scoped to the live UID plus an authorization generation.
Only a successful current-identity response with exactly boolean `available:true`
reveals the item. Start/restart it after successful live `/api/users/me`
validation, on committed navigation, and on visible-tab return/online recovery.
Coalesce simultaneous probes, do not poll in the background, and ignore stale
generations. Rechecking hides the link until confirmation. Network/503/invalid
responses hide it; unrelated areas remain usable. Auth loss/account change clears
the state synchronously and cancels its requests. If a focused link is removed,
move focus to the current main heading or mobile menu toggle as appropriate.

Do not add availability to `auth-shell.js` snapshots, localStorage/sessionStorage,
or service-worker caches. Neither cached false nor cached true controls access.
The gate runs from the persistent shell/auth integration across all generated
pages, not only while the reader module is mounted. The existing auth visual
snapshot must not reveal this link. Adjust sidebar drawer focusable selection to
exclude hidden/inert items; the current broad anchor query needs this narrow fix.

Direct `contents.html` navigation remains a valid authenticated route even while
the link is hidden: load its catalog/detail from the server. Do not make
`routeAllowed` consult cached availability and do not redirect a deep link solely
because the catalog probe failed. This permits empty/unavailable/retry views and
fresh server authorization. A 503 shows temporary unavailability; zero publications
shows the empty catalog. Do not mislabel CMS downtime as permission denial or
unpublish already read text based solely on a failed availability probe.

## 4. Routes, data and catalog

Use existing helpers from `auth.js`, never manually persisted bearer tokens:

| Operation | Contract |
| --- | --- |
| Catalog | `GET /api/contents/?limit=12&offset=<n>[&category=<slug>]`; JSON array of full DTOs, `X-Total-Count` header. `fetchAPIPage` returns `{data,total}`; there is no HTTP `{rows,count}` envelope. |
| Categories | `GET /api/contents/categories`; array of `{id,slug,name,count}`, with positive integer counts. |
| Reader | `GET /api/contents/<slug>`; single published DTO; must match requested slug. |
| Availability | New GET described above. |
| Media issue/refresh | `POST /api/contents/media-session`; no body; authenticated; 204 with Set-Cookie, no JSON token. |
| Media clear | `DELETE /api/contents/media-session`; no body; same-origin, 204; no bearer required by existing route. |

Use credentials `same-origin` and `cache:'no-store'`. GET requests inherit the
page/request abort signal. Treat missing/invalid totals as a failed list response,
not as zero. The API permits limit 1–50 and offset 0–1,000,000; the UI uses 12,
preserves server `publishedAt DESC,id DESC` order, and never resorts locally.
Categories and list load independently, so category failure has a local retry
without hiding a successful catalog. Category counts describe all eligible content,
not the current page. No search API is assumed or invented.

Catalog has one h1 `Conteúdos`, a labeled category nav with `Todas`, and a semantic
list of article cards. Each card has one descriptive heading link, optional cover,
summary, category text and a `<time datetime>` only when `published_at` is non-null.
Do not make a nested interactive whole-card button or place category links inside
the article link. Use stable card-link IDs for router focus restoration. Cover
absence needs no invented asset. Summary and labels are text nodes.

Pagination uses labeled previous/next links plus current page/total indication;
omit unavailable directions rather than fake disabled anchors. Cap navigable
offsets at the API limit. No infinite-scroll requirement. Fetching sets the affected
region `aria-busy`; a separate polite status announces completion/error, without
making the entire card list a live region. Initial loading uses a text status and
non-announced static placeholders. Empty all-content and empty category states
have distinct copy; empty category offers `Todas`. Errors offer `Tentar novamente`
with the same requested state. No stale card/detail DOM survives a route change
as if it represented the new query.

### URL and history rules

- Catalog canonical state: `/contents.html`, optionally `?category=<slug>&page=<n>`.
  Page is a positive decimal safe integer whose derived offset is within bounds;
  omit page 1 and empty category. A category change resets page to 1.
- Reader canonical state: `/contents.html?slug=<canonical>`. This identifies the
  exact article, not an immutable revision: refresh returns its current published
  revision. Historical revisions are not a public API feature.
- Canonical slugs use `^[a-z0-9]+(?:-[a-z0-9]+)*$`, maximum 160 characters. Reject
  duplicate slug/category/page keys and malformed recognized values before API
  work. A slug combined with catalog parameters is canonicalized to slug-only
  using `page.history.replaceState`; unrelated query keys are removed. Never
  normalize an invalid slug into another article. Show an invalid-link state.
- Real same-origin anchors provide copy/open-in-new-tab behavior. Let the existing
  router handle ordinary same-route clicks and emit its local `popstate`. Category
  controls and pagination also use real URLs. If an imperative state change is
  needed, use `page.history` then explicitly load once; pushState emits no event.
  Never overwrite `portalNavigation` or install a second router click handler.
- Listen through `page.listen(window,'popstate',...)` and read committed
  `page.location.search`, not an uncommitted browser URL during cross-area traversal.
  Back/forward loads the correct state and closes any gallery first. Track initial
  loads with `page.bindAPI` so `page.ready()` gates router restoration. Same-route
  loaders start synchronously in the history event before restoration settles.
- `Voltar ao catálogo` is a real link, not unconditional history.back(). After a
  catalog-to-reader transition it targets that mounted session's last category/page;
  a direct reader entry targets `/contents.html`. Browser Back retains native
  traversal. A hard refresh of a slug URL never requires a prior catalog fetch.
- Detail success updates document title to `<title> — Conteúdos — Portal Ownerinc`;
  catalog restores its title. Focus the article/catalog heading on user-driven
  transitions; browser traversal restores the router's saved focus/scroll without
  a competing scroll-to-top. Stable regions and reserved image boxes limit shifts.

404 means the article is no longer available and offers the catalog; 400/invalid
DTO means safe failure; 503/network has retry; 401 and definitive account denial
follow existing auth cleanup/redirect. Do not fall back to News or CMS preview.

## 5. Strict browser DTO contract

Implement a deliberate duplicate JS wire validator in `dto.js`. The API validator
is the normative strict public-wire acceptance rule; Task 1 is the normalization
source, not a reason for the browser to trim strings or normalize unsafe input.
CMS source normalization can accept noncanonical authoring values which the API
correctly rejects. Test parity on normalized Task 1 outputs and strict rejection
parity with `api/portal-pages/payload-dto.js`, explicitly preserving that distinction.

Validate the complete response before creating content DOM, media URLs, iframe
elements or gallery listeners. Reject an entire invalid list/detail, not just its
bad blocks. No unknown field, block, mark, layout, version or scope is skipped.
Use explicit own-property allowlists at every record; no object spreading into
DOM attributes, inherited properties or prototype-sensitive merging.

Required page keys, with no extras: `id, slug, title, summary, cover, categories,
published_at, content_version, asset_scope, content_blocks, revision`. UUID syntax
matches the API (case-insensitive hex groups; URL builders lower-case UUIDs).
`content_version` is numeric 1, scope is exactly `portal-pages`, and revision has
only UUID `id` and `status:'published'`. Reject preview scope even for admins.
Title is 1–200 Unicode code points; summary 0–1000, multiline. Cover is null or
exactly UUID `asset_id` plus nonempty alt up to 300. Categories are at most 20
records with UUID `id`, canonical `slug`, and 1–100 name. Timestamp is null or exact
`new Date(value).toISOString()` spelling. No native Payload IDs/relations/HTML.

All blocks allow optional `layout` in `content|wide|full|left|right`, defaulting at
render time to `content`. Apart from `type`, layout and the keys below, reject extras.

| Type (all ten) | Required fields and additional bounds |
| --- | --- |
| `heading` | `text` 1–200; integer `level` 2, 3 or 4. |
| `rich_text` | `nodes` array of the structured grammar below. |
| `image` | UUID `asset_id`, `alt` 1–300; optional `caption` 0–1000 multiline. |
| `gallery` | `images` array, 2–20 ordered entries; each exact UUID `asset_id`, `alt` 1–300 and optional multiline caption 0–1000. |
| `video` | UUID `asset_id`, `title` 1–200. |
| `pdf` | UUID `asset_id`, `title` 1–200. |
| `embed` | `provider` youtube or vimeo, canonical `url`, `title` 1–200. |
| `callout` | `tone` info/warning/success; `text` 1–2000 multiline; optional `title` 0–200. |
| `link` | `label` 1–200, HTTPS `url`, boolean `new_tab`, `style` primary/secondary. |
| `divider` | No additional fields. |

Plain-text handling reproduces the API's markup/event-handler/javascript pattern
rejection, Unicode control rejection, trimming requirements and newline rules.
Do not replace it with an HTML sanitizer or count UTF-16 units as code points.
Rich text preserves text whitespace but does not allow literal control/newline
characters; line breaks are structural. HTTPS links are at most 2048 characters,
have a hostname, no credentials, whitespace, controls or backslashes. No relative,
protocol-relative, `javascript:`, `data:`, `blob:` or mailto URLs are DTO links.

Content is at most 100 blocks and 5 MiB UTF-8 serialized content_blocks, measured
with TextEncoder. Reproduce the API's single 10,000-node budget across blocks,
rich block nodes, list items and inline nodes; do not reset per block. Detail
serialized DTO is at most 6 MiB. List validates at most requested limit rows,
unique page IDs, integer total 0–100,000 and total >= rows.length, and the 16 MiB
normalized `{rows,count}` size bound used by the API. Category response has at most
10,000 entries, exact four fields, positive safe integer counts, unique IDs/slugs,
and 16 MiB size bound. Use `authenticatedFetch` with bounded response reading in
`api.js` for content JSON: 6 MiB detail and 16 MiB list/categories transport caps,
then the normalized checks above. Return the same `{data,total}` list adapter shape
as `fetchAPIPage`, parsing the raw count header strictly. Never buffer unbounded
JSON before enforcing transport limits. Cancel the reader on cap excess or abort.

### Safe rich text and ordinary blocks

Rich nodes are exact `paragraph{children}`, `heading{level:2..6,children}` or
`list{ordered:boolean,items:Inline[][]}`. Inline leaves are
`text{text,marks}` or `break`; inline `link{url,new_tab,children}` contains only
text/break, never another link. Marks are unique entries from bold, italic,
underline and code. Empty arrays/text allowed by the API remain valid.

Create p, h2–h6, ol/ul/li, text nodes, br and a with `createElement`/textContent.
Apply marks in a fixed order using strong/em/u/code, independent of input order.
No innerHTML, insertAdjacentHTML, srcdoc, HTML strings, executable handlers, style
attributes from DTOs, or third-party rich-text runtime. The page title is the only
h1. Callouts are labeled asides with textual tone cues, not live alerts; multiline
text uses pre-wrap. Link blocks are anchors styled through fixed Portal classes.
Divider is hr. New-tab links use `_blank`, `rel="noopener noreferrer"`, and a
visible/accessibly announced new-tab cue. Same-tab external links retain normal
navigation; neither reader nor router silently changes their destination.

## 6. Native media and session lifecycle

For a validated page, construct only
`/api/contents/assets/<page.id>/<page.revision.id>/<asset_id>`, with lower-case
validated UUID path components. Asset IDs must come from that page's cover or
specific block. No `/uploads`, CMS paths, preview URLs, guessed extension, query
token, revision-less path or signed URL. No storageKey, Firebase token or secret
appears in markup, URLs, logs, history, storage or error text.

Before setting any native media src/href, await the coordinator's successful
bodyless POST using `authenticatedFetch`/existing token handling. Existing 204
has no expiresAt payload: record request-start time and conservatively treat the
lease as five minutes from that point, renewing at four minutes. Use a 15-second
timeout per issuance so a hung renewal cannot remain pending forever. Do not use
`fetchAPIAsset`, `response.blob()`, object URLs, base64, fetch-to-arrayBuffer or a
service worker to transport assets. Native img/video/PDF requests send the
same-origin HttpOnly cookie, not an Authorization header.

Production cookie is `__Secure-ownerinc-content-media`, Secure, HttpOnly,
SameSite=Strict, Path=/api/contents/assets, exactly five minutes; localhost HTTP
uses the existing development cookie. POST/DELETE Origin requirements remain
unchanged; browsers supply Origin, JS must not attempt to forge it. Each asset
request checks revocation, active user, revision and reference on the server.

The coordinator lives across soft navigation, but a mounted catalog/reader owns a
lease only while it has native media. One issuance/renewal is in flight per tab.
Refresh without replacing src on success: long-running videos keep their current
stream and position, and later Range requests get the renewed cookie. Renew while
visible with media and also while a native video is playing in a hidden tab.
Resume checks on visibility/online/focus, before play/seeking, gallery opening and
PDF link preparation; if renewal is overdue, pause a video before initiating new
play/seek work and renew. Browser suspension can prevent timers: uninterrupted
playback across a suspended tab or network outage is not promised.

On transient renewal failure retain validated text, show media-specific retry,
and retry with bounded backoff (5, 15, 30 seconds), respecting Retry-After on 429.
Stop automatic retries after that sequence until interaction/online recovery.
Do not hammer the existing authenticated-write limiter. On known lease expiry
pause playback and disable unprepared PDF actions. A media error has no readable
HTTP status from a native element: allow one renewal/retry per failure generation,
not a presumed 401 or infinite reload loop. For video recovery save currentTime
and playing state, reload after renewal, restore a clamped time on loadedmetadata,
then resume only if user intent still applies; handle rejected play promises.

A persistent asset failure after fresh issuance may be an unpublished/replaced
revision, 404, 416 or unavailable CMS. Offer `Recarregar conteúdo` to fetch and
validate the current DTO; never splice new-revision assets into the old article.
Authentication failure synchronously removes protected content/media and uses
existing logout handling. Existing open streams/received bytes cannot be revoked
retroactively; future requests remain independently authorized.

On ordinary route disposal release leases and stop timers; do not DELETE the
shared cookie on each reader exit or pagehide, which would break other tabs and
open PDF viewers. Cookie expiry bounds that idle lifetime. On explicit logout,
session denial or account switch, integrate bodyless DELETE into
`auth.js`'s existing `finishSessionExit` alongside editorial session revocation,
including the existing hidden-content/retry behavior if clearing fails. Prevent
new issuance while clearing; finish or cancel old work and clear again after any
late same-tab issuance completion before allowing the next identity to use media.
Coordinate auth-exit invalidation across tabs (BroadcastChannel with a storage
event fallback carrying only an invalidation generation, no credentials). Each
receiving tab cancels leases/issuance and hides media. Treat in-flight cross-tab
Set-Cookie races as bounded by server revocation checks and five-minute expiry,
not as proof of instantaneous global cookie revocation. A subsequent identity
must obtain its own successful POST before displaying assets.

### Per-media presentation and Range

- Images: figure/img/optional figcaption, required descriptive alt, async decoding,
  lazy load below the fold, natural aspect ratio and contain fit in the article.
  Catalog cover can crop to a stable thumbnail box; expanded/gallery images do not
  crop. No fabricated dimensions or srcset endpoints. Error keeps alt/caption and
  exposes retry; avoid broken-image-only feedback.
- Video: native controls, playsinline, preload=metadata, no autoplay/loop, a visible
  title and accessible name. No fake poster or invented captions endpoint. The DTO
  has no subtitle tracks/transcript; readable authored alternatives are an editorial
  accessibility requirement, not a claim that native controls make all videos
  accessible. Expose unsupported/playback failure with text and retry.
- PDF: a titled document block with a descriptive `Abrir PDF — <title>` real anchor
  targeting `_blank`, rel=noopener noreferrer, and visible new-tab instruction.
  Prepare/renew the lease before enabling the native URL, on focus/hover and on
  ordinary activation. If activation finds an expired lease, prevent it, renew and
  ask for a new click instead of asynchronous popup creation. Modified/new-tab
  activation uses the already prepared native href. Also offer a native same-origin
  download link with the download attribute, without fetching bytes; browser
  handling/content disposition determines whether it saves or opens. No embedded
  object, iframe PDF viewer or canvas-only PDF reader in this release. Accessible
  title, PDF type and renewal instructions remain usable without a browser viewer.
  A PDF opened in another tab has no Portal renewal script: later requests after
  the cookie expires may require returning to the Portal and reopening. State this
  beside the action, without promising indefinite standalone viewing. The binary
  document's tagging/reading order remains an editorial acceptance check.
- PDF and video use the existing native single-Range transport, including open
  and suffix ranges; retain 206, Content-Range, Accept-Ranges, Content-Length and
  416 behavior. Images use whole responses. No client Range synthesizer or full
  download prerequisite. Test actual seek/suffix behavior; a static source check
  alone does not prove it. `proxy_request_buffering off` is not proof of disabled
  response buffering; inspect real Nginx transport during service-backed acceptance.

## 7. Embeds and CSP

Accept only the Task 1 canonical URL for the declared provider:
`https://www.youtube.com/embed/<11 ASCII ID characters>` or
`https://player.vimeo.com/video/<positive decimal ID>`. Match the API's exact regex,
including no query/fragment/alternate host or credentials. Do not silently rewrite
to youtube-nocookie or add autoplay parameters.

Render a titled, lazy iframe in a responsive 16:9 wrapper, with
referrerpolicy=strict-origin-when-cross-origin, allowfullscreen, and a fixed allow
list of fullscreen, picture-in-picture and encrypted-media. Sandbox allows only
scripts, same-origin and presentation; provider playback under this combination
requires browser evidence. Do not grant top-navigation, forms, downloads or popups.
Provide an ordinary approved-provider link and useful title if embedding is
blocked; do not report iframe load as proof playback succeeded.

The existing Portal CSP permits YouTube but not Vimeo. Add only
`https://player.vimeo.com` to the Portal frame-src policy; preserve existing Firebase
and YouTube sources, object-src 'none', frame-ancestors and unrelated policies.
No new script-src/connect-src wildcard, no unsafe-eval, no object-src relaxation.
Native PDF links avoid a need for self frames or blob frames. Existing img/media
sources already permit same-origin native asset URLs. This is a configuration
specification, not authorization to reload Nginx or deploy it.

## 8. Mandatory gallery and lightbox

Every gallery renders an ordered semantic list of figures with actual button
triggers. A responsive CSS grid uses a minimum thumbnail width around 180px,
bounded by available inline size; one column on narrow mobile, two or more when
space permits. Thumbnail button names include image position and alt. Captions
remain plain text and appear in the grid and full view where present. Image
ordering is the DTO ordering, including repeated asset references.

Create at most one native `<dialog>` lightbox per mounted reader, attached outside
the Portal wrapper as an owned `data-page-overlay`, with a unique accessible name
and `aria-describedby` for the current caption/status. Open with showModal; provide
visible close, previous and next buttons (44px minimum targets), the uncropped img,
caption and polite `Imagem n de N` status. Previous/next wrap within this gallery;
never traverse another block. Keep the controls stable while the image loads.
Announce loading/failure and permit navigation past a failed image.

Focus the close button on open. Tab/Shift+Tab stay among current enabled dialog
controls (including a retry if present), with a dialog fallback if none; native
dialog behavior is reinforced and tested, not assumed. Escape closes through
cancel handling; Left/Right changes images only while this dialog owns focus and
never overrides text input/editable controls. Enter/Space activate buttons. Touch
uses the same large visible controls; swipe is optional and not required for
access. Preserve pinch zoom and native vertical scrolling, with no global touch
preventDefault. Backdrop close only fires when pointerdown/up both target the
backdrop, not after dragging an image. No autoplay slideshow.

Capture opener and scroll position; on normal close restore the still-connected
opener, otherwise a valid gallery heading/reader heading. On route/auth disposal
close without restoring focus into the departing page. Clear image src and
listeners on disposal. Lock document scroll while open, compensate scrollbar
width without a jump, and restore the exact previous styles/scroll on close.
Make background Portal wrapper/other applicable siblings inert while the dialog
is open, preserving their preexisting inert values. Never make the dialog's own
ancestor inert. Close the mobile drawer before opening; do not allow competing
sidebar/lightbox focus traps. Release only the inert/scroll state this lightbox
owns, respecting the shell's current mobile state.

Register close/dispose with the existing UI dialog lifecycle so router
`closePageDialogs()` closes it even for same-route traversal. Route-local teardown
also closes it before replacing article DOM. Motion is a short optional opacity
transition; prefers-reduced-motion removes it. Image navigation does not animate
sliding/zooming or shift focus. Browser Back changes catalog/reader URL and closes
the dialog; opening a gallery does not create a history entry.

## 9. Layout semantics

Use a single article grid constrained to the Portal main content's available
inline size, never viewport width. Standard article text has a centered maximum
measure of 72ch; wide blocks cap at 1100px; the outer reader can use all remaining
main width with Portal gutters. The title/metadata use the content measure.

| Layout | Desktop meaning |
| --- | --- |
| `content` or omitted | Centered standard 72ch reading column. |
| `wide` | Centered up to 1100px, bounded by available main width. |
| `full` | Full available article grid width inside main gutters; never underneath the sidebar or outside the shell. |
| `left` | Standard-measure block aligned to the left edge of the wide track, on its own grid row. |
| `right` | Standard-measure block aligned to the right edge of the wide track, on its own grid row. |

Left/right are alignment, not floats, implicit paired columns or a change to
document reading order. Every block remains a normal-flow row; captions stay with
their media. Apply the same five classes to all block types. Use min-width:0,
max-inline-size:100%, wrapping for long labels/links and flexible media sizing.
At <=768px, or when the available main region cannot accommodate the wide track,
all layouts collapse to one available-width column with mobile gutters. Expanded
and collapsed sidebar widths must both reflow correctly; no 100vw breakout or
negative margin trick. Dialog sizing uses safe viewport units, safe-area padding
and scrollable captions/controls, preserving functionality at 200% zoom.

## 10. Cancellation, restoration and cleanup

Each mount owns a lifecycle; each catalog/detail transition owns a child
AbortController and monotonically increasing request generation. Abort the old
generation and dispose its media/gallery before the next view. After every await,
including response parsing and media issuance, confirm page.active, generation
and UID before changing DOM or assigning src. Category work can be independent
within that same generation. Never allow A's late response to overwrite B.

Register DOM/window listeners with page.listen or a per-view controller; clear
per-view timers, observers, image handlers, pending decode work and controllers.
Pause videos, remove src/source nodes and call load() on disposal to cancel native
work; remove iframe src and nodes. Remove the gallery dialog and restore locks.
No asset object URLs are created; any incidental future object URL would require
page-owned revocation and cannot become the media transport strategy.

`page.bindAPI` treats POST as a mutation and can block navigation. Therefore the
read-only cookie renewal coordinator must not use the page's mutation/busy set;
it has its own tracked cancellation/serialization. Catalog/detail GETs remain
tracked so ready()/scroll restoration waits for their DOM. Renewal cannot prevent
leaving the area. A late issued cookie is not evidence that its disposed view can
render; auth-exit clearing has separate ownership as specified above.

The router already disposes on pagehide and remounts on persisted pageshow. Use
that path rather than duplicating mount listeners. On BFCache restoration require
fresh active-user validation, availability and media issuance before reassigning
sources. Retain no authorized DOM from a previous identity. Test repeated
enter/leave and BFCache paths for leaked handlers, duplicate dialogs, audio and
stale scroll locks. Error paths must tolerate missing optional status/pagination
containers according to the README UI invariant.

## 11. Verification and acceptance evidence

Implementation must extend existing dependency-free unit/router harnesses and
generated-shell checks, including `tests/unit/task-7-shell-mobile.test.mjs`, auth
stability/navigation tests, and Owner News regressions. Run `npm run verify`,
`node scripts/generate-public-shell.mjs --check` and `git diff --check`; record the
actual exit/result, not an inferred pass.

Required coverage:

1. **Validator parity:** fixtures for all ten blocks x five layouts plus omitted
   layout; normalized CMS output accepted by API/browser; identical wire rejects
   for unknown keys, native fields, preview/draft/version, duplicate marks, UUIDs,
   slugs, dates, arrays, bytes/nodes boundaries, nested links and malformed totals.
   Include Unicode code points versus bytes and exact request-slug matching.
2. **XSS:** hostile text/alt/caption/title, event-looking strings, HTML, entities,
   javascript/data/blob URLs, credential URLs, fake provider subdomains, srcdoc,
   style and prototype keys. Assert no unsafe nodes/attributes or partial content
   render when any DTO is invalid. A renderer test verifies actual DOM output,
   not only source-code regex checks.
3. **Navigation gate:** unauthenticated/inactive users, zero publications, positive
   publication, CMS down, malformed response, stale UID and delayed races; initial
   hidden markup on every generated page; no cache-based reveal/deny; direct slug
   works despite failed availability; hidden links excluded from mobile focus trap;
   generation idempotence and unchanged unrelated access controls.
4. **Routing:** real router initial catalog/deep link, category/page URLs, invalid
   query, exact slug, same-route clicks, modified clicks, Back/Forward, refresh,
   list return, unpublish 404, failures/retry, rapid A-to-B, cross-route transition,
   account change and BFCache. Verify document title, focus and scroll ownership.
5. **Media session/security:** exact empty-body POST/DELETE, 204 handling, native
   revision-bound URLs, cookie attributes/path, no token in DOM/URL/storage/logs,
   no Blob buffering, current identity checks, renewal deduplication/backoff,
   background playback and expiry, disposal and auth-exit clearing races.
6. **Native transport:** service-backed browser recording of image GET, metadata
   request, seek/open/suffix Range, 206/416 and private/no-store/nosniff headers;
   video >5 minutes with successful renewal and later seek; forced renewal failure,
   suspended-tab resume and stale-publication recovery; large PDF opens without a
   full JS-buffered download. Unit mocks alone cannot satisfy this evidence.
7. **Gallery accessibility:** keyboard-only open/cycle/close, reverse tab trap,
   arrows/Escape, captions/alts/status, image failure, focus restoration and removed
   opener, inert restoration, backdrop drag, scroll lock, mobile menu interaction,
   reduced motion, touch targets/pinch zoom, repeat mount/dispose. Supplement DOM
   tests with browser accessibility tree and screen-reader checks.
8. **PDF/video/embeds:** accessible PDF link and download behavior, viewer missing,
   expired standalone PDF/reopen instructions, editorial PDF tagging check,
   native controls, rejected play(), YouTube and Vimeo under effective CSP/sandbox,
   blocked-provider fallback. Record missing captions/transcripts as an editorial
   acceptance concern, not an invented DTO field or a false accessibility pass.
9. **Layout/mobile:** all five layouts with all ten blocks, sidebar expanded and
   collapsed, 320/375/768px and desktop widths, long captions/URLs, 200% zoom,
   full-width block containment and zero unintended horizontal page overflow.
10. **Regression:** Owner News catalog/overlay/navigation/media remain on their
    original domain/transport, Academy and editor entry continue working, existing
    logout still revokes editorial sessions, and shell generation stays consistent
    on every listed page. No unrelated permissions, upload or publication changes.

### Evidence status at this design commit

| Evidence | Status |
| --- | --- |
| Source/contract inspection and inline specification self-review | COMPLETE; baseline listed above. |
| Existing repository `npm run verify` during documentation work | FAIL, exit 1: 1960 passed, 15 failed, 19 skipped. Fourteen preview fixture tests failed with EPERM creating directories under `C:\Users`; one payload-operations test timed out spawning Git Bash. Initial attempt also exceeded the 120-second tool deadline; completed retry used a longer deadline. No feature code was changed to address these unrelated checks. |
| Existing generated shell check and document whitespace check | PASS (`node scripts/generate-public-shell.mjs --check` and `git diff --check`). |
| Reader implementation, new API route and reader automated tests | NOT IMPLEMENTED by this documentation-only change. |
| Browser layout, native media/Range, accessibility and BFCache evidence | NOT EXECUTED; requires implementation and an authorized test environment. |
| Real Firebase/CMS/Nginx integration and >5-minute playback | NOT EXECUTED; no service-backed claim. |
| Production/deploy actions | NOT REQUESTED / NOT EXECUTED. |

Future evidence must identify commit, fixture/environment, browser/version,
viewport, command/scenario, result (PASS/FAIL/NOT_EXECUTED) and artifact path where
available. Screenshots prove appearance only; network traces prove transport;
keyboard/screen-reader records prove the tested interaction. Never convert an
offline or mocked result into a claim of live Firebase, Vimeo or Nginx acceptance.

## 12. Self-review conclusions and implementation constraints

- API mismatch avoided: HTTP catalog is an array with a count header; session is
  bodyless 204; media has no MIME metadata in the DTO and no public upload URL.
- Availability is a fresh authenticated server fact, separate from auth snapshots
  and from route authorization. Downtime and empty are distinguishable.
- Five-minute cookies require proactive renewal; background suspension, standalone
  PDF tabs and cross-tab cookie races have explicit recovery/limits. This design
  does not extend TTL or change server authorization to conceal those limitations.
- Gallery is mandatory and owns modal accessibility/cleanup; PDF reading is a
  native accessible link strategy rather than an inaccessible embedded canvas.
- Vimeo needs one explicit CSP allowance and real playback verification. Effective
  CSP/Range behavior is not proven merely by editing configuration.
- Source validators normalize author input; strict browser parity targets the
  existing API wire validator. Any discovered preexisting CMS/API disagreement is
  reported with a fixture, not silently repaired by widening this reader.
- Scope remains a public-Portal reader design. Implementation planning and feature
  changes require the supervising session's next step; this commit contains only
  this specification.
