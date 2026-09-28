# Cards Pos Owner Frame 02 Design

Date: 2026-09-10
Status: approved by the user

Updated 2026-09-28 after the user supplied `Frame 2 (5).png` and requested
visual adjustments and comparisons. That source is 1448 × 3361 px and
supersedes the earlier inferred 862 × 1984 geometry.

## Goal

Update only the `convite_owner` Cards Pos composition to match the supplied
Frame 02 print. Keep the Guest card and the shared authentication, media,
history, CRUD, and PDF flows unchanged.

## Design

- Use the source ratio `1448 x 3361`, exported at `108 x 250.68 mm`.
- Render the existing Owner cover with a dark overlay and centered reservation
  title.
- Use a white editorial body containing greeting, reservation details, address,
  included services, paid consumption, six optional services, and the final
  host note.
- Reuse the local Raleway font and existing Owner service icons.
- Scale type and spacing from the reference pixels without fixed-pixel caps.
  Keep the body black, the reservation panel `#eae8e0`, and accents `#a49581`.
- Render the cover as a CSS background, with the image retained for readiness
  checks, so native preview and html2canvas use the same crop. The measured crop
  applies only to the default cover; uploaded images use centered cover.
- Use the local Owntime wordmark for the default brand text, and editable text
  for a customized brand. Use `ownerinc-logo-footer.png` in the footer: the
  legacy file named `ownerinc-logo.svg` actually contains the Owntime wordmark.
- Rebuild the Owner footer with editable relationship-center text, phone, and
  email plus the fixed Ownerinc logo.
- Keep every visible non-logo text editable through the existing safe rich-text
  controls.

## Compatibility

Keep `convite_owner` and the current persisted fields `heroTitle`,
`heroEmphasis`, `heroBrand`, `stayInfo`, `hostNote`, and `contact`. New fields
receive Frame 02 defaults when absent from an existing saved card. No database
or API migration is required because card values are already JSON.

## Validation

Update the existing frontend contract test, inspect desktop and mobile previews,
confirm the generated PDF dimensions, run `npm run verify`, and run
`git diff --check`.

Use native-resolution canvas export (1448 px wide, approximately 341 dpi at
108 mm) rather than multiplying the enlarged artboard by three. Compare the
source, previous export, new export and native browser preview; verify desktop,
tablet and mobile exports, uploaded images and editing behavior. Evidence:
[`2026-09-28-owner-frame-comparison.md`](../../reports/2026-09-28-owner-frame-comparison.md).
