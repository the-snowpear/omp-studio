import { PLATFORM } from "../platform";

/** Demo project folders in the local platform's spelling; preview data only, never Host truth. */
export const DEMO_TOOLS = PLATFORM === "darwin" ? "/Users/demo/Tools" : "C:\\Aspace\\Tools";

export const demoPath = (...segments: string[]): string => [DEMO_TOOLS, ...segments].join(PLATFORM === "darwin" ? "/" : "\\");
