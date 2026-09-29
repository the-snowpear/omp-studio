/**
 * Microphone permission channels, shared by Main and the sandboxed preload.
 * macOS gates the microphone per app (TCC); Windows leaves it to Chromium.
 */
export const CHROME_MEDIA_ACCESS_CHANNELS = Object.freeze({
  microphone: "omp-studio:desktop:media-access",
  openMicrophoneSettings: "omp-studio:desktop:media-access-settings",
} as const);

/** `denied` covers `restricted` (parental controls / MDM): the user cannot grant it here either. */
export type MicrophoneAccess = "granted" | "denied";
