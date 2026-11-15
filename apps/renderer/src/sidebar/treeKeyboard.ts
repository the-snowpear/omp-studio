/** Shared tree ordering and navigation; callers own expansion, loading and focus. */
export function flattenTree<T extends { path: string; type: "file" | "dir" }>(nodes: readonly T[], children: (node: T) => readonly T[] | undefined, expanded: (path: string) => boolean, parentPath?: string, depth = 0): { node: T; parentPath?: string; depth: number }[] {
  return nodes.flatMap(node => [
    { node, depth, ...(parentPath === undefined ? {} : { parentPath }) },
    ...(node.type === "dir" && expanded(node.path) ? flattenTree(children(node) ?? [], children, expanded, node.path, depth + 1) : []),
  ]);
}

export function treeNavigationIndex(key: string, index: number, count: number, pageSize = 10): number | undefined {
  if (!count) return undefined;
  const next = key === "ArrowDown" ? index + 1 : key === "ArrowUp" ? index < 0 ? count - 1 : index - 1
    : key === "Home" ? 0 : key === "End" ? count - 1 : key === "PageDown" ? index + pageSize : key === "PageUp" ? index - pageSize : undefined;
  return next === undefined ? undefined : Math.max(0, Math.min(count - 1, next));
}

export function treeTypeahead<T>(items: readonly T[], index: number, query: string, name: (item: T) => string): T | undefined {
  for (let offset = 1; offset <= items.length; offset++) {
    const item = items[(index + offset) % items.length]!;
    if (name(item).toLocaleLowerCase().startsWith(query.toLocaleLowerCase())) return item;
  }
  return undefined;
}
