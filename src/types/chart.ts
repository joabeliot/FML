import type { Node } from "@xyflow/react";
import type { NodePorts } from "../lib/dataWires.ts";

export type LayoutDirection = "TB" | "LR";

export interface FmlNodeData {
  /** Display name — the FML node id. */
  label: string;
  /** FML node type ("page", "api", or anything else declared). */
  kind: string;
  /** Metadata from the node's `@node { ... }` block. */
  meta: Record<string, string>;
  /** Current layout direction, so the custom node can place its handles. */
  dir: LayoutDirection;
  /** 1-based flow position (dagre rank), for the step badge. Same-rank nodes share it. */
  order?: number;
  /** Set while a node's badge is "traced": this node's role relative to it. */
  traceRole?: "self" | "in" | "out" | "dim";
  /** Toggle trace mode for a node id — wired in by FlowCanvas, called from the badge. */
  onBadge?: (id: string) => void;
  /** What this node is doing in the current run — drives the step badge. */
  runState?: "running" | "passed" | "failed" | "skipped";
  /** True while this portal's target doc is unfolded inline as a bubble. Only meaningful on a `flow` node. */
  expanded?: boolean;
  /** Toggle inline expansion for a `flow` node — wired in by App, called from the expand button. */
  onExpand?: (id: string) => void;
  /** Data sockets to draw (FML-20) — absent when this node shows none right now. */
  ports?: NodePorts;
  /** React Flow requires node data to be an index signature. */
  [key: string]: unknown;
}

export type FmlFlowNode = Node<FmlNodeData>;
