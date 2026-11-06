import type { ComputerStructureNode, ComputerStructureSnapshot } from "@omp-studio/studio-protocol";
export function ComputerStructure({ structure, selected, onSelect, zh }: { structure: ComputerStructureSnapshot; selected?: string | undefined; onSelect: (node: ComputerStructureNode) => void; zh: boolean }) {
  function nodes(items: ComputerStructureNode[]) {
    return <ul>{items.map(node => <li key={node.id}><button className="cw-node" aria-pressed={selected === node.id} onClick={() => onSelect(node)}><span>{node.role}</span><strong>{node.name || (zh ? "未命名" : "Unnamed")}</strong><small>{node.enabled ? zh ? "可用" : "Enabled" : zh ? "不可用" : "Disabled"}</small></button>{node.children.length ? <details><summary>{zh ? `${node.children.length} 个子节点` : `${node.children.length} children`}</summary>{nodes(node.children)}</details> : null}</li>)}</ul>;
  }
  return <div className="cw-structure"><p>{zh ? "只读结构，不执行节点操作。" : "Read-only structure; nodes cannot be operated."}{structure.coordinateSpace !== "frame" ? zh ? "坐标关系不可用，不叠加高亮。" : "Coordinate mapping unavailable; highlights are disabled." : ""}</p>{structure.reason ? <p role="status">{structure.reason}</p> : null}{structure.truncated ? <p role="status">{zh ? "结构已截断" : "Structure truncated"}</p> : null}{nodes(structure.nodes)}</div>;
}
