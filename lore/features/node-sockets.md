# Node sockets: data wires (FML-20)

The `capture.<name>` → `{name}` plumbing, drawn on the canvas as wires and
editable by dragging. This is only an editor feature: `run.ts` resolves
`{name}` the same way however it got into the text.

## Decisions (the ticket's three open questions)

Joab said to keep it minimal and do what feels right. Each of these is
reversible:

1. **Same canvas, second layer.** Wires are dashed orange bezier curves
   (`--color-data`), while control-flow edges are solid right-angled lines,
   so the two never read as the same thing. Ports sit on the left and right
   sides, because control flow uses the top and bottom. The **Data** toolbar
   toggle (saved per browser, off by default) shows every wire. With it off,
   the selected node's wires are still shown, plus the ports at their far
   ends. Wires are kept out of the layout and out of the fit key, so showing
   them never moves a node or the camera.
2. **Fields are free text, so a wire is appended.** You drag from an output
   port and drop anywhere on the target card. A menu offers that node's
   free-text fields (the reference is appended, joined with `/` for
   `path`/`url`), the two usual new places for a value on an `api` node
   (`auth: bearer {name}`, `query.<name>`), or a typed new key. A key that
   already exists gets the reference appended, never replaced. A field that
   already holds `{name}` isn't offered. Excluded: `method`, `label`,
   `expect`, `capture.*`.
3. **One input port per name.** A name used in several fields is one port
   with one wire, from the node whose `capture` defines it (per
   `resolveVariables`, so the first in declaration order).

Port states: filled means captured by a node. Hollow means an `@vars`
default (no wire, since the value is in the file). Hollow red means a
run-time input that nothing supplies. A node spending its own capture (e.g.
an `assert` on it) draws no self-wire.

## Where it lives

| Piece | File |
|---|---|
| Graph, visibility filter, drop options | `src/lib/dataWires.ts` (+ `.test.ts`) |
| Ports on the card, `updateNodeInternals` when they change | `src/components/nodes/FmlNode.tsx` (`DataPorts`) |
| Wire rendering | `src/components/edges/DataEdge.tsx` |
| Drop menu | `src/components/DataWirePicker.tsx` |
| Keeping data and control drags apart, drop target lookup | `src/components/FlowCanvas.tsx` (`isValidConnection`, `onConnectEnd`) |
| Toggle, data edges, writing the edit (undoable) | `src/App.tsx`, `src/components/Toolbar.tsx` |

## Gotcha (found by the e2e suite)

The visible graph keeps its object identity unless what it shows changes
(`shownRef` in App). Recomputing it on every selection change rebuilt every
canvas node, and doing that on the first click of a double-click swallowed
the double-click, so portal drill-in broke. Selecting a node *with* wires
still rebuilds, which is harmless because only `flow` nodes use
double-click.

## Not done

- Unwiring by dragging a wire off. To remove one, edit the field or the
  Code tab.
- Wires into or out of a bubble (another doc). Variable scope across docs is
  still the open routing question in `ideas/flow-execution.md`.
- Wires can cross cards on dense flows, because they're routed as plain
  beziers. Revisit if it gets noisy in real use.
