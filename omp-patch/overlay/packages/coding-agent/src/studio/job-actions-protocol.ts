/** Wire mirror of the root job-actions contract; native controllers remain the owner. */
export interface JobActionsStep {
	number: number;
	name: string;
	status?: string;
	conclusion?: string;
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
	failedLogs?: JobActionsFailedLog[];
	truncated?: boolean;
}
