# Cards Pos Owner Frame 02 Design

Date: 2026-09-10
Status: approved by the user

## Goal

Update only the `convite_owner` Cards Pos composition to match the supplied
Frame 02 print. Keep the Guest card and the shared authentication, media,
history, CRUD, and PDF flows unchanged.

## Design

- Use the print ratio `862 x 1984`, exported at `108 x 248.6 mm`.
- Render the existing Owner cover with a dark overlay and centered reservation
  title.
- Use a white editorial body containing greeting, reservation details, address,
  included services, paid consumption, six optional services, and the final
  host note.
- Reuse the local Raleway font and existing Owner service icons.
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
