import type { BrowserObservationEvent, BrowserObservationInput } from "@omp-studio/studio-protocol";
export const BROWSER_OBSERVATION_CHANNELS = { attach: "omp-studio:desktop:browser-attach", input: "omp-studio:desktop:browser-input", detach: "omp-studio:desktop:browser-detach", event: "omp-studio:desktop:browser-event" } as const;
export interface BrowserObservationAttach { observationId: string; sessionId: string; tabId: string }
export interface BrowserObservationResult { ok: boolean; message?: string }
export interface BrowserObservationControl { observationId: string; input: BrowserObservationInput }
export type { BrowserObservationEvent };
