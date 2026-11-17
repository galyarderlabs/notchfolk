# Spec: `shelf-capacity`

**Status: proposed** | **Owner: Galih**

## Objective

Let people choose the maximum number of files the Shelf can hold, without
hard-coding a different limit in the extension, daemon, helper, clipboard path,
or phone-sharing path.

## Scope and success criteria

- Add a Settings → Shelf integer control with minimum 6, maximum 64, step 1,
  and default 12.
- Save the choice with the existing GSettings preferences and apply it without
  restarting the session.
- Use the same chosen limit for local drops, clipboard-to-Shelf actions,
  direct daemon adds, and phone uploads.
- Update the Files hint and phone-sharing page to show the selected limit and
  the remaining room.
- If the limit is lowered below the number already stored, keep every existing
  file. Refuse new files until enough are removed; never evict files silently.
- After restarting Notchfolk, the selected value and existing files remain.

## Commands and verification

- JavaScript lint: `npx eslint gnome-extension/prefs.js gnome-extension/src/pages/files.js gnome-extension/src/pages/shelf.js`
- Rust checks: `cargo fmt --all -- --check` and `cargo test -p notchfolk-core -p notchfolk-daemon -p notchfolk-shelf`
- Schema validation: `glib-compile-schemas --strict --dry-run gnome-extension/schemas`
- Manual GNOME check: choose 6, 12, and 64; exercise drop, clipboard, and
  phone upload at the limit; lower the limit below the current count and verify
  files remain while additional adds are refused.

## Project structure

- `gnome-extension/schemas/org.gnome.shell.extensions.notchfolk.gschema.xml`:
  persisted setting, range, and default.
- `gnome-extension/prefs.js`: Settings → Shelf control.
- `gnome-extension/src/pages/files.js`, `clips.js`, and `shelf.js`: visible
  capacity, hints, and preflight checks.
- `crates/notchfolk-core/src/shelf.rs` and
  `crates/notchfolk-daemon/src/shelf.rs`: authoritative add limit.
- `crates/notchfolk-shelf/src/shelf.rs`: drag/drop refusal at the selected
  limit.
- `crates/notchfolk-daemon/src/share/server.rs` and
  `crates/notchfolk-daemon/src/share/page.html`: phone upload room and limit.

## Code style

Keep one persisted integer setting and pass its value to all enforcement
points. The schema follows the existing ranged integer pattern:

```xml
<key name="shelf-capacity" type="i">
  <range min="6" max="64"/>
  <default>12</default>
</key>
```

Use the existing `Adw.SpinRow` pattern for the Settings control; add no new
dependencies.

## Boundaries

- Preserve 12 as the default.
- Lowering the value never removes stored files.
- Do not commit any Shelf changes until the user asks.
- Keep the scroll fix and capacity setting independently reviewable.

## Open questions

None.
