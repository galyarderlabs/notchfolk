# Spec: `shelf-scroll`

**Status: proposed** | **Owner: Galih**

## Objective

Let people reach every file in the one-row Shelf when the row is wider than the
island. The GNOME Shell view and the drag-and-drop helper must scroll together,
so every file name stays under its preview.

## Scope and success criteria

- File tiles keep their fixed width and remain in one row; overflow scrolls
  horizontally instead of compressing or wrapping the tiles.
- A mouse wheel, touchpad, or horizontal scroll input over the Files row moves
  the row, including while the helper window covers the island.
- Scrolling in either layer keeps the other layer at the same offset.
- Both ends of an overflowing row are reachable. A short row stays centred.
- Scrolling does not change the selected tab, remove a file, or start a drag.
- The shelf remains usable when the helper is unavailable.

## Commands and verification

- JavaScript lint: `npx eslint gnome-extension/src/pages/files.js gnome-extension/src/shelfHelper.js`
- Helper check: `cargo check -p notchfolk-shelf`
- Manual GNOME check: with more tiles than fit, use vertical wheel, touchpad,
  and horizontal wheel input over the Files row; verify both ends and matching
  names/previews with the helper shown and hidden.

## Project structure

- `gnome-extension/src/pages/files.js`: the island's tile row and scroll offset.
- `gnome-extension/src/shelfHelper.js`: helper lifecycle and synchronized offset.
- `crates/notchfolk-shelf/src/shelf.rs`: GTK scroller and its input handling.

## Code style

Use the existing `Clutter.ScrollDirection` handling in
`gnome-extension/src/widgets.js` and GTK 4's scroll-event controller in the
helper. Keep wheel and touchpad movement in the horizontal adjustment; preserve
the existing `Scrolled` signal for keeping labels aligned.

## Boundaries

- Keep the row one line and retain the current tile dimensions.
- Do not add a permanent scrollbar or a new dependency.
- Do not commit any Shelf changes until the user asks.

## Open questions

None.
