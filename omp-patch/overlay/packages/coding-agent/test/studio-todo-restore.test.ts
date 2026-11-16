import { expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import type { SessionEntry } from "../src/session/session-entries";
import { TodoTracker, type TodoTrackerHost } from "../src/session/todo-tracker";
import type { ToolSession } from "../src/tools";
import { nextActionableTask, TodoTool, USER_TODO_EDIT_CUSTOM_TYPE } from "../src/tools/todo";

test.each(["toolResult", "userEdit"] as const)(
	"native restore makes legacy blocked tasks actionable without rewriting %s entries",
	async source => {
		const phases = [
			{
				name: "Verification",
				tasks: [
					{ content: "Finished check", status: "completed" },
					{ content: "Resume the old check", status: "blocked" },
				],
			},
		];
		const raw =
			source === "toolResult"
				? {
						type: "message",
						id: "old-todo",
						parentId: null,
						timestamp: "2026-11-11T12:00:00.000Z",
						message: {
							role: "toolResult",
							toolName: "todo",
							toolCallId: "old-call",
							content: [],
							isError: false,
							details: { op: "init", phases },
						},
					}
				: {
						type: "custom",
						id: "old-todo",
						parentId: null,
						timestamp: "2026-11-11T12:00:00.000Z",
						customType: USER_TODO_EDIT_CUSTOM_TYPE,
						data: { phases },
					};
		const entries = [raw] as unknown as SessionEntry[];
		const before = JSON.stringify(entries);
		const tracker = new TodoTracker({ sessionManager: { getBranch: () => entries } } as unknown as TodoTrackerHost);
		tracker.syncFromBranch();
		expect(tracker.phases[0]?.tasks.map(task => task.status)).toEqual(["completed", "pending"]);
		expect(nextActionableTask(tracker.phases)?.content).toBe("Resume the old check");
		let writes = 0;
		const session: ToolSession = {
			cwd: "/isolated",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated(),
			getTodoPhases: () => tracker.phases,
			setTodoPhases: () => {
				writes++;
			},
		};
		const result = await new TodoTool(session).execute("view-restored", { op: "view" });
		expect(result.details?.phases[0]?.tasks[1]?.status).toBe("pending");
		expect(writes).toBe(0);
		expect(JSON.stringify(entries)).toBe(before);
	},
);
