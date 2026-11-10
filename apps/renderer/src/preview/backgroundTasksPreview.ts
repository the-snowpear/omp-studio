import type { JobInspection, StudioJobAgentLink, StudioJobSnapshot, StudioServiceRow } from "@omp-studio/studio-protocol";
import { buildPreviewHub, previewJobInspections } from "../hubPreview";
import { PREVIEW_SERVICES } from "./servicesPreview";

// Reuse the command stories, but this surface demonstrates work run by the main conversation.
const now = Date.now();
const hub = buildPreviewHub(now);
export const PREVIEW_BACKGROUND_MAIN_AGENT_ID = "main";
export const PREVIEW_BACKGROUND_JOB_AGENTS: StudioJobAgentLink[] = [];
const commands = ["job-91", "job-87", "job-83", "job-77"].map(id => hub.jobs.find(job => job.id === id)!);
export const PREVIEW_BACKGROUND_JOBS: StudioJobSnapshot[] = commands.map((job, index) => {
  const terminal = job.status !== "running" && job.status !== "queued";
  const end = now - (index + 1) * 30000;
  return {
    jobId: job.id as StudioJobSnapshot["jobId"],
    generation: 1 as StudioJobSnapshot["generation"],
    ownerAgentId: PREVIEW_BACKGROUND_MAIN_AGENT_ID as StudioJobSnapshot["ownerAgentId"],
    type: "bash",
    label: job.label,
    status: job.status,
    startedAt: new Date((terminal ? end : now) - job.durationMs).toISOString(),
    ...(terminal ? { completedAt: new Date(end).toISOString() } : {}),
    ...(job.resultText || job.errorText ? { summary: job.resultText || job.errorText! } : {}),
    ...(job.widget === undefined ? {} : { widget: job.widget }),
  };
});
PREVIEW_BACKGROUND_JOBS.push({
  jobId: "job-background-queued" as StudioJobSnapshot["jobId"],
  generation: 1 as StudioJobSnapshot["generation"],
  ownerAgentId: PREVIEW_BACKGROUND_MAIN_AGENT_ID as StudioJobSnapshot["ownerAgentId"],
  type: "bash", label: "npm run check -- --only renderer", status: "queued",
});
export const PREVIEW_BACKGROUND_SERVICES: StudioServiceRow[] = PREVIEW_SERVICES.map((service, index) => ({
  ...service, ownerId: PREVIEW_BACKGROUND_MAIN_AGENT_ID, ...(index === 0 ? { previewUrl: "http://127.0.0.1:30141/" } : {}), state: index === 0 ? "ready" : "starting", startedAt: now - (index === 0 ? 192000 : 55000),
  ...(index === 0 ? { readyAt: now - 190800 } : {}),
}));
export const PREVIEW_BACKGROUND_DETAILS: Record<string, JobInspection> = {
  ...Object.fromEntries(PREVIEW_BACKGROUND_JOBS.map(job => [job.jobId, {
    jobId: String(job.jobId), purpose: job.label, pids: [], ...(job.summary ? { output: job.summary } : {}),
  } satisfies JobInspection])),
  ...previewJobInspections(now),
};
