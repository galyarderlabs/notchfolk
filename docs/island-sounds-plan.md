# Notchfolk Island Sounds — the island answers in audio

Plan for the island's interaction sounds - Galih's idea, agreed with him: the island
feels premium and alive when its gestures answer in audio, the way a Wayland shell
like Serpantinum does with its UI sounds, but Notchfolk's own: quiet, short, and
never in the way. The remaining work is tracked in
[island-sounds-tasks.md](island-sounds-tasks.md).

## The value

The island already answers in motion - it springs open, the pages slide, the ring
sweeps. Sound is the other half of "alive": a soft whoosh as it opens, a tick as a
tab turns, a pop as a message goes. Done right, the user never notices the sounds
themselves - they notice the island *feels* more like a thing than a panel.

Done wrong, it is a toy that annoys by lunch. The whole design is therefore
constraints, not features.

## The constraints (what makes it premium)

- **Short.** No sound longer than 300 ms. Most under 150 ms.
- **Quiet.** The sounds ride the desktop's event audio stream (the one the volume
  slider calls "System Sounds"), so the user's own volume settings govern them;
  the files themselves are mastered low (-18 LUFS-ish, quiet by design).
- **Sparse.** Only the moments below. A sound that plays often stops being feedback
  and becomes noise: no sound on hover, none on scrolling, none on the vitals
  updating, none on karaoke lines.
- **Never stacked.** A sound never interrupts or overlaps another of ours; a new
  one within 80 ms of the last is dropped.
- **Silence rules.** All island sounds stop when: Do Not Disturb is on, the
  session is locked, or the user turned the master switch off. The existing
  `chimes` setting (timer and reminder chimes) stays its own switch, untouched.
- **On by default, but quiet.** Premium things speak first and ask later: the
  sounds ship on, mastered so low that most users hear "alive", not "noisy", and
  one switch turns them all off.

## The moments

| Moment | Sound | Character | Cap |
|---|---|---|---|
| The island opens | `open` | a soft airy swell, in and up | 250 ms |
| The island closes | `close` | the same swell reversed, softer still | 200 ms |
| A tab turns | `tab` | a tick, like a well-oiled detent | 60 ms |
| A control is clicked (a segment, the pin, a page's own button) | `click` | a small rounded click | 50 ms |
| A message is sent to the assistant | `send` | a short pop, forward | 120 ms |
| A request to the assistant is answered | `answer` | a two-note chime, gentle | 300 ms |
| The assistant starts speaking | — | none: its voice is the sound | — |
| An alert arrives | — | the alert system keeps its own; nothing added | — |
| A focus session ends | — | the existing `chimes` switch keeps it | — |

Anything not in this table has no sound. Adding a moment means adding it to this
table first, with its cap, in this file.

## The player

GNOME Shell's own: `global.display.get_sound_player()`, exactly as the timer's
chime already uses (`play_from_theme`). For our own sounds the player's
`play(file, app, callback)` plays a bundled file on the event audio stream - no
daemon, no `pw-play`, no subprocess, no new moving parts. The sound files live in
the extension's own directory (`gnome-extension/sounds/`), named exactly as the
table above, in Ogg Vorbis (the format GNOME's theme sounds ship in).

Where a freedesktop sound-theme name fits a moment well (today: none does better
than our own files), `play_from_theme` is the fallback if a bundled file is
missing - the island never errors on a sound.

## The settings

One master switch: **Island sounds** (Settings → Island, beside the chimes
switch's own Alerts section): "Soft sounds when the island opens, tabs turn and
messages go - one switch for all of them". The schema key `island-sounds`
(default true). No per-moment toggles: a sound design with nine switches is a
settings page, not a design. Volume is the desktop's event volume, not ours.

## What this is not

- Not a notification sound system - alerts keep their own.
- Not the assistant's voice - that is speech, not feedback.
- Not per-page: the moments are the island's own gestures, shared by every page.
