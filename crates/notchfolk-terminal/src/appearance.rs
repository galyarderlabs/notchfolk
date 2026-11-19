// SPDX-License-Identifier: GPL-3.0-or-later

use gtk4::{gdk, gio, glib};
use vte4::prelude::*;

pub const THEME_KEY: &str = "island-theme";
pub const TINT_KEY: &str = "glass-tint";

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Appearance {
    pub glass: bool,
    standalone_background: gdk::RGBA,
}

impl Appearance {
    pub fn read(settings: Option<&gio::Settings>) -> Self {
        let Some(settings) = settings else {
            return Self::from_theme("black", 0);
        };
        if !supports_key(settings, THEME_KEY, glib::VariantTy::STRING) {
            return Self::from_theme("black", 0);
        }
        let theme = settings.string(THEME_KEY);
        let tint = if supports_key(settings, TINT_KEY, glib::VariantTy::INT32) {
            settings.int(TINT_KEY)
        } else {
            0
        };
        Self::from_theme(theme.as_str(), tint)
    }

    fn from_theme(theme: &str, tint: i32) -> Self {
        let glass = theme == "glass";
        // Outside Shell there is no blurred backdrop. Use one translucent,
        // blue-grey surface with enough contrast over an unfiltered white window.
        let standalone_background = if glass {
            let tint = tint.clamp(0, 100) as f32 / 100.0;
            let early = tint.sqrt();
            let mix = |clear: f32, dark: f32| clear + (dark - clear) * early;
            gdk::RGBA::new(mix(0.30, 0.06), mix(0.33, 0.07), mix(0.40, 0.07), 0.82)
        } else {
            gdk::RGBA::BLACK
        };
        Self {
            glass,
            standalone_background,
        }
    }

    pub fn body_background(self, embedded: bool) -> Option<gdk::RGBA> {
        // The fitted client has the actual Shell glass directly behind it.
        // Even a faint second layer here would leave a rectangular seam.
        (!embedded || !self.glass).then_some(self.standalone_background)
    }

    pub fn apply_terminal(self, terminal: &vte4::Terminal) {
        // Backgrounds only: never lower widget opacity or dim ANSI glyphs.
        let white = if self.glass { 1.0 } else { 0.88 };
        terminal.set_color_foreground(&gdk::RGBA::new(white, white, white, 1.0));
        terminal.set_color_background(&if self.glass {
            gdk::RGBA::new(0.0, 0.0, 0.0, 0.0)
        } else {
            gdk::RGBA::BLACK
        });
        terminal.set_clear_background(!self.glass);
    }
}

pub fn supports_key(settings: &gio::Settings, key: &str, kind: &glib::VariantTy) -> bool {
    settings
        .settings_schema()
        .is_some_and(|schema| schema.has_key(key) && schema.key(key).value_type() == kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_or_unknown_theme_is_opaque_black() {
        for appearance in [
            Appearance::read(None),
            Appearance::from_theme("black", 100),
            Appearance::from_theme("unknown", 0),
        ] {
            assert!(!appearance.glass);
            assert_eq!(appearance.body_background(false), Some(gdk::RGBA::BLACK));
            assert_eq!(appearance.body_background(true), Some(gdk::RGBA::BLACK));
        }
    }

    #[test]
    fn fitted_glass_adds_no_layer_at_any_tint() {
        for tint in [0, 25, 50, 100] {
            let appearance = Appearance::from_theme("glass", tint);
            assert!(appearance.glass);
            assert_eq!(appearance.body_background(true), None);
        }
    }

    #[test]
    fn standalone_glass_has_its_own_readable_tinted_background() {
        let clear = Appearance::from_theme("glass", 0);
        let dark = Appearance::from_theme("glass", 100);
        let bg = |a: Appearance| a.body_background(false).unwrap();
        assert!(bg(clear).red() > bg(Appearance::from_theme("glass", 25)).red());
        assert!(bg(Appearance::from_theme("glass", 25)).red() > bg(dark).red());
        // Even over solid white, the lightest fallback's brightest channel
        // stays below 0.5; this is a backing, not a change to text opacity.
        assert!(bg(clear).blue() * bg(clear).alpha() + (1.0 - bg(clear).alpha()) < 0.51);
        assert!(bg(clear).alpha() < 1.0 && bg(dark).alpha() < 1.0);
        assert_eq!(Appearance::from_theme("glass", -1), clear);
        assert_eq!(Appearance::from_theme("glass", 101), dark);
    }
}
