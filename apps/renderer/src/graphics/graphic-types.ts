export const GRAPHIC_EXTENSIONS = [
  "svg",
  "mermaid",
  "mmd",
  "chart",
  "obj",
  "ply",
  "wrl",
  "x3dv",
  "stl",
  "gltf",
  "glb",
  "usda",
] as const;
export type GraphicFormat = (typeof GRAPHIC_EXTENSIONS)[number];
export const GRAPHIC_MAX_BYTES = 32 * 1024 * 1024;
export function graphicFormat(name: string): GraphicFormat | undefined {
  const extension = name.split(".").at(-1)?.toLowerCase();
  return GRAPHIC_EXTENSIONS.find((value) => value === extension);
}
export interface GraphicBundle {
  name: string;
  format: GraphicFormat;
  bytes: Uint8Array;
  resources: Record<string, Uint8Array>;
}
export interface GraphicMaterial {
  color: number;
  opacity: number;
  metalness: number;
  roughness: number;
  map?: number;
  mapTransform?: number[];
  mapFlipY?: boolean;
  mapWrapS?: number;
  mapWrapT?: number;
}
export interface GraphicMesh {
  kind: "mesh" | "points" | "lines";
  position: Float32Array;
  normal?: Float32Array;
  uv?: Float32Array;
  color?: Float32Array;
  index?: Uint32Array;
  matrix: number[];
  groups: Array<{ start: number; count: number; materialIndex: number }>;
  materials: GraphicMaterial[];
}
export type GraphicResult =
  | {
      kind: "scene";
      meshes: GraphicMesh[];
      images: ImageBitmap[];
      warnings: string[];
    }
  | { kind: "document"; bundle: GraphicBundle };
