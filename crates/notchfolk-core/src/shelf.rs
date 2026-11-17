// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian
// Copyright (C) 2026 Galyarder Labs

//! The file shelf: files parked on the island to drag later; it never copies or moves them.

use serde::{Deserialize, Serialize};

/// The default capacity of the shelf.
pub const DEFAULT_CAPACITY: usize = 12;
/// Minimum allowed capacity.
pub const MIN_CAPACITY: usize = 6;
/// Maximum allowed capacity.
pub const MAX_CAPACITY: usize = 64;
/// The shelf holds this many files by default; to add another,
/// one must be removed first.
pub const CAPACITY: usize = DEFAULT_CAPACITY;

fn default_capacity() -> usize {
    DEFAULT_CAPACITY
}

/// One file parked on the shelf.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShelfItem {
    /// `file://` URI of the item.
    pub uri: String,
    /// Display name, usually the file name.
    pub name: String,
    pub added_at_ms: i64,
}

/// Files parked on the island, at most [`capacity`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shelf {
    items: Vec<ShelfItem>,
    /// Read through `clamped_capacity`: a file written by hand (or by an older build) may hold anything.
    #[serde(default = "default_capacity")]
    capacity: usize,
}

impl Default for Shelf {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            capacity: DEFAULT_CAPACITY,
        }
    }
}

/// `capacity` held between [`MIN_CAPACITY`] and [`MAX_CAPACITY`]: a saved 0 would take no file at all.
fn clamped_capacity(capacity: usize) -> usize {
    capacity.clamp(MIN_CAPACITY, MAX_CAPACITY)
}

impl Shelf {
    /// The parked files, newest first.
    pub fn items(&self) -> &[ShelfItem] {
        &self.items
    }

    /// How many files the shelf can hold at once, held between [`MIN_CAPACITY`] and [`MAX_CAPACITY`].
    pub fn capacity(&self) -> usize {
        clamped_capacity(self.capacity)
    }

    /// Sets the shelf's capacity, clamped between 6 and 64. Existing files are never removed.
    pub fn set_capacity(&mut self, capacity: usize) {
        self.capacity = clamped_capacity(capacity);
    }

    /// Adds an item at the front, moving it there if already present.
    /// Returns false, changing nothing, when a new item finds the shelf full.
    pub fn add(&mut self, item: ShelfItem) -> bool {
        let present = self.items.iter().any(|existing| existing.uri == item.uri);
        if !present && self.items.len() >= self.capacity() {
            return false;
        }
        self.items.retain(|existing| existing.uri != item.uri);
        self.items.insert(0, item);
        true
    }

    /// Takes the file with `uri` off the shelf; true if it was there.
    pub fn remove(&mut self, uri: &str) -> bool {
        let before = self.items.len();
        self.items.retain(|item| item.uri != uri);
        self.items.len() != before
    }

    /// Empties the shelf; the files themselves stay where they are.
    pub fn clear(&mut self) {
        self.items.clear();
    }

    /// Keeps only the items for which `exists` returns true; true if any were dropped.
    pub fn retain_existing(&mut self, exists: impl Fn(&ShelfItem) -> bool) -> bool {
        let before = self.items.len();
        self.items.retain(exists);
        self.items.len() != before
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(uri: &str) -> ShelfItem {
        ShelfItem {
            uri: uri.into(),
            name: uri.into(),
            added_at_ms: 0,
        }
    }

    #[test]
    fn re_adding_moves_to_front() {
        let mut shelf = Shelf::default();
        shelf.add(item("a"));
        shelf.add(item("b"));
        shelf.add(item("a"));
        let uris: Vec<_> = shelf.items().iter().map(|i| i.uri.as_str()).collect();
        assert_eq!(uris, ["a", "b"]);
    }

    #[test]
    fn a_full_shelf_refuses_new_files() {
        let mut shelf = Shelf::default();
        for n in 0..CAPACITY {
            assert!(shelf.add(item(&n.to_string())));
        }
        assert!(!shelf.add(item("new")));
        assert_eq!(shelf.items().len(), CAPACITY);
        // A file already there can still move to the front.
        assert!(shelf.add(item("0")));
        assert_eq!(shelf.items()[0].uri, "0");
        assert!(shelf.remove("1"));
        assert!(shelf.add(item("new")));
    }

    #[test]
    fn lowering_capacity_keeps_existing_files() {
        let mut shelf = Shelf::default();
        for n in 0..12 {
            assert!(shelf.add(item(&n.to_string())));
        }
        shelf.set_capacity(6);
        assert_eq!(shelf.items().len(), 12);
        assert!(!shelf.add(item("new")));
        assert!(shelf.add(item("0")));
        assert_eq!(shelf.items().len(), 12);
    }

    #[test]
    fn a_saved_capacity_outside_the_range_is_clamped() {
        // What a hand-edited shelf.json (or one from a build without the range) could hold.
        let saved: Shelf = serde_json::from_str(r#"{"items":[],"capacity":0}"#).unwrap();
        assert_eq!(saved.capacity(), MIN_CAPACITY);
        let saved: Shelf = serde_json::from_str(r#"{"items":[],"capacity":9000}"#).unwrap();
        assert_eq!(saved.capacity(), MAX_CAPACITY);
        // An older file has no capacity at all: the default.
        let saved: Shelf = serde_json::from_str(r#"{"items":[]}"#).unwrap();
        assert_eq!(saved.capacity(), DEFAULT_CAPACITY);
        // A shelf saved with 0 still takes files, up to the minimum.
        let mut saved: Shelf = serde_json::from_str(r#"{"items":[],"capacity":0}"#).unwrap();
        assert!(saved.add(item("a")));
    }
}
