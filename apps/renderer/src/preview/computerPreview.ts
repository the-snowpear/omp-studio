import type { StudioComputerStatus } from "@omp-studio/studio-protocol";
import { PREVIEW_BROWSER_IMAGE } from "./browserPreview";
export const PREVIEW_COMPUTER: StudioComputerStatus = { enabled: true, available: true, backend: "demo", capturePermission: "granted", inputPermission: "granted", axPermission: "granted", running: 1, targets: [
  { id: "demo-display", kind: "display", name: "Display 1", width: 1920, height: 1080 },
  { id: "demo-window", kind: "window", name: "Studio component preview", width: 960, height: 600 },
] };
export const PREVIEW_COMPUTER_IMAGE = PREVIEW_BROWSER_IMAGE;
