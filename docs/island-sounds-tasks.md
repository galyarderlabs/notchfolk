# Island sounds - tasks

Plan: [island-sounds-plan.md](island-sounds-plan.md). No phase starts until its
tasks are here and Galih has seen them. Every task names the exact file to touch
and the exact API to call; a task that does not is not ready.

## Phase 1 - the sounds themselves (the assets)

- [x] **Select or create the eight sounds**, mastered to the plan's caps and
  quietness: `open` (250 ms), `close` (200 ms), `tab` (60 ms), `click` (50 ms),
  `send` (120 ms), `answer` (300 ms), `drink` (130 ms), and `bite` (100 ms).
  The table is the law; all are synthesized by Notchfolk, mastered low, CC0.
- [x] **Place them at `gnome-extension/sounds/`** with a
  `gnome-extension/sounds/NOTICE-sounds.txt` naming each file's source and its
  CC0 licence, the pattern of `NOTICE-dancing-script.txt`.

## Phase 2 - the player and the gate (the extension's one small module)

- [x] **`gnome-extension/src/sounds.js`** - the only place that plays sounds:
  - `islandSound(name)` plays `sounds/<name>.wav` through
    `global.display.get_sound_player().play_from_file(file, 'Notchfolk', null)`.
  - Gates: the `island-sounds` setting off, locked session, DND, or a sound within
    80 ms of the last; missing files and player failures are silence.
  - `initSounds({dir, isEnabled, isDnd})` wires the extension directory and gates.
- [x] **The schema key** in `gnome-extension/schemas/...gschema.xml`:
  `island-sounds`, type `b`, default `true`, beside `chimes`.
- [x] **The Settings row** in `gnome-extension/prefs.js`: the Island section
  (or Alerts, beside `chimes` - Galih's call when he sees it):
  `switchRow(settings, 'island-sounds', 'Island sounds', 'Soft sounds for island actions, water logs and meals - one switch for all of them')`.

## Phase 3 - the moments (the hookups, each one line)

- [x] **Open and close**: `gnome-extension/src/controller.js`, in `expand()`
  after the island is on its way open → `islandSound('open')`; in `collapse()`
  → `islandSound('close')`. Only when the master switch is on (the gate checks).
- [x] **Tab turns**: `gnome-extension/src/expanded.js`, the page-switch signal
  the header already emits → `islandSound('tab')`.
- [x] **Click**: `soundOnClick` in `gnome-extension/src/widgets.js` plays `click`
  for controls; Water and Calories Add suppress it and play their semantic sound
  only after a successful log.
- [x] **Send**: `gnome-extension/src/voice.js`'s `_send()` → `islandSound('send')`.
- [x] **Answer**: `gnome-extension/src/controller.js`, where a typed or spoken
  request's answer arrives (the `settled`/reply path) → `islandSound('answer')`.
- [x] **Water and meal success**: `pages/water.js`, only after `water.Drink` returns an entry ID → `islandSound('drink')`; `pages/calories.js`, only after `calories.Add` returns an entry ID → `islandSound('bite')`. These replace the generic click sound on their Add controls.

## Phase 4 - the proof

- [x] **The tests**: the codebase's tests are GNOME-free logic (rules and
  projections), and the sounds module is nothing but GNOME calls - its acceptance
  test is the listen-through below, at the machine, as the plan's constraints
  are the test.
- [ ] **The listen-through**: Galih at his machine, an hour of normal work with
  the sounds on. If any sound draws attention to itself, it is re-mastered or
  cut - the plan's constraints are the acceptance test.
- [ ] **After the listen-through, the paper trail**: README's "Also:" line gains "soft island sounds";
  `docs/usage.md`'s Settings section gains the switch; `CHANGELOG.md`'s
  Unreleased gains the feature.

## Out of scope (said here so it is not relitigated)

- Per-moment toggles, volume sliders, per-page sounds.
- Sounds for hover, scrolling, vitals updates, karaoke lines, typing.
- Replacing the alert system's own sounds or the `chimes` switch.
