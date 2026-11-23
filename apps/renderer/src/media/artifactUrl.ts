export function artifactUrl(artifactId: string): string {
  if (globalThis.OMP_STUDIO_WEB_ENTRY) return `/api/artifacts/${encodeURIComponent(artifactId)}`;
  return `omp-artifact://library/${encodeURIComponent(artifactId)}`;
}
