export function artifactUrl(artifactId: string): string {
  return `omp-artifact://library/${encodeURIComponent(artifactId)}`;
}
