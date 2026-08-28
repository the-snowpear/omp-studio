import type { TurnFileChange } from "./toolMeta";

// TODO: TaskProgressDock gutted — todo state machine removed from toolMeta.ts
export function TaskProgressDock(_props: {
  todos: readonly unknown[];
  files: readonly TurnFileChange[];
  demo?: boolean;
  onReview?: () => void;
  onOpen?: (path: string) => void;
}) {
  return null;
}

