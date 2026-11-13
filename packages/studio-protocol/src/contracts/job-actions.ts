/** Structured native GitHub Actions watcher data attached to an existing task/eval job. */
export interface JobActionsStep {
	number: number;
	name: string;
	status?: string;
	conclusion?: string;
	/** Native observed duration; absent means unknown, not zero or an estimate. */
	durationSeconds?: number;
}
export interface JobActionsJob {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	durationSeconds?: number;
	url?: string;
	steps: JobActionsStep[];
}
export interface JobActionsRun {
	id: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	branch?: string;
	headSha?: string;
	url?: string;
	jobs: JobActionsJob[];
}
export interface JobActionsFailedLog {
	runId: number;
	/** Present only when the native run has one unambiguous job with this log's name. */
	jobId?: number;
	workflowName?: string;
	jobName: string;
	conclusion?: string;
	tail?: string;
	available: boolean;
	unavailableReason?: string;
}
export interface JobActionsView {
	mode: "run" | "commit";
	state: "watching" | "completed";
	repo: string;
	branch?: string;
	headSha?: string;
	pollCount?: number;
	note?: string;
	runs: JobActionsRun[];
	/** Bounded failure-log tails, included only in inspections, not job list snapshots. */
	failedLogs?: JobActionsFailedLog[];
	truncated?: boolean;
}
