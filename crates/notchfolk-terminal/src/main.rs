// SPDX-License-Identifier: GPL-3.0-or-later

//! A single GTK application owns the terminal widgets; hiding never closes their PTYs.
//! Only the standard GApplication activation and quit action are exported, not shell input.

mod appearance;
mod session;

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};

use gtk::subclass::prelude::ObjectSubclassIsExt;
use gtk::{gdk, gio, glib, pango};
use gtk4 as gtk;
use vte4::prelude::*;

use session::{Session, TerminalTarget, available_terminals, preferred_terminal};

const APP_ID: &str = "io.galyarderlabs.notchfolk.Terminal";
const APP_PATH: &str = "/io/galyarderlabs/notchfolk/Terminal";
const SETTINGS_SCHEMA: &str = "org.gnome.shell.extensions.notchfolk";
const TERMINAL_FONT_KEY: &str = "terminal-font";
const EXTERNAL_TERMINAL_KEY: &str = "terminal-external-app";
const DEFAULT_TERMINAL_FONT: &str = "Monospace 10";
const COMPACT_SIZE: (i32, i32) = (460, 240);
const EXPANDED_SIZE: (i32, i32) = (880, 480);
const HELP: &str = "Notchfolk Terminal — live shell tabs\n\
Usage: notchfolk-terminal [--toggle | --quit | --list-terminals | --help | --version]\n\
  No option   Show the terminal, keeping existing tabs\n\
  --toggle    Hide or show without stopping shells\n\
  --quit      Close this user's running helper; never start one\n\
  --list-terminals  List installed handoff targets without opening a display\n\
  --help      Show this help without opening a display\n\
  --version   Show the version without opening a display\n\n\
Default keys: Ctrl+Shift+T new tab; Ctrl+Shift+W close tab; Ctrl+Shift+E expand;\n\
Ctrl+Shift+C/V copy/paste; Ctrl+PageUp/PageDown switch tabs; Ctrl+Shift+Q hide.\n\
Tab and ordinary shell shortcuts are passed to the terminal by default.\n\
Scroll with the mouse wheel; tmux copy mode also uses Ctrl+B then PageUp.\n\n\
Local shortcuts: edit ~/.config/notchfolk/terminal-shortcuts.ini (or under\n\
$XDG_CONFIG_HOME), then quit and reopen the helper. Example:\n\
[shortcuts]\n\
new-tab=<Control><Shift>t\n\
close-tab=<Control><Shift>w\n\
expand=<Control><Shift>e\n\
hide=<Control><Shift>q\n\
copy=<Control><Shift>c\n\
paste=<Control><Shift>v\n\
previous-tab=<Control>Page_Up\n\
next-tab=<Control>Page_Down\n\
handoff=\n\
Use GTK accelerator syntax. Empty disables an action's shortcut; missing or\n\
invalid entries keep its default. The global shortcut starts unset; choose one\n\
in the extension's Island → Shortcuts settings.\n";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Request {
    Show,
    Toggle,
    Quit,
    Help,
    Version,
    ListTerminals,
}

fn parse_request(args: impl IntoIterator<Item = OsString>) -> Result<Request, &'static str> {
    let mut args = args.into_iter();
    let request = match args.next().as_deref() {
        None => Request::Show,
        Some(arg) if arg == OsStr::new("--toggle") => Request::Toggle,
        Some(arg) if arg == OsStr::new("--quit") => Request::Quit,
        Some(arg) if arg == OsStr::new("--help") || arg == OsStr::new("-h") => Request::Help,
        Some(arg) if arg == OsStr::new("--version") || arg == OsStr::new("-V") => Request::Version,
        Some(arg) if arg == OsStr::new("--list-terminals") => Request::ListTerminals,
        Some(_) => return Err("Unknown option. Run notchfolk-terminal --help for usage."),
    };
    if args.next().is_some() {
        return Err("Use only one option. Run notchfolk-terminal --help for usage.");
    }
    Ok(request)
}

fn main() -> glib::ExitCode {
    let request = match parse_request(std::env::args_os().skip(1)) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("notchfolk-terminal: {error}");
            return glib::ExitCode::FAILURE;
        }
    };
    // These paths must work before GTK initialization, including on headless package checks.
    match request {
        Request::Help => {
            print!("{HELP}");
            return glib::ExitCode::SUCCESS;
        }
        Request::Version => {
            println!("notchfolk-terminal {}", env!("CARGO_PKG_VERSION"));
            return glib::ExitCode::SUCCESS;
        }
        Request::ListTerminals => {
            // URI-escaped UTF-8 ID and label, tab-separated, one target per line.
            // This is the sole discovery backend used by extension preferences.
            for target in available_terminals() {
                println!(
                    "{}\t{}",
                    glib::uri_escape_string(target.id, None::<&str>, false),
                    glib::uri_escape_string(target.label, None::<&str>, false)
                );
            }
            return glib::ExitCode::SUCCESS;
        }
        Request::Quit => {
            return match quit_existing() {
                Ok(()) => glib::ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("notchfolk-terminal: could not close the running helper: {error}");
                    glib::ExitCode::FAILURE
                }
            };
        }
        Request::Show | Request::Toggle => {}
    }

    glib::set_application_name("Notchfolk Terminal");
    let app = gtk::Application::builder()
        .application_id(APP_ID)
        .flags(gio::ApplicationFlags::HANDLES_COMMAND_LINE)
        .build();
    app.add_main_option(
        "toggle",
        glib::Char::from(0),
        glib::OptionFlags::NONE,
        glib::OptionArg::None,
        "Hide or show the existing terminal",
        None,
    );
    let state = Rc::new(RefCell::new(None::<Rc<TerminalWindow>>));
    app.connect_startup(|_| {
        gtk::Window::set_default_icon_name(APP_ID);
        let provider = gtk::CssProvider::new();
        provider.load_from_string(include_str!("style.css"));
        if let Some(display) = gdk::Display::default() {
            gtk::style_context_add_provider_for_display(
                &display,
                &provider,
                gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
            );
        }
    });
    let activate_state = state.clone();
    app.connect_activate(move |app| show(app, &activate_state, None, false));
    let command_state = state.clone();
    app.connect_command_line(move |app, command| {
        show(
            app,
            &command_state,
            command.cwd(),
            command.options_dict().contains("toggle"),
        );
        glib::ExitCode::SUCCESS
    });
    let quit = gio::SimpleAction::new("quit", None);
    let quit_state = state.clone();
    let weak_app = app.downgrade();
    quit.connect_activate(move |_, _| {
        let window = quit_state.borrow().clone();
        if let Some(window) = window {
            window.request_quit();
        } else if let Some(app) = weak_app.upgrade() {
            app.quit();
        }
    });
    app.add_action(&quit);
    let hide = gio::SimpleAction::new("hide", None);
    let hide_state = state.clone();
    hide.connect_activate(move |_, _| hide_existing_window(&hide_state));
    app.add_action(&hide);
    for action in ["restore", "detach"] {
        let restore = gio::SimpleAction::new(action, None);
        let restore_state = state.clone();
        restore.connect_activate(move |_, _| {
            restore_existing_window(&restore_state, action == "detach");
        });
        app.add_action(&restore);
    }
    let expanded = expanded_state_action();
    app.add_action(&expanded);
    let fit = gio::SimpleAction::new(
        "fit-viewport",
        Some(glib::VariantTy::new("(ii)").expect("valid viewport parameter type")),
    );
    let fit_state = state.clone();
    fit.connect_activate(move |_, parameter| {
        if let Err(error) = fit_existing_window(&fit_state, parameter) {
            eprintln!("notchfolk-terminal: fit-viewport: {error}");
        }
    });
    app.add_action(&fit);
    let signals = [libc::SIGTERM, libc::SIGINT].map(|signal| {
        let signal_state = state.clone();
        let weak_app = app.downgrade();
        glib_unix::unix_signal_add_local(signal, move || {
            let window = signal_state.borrow().clone();
            if let Some(window) = window {
                window.request_quit();
            } else if let Some(app) = weak_app.upgrade() {
                app.quit();
            }
            glib::ControlFlow::Continue
        })
    });
    app.connect_shutdown(move |_| {
        if let Some(window) = state.borrow_mut().take() {
            window.clear_tabs();
            window.window.destroy();
        }
    });
    let exit = if request == Request::Toggle {
        app.run_with_args(&["notchfolk-terminal", "--toggle"])
    } else {
        app.run_with_args(&["notchfolk-terminal"])
    };
    for signal in signals {
        signal.remove();
    }
    exit
}

fn quit_existing() -> Result<(), glib::Error> {
    let bus = gio::bus_get_sync(gio::BusType::Session, None::<&gio::Cancellable>)?;
    let owner = match bus.call_sync(
        Some("org.freedesktop.DBus"),
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "GetNameOwner",
        Some(&(APP_ID,).to_variant()),
        None,
        gio::DBusCallFlags::NO_AUTO_START,
        3000,
        None::<&gio::Cancellable>,
    ) {
        Ok(reply) => {
            reply
                .get::<(String,)>()
                .ok_or_else(|| {
                    glib::Error::new(
                        gio::IOErrorEnum::InvalidData,
                        "The session bus returned an invalid owner",
                    )
                })?
                .0
        }
        Err(error) if absent_owner(&error) => return Ok(()),
        Err(error) => return Err(error),
    };
    // Address the unique owner, never the activatable application name: if it exits
    // between these calls, shutdown must not resurrect a new helper or shell.
    let parameters = (
        "quit",
        Vec::<glib::Variant>::new(),
        HashMap::<String, glib::Variant>::new(),
    )
        .to_variant();
    match bus.call_sync(
        Some(&owner),
        APP_PATH,
        "org.freedesktop.Application",
        "ActivateAction",
        Some(&parameters),
        None,
        gio::DBusCallFlags::NO_AUTO_START,
        3000,
        None::<&gio::Cancellable>,
    ) {
        Ok(_) => Ok(()),
        Err(error) if absent_owner(&error) => Ok(()),
        Err(error) => Err(error),
    }
}

fn absent_owner(error: &glib::Error) -> bool {
    error.matches(gio::DBusError::NameHasNoOwner) || error.matches(gio::DBusError::ServiceUnknown)
}

fn show(
    app: &gtk::Application,
    state: &RefCell<Option<Rc<TerminalWindow>>>,
    cwd: Option<PathBuf>,
    toggle: bool,
) {
    let window = {
        let mut state = state.borrow_mut();
        state
            .get_or_insert_with(|| TerminalWindow::new(app))
            .clone()
    };
    if window.quitting.get() {
        return;
    }
    if toggle && window.window.is_visible() {
        window.hide();
        return;
    }
    if window.tabs.borrow().is_empty() {
        window.new_tab(cwd, None);
    }
    window.window.present();
    window.focus_current();
    window.refresh_current();
}

fn hide_existing_window(state: &RefCell<Option<Rc<TerminalWindow>>>) {
    let window = state.borrow().clone();
    if let Some(window) = window {
        window.hide();
    }
}

fn restore_existing_window(state: &RefCell<Option<Rc<TerminalWindow>>>, detach: bool) {
    let window = state.borrow().clone();
    if let Some(window) = window
        && !window.quitting.get()
    {
        if detach {
            window.set_embedded(false);
        }
        // Page navigation is not application activation: preserve even an empty
        // notebook, and map without present(), focus_current() or a new shell.
        window.window.set_visible(true);
    }
}

fn expanded_state_action() -> gio::SimpleAction {
    let action = gio::SimpleAction::new_stateful("expanded", None, &false.to_variant());
    // This is observable mode, not a remote toggle. Disabling activation alone
    // does not reject GAction change-state requests, so reject those explicitly.
    action.set_enabled(false);
    action.connect_change_state(|_, _| {
        eprintln!("notchfolk-terminal: expanded is read-only; use the terminal's expand control");
    });
    action
}

fn fit_existing_window(
    state: &RefCell<Option<Rc<TerminalWindow>>>,
    parameter: Option<&glib::Variant>,
) -> Result<(), &'static str> {
    let (width, height) = parameter
        .and_then(|value| value.get::<(i32, i32)>())
        .filter(|(width, height)| {
            (1..=i16::MAX as i32).contains(width) && (1..=i16::MAX as i32).contains(height)
        })
        .ok_or("expected (ii) dimensions between 1 and 32767 logical pixels")?;
    let window = state.borrow().clone();
    if let Some(window) = window
        && !window.quitting.get()
    {
        // Wayland geometry must be requested by the GTK client, not forced by
        // Shell. Fitting must never present a hidden window or alter user mode.
        window.set_embedded(true);
        window.window.set_default_size(width, height);
    }
    Ok(())
}

mod terminal_body {
    use super::gtk;
    use gtk::{glib, graphene, gsk, prelude::*, subclass::prelude::*};
    use std::cell::Cell;

    pub struct TerminalBody {
        pub background: Cell<Option<gtk::gdk::RGBA>>,
    }

    impl Default for TerminalBody {
        fn default() -> Self {
            Self {
                background: Cell::new(Some(gtk::gdk::RGBA::BLACK)),
            }
        }
    }

    #[glib::object_subclass]
    impl ObjectSubclass for TerminalBody {
        const NAME: &'static str = "NotchfolkTerminalBody";
        type Type = super::TerminalBody;
        type ParentType = gtk::Box;
    }

    impl ObjectImpl for TerminalBody {}
    impl BoxImpl for TerminalBody {}

    impl WidgetImpl for TerminalBody {
        fn snapshot(&self, snapshot: &gtk::Snapshot) {
            let widget = self.obj();
            let bounds =
                graphene::Rect::new(0.0, 0.0, widget.width() as f32, widget.height() as f32);
            // Clip the backdrop and all child drawing, including VTE, together.
            snapshot.push_rounded_clip(&gsk::RoundedRect::from_rect(bounds, 12.0));
            if let Some(background) = self.background.get() {
                snapshot.append_color(&background, &bounds);
            }
            self.parent_snapshot(snapshot);
            snapshot.pop();
        }
    }
}

glib::wrapper! {
    pub struct TerminalBody(ObjectSubclass<terminal_body::TerminalBody>)
        @extends gtk::Widget, gtk::Box,
        @implements gtk::Accessible, gtk::Buildable, gtk::ConstraintTarget, gtk::Orientable;
}

struct Tab {
    id: u64,
    page: gtk::Box,
    terminal: vte4::Terminal,
    label: gtk::Label,
    close: gtk::Button,
    session: RefCell<Option<Arc<Session>>>,
    cwd: RefCell<Option<PathBuf>>,
    cancel: gio::Cancellable,
    closed: Cell<bool>,
    starting: Cell<bool>,
    handing_off: Cell<bool>,
    refreshing: Cell<bool>,
    refresh_again: Cell<bool>,
    refresh_after_return: Cell<bool>,
    refresh_queued: Cell<bool>,
    exit_status: Cell<Option<i32>>,
}

struct TerminalWindow {
    window: gtk::ApplicationWindow,
    root: TerminalBody,
    appearance: Cell<appearance::Appearance>,
    embedded: Cell<bool>,
    notebook: gtk::Notebook,
    empty: gtk::Label,
    cwd: gtk::Label,
    header_hint: gtk::Label,
    handoff_cwd: gtk::Label,
    choices: gtk::Box,
    handoff_cancellations: RefCell<Vec<std::sync::Weak<AtomicBool>>>,
    handoff: gtk::Button,
    popover: gtk::Popover,
    message: gtk::Label,
    message_box: gtk::Box,
    expand: gtk::Button,
    close_current: gtk::Button,
    tabs: RefCell<Vec<Rc<Tab>>>,
    settings: Option<gio::Settings>,
    next_id: Cell<u64>,
    expanded: gio::SimpleAction,
    pending: Cell<usize>,
    quitting: Cell<bool>,
    _hold: gio::ApplicationHoldGuard,
}

impl TerminalWindow {
    fn new(app: &gtk::Application) -> Rc<Self> {
        let window = gtk::ApplicationWindow::builder()
            .application(app)
            .title("Notchfolk Terminal")
            .decorated(false)
            .default_width(COMPACT_SIZE.0)
            .default_height(COMPACT_SIZE.1)
            .build();
        window.add_css_class("termi-notch");
        let root: TerminalBody = glib::Object::builder()
            .property("orientation", gtk::Orientation::Vertical)
            .build();
        root.add_css_class("terminal-body");
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        header.add_css_class("terminal-header");
        let cwd = gtk::Label::builder()
            .valign(gtk::Align::Center)
            .single_line_mode(true)
            .xalign(0.0)
            .ellipsize(pango::EllipsizeMode::Middle)
            .max_width_chars(32)
            .visible(false)
            .build();
        cwd.add_css_class("terminal-cwd");
        header.append(&cwd);
        let actions = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        actions.add_css_class("terminal-actions");
        actions.set_hexpand(true);
        actions.set_halign(gtk::Align::End);
        header.append(&actions);
        // A compositor tooltip can extend past the notch. Paint help over the
        // content below the header without changing its allocation or input.
        let header_hint = gtk::Label::builder()
            .halign(gtk::Align::End)
            .valign(gtk::Align::Start)
            .margin_start(12)
            .margin_end(12)
            .wrap(true)
            .wrap_mode(pango::WrapMode::WordChar)
            .can_target(false)
            .accessible_role(gtk::AccessibleRole::Presentation)
            .visible(false)
            .build();
        header_hint.add_css_class("terminal-header-hint");
        let expand = header_button("view-fullscreen-symbolic", "Expand terminal", &header_hint);
        actions.append(&expand);
        let new = header_button("list-add-symbolic", "New shell tab", &header_hint);
        actions.append(&new);
        let close_current = header_button(
            "window-close-symbolic",
            "Close this shell and its running jobs",
            &header_hint,
        );
        close_current.set_sensitive(false);
        actions.append(&close_current);
        let handoff = header_button(
            "document-send-symbolic",
            "Open in external terminal",
            &header_hint,
        );
        handoff.set_focus_on_click(false);
        handoff.set_sensitive(false);
        actions.append(&handoff);
        root.append(&header);
        let content = gtk::Box::new(gtk::Orientation::Vertical, 0);
        let overlay = gtk::Overlay::new();
        overlay.set_vexpand(true);
        overlay.set_child(Some(&content));
        overlay.add_overlay(&header_hint);
        overlay.set_clip_overlay(&header_hint, true);
        root.append(&overlay);
        let message_box = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        message_box.add_css_class("terminal-message");
        let message = gtk::Label::builder()
            .wrap(true)
            .xalign(0.0)
            .hexpand(true)
            .selectable(true)
            .build();
        let dismiss = icon_button("window-close-symbolic", "Dismiss message");
        message_box.append(&message);
        message_box.append(&dismiss);
        message_box.set_visible(false);
        content.append(&message_box);
        let empty = gtk::Label::new(Some("No shells open. Use + to start a new tab."));
        empty.set_vexpand(true);
        empty.set_wrap(true);
        empty.set_margin_start(20);
        empty.set_margin_end(20);
        content.append(&empty);
        let notebook = gtk::Notebook::builder()
            .scrollable(true)
            .hexpand(true)
            .vexpand(true)
            .build();
        notebook.set_show_border(false);
        notebook.set_show_tabs(false);
        notebook.set_visible(false);
        content.append(&notebook);
        window.set_child(Some(&root));
        let popover = gtk::Popover::new();
        popover.add_css_class("terminal-menu");
        popover.set_has_arrow(false);
        let choices = gtk::Box::new(gtk::Orientation::Vertical, 6);
        choices.set_margin_top(12);
        choices.set_margin_bottom(12);
        choices.set_margin_start(12);
        choices.set_margin_end(12);
        let handoff_cwd = gtk::Label::builder()
            .wrap(true)
            .wrap_mode(pango::WrapMode::WordChar)
            .max_width_chars(32)
            .xalign(0.0)
            .build();
        choices.append(&handoff_cwd);
        // Open inward from the rightmost header action. Scroll a long list instead
        // of putting its last targets outside the compact terminal card.
        let scroller = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .propagate_natural_width(true)
            .propagate_natural_height(true)
            .max_content_height(COMPACT_SIZE.1 - 64)
            .child(&choices)
            .build();
        popover.set_position(gtk::PositionType::Bottom);
        popover.set_halign(gtk::Align::End);
        popover.set_child(Some(&scroller));
        popover.set_parent(&handoff);
        let ui = Rc::new(Self {
            window,
            root,
            appearance: Cell::new(appearance::Appearance::read(None)),
            embedded: Cell::new(false),
            notebook,
            empty,
            cwd,
            header_hint,
            handoff_cwd,
            choices,
            handoff_cancellations: RefCell::new(Vec::new()),
            handoff,
            popover,
            message,
            message_box,
            expand,
            close_current,
            tabs: RefCell::new(Vec::new()),
            settings: terminal_settings(),
            next_id: Cell::new(1),
            expanded: app
                .lookup_action("expanded")
                .and_then(|action| action.downcast::<gio::SimpleAction>().ok())
                .expect("expanded state is registered before activation"),
            pending: Cell::new(0),
            quitting: Cell::new(false),
            _hold: app.hold(),
        });
        on_click(&new, &ui, |ui| {
            let session = ui
                .current_tab()
                .and_then(|tab| tab.session.borrow().clone());
            ui.new_tab(None, session);
        });
        on_click(&ui.expand, &ui, |ui| ui.toggle_size());
        on_click(&ui.close_current, &ui, |ui| {
            if let Some(tab) = ui.current_tab() {
                ui.close_tab(tab.id);
            }
        });
        on_click(&dismiss, &ui, |ui| {
            if ui
                .handoff_cancellations
                .borrow()
                .iter()
                .any(|cancel| cancel.strong_count() > 0)
            {
                return;
            }
            ui.message_box.set_visible(false);
            ui.focus_current();
        });
        on_click(&ui.handoff, &ui, |ui| ui.show_handoff());
        let weak = Rc::downgrade(&ui);
        ui.popover.connect_show(move |_| {
            if let Some(ui) = weak.upgrade() {
                ui.refresh_current();
            }
        });
        let weak = Rc::downgrade(&ui);
        ui.window.connect_close_request(move |_| {
            if let Some(ui) = weak.upgrade() {
                ui.hide();
            }
            glib::Propagation::Stop
        });
        let weak = Rc::downgrade(&ui);
        ui.window.connect_is_active_notify(move |window| {
            if window.is_active()
                && let Some(ui) = weak.upgrade()
            {
                ui.focus_current();
                ui.refresh_current();
            }
        });
        let weak = Rc::downgrade(&ui);
        ui.notebook.connect_switch_page(move |_, _, index| {
            if let Some(ui) = weak.upgrade() {
                let tab = ui.tabs.borrow().get(index as usize).cloned();
                if let Some(tab) = tab {
                    ui.update_header(&tab);
                    if ui.window.is_active() {
                        tab.terminal.grab_focus();
                    }
                    ui.refresh_cwd(&tab);
                }
            }
        });
        if let Some(settings) = &ui.settings {
            for (key, kind) in [
                (appearance::THEME_KEY, glib::VariantTy::STRING),
                (appearance::TINT_KEY, glib::VariantTy::INT32),
            ] {
                if !appearance::supports_key(settings, key, kind) {
                    continue;
                }
                let weak = Rc::downgrade(&ui);
                settings.connect_changed(Some(key), move |_, _| {
                    if let Some(ui) = weak.upgrade() {
                        ui.refresh_appearance();
                    }
                });
            }
        }
        ui.refresh_appearance();
        install_shortcuts(&ui);
        ui
    }

    fn refresh_appearance(&self) {
        let appearance = appearance::Appearance::read(self.settings.as_ref());
        if self.appearance.replace(appearance) == appearance {
            return;
        }
        if appearance.glass {
            self.window.add_css_class("terminal-glass");
        } else {
            self.window.remove_css_class("terminal-glass");
        }
        self.sync_background();
        // Update hidden tabs too; switching tabs must never expose an old theme.
        for tab in self.tabs.borrow().iter() {
            appearance.apply_terminal(&tab.terminal);
        }
    }

    fn set_embedded(&self, embedded: bool) {
        if self.embedded.replace(embedded) != embedded {
            // GTK normally remembers each compositor allocation as the next default size.
            // A late compact configure must not replace the island's requested viewport.
            self.window.set_resizable(!embedded);
            self.sync_background();
        }
    }

    fn sync_background(&self) {
        let background = self.appearance.get().body_background(self.embedded.get());
        if self.root.imp().background.replace(background) != background {
            self.root.queue_draw();
        }
    }

    fn current_tab(&self) -> Option<Rc<Tab>> {
        let index = self.notebook.current_page()?;
        self.tabs.borrow().get(index as usize).cloned()
    }

    fn update_tab_chrome(&self) {
        let count = self.tabs.borrow().len();
        self.notebook.set_show_tabs(count > 1);
    }

    fn focus_current(&self) {
        if !self.window.is_visible() || !self.window.is_active() {
            return;
        }
        if let Some(tab) = self.current_tab() {
            tab.terminal.grab_focus();
        }
    }

    fn hide(&self) {
        self.header_hint.set_visible(false);
        self.popover.popdown();
        self.window.set_visible(false);
        self.set_embedded(false);
    }

    fn new_tab(self: &Rc<Self>, cwd: Option<PathBuf>, inherit: Option<Arc<Session>>) {
        if self.quitting.get() {
            return;
        }
        let id = self.next_id.get();
        self.next_id.set(id + 1);
        let terminal = vte4::Terminal::new();
        terminal.set_hexpand(true);
        terminal.set_vexpand(true);
        terminal.set_scrollback_lines(10_000);
        terminal.set_scroll_on_keystroke(true);
        terminal.set_scroll_on_output(false);
        terminal.set_audible_bell(false);
        terminal.set_mouse_autohide(true);
        if let Some(settings) = self.settings.as_ref().filter(|settings| {
            appearance::supports_key(settings, TERMINAL_FONT_KEY, glib::VariantTy::STRING)
        }) {
            // GSettings owns each binding until its VTE is destroyed. Read-only
            // bindings also update hidden tabs without retaining the window.
            settings
                .bind(TERMINAL_FONT_KEY, &terminal, "font-desc")
                .get_only()
                .no_sensitivity()
                .mapping(|value, _| {
                    value
                        .str()
                        .map(|description| terminal_font_description(description).to_value())
                })
                .build();
        } else {
            terminal.set_font(Some(&pango::FontDescription::from_string(
                DEFAULT_TERMINAL_FONT,
            )));
        }
        self.appearance.get().apply_terminal(&terminal);
        terminal.set_margin_start(14);
        terminal.set_margin_end(14);
        terminal.set_margin_top(6);
        terminal.set_margin_bottom(8);
        terminal.set_input_enabled(false);
        // VTE explicitly does not support GtkScrolledWindow. It handles its own
        // scrolling; tmux supplies the live shell's wheel/copy-mode history.
        let page = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        page.append(&terminal);
        let label = gtk::Label::new(Some("Starting…"));
        label.set_ellipsize(pango::EllipsizeMode::End);
        label.set_width_chars(6);
        label.set_max_width_chars(16);
        let close = icon_button(
            "window-close-symbolic",
            "Close this shell and its running jobs",
        );
        close.add_css_class("tab-close");
        let tab_label = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        tab_label.append(&label);
        tab_label.append(&close);
        tab_label.add_css_class("terminal-tab");
        let tab = Rc::new(Tab {
            id,
            page,
            terminal,
            label,
            close,
            session: RefCell::new(None),
            cwd: RefCell::new(None),
            cancel: gio::Cancellable::new(),
            closed: Cell::new(false),
            starting: Cell::new(true),
            handing_off: Cell::new(false),
            refreshing: Cell::new(false),
            refresh_again: Cell::new(false),
            refresh_after_return: Cell::new(false),
            refresh_queued: Cell::new(false),
            exit_status: Cell::new(None),
        });
        on_click(&tab.close, self, move |ui| ui.close_tab(id));
        let weak = Rc::downgrade(self);
        tab.terminal.connect_child_exited(move |_, status| {
            if let Some(ui) = weak.upgrade() {
                ui.child_exited(id, status);
            }
        });
        let weak = Rc::downgrade(self);
        tab.terminal
            .connect_current_directory_uri_changed(move |_| {
                if let Some(ui) = weak.upgrade()
                    && ui.window.is_visible()
                {
                    let tab = ui.tabs.borrow().iter().find(|tab| tab.id == id).cloned();
                    if let Some(tab) = tab {
                        ui.refresh_cwd(&tab);
                    }
                }
            });
        let weak_tab = Rc::downgrade(&tab);
        tab.terminal.connect_commit(move |_, text, _| {
            if is_submission(text)
                && let Some(tab) = weak_tab.upgrade()
            {
                tab.refresh_after_return.set(true);
            }
        });
        let weak = Rc::downgrade(self);
        let weak_tab = Rc::downgrade(&tab);
        tab.terminal.connect_contents_changed(move |_| {
            let Some(tab) = weak_tab.upgrade() else {
                return;
            };
            if !tab.refresh_after_return.get() || tab.refresh_queued.get() {
                return;
            }
            let Some(ui) = weak.upgrade() else { return };
            tab.refresh_queued.set(true);
            // Coalesce a VTE output batch rather than query tmux on each character.
            // Return's trailing echo normally leaves column zero; keep waiting in
            // that case so plain Bash's following prompt, not its echo, triggers
            // the read. OSC 7 is not required and no timer or output polling runs.
            glib::idle_add_local_once(move || {
                tab.refresh_queued.set(false);
                if !tab.closed.get()
                    && !ui.quitting.get()
                    && tab.refresh_after_return.get()
                    && tab.terminal.cursor_position().0 != 0
                {
                    tab.refresh_after_return.set(false);
                    ui.refresh_cwd(&tab);
                }
            });
        });
        self.tabs.borrow_mut().push(tab.clone());
        self.empty.set_visible(false);
        self.notebook.set_visible(true);
        let index = self.notebook.append_page(&tab.page, Some(&tab_label));
        self.update_tab_chrome();
        self.notebook.set_current_page(Some(index));
        self.update_header(&tab);
        self.pending.set(self.pending.get() + 1);
        let ui = self.clone();
        glib::MainContext::default().spawn_local(async move {
            let result = gio::spawn_blocking(move || {
                let cwd = match inherit {
                    Some(session) => Some(session.cwd()?),
                    None => cwd,
                };
                let session = Session::new(cwd.as_deref())?;
                let cwd = session.cwd()?;
                Ok::<_, io::Error>((Arc::new(session), cwd))
            }).await;
            match result {
                Ok(Ok((session, cwd))) if !tab.closed.get() && !ui.quitting.get() => {
                    tab.session.replace(Some(session));
                    tab.cwd.replace(Some(cwd));
                    ui.attach(&tab);
                }
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    ui.remove_tab(tab.id);
                    ui.report(&format!("Could not start a shell: {error}. Check that tmux and your login shell are installed, then use + to retry."));
                }
                Err(_) => {
                    ui.remove_tab(tab.id);
                    ui.report("The shell startup worker failed. Close the helper and try again.");
                }
            }
            ui.finish_job();
        });
        self.focus_current();
    }

    fn attach(self: &Rc<Self>, tab: &Rc<Tab>) {
        let argv = {
            let session = tab.session.borrow();
            let Some(session) = session.as_ref() else {
                return;
            };
            session.attach_argv()
        };
        let argv = match vte_argv(&argv) {
            Ok(argv) => argv,
            Err(error) => {
                self.report(&format!("Could not attach the terminal: {error}"));
                self.remove_tab(tab.id);
                return;
            }
        };
        let ui = self.clone();
        let attached_tab = tab.clone();
        self.pending.set(self.pending.get() + 1);
        tab.terminal.spawn_async(
            vte4::PtyFlags::DEFAULT,
            None,
            &argv,
            &[],
            glib::SpawnFlags::SEARCH_PATH,
            || {},
            5000,
            Some(&tab.cancel),
            move |result| {
                attached_tab.starting.set(false);
                match result {
                    Ok(_) if !attached_tab.closed.get() && !ui.quitting.get() => {
                        attached_tab.terminal.set_input_enabled(true);
                        ui.update_tab(&attached_tab);
                        ui.focus_current();
                    }
                    Ok(_) => {}
                    Err(error)
                        if attached_tab.closed.get()
                            && error.matches(gio::IOErrorEnum::Cancelled) => {}
                    Err(error) => {
                        ui.remove_tab(attached_tab.id);
                        ui.report(&format!(
                            "Could not attach the terminal: {error}. Use + to start a new shell."
                        ));
                    }
                }
                ui.finish_job();
            },
        );
    }

    fn close_tab(&self, id: u64) {
        let tab = self.tabs.borrow().iter().find(|tab| tab.id == id).cloned();
        if let Some(tab) = tab
            && !tab.handing_off.get()
        {
            self.remove_tab(id);
        }
    }

    fn remove_tab(&self, id: u64) {
        let index = self.tabs.borrow().iter().position(|tab| tab.id == id);
        let Some(index) = index else { return };
        let tab = self.tabs.borrow_mut().remove(index);
        tab.closed.set(true);
        tab.cancel.cancel();
        // VTE owns the child watch and PTY. Unparent the widget and let its last
        // Rust reference drop at callback completion: disposal hangs up/reaps
        // this tmux client without disturbing a successfully transferred shell.
        // Do not call set_pty(None): affected VTE versions dereference that NULL.
        tab.session.take();
        self.notebook.remove_page(Some(index as u32));
        tab.page.remove(&tab.terminal);
        self.update_tab_chrome();
        let empty = self.tabs.borrow().is_empty();
        self.empty.set_visible(empty);
        self.notebook.set_visible(!empty);
        if let Some(tab) = self.current_tab() {
            self.update_header(&tab);
            self.focus_current();
        } else {
            self.cwd.set_visible(false);
            self.close_current.set_sensitive(false);
            self.handoff.set_sensitive(false);
        }
    }

    fn child_exited(&self, id: u64, status: i32) {
        let tab = self.tabs.borrow().iter().find(|tab| tab.id == id).cloned();
        if let Some(tab) = tab {
            if tab.handing_off.get() {
                tab.exit_status.set(Some(status));
                return;
            }
            self.remove_tab(id);
            if status != 0 {
                self.report(&format!("The terminal connection ended (wait status {status}). Its tab was closed. Use + to start a new shell."));
            }
        }
    }

    fn refresh_current(self: &Rc<Self>) {
        if let Some(tab) = self.current_tab() {
            self.refresh_cwd(&tab);
        }
    }

    fn refresh_cwd(self: &Rc<Self>, tab: &Rc<Tab>) {
        if tab.closed.get() || self.quitting.get() {
            return;
        }
        if tab.refreshing.get() {
            // A prompt arriving during an earlier focus/OSC lookup must not be lost.
            tab.refresh_again.set(true);
            return;
        }
        let Some(session) = tab.session.borrow().clone() else {
            return;
        };
        tab.refreshing.set(true);
        self.pending.set(self.pending.get() + 1);
        let ui = self.clone();
        let tab = tab.clone();
        glib::MainContext::default().spawn_local(async move {
            let result = gio::spawn_blocking(move || session.cwd()).await;
            tab.refreshing.set(false);
            if !tab.closed.get() && !ui.quitting.get() {
                match result {
                    Ok(Ok(cwd)) => {
                        tab.cwd.replace(Some(cwd));
                        ui.update_tab(&tab);
                    }
                    Ok(Err(error)) => {
                        ui.report(&format!(
                            "Could not read the shell's current directory: {error}"
                        ));
                    }
                    Err(_) => ui.report(
                        "The directory lookup worker failed. Refocus the terminal to try again.",
                    ),
                }
            }
            if tab.refresh_again.replace(false) {
                ui.refresh_cwd(&tab);
            }
            ui.finish_job();
        });
    }

    fn update_tab(&self, tab: &Tab) {
        if let Some(cwd) = tab.cwd.borrow().as_ref() {
            tab.label.set_text(&format!(
                "{} · {}",
                tab.id,
                cwd.file_name().unwrap_or(cwd.as_os_str()).to_string_lossy()
            ));
            tab.label.set_tooltip_text(Some(&cwd.to_string_lossy()));
        }
        if self
            .current_tab()
            .is_some_and(|current| current.id == tab.id)
        {
            self.update_header(tab);
        }
    }

    fn update_header(&self, tab: &Tab) {
        self.cwd.set_visible(true);
        if let Some(cwd) = tab.cwd.borrow().as_ref() {
            let path = cwd.to_string_lossy();
            self.cwd.set_text(&abbreviated_cwd(cwd, &glib::home_dir()));
            self.cwd.set_tooltip_text(Some(&path));
            self.handoff_cwd.set_text(&format!(
                "Current directory: {path}\nLive handoff keeps this shell and its running jobs."
            ));
        } else {
            self.cwd.set_text("Starting shell…");
            self.cwd.set_tooltip_text(None);
        }
        self.handoff
            .set_sensitive(!tab.starting.get() && !tab.handing_off.get());
        self.close_current.set_sensitive(!tab.handing_off.get());
    }

    fn show_handoff(self: &Rc<Self>) {
        let mut targets = available_terminals();
        let saved = self
            .settings
            .as_ref()
            .filter(|settings| {
                appearance::supports_key(settings, EXTERNAL_TERMINAL_KEY, glib::VariantTy::STRING)
            })
            .map(|settings| settings.string(EXTERNAL_TERMINAL_KEY))
            .unwrap_or_default();
        if let Some(target) = preferred_terminal(&mut targets, &saved) {
            self.choose_handoff(Arc::new(target));
            return;
        }
        if !saved.is_empty() {
            self.report("Your default external terminal is unavailable. Choose another terminal.");
        }
        self.clear_handoff_choices();
        if targets.is_empty() {
            self.choices.append(&gtk::Label::new(Some(
                "No capable external terminal was found.",
            )));
        }
        for target in targets {
            let label = gtk::Label::builder()
                .label(target.label.as_str())
                .ellipsize(pango::EllipsizeMode::End)
                .max_width_chars(32)
                .build();
            let button = gtk::Button::builder()
                .child(&label)
                .tooltip_text(target.label.as_str())
                .build();
            let target = Arc::new(target);
            on_click(&button, self, move |ui| ui.choose_handoff(target.clone()));
            self.choices.append(&button);
        }
        self.popover.popup();
    }

    fn clear_handoff_choices(&self) {
        while let Some(child) = self.choices.first_child() {
            self.choices.remove(&child);
        }
        self.choices.append(&self.handoff_cwd);
    }

    fn choose_handoff(self: &Rc<Self>, target: Arc<TerminalTarget>) {
        if !target.is_manual() {
            self.handoff_current(target);
            return;
        }
        self.clear_handoff_choices();
        self.choices.append(&gtk::Label::builder()
            .label("Wave requires a manual attach. Copy the one-use command, then paste it into a local Wave terminal and press Enter within 2 minutes. Your shell stays here until Wave connects.")
            .wrap(true).max_width_chars(32).xalign(0.0).build());
        let copy = gtk::Button::with_label("Copy command & open Wave");
        on_click(&copy, self, move |ui| ui.handoff_current(target.clone()));
        self.choices.append(&copy);
        let cancel = gtk::Button::with_label("Cancel");
        on_click(&cancel, self, |ui| ui.popover.popdown());
        self.choices.append(&cancel);
        self.popover.popup();
    }

    fn handoff_current(self: &Rc<Self>, target: Arc<TerminalTarget>) {
        self.popover.popdown();
        let Some(tab) = self.current_tab() else {
            return;
        };
        if tab.starting.get() || tab.handing_off.get() || self.quitting.get() {
            return;
        }
        let Some(session) = tab.session.borrow().clone() else {
            return;
        };
        tab.handing_off.set(true);
        tab.close.set_sensitive(false);
        self.update_header(&tab);
        self.report(if target.is_manual() {
            "Copying the one-use command and opening Wave. Paste into a local Wave terminal and press Enter within 2 minutes."
        } else {
            "Opening the external terminal. This tab stays open until the handoff is confirmed."
        });
        let cancelled = Arc::new(AtomicBool::new(false));
        self.handoff_cancellations
            .borrow_mut()
            .retain(|cancel| cancel.strong_count() > 0);
        self.handoff_cancellations
            .borrow_mut()
            .push(Arc::downgrade(&cancelled));
        let cancel_button = gtk::Button::with_label("Cancel handoff");
        let cancel = cancelled.clone();
        cancel_button.connect_clicked(move |button| {
            cancel.store(true, Ordering::Release);
            button.set_sensitive(false);
        });
        self.message_box.append(&cancel_button);
        let copy_window = target
            .is_manual()
            .then(|| glib::SendWeakRef::from(self.window.downgrade()));
        self.pending.set(self.pending.get() + 1);
        let ui = self.clone();
        glib::MainContext::default().spawn_local(async move {
            let result = gio::spawn_blocking(move || {
                session.handoff(&target, &cancelled, |command| {
                    let window =
                        copy_window.ok_or_else(|| io::Error::other("The handoff UI closed"))?;
                    let (acknowledged, copied) = mpsc::sync_channel(1);
                    let copy_cancelled = cancelled.clone();
                    let timeout = std::time::Duration::from_secs(5);
                    let deadline = std::time::Instant::now() + timeout;
                    // Only the explicit copy action reaches this one-shot callback.
                    // A delayed callback must not overwrite the clipboard after expiry.
                    glib::idle_add_once(move || {
                        if copy_cancelled.load(Ordering::Acquire)
                            || std::time::Instant::now() >= deadline
                        {
                            return;
                        }
                        if let Some(window) = window.upgrade() {
                            window.clipboard().set_text(&command);
                            let _ = acknowledged.send(());
                        }
                    });
                    copied.recv_timeout(timeout).map_err(|_| {
                        cancelled.store(true, Ordering::Release);
                        io::Error::other("The copy action was cancelled or its UI closed")
                    })
                })
            })
            .await;
            ui.message_box.remove(&cancel_button);
            tab.handing_off.set(false);
            tab.close.set_sensitive(true);
            match result {
                Ok(Ok(())) => {
                    ui.remove_tab(tab.id);
                    ui.hide();
                    ui.report("The live shell was transferred to the external terminal.");
                }
                Ok(Err(error)) => {
                    ui.report(&format!(
                        "Could not hand off this shell: {error}. The tab has been kept open."
                    ));
                    ui.update_tab(&tab);
                }
                Err(_) => {
                    ui.report("The handoff worker failed. The tab has been kept open.");
                    ui.update_tab(&tab);
                }
            }
            if let Some(status) = tab.exit_status.take() {
                ui.child_exited(tab.id, status);
            }
            ui.focus_current();
            ui.finish_job();
        });
    }

    fn toggle_size(&self) {
        let expanded = !self
            .expanded
            .state()
            .and_then(|state| state.get::<bool>())
            .expect("expanded action has a boolean state");
        let (width, height) = if expanded {
            EXPANDED_SIZE
        } else {
            COMPACT_SIZE
        };
        self.window.unmaximize();
        self.window.set_default_size(width, height);
        self.expand.set_icon_name(if expanded {
            "view-restore-symbolic"
        } else {
            "view-fullscreen-symbolic"
        });
        let label = if expanded {
            "Compact terminal"
        } else {
            "Expand terminal"
        };
        name_header_button(&self.expand, label);
        // Publish only the explicit user's mode change. Compositor allocations
        // and fit-viewport requests never feed back into this state.
        self.expanded.set_state(&expanded.to_variant());
        self.focus_current();
    }

    fn run_shortcut(self: &Rc<Self>, action: TerminalAction) {
        self.header_hint.set_visible(false);
        match action {
            TerminalAction::NewTab => {
                let session = self
                    .current_tab()
                    .and_then(|tab| tab.session.borrow().clone());
                self.new_tab(None, session);
            }
            TerminalAction::CloseTab => {
                if let Some(tab) = self.current_tab() {
                    self.close_tab(tab.id);
                }
            }
            TerminalAction::Expand => self.toggle_size(),
            TerminalAction::Hide => self.hide(),
            TerminalAction::Copy => {
                if let Some(tab) = self.current_tab() {
                    tab.terminal.copy_clipboard_format(vte4::Format::Text);
                }
            }
            TerminalAction::Paste => {
                if let Some(tab) = self.current_tab() {
                    tab.terminal.paste_clipboard();
                }
            }
            TerminalAction::PreviousTab => self.notebook.prev_page(),
            TerminalAction::NextTab => self.notebook.next_page(),
            TerminalAction::Handoff => {
                if self.handoff.is_sensitive() {
                    self.show_handoff();
                }
            }
        }
    }

    fn report(&self, message: &str) {
        eprintln!("notchfolk-terminal: {message}");
        self.message.set_text(message);
        self.message_box.set_visible(true);
    }

    fn cancel_handoffs(&self) {
        for cancelled in self
            .handoff_cancellations
            .borrow()
            .iter()
            .filter_map(std::sync::Weak::upgrade)
        {
            cancelled.store(true, Ordering::Release);
        }
    }

    fn request_quit(&self) {
        self.quitting.set(true);
        self.cancel_handoffs();
        self.hide();
        // Let workers revoke one-use requests and settle any confirmed attach.
        if self.pending.get() == 0 {
            self.quit_now();
        }
    }

    fn finish_job(&self) {
        self.pending.set(self.pending.get() - 1);
        if self.quitting.get() && self.pending.get() == 0 {
            self.quit_now();
        }
    }

    fn quit_now(&self) {
        self.clear_tabs();
        if let Some(app) = self.window.application() {
            app.quit();
        }
    }

    fn clear_tabs(&self) {
        self.cancel_handoffs();
        // Do not hold a RefCell borrow across GTK callbacks triggered by removing pages.
        loop {
            let id = self.tabs.borrow().first().map(|tab| tab.id);
            match id {
                Some(id) => self.remove_tab(id),
                None => break,
            }
        }
    }
}

impl Drop for TerminalWindow {
    fn drop(&mut self) {
        self.cancel_handoffs();
        // A manually parented popover must be released before its button.
        if self.popover.parent().is_some() {
            self.popover.unparent();
        }
    }
}

fn terminal_settings() -> Option<gio::Settings> {
    let default_source = gio::SettingsSchemaSource::default();
    let directory =
        glib::user_data_dir().join("gnome-shell/extensions/io.galyarderlabs.notchfolk/schemas");
    // Match the extension's local-first lookup. Standalone and system installs
    // may have no local compiled schema; GLib's default includes GSETTINGS_SCHEMA_DIR.
    let source =
        gio::SettingsSchemaSource::from_directory(directory, default_source.as_ref(), false)
            .ok()
            .or(default_source)?;
    let schema = source.lookup(SETTINGS_SCHEMA, true)?;
    // Validate keys independently at their use sites: an older schema without a
    // terminal font can still supply the island theme and glass tint.
    schema.path()?;
    Some(gio::Settings::new_full(
        &schema,
        None::<&gio::SettingsBackend>,
        None,
    ))
}

fn terminal_font_description(value: &str) -> pango::FontDescription {
    let value = value.trim();
    if value.is_empty() || value.contains('\0') {
        return pango::FontDescription::from_string(DEFAULT_TERMINAL_FONT);
    }
    let font = pango::FontDescription::from_string(value);
    // Pango accepts arbitrary family names and resolves unavailable fonts.
    // Only reject descriptions that cannot provide a usable family and size.
    if !font.set_fields().contains(pango::FontMask::FAMILY) || font.size() <= 0 {
        return pango::FontDescription::from_string(DEFAULT_TERMINAL_FONT);
    }
    font
}

#[derive(Clone, Copy)]
enum TerminalAction {
    NewTab,
    CloseTab,
    Expand,
    Hide,
    Copy,
    Paste,
    PreviousTab,
    NextTab,
    Handoff,
}

const SHORTCUTS: [(&str, &str, TerminalAction); 9] = [
    ("new-tab", "<Control><Shift>t", TerminalAction::NewTab),
    ("close-tab", "<Control><Shift>w", TerminalAction::CloseTab),
    ("expand", "<Control><Shift>e", TerminalAction::Expand),
    ("hide", "<Control><Shift>q", TerminalAction::Hide),
    ("copy", "<Control><Shift>c", TerminalAction::Copy),
    ("paste", "<Control><Shift>v", TerminalAction::Paste),
    (
        "previous-tab",
        "<Control>Page_Up",
        TerminalAction::PreviousTab,
    ),
    ("next-tab", "<Control>Page_Down", TerminalAction::NextTab),
    ("handoff", "", TerminalAction::Handoff),
];

fn shortcut_value(file: &glib::KeyFile, name: &str, default: &str) -> Result<String, glib::Error> {
    match file.string("shortcuts", name) {
        Ok(value) => Ok(value.trim().to_owned()),
        Err(error)
            if error.matches(glib::KeyFileError::KeyNotFound)
                || error.matches(glib::KeyFileError::GroupNotFound) =>
        {
            Ok(default.to_owned())
        }
        Err(error) => Err(error),
    }
}

fn install_shortcuts(ui: &Rc<TerminalWindow>) {
    let path = glib::user_config_dir().join("notchfolk/terminal-shortcuts.ini");
    let file = glib::KeyFile::new();
    if let Err(error) = file.load_from_file(&path, glib::KeyFileFlags::NONE) {
        if !error.matches(glib::FileError::Noent) {
            ui.report(&format!(
                "Could not read {}: {error}. Default shortcuts are in use.",
                path.display()
            ));
        }
        // A malformed file may have been partially parsed; do not apply fragments.
        install_shortcut_values(ui, &glib::KeyFile::new(), &path);
    } else {
        install_shortcut_values(ui, &file, &path);
    }
}

fn install_shortcut_values(ui: &Rc<TerminalWindow>, file: &glib::KeyFile, path: &std::path::Path) {
    let controller = gtk::ShortcutController::new();
    controller.set_propagation_phase(gtk::PropagationPhase::Capture);
    for (name, default, action) in SHORTCUTS {
        let value = match shortcut_value(file, name, default) {
            Ok(value) => value,
            Err(error) => {
                ui.report(&format!(
                    "Invalid shortcut {name} in {}: {error}. Using its default.",
                    path.display()
                ));
                default.to_owned()
            }
        };
        if value.is_empty() {
            continue;
        }
        let trigger = if value.contains('\0') {
            None
        } else {
            gtk::ShortcutTrigger::parse_string(&value)
        };
        let trigger = match trigger {
            Some(trigger) => trigger,
            None => {
                ui.report(&format!("Invalid shortcut {name}={value:?} in {}. Use GTK syntax such as <Control><Shift>t. Using its default.", path.display()));
                if default.is_empty() {
                    continue;
                }
                gtk::ShortcutTrigger::parse_string(default).expect("built-in shortcut is valid")
            }
        };
        let weak = Rc::downgrade(ui);
        let callback = gtk::CallbackAction::new(move |_, _| {
            if let Some(ui) = weak.upgrade()
                && !ui.quitting.get()
            {
                ui.run_shortcut(action);
                glib::Propagation::Stop
            } else {
                glib::Propagation::Proceed
            }
        });
        controller.add_shortcut(gtk::Shortcut::new(Some(trigger), Some(callback)));
    }
    ui.window.add_controller(controller);
}

fn abbreviated_cwd(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(relative) if relative.as_os_str().is_empty() => "~".to_owned(),
        Ok(relative) => format!("~/{}", relative.display()),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

fn icon_button(icon: &str, label: &str) -> gtk::Button {
    let button = gtk::Button::from_icon_name(icon);
    name_button(&button, label);
    button
}

fn name_button(button: &gtk::Button, label: &str) {
    button.set_tooltip_text(Some(label));
    button.update_property(&[gtk::accessible::Property::Label(label)]);
}

fn name_header_button(button: &gtk::Button, label: &str) {
    name_button(button, label);
    // Keep tooltip-text as the help string (also for the mutable expand
    // action), but never let GTK open a separate tooltip surface.
    button.set_has_tooltip(false);
}

fn header_button(icon: &str, label: &str, hint: &gtk::Label) -> gtk::Button {
    let button = gtk::Button::from_icon_name(icon);
    name_header_button(&button, label);
    let help = hint.clone();
    button.connect_state_flags_changed(move |button, previous| {
        let hovered = button.state_flags().contains(gtk::StateFlags::PRELIGHT);
        if hovered != previous.contains(gtk::StateFlags::PRELIGHT) {
            if hovered && let Some(text) = button.tooltip_text() {
                help.set_text(&text);
            }
            help.set_visible(hovered);
        }
    });
    let help = hint.clone();
    button.connect_clicked(move |_| help.set_visible(false));
    button
}

fn on_click(
    button: &gtk::Button,
    ui: &Rc<TerminalWindow>,
    callback: impl Fn(&Rc<TerminalWindow>) + 'static,
) {
    let weak = Rc::downgrade(ui);
    button.connect_clicked(move |_| {
        if let Some(ui) = weak.upgrade() {
            callback(&ui);
        }
    });
}

fn vte_argv(argv: &[OsString]) -> io::Result<Vec<&str>> {
    if argv.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "tmux supplied an empty command",
        ));
    }
    argv.iter().map(|arg| {
        let arg = arg.to_str().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "VTE requires a UTF-8 executable and socket path; use a UTF-8 runtime directory"))?;
        if arg.contains('\0') {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "the terminal command contains a NUL byte"));
        }
        Ok(arg)
    }).collect()
}

fn is_submission(text: &str) -> bool {
    text.bytes().any(|byte| matches!(byte, b'\r' | b'\n'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStringExt;

    #[test]
    fn terminal_font_preserves_family_style_and_size() {
        let font = terminal_font_description("JetBrainsMono Nerd Font Bold Italic 12");
        assert_eq!(font.family().as_deref(), Some("JetBrainsMono Nerd Font"));
        assert_eq!(font.weight(), pango::Weight::Bold);
        assert_eq!(font.style(), pango::Style::Italic);
        assert_eq!(font.size(), 12 * pango::SCALE);
        assert!(!font.is_size_absolute());

        let pixels = terminal_font_description("Monospace 14px");
        assert_eq!(pixels.size(), 14 * pango::SCALE);
        assert!(pixels.is_size_absolute());
    }

    #[test]
    fn unusable_terminal_font_keeps_previous_default() {
        let default = pango::FontDescription::from_string(DEFAULT_TERMINAL_FONT);
        for value in [
            "",
            "   ",
            "Monospace",
            "Monospace 0",
            "12",
            "Mono\0space 12",
        ] {
            assert_eq!(terminal_font_description(value), default, "{value:?}");
        }
        assert_eq!(terminal_font_description(DEFAULT_TERMINAL_FONT), default);
    }

    #[test]
    fn terminal_font_leaves_unavailable_families_to_pango() {
        let font = terminal_font_description("Notchfolk Uninstalled Test Font 11");
        assert_eq!(
            font.family().as_deref(),
            Some("Notchfolk Uninstalled Test Font")
        );
        assert_eq!(font.size(), 11 * pango::SCALE);
    }

    #[test]
    fn activation_flags_are_exclusive_and_commands_are_not_accepted() {
        assert_eq!(parse_request([]), Ok(Request::Show));
        assert_eq!(parse_request(["--toggle".into()]), Ok(Request::Toggle));
        assert_eq!(parse_request(["--quit".into()]), Ok(Request::Quit));
        assert_eq!(parse_request(["--help".into()]), Ok(Request::Help));
        assert_eq!(parse_request(["--version".into()]), Ok(Request::Version));
        assert_eq!(
            parse_request(["--list-terminals".into()]),
            Ok(Request::ListTerminals)
        );
        assert!(parse_request(["--toggle".into(), "--quit".into()]).is_err());
        assert!(parse_request(["-e".into(), "echo unsafe".into()]).is_err());
        assert!(parse_request([OsString::from_vec(vec![0xff])]).is_err());
    }

    #[test]
    fn attach_arguments_are_never_lossily_rewritten() {
        let args = [
            OsString::from("/usr/bin/tmux"),
            OsString::from("/run/user/1000/socket with spaces"),
        ];
        assert_eq!(
            vte_argv(&args).unwrap(),
            ["/usr/bin/tmux", "/run/user/1000/socket with spaces"]
        );
        assert!(vte_argv(&[]).is_err());
        assert!(vte_argv(&[OsString::from_vec(vec![0xff])]).is_err());
        assert!(vte_argv(&[OsString::from("bad\0argument")]).is_err());
    }

    #[test]
    fn quit_treats_only_a_missing_owner_as_already_closed() {
        assert!(absent_owner(&glib::Error::new(
            gio::DBusError::NameHasNoOwner,
            "gone"
        )));
        assert!(absent_owner(&glib::Error::new(
            gio::DBusError::ServiceUnknown,
            "gone"
        )));
        assert!(!absent_owner(&glib::Error::new(
            gio::DBusError::AccessDenied,
            "denied"
        )));
    }

    #[test]
    fn missing_shortcuts_default_but_empty_overrides_disable() {
        let file = glib::KeyFile::new();
        assert_eq!(
            shortcut_value(&file, "new-tab", "<Control><Shift>t").unwrap(),
            "<Control><Shift>t"
        );
        file.set_string("shortcuts", "new-tab", "   ");
        assert_eq!(
            shortcut_value(&file, "new-tab", "<Control><Shift>t").unwrap(),
            ""
        );
        assert_eq!(
            shortcut_value(&file, "copy", "<Control><Shift>c").unwrap(),
            "<Control><Shift>c"
        );
        file.set_string("shortcuts", "new-tab", "<Alt>n");
        assert_eq!(
            shortcut_value(&file, "new-tab", "<Control><Shift>t").unwrap(),
            "<Alt>n"
        );
    }

    #[test]
    fn invalid_keyfile_escapes_are_reported_not_ignored() {
        let file = glib::KeyFile::new();
        file.set_value("shortcuts", "new-tab", r"\z");
        assert!(shortcut_value(&file, "new-tab", "<Control><Shift>t").is_err());
    }

    #[test]
    fn cwd_refresh_is_armed_by_submission_not_typing_or_completion() {
        assert!(is_submission("\r"));
        assert!(is_submission("\n"));
        assert!(is_submission("cd /tmp\r\n"));
        assert!(!is_submission("cd /tmp"));
        assert!(!is_submission("\t"));
        assert!(!is_submission("\u{1b}[A"));
    }

    #[test]
    fn cwd_abbreviation_respects_home_path_boundaries() {
        let home = Path::new("/home/lee");
        assert_eq!(abbreviated_cwd(home, home), "~");
        assert_eq!(abbreviated_cwd(Path::new("/home/lee/work"), home), "~/work");
        assert_eq!(
            abbreviated_cwd(Path::new("/home/lee-other/work"), home),
            "/home/lee-other/work"
        );
        assert_eq!(abbreviated_cwd(Path::new("/tmp"), home), "/tmp");
    }

    fn test_window(id: &str) -> Rc<TerminalWindow> {
        let app = gtk::Application::builder()
            .application_id(id)
            .flags(gio::ApplicationFlags::NON_UNIQUE)
            .build();
        app.register(None::<&gio::Cancellable>).unwrap();
        app.add_action(&expanded_state_action());
        TerminalWindow::new(&app)
    }

    #[gtk::test]
    #[ignore = "requires an isolated GTK display"]
    fn header_allocates_the_path_without_displacing_actions() {
        let provider = gtk::CssProvider::new();
        provider.load_from_string(include_str!("style.css"));
        gtk::style_context_add_provider_for_display(
            &gdk::Display::default().unwrap(),
            &provider,
            gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
        );
        let ui = test_window("org.notchfolk.TestHeader"); // Never present a window or start a shell.
        let header = ui.cwd.parent().unwrap();
        let actions = ui.expand.parent().unwrap();
        let allocate = |width| {
            let (_, height, _, _) = header.measure(gtk::Orientation::Vertical, width);
            header.allocate(width, height, -1, None);
        };

        ui.cwd.set_visible(true);
        let path = "/a-long-folder-name".repeat(20);
        ui.cwd.set_text(&path);
        let (min, natural, _, _) = header.measure(gtk::Orientation::Horizontal, -1);
        assert!(min <= 320, "compact header must fit at 320 logical pixels");
        allocate(natural + 100);
        let wide_path = ui.cwd.width();
        let wide_actions = actions.width();
        ui.cwd.set_text("~");
        allocate(natural + 100);
        assert!(ui.cwd.width() < wide_path);
        assert_eq!(actions.width(), wide_actions);

        ui.cwd.set_text(&path);
        allocate(min + 8);
        assert!(ui.cwd.width() < wide_path);
        assert!(ui.cwd.layout().is_ellipsized());
        assert_eq!(actions.width(), wide_actions);
        let buttons = actions.observe_children();
        assert_eq!(buttons.n_items(), 4);
        let cwd = ui.cwd.compute_bounds(&header).unwrap();
        let mut right = cwd.x() + cwd.width();
        for (index, (icon, label)) in [
            ("view-fullscreen-symbolic", "Expand terminal"),
            ("list-add-symbolic", "New shell tab"),
            (
                "window-close-symbolic",
                "Close this shell and its running jobs",
            ),
            ("document-send-symbolic", "Open in external terminal"),
        ]
        .into_iter()
        .enumerate()
        {
            let button = buttons
                .item(index as u32)
                .unwrap()
                .downcast::<gtk::Button>()
                .unwrap();
            assert!(button.is_focusable() && button.can_target());
            assert_eq!(button.icon_name().as_deref(), Some(icon));
            assert_eq!(button.accessible_role(), gtk::AccessibleRole::Button);
            assert!(gtk::test_accessible_has_property(
                &button,
                gtk::AccessibleProperty::Label
            ));
            assert!(!button.has_tooltip());
            button.set_sensitive(true);
            button.set_state_flags(gtk::StateFlags::PRELIGHT, false);
            assert!(ui.header_hint.get_visible());
            assert_eq!(ui.header_hint.text().as_str(), label);
            assert!(!ui.header_hint.can_target());
            let overlay = ui.header_hint.parent().unwrap();
            overlay.allocate(320, 180, -1, None);
            let hint = ui.header_hint.compute_bounds(&overlay).unwrap();
            assert!(hint.x() >= 0.0 && hint.x() + hint.width() <= 320.0);
            assert!(hint.y() >= 0.0 && hint.y() + hint.height() <= 180.0);
            button.unset_state_flags(gtk::StateFlags::PRELIGHT);
            assert!(!ui.header_hint.get_visible());
            let bounds = button.compute_bounds(&header).unwrap();
            assert!(bounds.x() > right && bounds.width() >= 24.0 && bounds.height() >= 24.0);
            right = bounds.x() + bounds.width();
        }
        assert!(right <= header.width() as f32);
        assert!(ui.notebook.next_sibling().is_none(), "no handoff footer");
        assert_eq!(
            ui.popover.parent().as_ref(),
            Some(ui.handoff.upcast_ref::<gtk::Widget>())
        );
    }

    #[gtk::test]
    #[ignore = "requires an isolated GTK display"]
    fn late_compact_layout_cannot_overwrite_an_embedded_fit() {
        let ui = test_window("org.notchfolk.TestViewport");
        let state = RefCell::new(Some(ui.clone()));
        ui.window.set_visible(true); // Realize the native surface without activating or creating a shell.
        let surface = ui.window.surface().unwrap();
        let viewport = (834_i32, 240_i32);
        fit_existing_window(&state, Some(&viewport.to_variant())).unwrap();
        surface.emit_by_name::<()>("layout", &[&COMPACT_SIZE.0, &COMPACT_SIZE.1]);
        assert_eq!(ui.window.default_size(), viewport);
        assert!(!ui.window.is_resizable());
        restore_existing_window(&state, true);
        assert!(ui.window.is_resizable());
        ui.window.close();
    }

    #[test]
    fn hiding_an_uncreated_window_is_idempotent_and_does_not_activate() {
        let state = RefCell::new(None);
        hide_existing_window(&state);
        hide_existing_window(&state);
        assert!(state.borrow().is_none());
    }

    #[test]
    fn restoring_or_detaching_an_uncreated_window_never_creates_a_shell_or_window() {
        let state = RefCell::new(None);
        restore_existing_window(&state, false);
        restore_existing_window(&state, true);
        assert!(state.borrow().is_none());
    }

    #[test]
    fn viewport_fit_validates_dimensions_without_creating_a_window() {
        let state = RefCell::new(None);
        assert!(fit_existing_window(&state, Some(&(804_i32, 240_i32).to_variant())).is_ok());
        assert!(fit_existing_window(&state, Some(&(804_i32, 480_i32).to_variant())).is_ok());
        assert!(state.borrow().is_none());
        assert!(fit_existing_window(&state, None).is_err());
        assert!(fit_existing_window(&state, Some(&true.to_variant())).is_err());
        assert!(fit_existing_window(&state, Some(&(0_i32, 240_i32).to_variant())).is_err());
        assert!(fit_existing_window(&state, Some(&(804_i32, -1_i32).to_variant())).is_err());
        assert!(fit_existing_window(&state, Some(&(32768_i32, 240_i32).to_variant())).is_err());
    }

    #[test]
    fn expanded_state_rejects_remote_changes_but_publishes_user_mode() {
        let action = expanded_state_action();
        assert_eq!(
            action.state().and_then(|state| state.get::<bool>()),
            Some(false)
        );
        action.activate(None);
        action.change_state(&true.to_variant());
        assert_eq!(
            action.state().and_then(|state| state.get::<bool>()),
            Some(false)
        );
        action.set_state(&true.to_variant());
        assert_eq!(
            action.state().and_then(|state| state.get::<bool>()),
            Some(true)
        );
        action.change_state(&false.to_variant());
        assert_eq!(
            action.state().and_then(|state| state.get::<bool>()),
            Some(true)
        );
    }
}
