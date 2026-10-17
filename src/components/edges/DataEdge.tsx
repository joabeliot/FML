import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";

/**
 * A data wire (FML-20): a captured value travelling from the node that
 * captures it to a node that spends it. Curved and dashed where control-flow
 * edges are right-angled and solid, and in its own colour, so "what runs
 * next" and "what value goes where" never read as the same line.
 */
export function DataEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }: EdgeProps) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <BaseEdge
      path={path}
      style={{ stroke: "var(--color-data)", strokeWidth: 1.25, strokeDasharray: "4 3", opacity: 0.85 }}
      interactionWidth={0}
    />
  );
}
