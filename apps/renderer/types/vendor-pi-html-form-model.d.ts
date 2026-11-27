// Type stub for the vendored html-form parser package. The renderer only
// consumes spans through it; the bundle resolves the real parser through the
// vite alias, and CI typechecks without the vendored package being installed.

import type { FormSpan } from "@omp-studio/studio-protocol";

export declare function spansText(spans: readonly FormSpan[]): string;
