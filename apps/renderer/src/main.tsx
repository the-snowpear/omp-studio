/**
 * OMP Studio renderer entry.
 *
 * `mountRenderer` is the public mounting API: it takes a semantic
 * `StudioClient` supplied by the caller (desktop shell, local WebUI bridge,
 * or a test) and never imports or constructs a transport itself.
 *
 * When this module is loaded directly by Vite (the auto-bootstrap entry),
 * the hosting page injects that client on `globalThis.OMP_STUDIO_CLIENT`
 * before the bundle runs. If it is absent we render an explicit unavailable
 * state instead of failing.
 */

import { createRoot } from "react-dom/client";
import type { StudioClient } from "@omp-studio/client-contract";
import { App, Unavailable } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import "./App.css";

/** Mount the renderer into `element` with an injected semantic client. */
export function mountRenderer(element: Element, client: StudioClient): void {
  createRoot(element).render(
    <ErrorBoundary>
      <App client={client} />
    </ErrorBoundary>,
  );
}

const host = document.getElementById("root");
if (host !== null) {
  const injected = globalThis.OMP_STUDIO_CLIENT;
  createRoot(host).render(
    <ErrorBoundary>
      {injected === undefined ? <Unavailable /> : <App client={injected} />}
    </ErrorBoundary>,
  );
}
