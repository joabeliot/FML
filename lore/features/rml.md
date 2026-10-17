# RML: RoadMap Language (FML-21)

FML maps an API flow. RML maps a project: features and milestones, where
`A -> B` means **B depends on A**. Nodes can have several parents, so it's a
DAG. RML is the third piece alongside lore and FML: a roadmap node points at
the `.fml` that proves it and the lore tickets driving it.

## Decisions

- **Same grammar, different vocabulary.** `.rml` is parsed by
  `src/fml/parse.ts` with `RML_VOCABULARY` (`feature`, `milestone`) through
  the new `ParseOptions.vocabulary`. FML's default vocabulary is unchanged.
  Comments, `@doc`, `@fof` and edge notes all come for free. There is no
  second parser.
- **Three written states plus one derived.** You write `status: pending |
  active | done` by hand (pending when absent). The view also derives
  **ready**: pending, with every dependency done. That's the frontier,
  "what's next". The ticket asked whether a third state was wanted;
  in-progress is real on a roadmap, so it's in. Status is not derived from
  a linked ticket's state (a non-goal in the ticket).
- **Links are plain text in v1.** `fml:` and `ticket:` are shown as
  references. An `fml:` whose file is loaded in the workspace opens it in
  the flow view. Ticket ids aren't resolved against `ticket.json`, which
  waits on the File System Access / "Open folder" item.
- **One workspace.** `.rml` files are stored under their full name
  (`roadmap.rml`). `fileKey` only strips `.fml`, so the two kinds of file
  can't collide, and persistence, ⌘Z and the Source panel cover both. Places
  that only deal with flows filter them out (`isRoadmapKey`).
- **Layout is earliest-column.** A node sits one column past its deepest
  prerequisite. dagre only orders tiles vertically within a column, because
  plain dagre balancing pushed nodes far right and ran connectors behind
  unrelated tiles.
- **Its own React Flow store.** The two views swap in place. Sharing the
  app's store let one canvas render a frame of the other's node types.

## Visual language (from the reference image)

| Display | Looks like |
|---|---|
| done | tile lit in its `area` colour, gold-tinted border |
| active | lit, gold border with a soft ring |
| ready | dark tile, area-coloured border, `NEXT` tag |
| locked | dark, dimmed |

Milestones are bolder with rounder corners and a ◆. Connectors turn gold once
their prerequisite is done. Hover shows the title and description; click
opens the panel (status, description, area, proven-by flows, tickets,
depends-on and unlocks).

## Where it lives

| Piece | File |
|---|---|
| Vocabulary, status, display states, checks (bad status, unknown key, cycles), progress | `src/rml/rml.ts` (+ `rml.test.ts`) |
| Pluggable vocabulary in the parser | `src/fml/parse.ts` (`FML_VOCABULARY`), `src/fml/types.ts` (`FmlVocabulary`) |
| View, tiles, layout, panel, status write-back | `src/components/RoadmapView.tsx` |
| Flows/Roadmap switch, file routing, toolbar mode | `src/App.tsx`, `src/components/Toolbar.tsx` |
| Example (F*ML's own roadmap, real statuses as of 2026-10-17) | `examples/roadmap.rml` |

## FML-28: skill-tree look + editing (2026-10-17)

Joab sent a game talent-tree screenshot as the target look.

- **Layout** (`src/lib/radialLayout.ts`, pure + tested): roots at the
  centre; each node one grid step (124px) from its tree parent (its deepest
  prerequisite) in one of 8 compass directions, taking the free cell closest
  to its branch's outward heading, further out if the near ones are taken.
  Placed breadth-first; siblings grouped by area. Gives the octilinear look
  of the reference. A first pass used a polar tidy-tree, which put lines at
  every angle and looked tangled, so it was dropped.
- **Tiles**: square features (74px if they unlock ≥3, else 56), diamond
  milestones, an icon per tile (`icon:` key, else picked from the id), the
  label underneath on a backing so lines never run through text. Warm dark
  canvas. Straight centre-to-centre lines (hidden centre handles).
- **Editing**: + Feature / + Milestone (unlocked by the selection, if any),
  drag a tile's gold `link` handle onto another to add a dependency (loops
  refused), panel edits every field plus rename/kind/dependencies, Delete
  key. All through `onEdit`, so App's undo stack covers it. Uses the same
  `fmlStructure` / `fmlEdit` ops as the flow view; the grammar is the same.
- **New roadmap** button creates `roadmap.rml` with one `start` milestone.

## Not done

- Only a roadmap's first `@doc` is shown.
- Tiles can't be dragged and positions aren't saved. The layout is always
  automatic (by design for now: the grid is what keeps it tidy).
