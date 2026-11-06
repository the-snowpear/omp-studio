import { createContext, useContext, type ReactNode } from "react";

const SurfaceContext = createContext<Document | null>(null);
export function SurfaceProvider({ document, children }: { document: Document; children: ReactNode }) {
  return <SurfaceContext.Provider value={document}>{children}</SurfaceContext.Provider>;
}
export const useSurfaceDocument = () => useContext(SurfaceContext) ?? document;
export function surfaceWindow(doc: Document): Window & typeof globalThis {
  return (doc.defaultView ?? window) as Window & typeof globalThis;
}
export function useSurfaceChrome() {
  return surfaceWindow(useSurfaceDocument()).ompStudioChrome;
}
export function revealMainWindow(workbench = false): boolean {
  void globalThis.ompStudioChrome?.controlFloatWindow?.({ key: "", action: "showMain" });
  const request = { accepted: true };
  if (workbench) window.dispatchEvent(new CustomEvent("omp:dock-reveal-workbench", { detail: request }));
  return request.accepted;
}
