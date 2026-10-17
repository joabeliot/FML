# lore/tickets/

Reference material for tickets that doesn't fit in `ticket.json`'s text
fields — chiefly images JB pastes when describing a feature by example.
`ticket.json` itself is managed only through `lore ticket` (never hand-edited
— see `CLAUDE.md`), but a ticket's `--context` list can point at a file in
here so an agent picking up the ticket can actually see what was meant.

## assets/

- `node-socket-linking-reference.png` — Blender/node-editor-style sockets:
  typed in/out ports on a node, wired to another node's port to pass a
  value. Reference for the FML node-variable-wiring feature (visual
  connection instead of typing `{name}` into a field).
- `rml-roadmap-reference.png` — a game tech-tree (muted vs. lit nodes,
  multi-parent dependencies, grouped by category/colour). Reference for RML
  (RoadMap Language), the sibling tool for visualizing project roadmaps the
  same way FML visualizes flows.
