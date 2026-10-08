// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { parseGraphic } from "./graphic-parser";
import { normalizeGraphicPath, openGraphicBundle } from "./graphic-bundle";
const encode = (text: string) => new TextEncoder().encode(text);
const buffer = (text: string) => encode(text).buffer;
const vertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const gltf = (uri?: string) => ({
  asset: { version: "2.0" },
  buffers: [{ byteLength: vertices.byteLength, ...(uri ? { uri } : {}) }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: vertices.byteLength }],
  accessors: [
    {
      bufferView: 0,
      componentType: 5126,
      count: 3,
      type: "VEC3",
      min: [0, 0, 0],
      max: [1, 1, 0],
    },
  ],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  nodes: [{ mesh: 0 }],
  scenes: [{ nodes: [0] }],
  scene: 0,
});
const fixtures: Record<string, string> = {
  "triangle.obj": "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n",
  "triangle.ply":
    "ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n",
  "triangle.stl":
    "solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid triangle",
  "triangle.usda":
    '#usda 1.0\ndef Mesh "Triangle"\n{\n int[] faceVertexCounts = [3]\n int[] faceVertexIndices = [0, 1, 2]\n point3f[] points = [(0,0,0), (1,0,0), (0,1,0)]\n}\n',
  "triangle.gltf": JSON.stringify(
    gltf(
      "data:application/octet-stream;base64," +
        Buffer.from(vertices.buffer).toString("base64"),
    ),
  ),
};
afterEach(() => vi.unstubAllGlobals());
describe("bounded graphic parsers", () => {
  it.each(Object.entries(fixtures))(
    "parses %s into drawable finite geometry",
    async (name, source) => {
      vi.stubGlobal("self", globalThis);
      vi.stubGlobal("ProgressEvent", class extends Event {});
      const result = await parseGraphic(name, buffer(source));
      expect(result.kind).toBe("scene");
      if (result.kind !== "scene") return;
      expect(result.meshes[0]?.position.length).toBeGreaterThanOrEqual(9);
      expect(
        result.meshes.every((mesh) => mesh.position.every(Number.isFinite)),
      ).toBe(true);
    },
  );
  it("reads GLB and ZIP sidecars without an external fetch", async () => {
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("ProgressEvent", class extends Event {});
    const json = encode(JSON.stringify(gltf()));
    const padded = (json.length + 3) & ~3;
    const glb = new ArrayBuffer(12 + 8 + padded + 8 + vertices.byteLength);
    const view = new DataView(glb);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, glb.byteLength, true);
    view.setUint32(12, padded, true);
    view.setUint32(16, 0x4e4f534a, true);
    new Uint8Array(glb, 20, padded).fill(32);
    new Uint8Array(glb, 20, json.length).set(json);
    view.setUint32(20 + padded, vertices.byteLength, true);
    view.setUint32(24 + padded, 0x004e4942, true);
    new Uint8Array(glb, 28 + padded).set(new Uint8Array(vertices.buffer));
    expect((await parseGraphic("triangle.glb", glb)).kind).toBe("scene");
    const zip = zipSync({
      "scene.gltf": encode(JSON.stringify(gltf("positions.bin"))),
      "positions.bin": new Uint8Array(vertices.buffer),
    });
    expect(
      (await parseGraphic("triangle.zip", Uint8Array.from(zip).buffer)).kind,
    ).toBe("scene");
    await expect(
      parseGraphic(
        "triangle.gltf",
        buffer(JSON.stringify(gltf("https://example.invalid/positions.bin"))),
      ),
    ).rejects.toThrow(/Remote/);
    await expect(
      parseGraphic(
        "triangle.gltf",
        buffer(JSON.stringify(gltf("missing.bin"))),
      ),
    ).rejects.toThrow(/Missing/);
  });
  it.each(["obj", "ply", "stl", "gltf", "glb", "usda"])(
    "rejects damaged %s instead of displaying success",
    async (extension) => {
      await expect(
        parseGraphic("bad." + extension, buffer("not a valid model")),
      ).rejects.toThrow();
    },
  );
  it("rejects archive traversal, unbounded geometry and scene scripts", async () => {
    expect(() => normalizeGraphicPath("../../secret")).toThrow();
    const zip = zipSync({ "../scene.obj": encode(fixtures["triangle.obj"]!) });
    expect(() =>
      openGraphicBundle("bad.zip", Uint8Array.from(zip).buffer),
    ).toThrow(/Unsafe|escapes/);
    const oversized = gltf();
    oversized.accessors[0]!.count = 2000000;
    await expect(
      parseGraphic("large.gltf", buffer(JSON.stringify(oversized))),
    ).rejects.toThrow(/budget/);
    await expect(
      parseGraphic(
        "bad.x3dv",
        buffer('#X3D V3.3 utf8\nScript { url "javascript:run()" }'),
      ),
    ).rejects.toThrow(/scripts/);
    await expect(
      parseGraphic("bad.wrl", buffer("#VRML V2.0 utf8\nShape {")),
    ).rejects.toThrow(/incomplete/);
  });
});

it("loads native USDA references from the authorized bundle and rejects missing or cyclic layers",async()=>{
 const layer='#usda 1.0\ndef Xform "Model" (\n prepend references = @layers/triangle.usda@\n)\n{\n}\n';
 const files={"scene.usda":encode(layer),"layers/triangle.usda":encode(fixtures["triangle.usda"]!)};
 const result=await parseGraphic("linked.zip",Uint8Array.from(zipSync(files)).buffer);
 expect(result.kind).toBe("scene");
 if(result.kind==="scene")expect(result.meshes.some(mesh=>mesh.position.length>=9)).toBe(true);
 await expect(parseGraphic("scene.usda",buffer(layer))).rejects.toThrow(/Missing USDA/);
 const cycle={"scene.usda":encode('#usda 1.0\ndef Xform "A" (\n prepend references = @other.usda@\n)\n{}\n'),"other.usda":encode('#usda 1.0\ndef Xform "B" (\n prepend references = @scene.usda@\n)\n{}\n')};
 await expect(parseGraphic("cycle.zip",Uint8Array.from(zipSync(cycle)).buffer)).rejects.toThrow(/cyclic/);
});
