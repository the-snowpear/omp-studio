import type { AgentSession } from "../../session/agent-session";

export interface CompactionSubmissionPort {
	wait(): Promise<void>;
	pending(): boolean;
}

/** The native yield boundary shared by the terminal and Studio's typed maintenance queue. */
export async function waitForCompactionYield(
	session: AgentSession,
	isCurrent: () => boolean,
	submissions?: CompactionSubmissionPort,
): Promise<boolean> {
	while (isCurrent()) {
		await session.waitForIdle();
		await submissions?.wait();
		await session.waitForAdmittedSubmissions();
		if (session.isSessionTransitioning) await session.waitForSessionTransition();
		if (session.hasPendingAsyncWork()) await session.settleAsyncWork();
		if (!isCurrent()) return false;
		if (
			!session.isStreaming &&
			!session.isRetrying &&
			!session.isSessionTransitioning &&
			!session.agent.isPaused &&
			!session.hasAdmittedSubmission &&
			!session.hasPendingAsyncWork() &&
			session.queuedMessageCount === 0 &&
			!submissions?.pending()
		)
			return true;
		await Bun.sleep(10);
	}
	return false;
}
