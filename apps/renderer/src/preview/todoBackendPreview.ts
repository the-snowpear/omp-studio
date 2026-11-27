import type { TodoBackendState } from "@omp-studio/studio-protocol";
export function getPreviewTodoBackends(zh: boolean): TodoBackendState {
  return { selected: "native", source: "default", sync: { state: "native" }, backends: [
    { id: "native", label: zh ? "原生会话列表" : "Native session list" },
    { id: "project-tracker", label: zh ? "项目任务同步" : "Project task tracker", description: zh ? "由项目扩展注册，将本会话的 Todo 列表同步到任务跟踪器。" : "Registered by the project extension to mirror this session’s Todo list to its task tracker.", extensionPath: ".omp/extensions/project-tracker.ts" },
  ] };
}

/** Static source for the local preview inspector; it is never executed or saved. */
export const PREVIEW_TODO_BACKEND_SOURCE = `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTodoBackend({
    id: "project-tracker",
    label: "Project task tracker",
    async replace(phases) {
      await Bun.write(
        "project-todos.json",
        JSON.stringify(phases, null, 2),
      );
    },
  });
}
`;
