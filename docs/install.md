# Installing Notchfolk

Three steps and an optional fourth: about a minute, no root and nothing to compile.

## 1. Check your desktop

Notchfolk runs on **GNOME Shell 46 to 51** on a 64-bit Intel or AMD PC. Check
in a terminal:

```sh
gnome-shell --version   # GNOME Shell 46.x up to 51.x
uname -m                # x86_64
```

Each of these was installed with the command below and checked:

| GNOME Shell | Ubuntu | Fedora Workstation | Debian |
|---|---|---|---|
| 46 | 24.04 LTS | 40 | |
| 47 | 24.10 | 41 | |
| 48 | 25.04 | 42 | 13 |
| 49 | 25.10 | 43 | |
| 50 | 26.04 LTS | 44 | |
| 51 | 26.10 | 45 | |

Other systems with one of these GNOME Shell versions work the same way.
Other desktops (KDE Plasma, Cinnamon, XFCE, COSMIC, …) cannot load GNOME
Shell extensions, so Notchfolk does not run there; nor does it run on ARM
computers (Raspberry Pi and other ARM machines), for which there are no ready-built
programs.

## 2. Install

Paste this into a terminal and press Enter:

```sh
curl -fsSL https://raw.githubusercontent.com/galyarderlabs/notchfolk/main/get.sh | bash
```

(`curl: command not found`? Install it first: `sudo apt install curl`.)

It downloads the latest release, checks its checksum and installs it for
your user. It ends with `==> Notchfolk 1.x.y is installed` and what to do next:
log out and back in, and how to check or remove Notchfolk. Run it as yourself,
**without sudo**: everything goes in your own home folder, and it refuses to
run as root. On a GNOME Shell version Notchfolk was not made for it stops before
changing anything.

## 3. Log out and back in

GNOME Shell on Wayland only loads a new extension at login, so log out and
back in once. (On GNOME 46 to 48 with an X11 session you can instead press
Alt+F2, type `r` and press Enter.)

The island now sits in the middle of the top bar, in place of the clock.
Rest the pointer on it to open it.

## 4. The voice assistant (optional)

Everything else works without it. To ask the island things out loud with
Super+I:

1. Install and sign in to one of Claude Code, Codex, Grok, opencode or Antigravity (the
   assistant guide says how; each uses your own plan).
2. Set up speech recognition once, in a terminal. It downloads the speech
   model picked in Settings → Assistant (`small`, 265 MB, by default; or name
   one, which Settings then uses: `notchfolk-setup-voice base`) and needs nothing
   else installed. A graphics
   card is used through Vulkan when there is one, else the processor:

   ```sh
   ~/.local/bin/notchfolk-setup-voice
   ```

   Set up with an older Notchfolk, speech recognition used a Python environment
   of up to 3 GB; updating Notchfolk with the installer downloads the new model
   and deletes it by itself (`notchfolk-setup-voice --remove-old` does the same by
   hand). In the assistant, a **Set up** button opens a terminal that runs
   `notchfolk-setup-voice` for you.

3. Pick the AI in Notchfolk's Settings → Assistant, or leave it on Automatic,
   and press Super+I. An AI installed later is found by itself.

`notchfolk-setup-voice` ends by checking what Notchfolk itself finds; run the same check
any time:

```sh
~/.local/bin/notchfolkd --doctor
```

(Notchfolk's commands are in `~/.local/bin`. When that folder is on your PATH,
which the installer checks, their names alone do.)

It lists speech recognition (its models, and the GPU or processor it runs
on) and each AI, where it is installed and whether
you are signed in. Notchfolk finds AIs installed with npm (also a prefix of your
own), nvm, volta, fnm, pnpm, bun, Homebrew, mise, asdf, Nix or their own
installers, and takes what your login shell sets for them
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, an API key, a proxy).

## Updating

Notchfolk tells you in the island when a new version is out.

1. Click **Update** in that alert, or open Notchfolk's Settings → **About**.
2. Click **Update**. It takes a few seconds; no password is needed, and you
   can close Settings meanwhile.
3. Click **Log Out** and log back in.

Your tasks, calendar events, clipboard history and settings stay.

**Notchfolk 1.3 or older**, or the button didn't work? Paste this in a terminal,
press Enter, then log out and back in:

```sh
curl -fsSL https://raw.githubusercontent.com/galyarderlabs/notchfolk/main/get.sh | bash
```

**Installed from a package?** Update it the way you installed it: download
the new `.deb` or `.rpm` from [Releases](https://github.com/galyarderlabs/notchfolk/releases/latest)
and open it, or on Arch run `git pull` and `makepkg -si` again in
`packaging/aur`. Then log out and back in. Don't also run the command above: it would add a second copy (see
[below](#both-a-package-and-the-one-line-install)).

To install a particular version, put `NOTCHFOLK_VERSION` before `bash`:
`… | NOTCHFOLK_VERSION=1.0.5 bash`.

## Uninstalling

```sh
~/.local/bin/notchfolk-uninstall
```

This removes the extension, its programs, its service and its font, the
voice assistant's speech recognition and its models, Notchfolk's caches, and a
battery charge limit Notchfolk set (asking for your password), and takes Notchfolk's
hooks out of Claude Code's and Codex's settings. Your tasks,
calendar events, clipboard history, timer settings and app usage (if you
turned the Apps page on) stay in `~/.local/share/notchfolk`; delete it too to
remove everything.

Remove Notchfolk this way, not with the Extensions app's Remove button: that
deletes only the extension, and leaves `notchfolkd`, its service and its hooks.
A system-wide package is removed as [below](#both-a-package-and-the-one-line-install).

## Without internet on the computer

Download `notchfolk-<version>-x86_64-linux.tar.gz` from
[Releases](https://github.com/galyarderlabs/notchfolk/releases) on another computer,
copy it over, then:

```sh
tar -xzf notchfolk-*-x86_64-linux.tar.gz
cd notchfolk-*-x86_64-linux
./install.sh
```

## Other ways to install

### Ubuntu and Debian (.deb), Fedora (.rpm)

Each [release](https://github.com/galyarderlabs/notchfolk/releases) also has
system-wide packages, installed for every user of the computer with the
system's package manager (so they update and uninstall with it):

```sh
sudo apt install ./notchfolk_*_amd64.deb        # Ubuntu 24.04 and newer, Debian 13
sudo dnf install ./notchfolk-*.x86_64.rpm       # Fedora 40 and newer
```

They put the programs in `/usr/bin`, the extension in
`/usr/share/gnome-shell/extensions`, and the rest where the system expects
it. GNOME Shell only finds a new extension at login, and turns extensions
on per user: so each user logs out and back in, then turns Notchfolk on once, in
the Extensions app or with:

```sh
gnome-extensions enable io.galyarderlabs.notchfolk
```

`notchfolkd` starts on its own when the extension first calls it. The voice
assistant is set up per user as above, with `notchfolk-setup-voice`.

### Arch Linux

The AUR package (`notchfolk-bin`) is prepared — see the `PKGBUILD` in
[`packaging/aur`](../packaging/aur) — but it is not published yet, so
`yay -S notchfolk-bin` finds nothing for now. Build it straight from this
repository instead:

```sh
sudo pacman -S --needed base-devel git
git clone --depth 1 https://github.com/galyarderlabs/notchfolk.git
cd notchfolk/packaging/aur
makepkg -si
# Log out and back in, then:
gnome-extensions enable io.galyarderlabs.notchfolk
```

To update, run `git pull` in that folder and `makepkg -si` again.

### Both a package and the one-line install

A copy installed with `get.sh`, in your home folder, takes precedence for
you over a system-wide package: GNOME Shell, D-Bus and systemd all look in
your home folder first. Run `notchfolk-uninstall` to remove your own copy; the
package's then takes over, with your settings and data kept.

Before removing the package itself, each user who ran Notchfolk takes its alert
hooks out of Claude Code's and Codex's settings, which would otherwise call
an `notchfolkd` that is gone. A battery charge limit set with the assistant
stays after the package goes, so lift it first too:

```sh
notchfolkd --unhook-all
notchfolk-charge-limit 100       # only if the assistant set a charge limit
sudo apt remove notchfolk        # or: sudo dnf remove notchfolk, sudo pacman -R notchfolk-bin
```

### Checking a download

Release files are built by GitHub Actions from the tagged source, with a
build provenance attestation. With the [GitHub CLI](https://cli.github.com):

```sh
gh attestation verify notchfolk-*-x86_64-linux.tar.gz --repo galyarderlabs/notchfolk
```

`get.sh` checks each download against its `.sha256` already.

### From source

For development or other architectures. You need Rust 1.92 or newer (1.88 without the shelf helper) ([rustup](https://rustup.rs); Ubuntu 24.04's own `cargo` is too old), for the shelf's drag and drop the GTK 4 development files, and for the voice assistant's speech recognition (whisper.cpp) cmake, libclang, and for the GPU the Vulkan headers and glslc:

```sh
sudo apt install git build-essential pkg-config libgtk-4-dev cmake libclang-dev libvulkan-dev glslc
# Fedora: git gcc-c++ pkgconf gtk4-devel cmake clang-devel vulkan-loader-devel glslc
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
git clone https://github.com/galyarderlabs/notchfolk.git
cd notchfolk
./install.sh
```

## What the installer changes

Everything goes in your home folder:

| Where | What |
|---|---|
| `~/.local/share/gnome-shell/extensions/io.galyarderlabs.notchfolk` | The GNOME Shell extension |
| `~/.local/bin` | `notchfolkd` (the background service), `notchfolk-shelf` (drag and drop), `notchfolk-whisper` (speech recognition), `notchfolk-uninstall`, `notchfolk-setup-voice`, `notchfolk-charge-limit` |
| `~/.config/systemd/user`, `~/.local/share/dbus-1/services` | Starting `notchfolkd` with your session |
| `~/.local/share/fonts/notchfolk` | Inter, the island's typeface |
| `~/.local/share/notchfolk` | Your data, and the speech models `notchfolk-setup-voice` downloads (`models`) |
| `~/.local/share/doc/notchfolk` | This README |

Once running, Notchfolk adds its hooks to Claude Code's `~/.claude/settings.json`
and Codex's `~/.codex/hooks.json` when it finds them, so they ask you on
the island (Codex asks once, at its next start, to trust them); turning
them off in Settings → AI Usage → AI Agents, or uninstalling, takes them
out. Commands you run from the assistant keep their logs in
`~/.cache/notchfolk/runs` until they end.

On a first install only, it sets Notchfolk's look (a slim glass top bar with the
island in it); updates leave it as you have it. It never changes other
extensions: when one would fight with the island (Blur my Shell's top bar
blur, or an extension that takes the same place in the top bar, such as Hide
Top Bar), it ends with a recommendation and the command to turn that off. If
GNOME's extensions were switched off altogether (the Extensions app's main
switch), it switches them on.

## If something goes wrong

**The island does not appear.** Log out and back in once more, then check:

```sh
gnome-extensions info io.galyarderlabs.notchfolk   # State: ACTIVE (or ENABLED)
```

If it says `OUT OF DATE`, your GNOME Shell version is outside 46 to 51. If
it says `ERROR`, that is most likely a bug in Notchfolk: please
[open an issue](https://github.com/galyarderlabs/notchfolk/issues) with GNOME Shell's
log (see **Anything else** below).

**A phone can't open the Shelf.** It must be on the same Wi-Fi as the
computer. A firewall that blocks incoming connections keeps it out too: see
the [usage guide](usage.md#troubleshooting) for the ufw and firewalld commands.

**Music does not show.** Check the background service:
`systemctl --user status notchfolkd`.

**The voice assistant does not answer.** Run `~/.local/bin/notchfolkd --doctor` (with a .deb, .rpm
or AUR package, `notchfolkd --doctor`): it says what is missing (speech recognition, an AI, or its
sign-in) and what to run.

**Anything else.** GNOME Shell's log shows extension errors:
`journalctl -b -o cat /usr/bin/gnome-shell | grep -i notchfolk`. Please
[open an issue](https://github.com/galyarderlabs/notchfolk/issues) with what it says
and the output of `gnome-shell --version`.
