import imageUrl from "./assets/landscape.png?url";
import audioUrl from "./assets/preview-tone.wav?url";
export function previewMediaUrl(kind: string): string | undefined {
  return kind === "image" ? imageUrl : kind === "audio" ? audioUrl : undefined;
}
