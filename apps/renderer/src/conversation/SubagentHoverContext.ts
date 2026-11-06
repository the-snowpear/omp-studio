import { createContext, useContext } from "react";
import type { SubagentHubTarget, SubagentView, saPill } from "./toolMeta";

export type SubagentHoverCard = {
  readonly anchor: HTMLElement;
  readonly id: string;
  readonly agent: SubagentView;
  readonly target?: SubagentHubTarget;
  readonly pill: ReturnType<typeof saPill>;
  readonly inspectable: boolean;
};

export type SubagentHoverControl = {
  open(card: SubagentHoverCard): void;
  update(card: SubagentHoverCard): void;
  close(anchor?: HTMLElement): void;
};

export const SubagentHoverContext = createContext<SubagentHoverControl | null>(null);
export const useSubagentHoverPreview = () => useContext(SubagentHoverContext);
