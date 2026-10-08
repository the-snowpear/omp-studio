export const PREVIEW_GRAPHICS: Record<string,string> = { "scene.obj": "v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 3 2\nf 1 2 4\nf 2 3 4\nf 3 1 4\n", "scene.x3dv": "#X3D V3.3 utf8\nPROFILE Interchange\nShape { appearance Appearance { material Material { diffuseColor 0.55 0.4 0.85 } } geometry Box { size 2 2 2 } }" };
import type { ArtifactRecord } from "@omp-studio/client-contract";
import { PREVIEW_ANNOTATION_BUNDLE } from "./annotationsPreview";

/** Display-only continuation of the existing workspace fixture. */
export const PREVIEW_ARTIFACTS: readonly ArtifactRecord[] = [
  ...Object.keys(PREVIEW_GRAPHICS).map((name,index)=>({artifactId:"demo-graphic-"+index,kind:"graphic" as const,name,mimeType:"model/obj",bytes:new TextEncoder().encode(PREVIEW_GRAPHICS[name]).byteLength,createdAt:"2026-10-07T10:00:00Z",sha256:"0".repeat(64)})),
  { artifactId: "demo-recording", kind: "recording", name: "shell-build.studiocast", mimeType: "application/x-studio-terminalcast", bytes: 460, createdAt: "2026-09-24T09:15:00Z", sha256: "0".repeat(64) },
  { artifactId: "demo-annotation", kind: "annotation", name: "annotations-v2.json", mimeType: "application/json", bytes: new TextEncoder().encode(JSON.stringify(PREVIEW_ANNOTATION_BUNDLE)).byteLength, createdAt: "2026-09-24T09:10:00Z", sha256: "0".repeat(64) },
  { artifactId: "demo-image", kind: "image", name: "workspace-preview.png", mimeType: "image/png", bytes: 184320, createdAt: "2026-09-24T09:00:00Z", sha256: "0".repeat(64) },
  { artifactId: "demo-audio", kind: "audio", name: "review-notes.wav", mimeType: "audio/wav", bytes: 983040, createdAt: "2026-09-24T08:50:00Z", sha256: "0".repeat(64) },
  { artifactId: "demo-judgment", kind: "judgment", name: "review-results.json", mimeType: "application/json", bytes: 2400, createdAt: "2026-09-24T08:40:00Z", sha256: "0".repeat(64) },
];
