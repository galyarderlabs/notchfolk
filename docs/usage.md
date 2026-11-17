# Using Notchfolk

This guide covers everyday use, the settings, troubleshooting and uninstalling. For installing, see the [installation guide](install.md); for the README, [go up](../README.md).

## Usage

| Do this | To |
|---|---|
| Rest the pointer on the notch | Open the island (or click it, if Settings say so) |
| Click a tab, or scroll or swipe over the tabs | Switch pages (scrolling a page's own content never does) |
| Move the pointer away, or press Esc | Close it |
| Click the notch | Open it now; on an alert, open what it is about |
| Middle-click the notch | Play or pause |
| Rest the pointer on an alert | Keep it until the pointer leaves |
| Swipe up or down on an alert (touchpad) | Put it away, or open it |
| Right-click the notch | Put an alert away; else bring the call, or the music player, to the front |
| Super+V | Open the clipboard history with search ready; Enter pastes |
| Drag a file towards the notch | Open the files tray to drop it |
| Super+I | Ask the voice assistant; press again to finish speaking, or after an answer to ask more. Start typing (or click the keyboard) to type the request instead |
| Enter or Esc on the assistant's card | Run or Deny the command it shows |

The island reopens on the page you picked last (for five minutes), or on
what is live: a call, unseen notifications, music, a running timer. With two
music players running, the music page shows the other one's icon to switch
to it.

While a window is fullscreen (a video, a game), the island stays out of the
way: alerts, notifications and reminders wait and show once it is gone, and
a burst of notifications comes as one ("6 new notifications"), each still
unread in the list. A reminder stays until you are back at the computer.
While you share or record the screen, alerts leave out what notifications
say, and the clipboard history stays hidden. If Notchfolk's background service
stops, a warning shows in the closed island; click it to start it again.

## Settings

Click the gear right of the clock in the open island (or Notchfolk's gear in the
**Extensions** app):

- **Island:** Notchfolk's own black island, or Glass, clear dark glass that shows what
  is behind it (windows and wallpaper) blurred, with a slider from clear to dark smoked glass; the top bar on a slider from glass (default) to black, and black anyway while a window reaches it (off by default);
  a little space below the island inside the bar (on by default); auto-hide (always, with a top bar that hides, or beside maximized windows; off by default); a 24- or 12-hour clock (or as GNOME's); privacy dots; which pages the open island has (Music,
  Notifications, Timer, Reminders, Shelf, Calendar, Apps, AI Usage, Vitals) and whether it
  has the AI assistant at all; world clocks, and their cities;
  the closed island inside the bar or hanging below it; with more than one
  display, on the main one or the one you are using; opening when the
  pointer rests on it (and for how long) or only on a click; how long auto-hide waits.
- **Alerts:** apps' notifications in the island (or GNOME's own banners
  instead); over full-screen apps too (off by default); volume and brightness; charging, network, Bluetooth and Caps
  Lock, each on its own; new songs, sounds; lyrics online;
  a reminder before calendar events, and how many minutes before.
  Alerts other than a low battery are not shown while Do Not Disturb is on.
- **Calls:** show calls in the island, and the live preview of the call.
- **Weather:** the city, or following the GNOME World Clock nearest your time
  zone; the temperature's unit — auto, Celsius or Fahrenheit.
- **Clipboard:** turn the history on or off, clear it, what Super+V opens (the
  clipboard history, or GNOME's calendar), and choose apps whose copies are never
  kept (password managers are on the list from the start).
- **Shelf:** how many files the files tray holds — as many as you like; a long
  row scrolls.
- **Timer:** session and break lengths, Do Not Disturb while focusing.
- **Vitals:** the page on or off, which vital rides the closed island beside the
  wave (none by default), and the temperature's unit — auto (the locale's own),
  Celsius or Fahrenheit.
- **Assistant:** the bot's look (shape, colour, glow, with a live
  preview); the assistant on or off, its shortcut, which AI answers and with
  which model (only those your plan includes, with your plan's name), speech recognition, language, and whether it may use the text
  you selected (off by default) or read your notifications; how long a quiet
  conversation is kept, and clearing it now.
- **AI Usage:** on or off, which plans to show, and when to warn; and
  under **AI Agents**, a switch for each of Claude Code and Codex that is
  installed (on by default; none listed when neither is).
- **About:** the version and whether it is up to date (with how to update,
  and the switch for asking GitHub once a day), help, a bug report to copy
  (`notchfolkd --report`), and resetting every setting.

## Troubleshooting

**The island does not appear after installing.** Log out and back in (on
Wayland this is required once). Then check that it is enabled:
`gnome-extensions info io.galyarderlabs.notchfolk`.

**Music or lyrics do not show.** Check that the background service runs:
`systemctl --user status notchfolkd`, and read its log with
`journalctl --user -u notchfolkd -f`. Songs LRCLIB does not know show "No lyrics
found"; a busy service retries on its own.

**Files cannot be dragged in or out.** The release package includes the
drag-and-drop helper; when building from source, install `libgtk-4-dev`
(Fedora: `gtk4-devel`) and run `./install.sh` again.

**A phone can't open the Shelf.** It must be on the same Wi-Fi as the computer
(not a guest network that keeps devices apart). A firewall that blocks
incoming connections keeps it out too: with ufw, the island offers the
command (**Copy fix**), `sudo ufw allow from <your network> to any port 47830:47839 proto tcp`;
with firewalld on a zone that blocks them (Fedora Workstation's own does not),
`sudo firewall-cmd --permanent --add-port=47830-47839/tcp && sudo firewall-cmd --reload`.
Notchfolk never changes the firewall itself, and listens only while you share.

**Another extension covers the island.** Extensions that restyle or move the
top bar (Dash to Panel, Hide Top Bar, other islands) can get in the way;
turn them off in the Extensions app.

**The voice assistant does not answer.** Run `~/.local/bin/notchfolkd --doctor`: it says what
is missing (speech recognition, an AI, or its sign-in) and what to run.

**Something else.** Run `~/.local/bin/notchfolkd --report` (or Settings → About → Copy a bug
report): it gathers the versions, what works and recent logs, without your
data. Please [open an issue](../../issues) and paste it there.

With a .deb, .rpm or AUR package, Notchfolk's commands are in `/usr/bin`: run
them by name alone (`notchfolkd --doctor`, `notchfolkd --report`).

## Uninstalling

```sh
~/.local/bin/notchfolk-uninstall
```

(or `./uninstall.sh` from the release package or the source folder). This
removes the extension, the programs, the service, the font, the voice
assistant's speech recognition and Notchfolk's caches, and lifts a battery charge
limit Notchfolk set; it also takes Notchfolk's hooks out of Claude Code's and Codex's
settings. Your tasks, calendar events, clipboard history, shelf and
timer settings stay in `~/.local/share/notchfolk` until you delete them.

Remove Notchfolk this way, not with the Extensions app's Remove button, which
deletes only the extension and leaves `notchfolkd` and its hooks behind. For a
system-wide package, each user runs `notchfolkd --unhook-all` first (and
`notchfolk-charge-limit 100` if the assistant set a battery charge limit), then
remove it with `sudo apt remove notchfolk`, `sudo dnf remove notchfolk` or
`sudo pacman -R notchfolk-bin`.
