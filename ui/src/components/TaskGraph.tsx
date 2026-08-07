import { useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  BackgroundVariant,
  type Connection,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { TaskGraph } from "../api-types";
import type { NodeState } from "../types";
import StepNode, { type StepNodeData } from "./StepNode";

const NODE_TYPES = { stepNode: StepNode };

// ─── Layout helpers ──────────────────────────────────────────────────────────
// Topological sort → assign layer, then spread across x within each layer
function computeLayout(
  steps: TaskGraph["steps"],
): Map<string, { x: number; y: number }> {
  const layer = new Map<string, number>();

  function getLayer(id: string): number {
    if (layer.has(id)) return layer.get(id)!;
    const step = steps.find((s) => s.id === id)!;
    const l = step.dependsOn.length === 0
      ? 0
      : Math.max(...step.dependsOn.map(getLayer)) + 1;
    layer.set(id, l);
    return l;
  }

  steps.forEach((s) => getLayer(s.id));

  // group by layer
  const byLayer = new Map<number, string[]>();
  for (const [id, l] of layer) {
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(id);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const NODE_W = 200;
  const NODE_H = 160;
  const GAP_X = 60;
  const GAP_Y = 80;

  for (const [l, ids] of byLayer) {
    const total = ids.length;
    ids.forEach((id, i) => {
      const x = (i - (total - 1) / 2) * (NODE_W + GAP_X);
      const y = l * (NODE_H + GAP_Y);
      positions.set(id, { x, y });
    });
  }

  return positions;
}

interface TaskGraphProps {
  graph: TaskGraph;
  nodeStates: Map<string, NodeState>;
}

export default function TaskGraphView({ graph, nodeStates }: TaskGraphProps) {
  const layout = useMemo(() => computeLayout(graph.steps), [graph]);

  const initialNodes: Node<StepNodeData>[] = useMemo(
    () =>
      graph.steps.map((step) => ({
        id: step.id,
        type: "stepNode",
        position: layout.get(step.id) ?? { x: 0, y: 0 },
        data: {
          label: step.label,
          capability: step.capability,
          nodeState: nodeStates.get(step.id) ?? { phase: "idle" },
        },
      })),
    [graph, layout, nodeStates],
  );

  const initialEdges: Edge[] = useMemo(
    () =>
      graph.steps.flatMap((step) =>
        step.dependsOn.map((dep) => ({
          id: `${dep}->${step.id}`,
          source: dep,
          target: step.id,
          animated: false,
          style: { stroke: "#334155", strokeWidth: 2 },
        })),
      ),
    [graph],
  );

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  const onConnect = useCallback(
    (params: Connection) => addEdge(params, edges),
    [edges],
  );

  // Sync nodeStates into node data without re-creating layout
  const liveNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          nodeState: nodeStates.get(n.id) ?? { phase: "idle" },
        },
      })),
    [nodes, nodeStates],
  );

  return (
    <div className="graph-canvas">
      <ReactFlow
        nodes={liveNodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="#1e293b"
        />
        <Controls
          style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8 }}
        />
        <MiniMap
          nodeColor={(n) => {
            const state = nodeStates.get(n.id);
            switch (state?.phase) {
              case "settled":  return "#22c55e";
              case "running":  return "#f59e0b";
              case "blocked":  return "#ef4444";
              case "failed":   return "#7f1d1d";
              case "queued":   return "#6366f1";
              default:         return "#1e293b";
            }
          }}
          style={{ background: "#0f172a", border: "1px solid #1e293b" }}
          maskColor="rgba(0,0,0,0.4)"
        />
      </ReactFlow>
    </div>
  );
}
