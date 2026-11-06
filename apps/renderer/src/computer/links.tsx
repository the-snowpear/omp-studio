import { createContext, useContext, type ReactNode } from "react";
import type { ComputerFrameIntent } from "./types";

/** Context follows React portals into native surfaces; it never searches the global document. */
const ComputerLinkContext = createContext<((intent: Omit<ComputerFrameIntent, "id">) => void) | undefined>(undefined);
export function ComputerLinkProvider({ onOpen, children }: { onOpen: (intent: Omit<ComputerFrameIntent, "id">) => void; children: ReactNode }) {
  return <ComputerLinkContext.Provider value={onOpen}>{children}</ComputerLinkContext.Provider>;
}
export const useComputerLink = () => useContext(ComputerLinkContext);
