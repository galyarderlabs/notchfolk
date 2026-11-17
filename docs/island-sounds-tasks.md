# Island sounds - tasks

Plan: [island-sounds-plan.md](island-sounds-plan.md). No phase starts until its
tasks are here and Galih has seen them. Every task names the exact file to touch
and the exact API to call; a task that does not is not ready.

## Phase 1 - the sounds themselves (the assets)

- [ ] **Select or create the seven sounds**, mastered to the plan's caps and
  quietness: `open` (250 ms), `close` (200 ms), `tab` (60 ms), `click` (50 ms),
  `send` (120 ms), `answer` (300 ms) - six, plus nothing; the table is the law.
  Source: CC0 sound libraries (e.g. Kenney's UI audio, CC0; or
  [uisfx](https://github.com/romainsimon/uisfx)'s CC0 procedural packs), trimmed
  and levelled to a low master. Delivered as Ogg Vorbis, mono, 44.1 kHz.
- [ ] **Place them at `gnome-extension/sounds/`** with a
  `gnome-extension/sounds/NOTICE-sounds.txt` naming each file's source and its
  CC0 licence, the pattern of `NOTICE-dancing-script.txt`.

## Phase 2 - the player and the gate (the extension's one small module)

- [ ] **`gnome-extension/src/sounds.js`** - a new module, the only place that
  plays anything:
  - `export function islandSound(name)` - plays
    `Extension.lookupByURL(...)`'s `sounds/<name>.ogg` via
    `global.display.get_sound_player().play(fileUri, 'Notchfolk', null)`.
  - The gate inside it, in order: the `island-sounds` setting off → return;
    `Main.sessionMode.isLocked` → return; the island's Do Not Disturb
    (`notchfolk`'s own DND state as the alerts read it) → return; a sound within
    80 ms of the last → return (the never-stacked rule).
  - A missing file is a no-op with no error (the player's callback swallows it).
- [ ] **The schema key** in `gnome-extension/schemas/...gschema.xml`:
  `island-sounds`, type `b`, default `true`, beside `chimes`.
- [ ] **The Settings row** in `gnome-extension/prefs.js`: the Island section
  (or Alerts, beside `chimes` - Galih's call when he sees it):
  `switchRow(settings, 'island-sounds', 'Island sounds', 'Soft sounds when the island opens, tabs turn and messages go')`.

## Phase 3 - the moments (the hookups, each one line)

- [ ] **Open and close**: `gnome-extension/src/controller.js`, in `expand()`
  after the island is on its way open → `islandSound('open')`; in `collapse()`
  → `islandSound('close')`. Only when the master switch is on (the gate checks).
- [ ] **Tab turns**: `gnome-extension/src/expanded.js`, the page-switch signal
  the header already emits → `islandSound('tab')`.
- [ ] **Click**: `gnome-extension/src/widgets.js`'s `pillButton` (and the
  segmented `St.Button`s the pages make) → `islandSound('click')` on `clicked`.
  One central helper, not a hunt through every page.
- [ ] **Send**: `gnome-extension/src/voice.js`'s `_send()` → `islandSound('send')`.
- [ ] **Answer**: `gnome-extension/src/controller.js`, where a typed or spoken
  request's answer arrives (the `settled`/reply path) → `islandSound('answer')`.

## Phase 4 - the proof

- [ ] **The tests** (`tests/extension/`): the gate (setting off, DND, locked,
  the 80 ms rule) and each moment firing exactly once per gesture.
- [ ] **The listen-through**: Galih at his machine, an hour of normal work with
  the sounds on. If any sound draws attention to itself, it is re-mastered or
  cut - the plan's constraints are the acceptance test.
- [ ] **The paper trail**: README's "Also:" line gains "soft island sounds";
  `docs/usage.md`'s Settings section gains the switch; `CHANGELOG.md`'s
  Unreleased gains the feature.

## Out of scope (said here so it is not relitigated)

- Per-moment toggles, volume sliders, per-page sounds.
- Sounds for hover, scrolling, vitals updates, karaoke lines, typing.
- Replacing the alert system's own sounds or the `chimes` switch.
