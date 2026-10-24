/**
 * Job tree for the Agent Hub: a subagent's jobs nest under the task job that
 * runs it. Lineage comes from the job rows themselves (`agentId` of a task job)
 * and the Runtime's `jobAgents` parent links for owners whose task job is not
 * listed (evicted, or spawned outside a job).
 */

export type JobTreeInput = {
  readonly id: string;
  readonly ownerId: string;
  readonly agentId?: string;
};

export type JobTreeRow<TJob extends JobTreeInput> = {
  readonly job: TJob;
  readonly depth: number;
  /** Number of jobs nested (directly or deeper) under this row. */
  readonly descendants: number;
};

const MAX_HOPS = 64;

/**
 * Depth-first rows. Order within a level follows `jobs` (the Runtime lists
 * newest first). A job whose owner chain cycles or never reaches a listed task
 * job stays at the top level.
 */
export function buildJobTree<TJob extends JobTreeInput>(
  jobs: readonly TJob[],
  links: ReadonlyArray<{ readonly id: string; readonly parentId?: string }> = [],
): JobTreeRow<TJob>[] {
  const runner = new Map<string, TJob>();
  for (const job of jobs) if (job.agentId && !runner.has(job.agentId)) runner.set(job.agentId, job);
  const parentAgent = new Map(links.map((link) => [link.id, link.parentId]));
  const parentOf = (job: TJob): TJob | undefined => {
    let agent: string | undefined = job.ownerId;
    for (let hops = 0; agent !== undefined && hops < MAX_HOPS; hops += 1) {
      const host = runner.get(agent);
      if (host !== undefined && host !== job) return host;
      agent = parentAgent.get(agent);
    }
    return undefined;
  };
  const children = new Map<TJob | undefined, TJob[]>();
  for (const job of jobs) {
    let parent = parentOf(job);
    // Reject a parent whose own chain leads back to this job (cycle).
    for (let seen = parent, hops = 0; seen !== undefined && hops < MAX_HOPS; hops += 1) {
      if (seen === job) {
        parent = undefined;
        break;
      }
      seen = parentOf(seen);
    }
    const list = children.get(parent) ?? [];
    list.push(job);
    children.set(parent, list);
  }
  const rows: JobTreeRow<TJob>[] = [];
  const visit = (job: TJob, depth: number): number => {
    const index = rows.length;
    rows.push({ job, depth, descendants: 0 });
    let count = 0;
    for (const child of children.get(job) ?? []) count += 1 + visit(child, depth + 1);
    rows[index] = { job, depth, descendants: count };
    return count;
  };
  for (const root of children.get(undefined) ?? []) visit(root, 0);
  return rows;
}

/** Rows of one agent's jobs: the jobs it owns, with whatever nests under them. */
export function agentJobTree<TJob extends JobTreeInput>(
  jobs: readonly TJob[],
  links: ReadonlyArray<{ readonly id: string; readonly parentId?: string }>,
  agentId: string,
): JobTreeRow<TJob>[] {
  const rows = buildJobTree(jobs, links);
  const out: JobTreeRow<TJob>[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.job.ownerId !== agentId) continue;
    const block = rows.slice(index, index + 1 + row.descendants);
    for (const item of block) out.push({ ...item, depth: item.depth - row.depth });
    index += row.descendants;
  }
  return out;
}
