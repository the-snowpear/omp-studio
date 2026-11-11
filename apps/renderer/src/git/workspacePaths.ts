/** Git models use repository paths; Explorer and file documents use workspace paths. */
export function repositoryPathForWorkspaceFile(path: string, workspacePrefix = ""): string {
  return workspacePrefix ? `${workspacePrefix}/${path}` : path;
}

export function workspacePathForRepositoryFile(path: string, workspacePrefix = ""): string | undefined {
  if (!workspacePrefix) return path;
  const prefix = `${workspacePrefix}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}
