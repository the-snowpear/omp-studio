import { Children, createContext, useContext, type ReactNode } from "react";

export const SpillViewer = createContext<((uri: string) => void) | undefined>(undefined);
const spillPattern = /^(?:local:\/\/\d+\.log|artifact:\/\/\d+)$/i;
export const isSpillUri = (uri: string) => spillPattern.test(uri);

export function SpillLink({ uri, children }: { uri: string; children: ReactNode }) {
  const open = useContext(SpillViewer);
  return open ? <button type="button" className="md-spill-link" onClick={() => open(uri)}>{children}</button> : <>{children}</>;
}

export function linkSpillText(children: ReactNode): ReactNode {
  return Children.map(children, child => typeof child !== "string" || !/(?:local|artifact):\/\//i.test(child) ? child
    : child.split(/(local:\/\/\d+\.log\b|artifact:\/\/\d+\b)/gi).map((part, index) => isSpillUri(part)
      ? <SpillLink uri={part} key={index}>{part}</SpillLink> : part));
}
