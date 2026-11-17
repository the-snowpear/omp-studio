/**
 * The key the swarm recorder files history under: execution target, workspace,
 * parent session and preview. The workbench deck records under it and the
 * Agent Hub reads under it, so both must build it here.
 */
export function agentSwarmScope(targetId: string | null, workspaceId: string | undefined, parentSessionId: string | undefined, preview: boolean): string {
  return JSON.stringify([targetId, workspaceId, parentSessionId, preview]);
}
