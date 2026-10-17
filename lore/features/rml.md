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

## Not done

- Only a roadmap's first `@doc` is shown.
- Tiles can't be dragged and positions aren't saved. The layout is always
  automatic.
- No structural editing (add/delete/connect) in the roadmap view yet. The
  `fmlStructure.ts` ops would work as-is (the grammar is the same), but the
  UI isn't wired.
