/** Self-contained sources for the graphic formats accepted in conversation Markdown. */
const positions = new Float32Array([-1, -0.7, 0, 1, -0.7, 0, 0, 1, 0]);
const positionBytes = new Uint8Array(positions.buffer);
const gltf = (uri?: string) => ({
  asset: { version: "2.0" },
  buffers: [{ byteLength: positions.byteLength, ...(uri ? { uri } : {}) }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-1, -0.7, 0], max: [1, 1, 0] }],
  materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.25, 0.65, 0.55, 1], metallicFactor: 0 } }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
  nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
});

export const CONTENT_GALLERY_GRAPHICS = [
  { language: "svg", source: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240" viewBox="0 0 640 240"><rect width="640" height="240" rx="24" fill="#172c43"/><circle cx="120" cy="120" r="64" fill="#72cbb4"/><path d="M220 120H360" stroke="#72cbb4" stroke-width="6"/><rect x="390" y="64" width="180" height="112" rx="16" fill="#72cbb4"/><text x="480" y="126" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#172c43">OMP Studio</text></svg>' },
  { language: "mermaid", source: "flowchart LR\n  A[用户消息] --> B[工具链]\n  B --> C[结构化结果]\n  C --> D[最终回复]" },
  { language: "mmd", source: "sequenceDiagram\n  participant UI\n  participant Host\n  UI->>Host: conversation.open\n  Host-->>UI: transcript + live events" },
  { language: "chart", source: JSON.stringify({ columns: ["轮次", "输入", "输出"], rows: [[1, 24, 12], [2, 38, 18], [3, 29, 25], [4, 45, 31]] }, null, 2) },
  { language: "obj", source: "v -1 -0.7 0\nv 1 -0.7 0\nv 0 1 0\nf 1 2 3" },
  { language: "ply", source: "ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n-1 -0.7 0\n1 -0.7 0\n0 1 0\n3 0 1 2" },
  { language: "stl", source: "solid triangle\nfacet normal 0 0 1\nouter loop\nvertex -1 -0.7 0\nvertex 1 -0.7 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid triangle" },
  { language: "gltf", source: JSON.stringify(gltf("data:application/octet-stream;base64," + btoa(String.fromCharCode(...positionBytes))), null, 2) },
  { language: "usda", source: '#usda 1.0\ndef Mesh "Triangle"\n{\n int[] faceVertexCounts = [3]\n int[] faceVertexIndices = [0, 1, 2]\n point3f[] points = [(-1,-0.7,0), (1,-0.7,0), (0,1,0)]\n}' },
  { language: "wrl", source: "#VRML V2.0 utf8\nShape {\n appearance Appearance { material Material { diffuseColor 0.25 0.65 0.55 } }\n geometry Box { size 2 1.2 1 }\n}" },
  { language: "x3dv", source: "#X3D V3.3 utf8\nPROFILE Interchange\nShape {\n appearance Appearance { material Material { diffuseColor 0.25 0.65 0.55 } }\n geometry Sphere { radius 1 }\n}" },
] as const;

/** GLB carries binary chunks, so its conversation example is a file reference. */
export function contentGalleryGlb(): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(gltf()));
  const padded = (json.length + 3) & ~3;
  const bytes = new ArrayBuffer(12 + 8 + padded + 8 + positions.byteLength);
  const header = new DataView(bytes);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, bytes.byteLength, true);
  header.setUint32(12, padded, true);
  header.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(bytes, 20, padded).fill(32);
  new Uint8Array(bytes, 20, json.length).set(json);
  header.setUint32(20 + padded, positions.byteLength, true);
  header.setUint32(24 + padded, 0x004e4942, true);
  new Uint8Array(bytes, 28 + padded).set(positionBytes);
  return bytes;
}
