import { useCallback, useEffect, useMemo } from "react";
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
  type Edge,
  type Node,
} from "reactflow";
import type { NodeStateWire, ProviderCatalogEntryWire, TaskGraph } from "@sentinel/schemas";
import StepNode, { type StepNodeData } from "./StepNode";

const NODE_TYPES = { stepNode: StepNode };

// ─── Layout helpers ──────────────────────────────────────────────────────────
// Topological sort → assign layer, then spread across x within each layer.
function computeLayout(
  steps: TaskGraph["steps"],
): Map<string, { x: number; y: number }> {
  const layer = new Map<string, number>();

  function getLayer(id: string): number {
    const cached = layer.get(id);
    if (cached !== undefined) return cached;
    const step = steps.find((s) => s.id === id);
    if (step === undefined) {
      layer.set(id, 0);
      return 0;
    }
    const l =
      step.dependsOn.length === 0
        ? 0
        : Math.max(...step.dependsOn.map(getLayer)) + 1;
    layer.set(id, l);
    return l;
  }

  steps.forEach((s) => getLayer(s.id));

  const byLayer = new Map<number, string[]>();
  for (const [id, l] of layer) {
    const ids = byLayer.get(l) ?? [];
    ids.push(id);
    byLayer.set(l, ids);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const NODE_W = 210;
  const NODE_H = 170;
  const GAP_X = 70;
  const GAP_Y = 90;

  for (const [l, ids] of byLayer) {
    const total = ids.length;
    ids.forEach((id, i) => {
      positions.set(id, {
        x: (i - (total - 1) / 2) * (NODE_W + GAP_X),
        y: l * (NODE_H + GAP_Y),
      });
    });
  }

  return positions;
}

function nodeColor(state: NodeStateWire | undefined): string {
  switch (state?.kind) {
    case "settled":
      return "#22c55e";
    case "quoted":
    case "paying":
    case "paid":
    case "validating":
      return "#f59e0b";
    case "blocked":
      return "#ef4444";
    case "failed":
      return "#7f1d1d";
    default:
      return "#334155";
  }
}

interface TaskGraphProps {
  graph: TaskGraph;
  nodeStates: Record<string, NodeStateWire>;
  /** Provider catalog keyed by id — node cards read scheme/network from here. */
  providersById?: Record<string, ProviderCatalogEntryWire>;
  /** nodeId → fallback provider (reroute tracking from useWs). */
  reroutes?: Record<string, string>;
}

export default function TaskGraphView({ graph, nodeStates, providersById, reroutes }: TaskGraphProps) {
  const layout = useMemo(() => computeLayout(graph.steps), [graph]);

  // Position-only nodes — the state machine data is merged in liveNodes so a
  // node_state frame doesn't reset drag positions.
  const baseNodes: Node<StepNodeData>[] = useMemo(
    () =>
      graph.steps.map((step) => ({
        id: step.id,
        type: "stepNode",
        position: layout.get(step.id) ?? { x: 0, y: 0 },
        data: {
          label: step.label,
          capability: step.capability,
          nodeState: { kind: "pending" },
        },
      })),
    [graph, layout],
  );

  const baseEdges: Edge[] = useMemo(
    () =>
      graph.steps.flatMap((step) =>
        step.dependsOn.map((dep) => ({
          id: `${dep}->${step.id}`,
          source: dep,
          target: step.id,
          style: { stroke: "#334155", strokeWidth: 2 },
        })),
      ),
    [graph],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<StepNodeData>(baseNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(baseEdges);

  // Swap in a new graph (new task / replay) without touching user drag state.
  useEffect(() => {
    setNodes(baseNodes);
  }, [baseNodes, setNodes]);

  useEffect(() => {
    setEdges(baseEdges);
  }, [baseEdges, setEdges]);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges],
  );

  // Merge live node states into node data.
  const liveNodes = useMemo(
    () =>
      nodes.map((n) => {
        const ns = nodeStates[n.id] ?? { kind: "pending" };
        const providerId = "providerId" in ns ? ns.providerId : undefined;
        const meta =
          providerId !== undefined ? providersById?.[providerId] : undefined;
        return {
          ...n,
          data: {
            ...n.data,
            nodeState: ns,
            providerMeta:
              meta !== undefined
                ? { scheme: meta.scheme, network: meta.network }
                : null,
            fellBackTo: reroutes?.[n.id] ?? null,
          },
        };
      }),
    [nodes, nodeStates, providersById, reroutes],
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
          nodeColor={(n) => nodeColor(nodeStates[n.id])}
          style={{ background: "#0f172a", border: "1px solid #1e293b" }}
          maskColor="rgba(0,0,0,0.4)"
        />
      </ReactFlow>
    </div>
  );
}
