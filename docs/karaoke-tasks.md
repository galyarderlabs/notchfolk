# Karaoke mode (compact lyrics)

Plan and task breakdown for the karaoke compact - Galih's idea, agreed with him:
while a song with synced lyrics plays, the closed island becomes a one-line karaoke.
No phase starts implementation until its tasks are listed here and Galih has seen the
plan. Every task names the exact Notchfolk file to touch and the exact API to call.
If a task does not name those, it is not ready to implement.

## The plan

```
[♪ art or app icon]   ♪ the line being sung   [wave]
```

- **Left:** the cover art the compact already shows; the player app's icon when a
  song carries none.
- **Center:** the line being sung, one line, fading between lines; ellipsized when a
  line runs long, so the island never grows past its measure.
- **Right:** the wave the compact already shows.
- **Activation, all three:** the switch is on, a song is playing, and the song carries
  synced lyrics. Anything else - paused, stopped, plain text lyrics, no lyrics - the
  closed island is exactly what it is today.
- **The assistant keeps its home:** the karaoke line takes the center only while it
  plays; the pointer entering or the island opening brings the assistant back, and the
  line waits. Nothing is covered by the mode.
- **Off by default, and its switch is on the Music page** - where the lyrics live - not
  in Settings (Galih's call). The switch persists in the schema; the closed island's
  quiet default stands for everyone who never turns it on.

Everything the mode needs already exists: the daemon fetches synced lyrics (LRCLIB) and
publishes `Lyrics` and `NowPlaying`; `playback.js` turns them into the line being sung
(`positionMs`, `lineIndexAt` - the LyricsPane's own timing); the compact already shows
the art, the wave, and ticks with the clock. The mode is a new arrangement of what is
there, not a new source of anything.

## Phase 1 - the karaoke compact

| # | Task | Files / API | Status |
|---|------|-------------|--------|
| 1.1 | Schema: `compact-karaoke` (b, default false), summary "The karaoke line in the closed island", description naming the three activation conditions. | `gnome-extension/schemas/org.gnome.shell.extensions.notchfolk.gschema.xml` | not built |
| 1.2 | The switch, on the Music page beside the lyrics controls, bound to `compact-karaoke`; its label says what it does: "Karaoke - the line being sung in the closed island while music plays". | `gnome-extension/src/pages/media.js` (`switchRow` from `widgets.js`, as the Music page's own controls do) | not built |
| 1.3 | The karaoke row in the compact: when the switch is on, `Playback.showsClosed(nowPlaying)` holds, the daemon's `Lyrics` for the song carry timestamps (the `LyricsPane`'s own check - see `lyrics.js`'s synced test), the row is `[art / app icon] [line] [wave]`; otherwise the compact is untouched. | `gnome-extension/src/compact.js` + `gnome-extension/src/playback.js` (`showsClosed`, `positionMs`, `lineIndexAt`) + `gnome-extension/src/daemon.js` (`Lyrics` property) | not built |
| 1.4 | The line's timing: on the compact's own tick (the clock's), `Playback.lineIndexAt(lines, Playback.positionMs(nowPlaying))` picks the line; the label fades between lines (`ease` as the island's own animations do); a line that runs long ellipsizes (`Clutter.EllipsizeMode.END`), the island's `preferredWidth` measuring it as one line's width, capped. | `gnome-extension/src/compact.js` | not built |
| 1.5 | The assistant keeps its home: the karaoke line holds the center only while the island is closed and unhovered; the pointer entering or the island opening returns the assistant button and waits the line (the compact's existing hover/assist paths). | `gnome-extension/src/compact.js` | not built |
| 1.6 | The art's left, the wave's right: reuse the compact's existing `_musicStatus` art and `_bars` - the karaoke row arranges them around the line; the art falls back to the player's app icon when a song carries none (the daemon's `Players` carry the app, as the Music page's own header shows it). | `gnome-extension/src/compact.js` + `gnome-extension/src/daemon.js` (`Players`) | not built |
| 1.7 | Styles: `.notchfolk-compact-karaoke-*` in `stylesheet.css` - the line at the compact's text size (the date's own 15px/600), the fade, the dim of a line that waits. Follow the existing `.notchfolk-*` naming. | `gnome-extension/stylesheet.css` | not built |
| 1.8 | The spec: `docs/product-spec.md` section 5 (the island's looks) gains the karaoke compact - the three conditions, the yield to the assistant, the off-by-default. | `docs/product-spec.md` | not built |
| 1.9 | Verify: `npx eslint` clean, the extension tests pass, the schema valid XML; the daemon untouched (no Rust change - the mode reads what it already publishes). | - | not built |
| 1.10 | Device test by Galih: the switch on the Music page; a song with synced lyrics plays - the line walks the island, the art left, the wave right; the pointer enters - the assistant returns; a song without lyrics - the compact as today; the switch off - the compact as today. | - | **waiting** |

## Not in scope (said no to, for the record)

- **No two-line karaoke** - the closed island holds one line; the Music page holds the
  whole lyric.
- **No Settings group** - the switch lives on the Music page, where the lyrics live.
- **No on-by-default** - the quiet compact stands; the mode is asked for.
