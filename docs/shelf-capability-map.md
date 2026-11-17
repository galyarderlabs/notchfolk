# Capability Map: Shelf scroll and capacity

| Module id | Responsibility | Depends on |
|---|---|---|
| `shelf-scroll` | Make the Files row scroll horizontally through the island and drag-and-drop helper, with file names staying aligned. | — |
| `shelf-capacity` | Add a saved 6–64 file limit in Settings and enforce it across every way files enter the Shelf. | A shared setting value between the extension, daemon and helper. |

Build order: `shelf-scroll` → `shelf-capacity`.

Each module is a separate change and can be reviewed independently. Keep the current
local Shelf handoff edit uncommitted until the user asks to commit it.
