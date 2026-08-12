/// <reference types="vite/client" />

import type { StudioClient } from "@omp-studio/client-contract";

declare global {
  /**
   * Semantic client injected by the hosting shell (desktop preload or the
   * local WebUI bridge) before the renderer bundle runs. Optional at
   * runtime: when absent, the Vite entry renders an explicit unavailable
   * state instead of crashing. The renderer never imports a transport.
   */
  var OMP_STUDIO_CLIENT: StudioClient | undefined;
}

export {};
