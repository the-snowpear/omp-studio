import type { Dispatch, SetStateAction } from "react";
import type { CapabilityManifest } from "@omp-studio/studio-protocol";
import { WorkspaceStatus } from "../../workspaces/Workspace";
import type { SessionId, StudioClient } from "@omp-studio/client-contract";
import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";
import { CompletionRing, JobWidget } from "../../conversation/JobWidget";
import { JobInspector } from "../../conversation/JobInspector";
import { type JobTreeRow } from "../../conversation/jobTree";
import { Icon } from "../../icons";
import { previewJobInspections } from "../../hubPreview";
import { type HubAgent, type HubJob } from "./types";
import { CONTRACT, missingCap } from "./capabilities";
import { fmtDur } from "./projection";

interface HubJobRowProps {
  selectedJobId: string | null;
  setSelectedJobId: Dispatch<SetStateAction<string | null>>;
  zh: boolean;
  preview: boolean;
  viewingLive: boolean;
  commandBusy: boolean;
  connOnline: boolean;
  client: StudioClient | undefined;
  capabilities: CapabilityManifest | undefined;
  cancelJob: (job: HubJob) => void;
  parentSessionId: SessionId | undefined;
  snapshot: OperatorStateSnapshot | undefined;
  resyncRequired: boolean | undefined;
  row: JobTreeRow<HubJob>;
  agent: HubAgent | undefined;
}

export function HubJobRow({ selectedJobId, setSelectedJobId, zh, preview, viewingLive, commandBusy, connOnline, client, capabilities, cancelJob, parentSessionId, snapshot, resyncRequired, row, agent }: HubJobRowProps) {

    const job = row.job;
    const open = selectedJobId === job.id;
    const toggle = () => setSelectedJobId(open ? null : job.id);
    return (
      <div key={job.id}>
        <div
          className={`hub-job${open ? " selected" : ""}`}
          role="button"
          tabIndex={0}
          aria-expanded={open}
          aria-label={`${job.label} · ${job.status}`}
          data-job-id={job.id}
          data-depth={row.depth}
          style={row.depth > 0 ? { marginLeft: `calc(${row.depth} * var(--sp-16, 16px))` } : undefined}
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggle();
            }
          }}
        >
          <span
            className={`a-ic ${job.type === "bash" ? "blue" : "purple"}`}
            aria-hidden="true"
          >
            <Icon
              name={job.type === "bash" ? "terminal" : "bot"}
              extra="sm"
            />
          </span>
          <div className="jb-label">
            <span className="ellipsis" style={{ display: "block" }}>
              {job.label}
            </span>
            {job.caption ? <span className="small muted" style={{ display: "block" }}>{job.caption}</span> : null}
            <span className="mono hub-job-meta">
              {job.id} · {job.type} · {fmtDur(job.durationMs)}
              {agent && job.ownerId !== agent.id ? ` · owner ${job.ownerId}` : ""}
              {row.descendants > 0 ? ` · ${row.descendants} ${zh ? "个子任务" : "nested"}` : ""}
              {job.completionPercent !== undefined && job.status === "running" ? (
                <CompletionRing percent={job.completionPercent} size={16} />
              ) : null}
            </span>
            {job.stage ?? job.widget?.stage ? (
              <span className="ellipsis" style={{ display: "block", color: "var(--text-2)" }}>
                {job.stage ?? job.widget?.stage}
              </span>
            ) : null}
            {job.widget && job.widget.blocks.length > 0 && !open ? (
              <div className="hub-job-widget">
                <JobWidget view={job.widget} compact />
              </div>
            ) : null}
            {job.errorText ? (
              <span className="mono" style={{ color: "var(--red)" }}>
                {job.errorText}
              </span>
            ) : null}
            {job.resultText ? (
              <span className="mono" style={{ color: "var(--green)" }}>
                {job.resultText}
              </span>
            ) : null}
          </div>
          <WorkspaceStatus state={job.status} />
          {job.status === "running" &&
          (!agent || job.ownerId === agent.id) ? (
            <button
              className="btn small outline"
              type="button"
              disabled={
                preview ||
                !viewingLive ||
                commandBusy ||
                !connOnline ||
                !client ||
                missingCap(capabilities, "job.cancel")
              }
              data-tip={
                !viewingLive
                  ? CONTRACT.historicalWrite
                  : missingCap(capabilities, "job.cancel")
                    ? CONTRACT.cancel
                    : undefined
              }
              onClick={(event) => {
                event.stopPropagation();
                cancelJob(job);
              }}
            >
              取消
            </button>
          ) : null}
        </div>
        {open ? (
          <JobInspector
            job={job}
            client={client}
            sessionId={parentSessionId ?? snapshot?.sessionId}
            available={!preview && viewingLive && connOnline && !resyncRequired}
            {...(preview ? { previewInspection: previewJobInspections()[job.id] ?? null } : {})}
            onClose={() => setSelectedJobId(null)}
          />
        ) : null}
      </div>
    );
  
}
