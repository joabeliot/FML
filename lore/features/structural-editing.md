# Structural editing (FML-22)

Add, delete and rename nodes, and add and delete edges, from the dashboard.
Each one writes a small edit straight into the `.fml` text.

## Where it lives

| Piece | File |
|---|---|
| Text ops: `addNode`, `deleteNode`, `renameNode`, `addEdge`, `deleteEdge`, `uniqueNodeId`, `safeLabel` | `src/lib/fmlStructure.ts` |
| Tests, including a sweep that deletes and renames every node in every example | `src/lib/fmlStructure.test.ts` |
| Wiring, undo stack, keyboard shortcuts | `src/App.tsx` (the "structural edits" block) |
| `+ Node` type menu | `src/components/Toolbar.tsx` |
| Editable id + Delete button | `src/components/PropertyPanel.tsx` (`IdField`) |
| Drag to connect | `src/components/FlowCanvas.tsx` (`onConnect`, `deleteKeyCode={null}`) |

## Rules it follows

- **Edit the lines, never re-print the file.** Same rule as `fmlEdit.ts`. The
  scanner reads lines the way the parser lexes them: comments stripped,
  groups scoped by indentation, and note blocks skipped.
- **Placement:** append. New declarations go at the end of `@nodes`, which is
  created ahead of `@node`/`@flow` when the doc has none. A new edge joins the
  source's existing group, otherwise it goes on a new line at the end of
  `@flow`, which is created if missing. Revisit only if JB finds it hard to
  read.
- **Delete cascades:** the declaration, the `@node` block, every edge touching
  the node (note blocks included), and any group header left empty.
- **No-op instead of an error:** an op returns the source unchanged if the id
  is taken or invalid, or the node or edge isn't there. The UI treats an
  unchanged source as "rejected".
- **Undo:** an in-memory stack of `{file, previous text}`, 50 entries, ⌘Z.
  It's lost on reload. The Source panel's own typing isn't on it.
- **Doc-local:** every op is scoped to one `@doc` span, and an edge can't be
  drawn into a bubble (another doc's node).
- **Positions:** a rename carries the dragged position over to the new id
  (`renamePosition`).

## Not done / open

- The ops are written against FML's grammar. RML (FML-21) will need its own
  section names, but the scanner/splice pattern is the part to reuse.
- An edge can't be re-targeted by dragging its end (`edgesReconnectable` is
  still off). Delete it and draw a new one instead.
- New nodes are placed by dagre. Unconnected ones sit in the top rank until
  they're wired in.
