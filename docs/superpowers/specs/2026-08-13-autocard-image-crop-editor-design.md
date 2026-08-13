# AutoCard Image Crop Editor Design

**Date:** 2026-08-13
**Status:** Approved

## Goal

Allow an authorized AutoCard user to choose which part of an uploaded photo is
visible inside the card frame, without creating a second copy of the private
media asset.

## Scope

The first version covers the active AutoCard templates that accept user photos:

- `aniversariante`, using its square birthday frame;
- `novo_funcionario`, using its employee-photo frame.

The existing authenticated upload, private media route, blob URL lifecycle,
history, variants, and PNG export remain in place.

## User Flow

1. The user selects a valid image.
2. The existing upload flow validates dimensions and size, uploads the image,
   and loads it through `fetchAPIAsset()`.
3. Once the authenticated blob URL is ready, a crop modal opens automatically.
4. The modal shows the image inside the exact frame ratio used by the selected
   template.
5. The user drags the image, adjusts a zoom slider, or chooses `Centralizar`.
6. `Cancelar` restores the last confirmed crop; `Aplicar enquadramento` updates
   the card preview and closes the modal.
7. The user can reopen the modal through `Ajustar enquadramento` while the card
   has a loaded image.
8. Saving the card persists the confirmed crop with the card data.

## Interaction Contract

The crop editor is implemented with browser APIs and existing project styles;
no frontend framework or new dependency is introduced.

- Dragging uses pointer events and works with mouse, touch, and pen input.
- The image remains constrained so no empty area appears inside the frame.
- Zoom has a bounded range with a stable default.
- Keyboard users can operate the dialog, buttons, and zoom slider.
- The dialog uses the native `dialog` element and returns focus to the opener.
- Reduced-motion users do not receive drag/zoom animations or decorative
  transitions.
- A failed media load does not open the modal and keeps the existing placeholder
  and safe error toast.

## Persisted Data

The card payload gains an optional `mediaCrop` object:

```json
{
  "x": 0.5,
  "y": 0.5,
  "zoom": 1
}
```

Contract:

- `x` and `y` are normalized focal-point coordinates in the range `0..1`;
- `zoom` is a bounded positive number, with `1` as the default;
- missing or invalid values normalize to the centered default;
- old cards without `mediaCrop` remain valid and render centered;
- the API validates and returns `mediaCrop` on create, read, update, list, and
  duplicate;
- duplicate copies the crop settings together with the media reference.

The crop is stored with the card rather than in the media table because the
same private image may be referenced by more than one card with different
frames.

## Rendering

The confirmed crop is applied to every image-bearing representation of the
card:

- the main editor preview;
- the birthday variant;
- the employee variant;
- the loaded DOM captured by `html2canvas` for PNG export.

The original image remains unchanged. Rendering continues to use the
authenticated `blob:` URL and applies the normalized crop through CSS/image
transform state rather than constructing a protected API URL in an `img` tag.

## API and Database

- Extend the card payload validator with optional `mediaCrop` validation.
- Add a forward migration for a nullable JSONB column on `autocard_cards`.
- Add the same column to the fresh-install schema.
- Keep the existing media authorization and file storage unchanged.
- Preserve audit events for card create, update, and duplicate.

## Error Handling

- Invalid crop payloads receive the existing safe validation response.
- A missing media asset keeps the card placeholder behavior and does not emit a
  broken image URL.
- Upload or media-loading failures do not mutate the last confirmed crop.
- Canceling the modal discards only unconfirmed drag/zoom changes.

## Verification

Add focused regression coverage for:

- crop defaults and numeric bounds;
- API persistence and normalization;
- edit and duplicate round trips;
- modal opening after successful media load;
- cancel/apply/reset behavior;
- pointer drag and zoom clamping;
- safe placeholders while media is loading or unavailable;
- variants and PNG export using the confirmed crop;
- accessibility and reduced-motion contracts.

Run `npm run verify`, the focused AutoCard/frontend tests, and
`git diff --check` before publication. Live validation remains a separate step
and requires an explicit push/deploy decision.
