// SPDX-License-Identifier: GPL-3.0-or-later

use gtk4::{gdk, gio, glib};
use vte4::prelude::*;

pub const THEME_KEY: &str = "island-theme";
pub const TINT_KEY: &str = "glass-tint";

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Appearance {
    pub glass: bool,
    pub background: gdk::RGBA,
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
        // GTK cannot use Shell's backdrop shader. A single smoked translucent
        // layer keeps text readable over both bright and dark desktop content.
        // Tint darkens only that layer, never the window or its glyphs.
        let background = if glass {
            let tint = tint.clamp(0, 100) as f32 / 100.0;
            gdk::RGBA::new(0.035, 0.04, 0.05, 0.64 + 0.20 * tint)
        } else {
            gdk::RGBA::BLACK
        };
        Self { glass, background }
    }

    pub fn apply_terminal(self, terminal: &vte4::Terminal) {
        // TerminalBody supplies the one background layer, including margins.
        // Do not stack another tint or lower widget opacity: text/ANSI colours
        // and selection/cursor rendering must retain their full contrast.
        terminal.set_color_background(&if self.glass {
            gdk::RGBA::new(0.0, 0.0, 0.0, 0.0)
        } else {
            gdk::RGBA::BLACK
        });
        terminal.set_clear_background(!self.glass);
    }
}

pub fn supports_key(settings: &gio::Settings, key: &str, kind: &glib::VariantTy) -> bool {
    settings.settings_schema().is_some_and(|schema| {
        schema.has_key(key) && schema.key(key).value_type() == kind
    })
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
            assert_eq!(appearance.background, gdk::RGBA::BLACK);
        }
    }

    #[test]
    fn glass_stays_translucent_across_tint_range() {
        let clear = Appearance::from_theme("glass", 0);
        let dark = Appearance::from_theme("glass", 100);
        assert!(clear.glass && dark.glass);
        assert!(clear.background.alpha() > 0.0);
        assert!(clear.background.alpha() < dark.background.alpha());
        assert!(dark.background.alpha() < 1.0);
        assert_eq!(Appearance::from_theme("glass", -1), clear);
        assert_eq!(Appearance::from_theme("glass", 101), dark);
    }
}
