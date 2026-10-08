import { zipSync } from "fflate";
import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  LoadingManager,
  Loader,
  Texture,
  type Object3D,
  type Material,
} from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { USDLoader } from "three/addons/loaders/USDLoader.js";
import { imageMeta } from "image-meta";
import {
  checkTextGraphic,
  normalizeGraphicPath,
  openGraphicBundle,
} from "./graphic-bundle";
import type {
  GraphicBundle,
  GraphicMaterial,
  GraphicMesh,
  GraphicResult,
} from "./graphic-types";

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}
function validateGltfBundle(bundle: GraphicBundle): void {
  let source: string;
  if (bundle.format === "glb") {
    const bytes = bundle.bytes;
    if (bytes.byteLength < 20) throw new Error("Invalid GLB header");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint32(12, true);
    if (
      view.getUint32(0, true) !== 0x46546c67 ||
      view.getUint32(4, true) !== 2 ||
      view.getUint32(8, true) !== bytes.byteLength ||
      view.getUint32(16, true) !== 0x4e4f534a ||
      length > 8 * 1024 * 1024 ||
      length + 20 > bytes.byteLength
    )
      throw new Error("Invalid or oversized GLB JSON chunk");
    source = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(20, 20 + length),
    );
  } else
    source = new TextDecoder("utf-8", { fatal: true }).decode(bundle.bytes);
  checkTextGraphic(source, 8 * 1024 * 1024);
  const data = JSON.parse(source) as {
    buffers?: { byteLength?: number }[];
    bufferViews?: { byteLength?: number }[];
    accessors?: { count?: number; sparse?: { count?: number } }[];
    images?: unknown[];
  };
  const bounded = (value: unknown, max: number) =>
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= max;
  if (
    (data.buffers ?? []).some(
      (b) => !bounded(b.byteLength, 32 * 1024 * 1024),
    ) ||
    (data.buffers ?? []).reduce((sum, b) => sum + (b.byteLength ?? 0), 0) >
      32 * 1024 * 1024 ||
    (data.bufferViews ?? []).some(
      (b) => !bounded(b.byteLength, 32 * 1024 * 1024),
    ) ||
    (data.accessors ?? []).some(
      (a) =>
        !bounded(a.count, 1_000_000) ||
        (a.sparse && !bounded(a.sparse.count, 1_000_000)),
    ) ||
    (data.images?.length ?? 0) > 32
  )
    throw new Error("glTF exceeds its geometry or texture budget");
}
function usdaPackage(bundle: GraphicBundle): ArrayBuffer {
  const ordered: Record<string, Uint8Array> = { [bundle.name]: bundle.bytes, ...bundle.resources };
  const layers = new Map<string, string[]>();
  for (const [name, bytes] of Object.entries(ordered)) {
    if (!name.toLowerCase().endsWith(".usda")) continue;
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    checkTextGraphic(source, 8 * 1024 * 1024);
    const directory = name.includes("/") ? name.slice(0, name.lastIndexOf("/") + 1) : "";
    const links: string[] = [];
    for (const match of source.matchAll(/@([^@\r\n]+)@/g)) {
      const target = normalizeGraphicPath(directory + match[1]!);
      if (!ordered[target]) throw new Error("Missing USDA resource: " + target + ". Import it together with the root file as a ZIP.");
      if (target.endsWith(".usda")) links.push(target);
      else if (!/\.(?:png|jpe?g|webp)$/i.test(target)) throw new Error("Unsupported USDA associated resource: " + target);
    }
    layers.set(name, links);
  }
  const visit = (name: string, active: Set<string>): void => {
    if (active.has(name) || active.size >= 16) throw new Error("USDA references are cyclic or exceed 16 layers");
    const next = new Set(active); next.add(name);
    for (const target of layers.get(name) ?? []) visit(target, next);
  };
  visit(bundle.name, new Set());
  return arrayBuffer(zipSync(ordered, { level: 0 }));
}

export async function parseGraphic(
  name: string,
  input: ArrayBuffer,
): Promise<GraphicResult> {
  const bundle = openGraphicBundle(name, input);
  const text = () =>
    new TextDecoder("utf-8", { fatal: true }).decode(bundle.bytes);
  if (
    ["svg", "mermaid", "mmd", "chart", "wrl", "x3dv"].includes(bundle.format)
  ) {
    const source = text();
    if (["wrl", "x3dv"].includes(bundle.format)) {
      checkTextGraphic(source, 256000);
      if (/\b(?:Script|EXTERNPROTO|PROTO)\s*(?:\{|\[|[A-Za-z_])/u.test(source))
        throw new Error("Scene scripts and external prototypes are disabled");
    } else if (source.length > 800000)
      throw new Error("Graphic source exceeds the 800 kB display limit");
    return { kind: "document", bundle };
  }
  const originalCreateURL = URL.createObjectURL;
  const manager = new LoadingManager();
  const urls = new Map<string, string>();
  const created = new Set<string>();
  const bitmaps = new Set<ImageBitmap>();
  const warnings: string[] = [];
  const pending: Promise<unknown>[] = [];
  URL.createObjectURL = (blob: Blob) => {
    const url = originalCreateURL.call(URL, blob);
    created.add(url);
    return url;
  };
  const directory = bundle.name.includes("/")
    ? bundle.name.slice(0, bundle.name.lastIndexOf("/") + 1)
    : "";
  const resource = (url: string): Uint8Array => {
    if (url.startsWith("data:")) {
      const match =
        /^data:(?:application\/(?:octet-stream|gltf-buffer)|image\/(?:png|jpeg|webp));base64,([a-z0-9+/=]+)$/iu.exec(
          url,
        );
      if (!match || match[1]!.length > 8 * 1024 * 1024)
        throw new Error("Embedded resource is unsupported or too large");
      return Uint8Array.from(atob(match[1]!), (c) => c.charCodeAt(0));
    }
    const key = normalizeGraphicPath(url.replace(/^graphic:\/\//u, ""));
    const data =
      bundle.resources[key] ??
      bundle.resources[normalizeGraphicPath(directory + url)];
    if (!data)
      throw new Error(
        "Missing associated resource: " +
          key +
          ". Import the graphic and its resources together as a ZIP.",
      );
    return data;
  };
  manager.setURLModifier((url) => {
    if (created.has(url)) return url;
    const data = resource(url);
    let result = urls.get(url);
    if (!result) {
      result = URL.createObjectURL(new Blob([arrayBuffer(data)]));
      urls.set(url, result);
      created.add(result);
    }
    return result;
  });
  const decode = async (url: string): Promise<ImageBitmap> => {
    const data = created.has(url)
      ? new Uint8Array(await (await fetch(url)).arrayBuffer())
      : resource(url);
    if (data.byteLength > 8 * 1024 * 1024)
      throw new Error("Texture exceeds 8 MiB");
    const meta = imageMeta(data);
    if (
      meta.width * meta.height > 4_000_000 ||
      meta.width > 4096 ||
      meta.height > 4096
    )
      throw new Error("Texture exceeds 4 million pixels");
    const scale = Math.min(1, 1024 / Math.max(meta.width, meta.height));
    const bitmap = await createImageBitmap(new Blob([arrayBuffer(data)]), {
      resizeWidth: Math.max(1, Math.round(meta.width * scale)),
      resizeHeight: Math.max(1, Math.round(meta.height * scale)),
    });
    if (bitmaps.size >= 32) {
      bitmap.close();
      throw new Error("Texture count exceeds 32");
    }
    bitmaps.add(bitmap);
    return bitmap;
  };
  class BundleTextureLoader extends Loader<Texture<ImageBitmap>> {
    override load(
      url: string,
      onLoad?: (texture: Texture<ImageBitmap>) => void,
      _onProgress?: (event: ProgressEvent) => void,
      onError?: (error: unknown) => void,
    ): Texture<ImageBitmap> {
      const texture = new Texture<ImageBitmap>();
      const task = decode(url).then((bitmap) => {
        texture.image = bitmap;
        texture.needsUpdate = true;
        onLoad?.(texture);
      });
      pending.push(task);
      void task.catch((error) => onError?.(error));
      return texture;
    }
  }
  const textureLoader = new BundleTextureLoader(manager);
  manager.addHandler(/.*/, textureLoader);
  // USDComposer uses the browser Image interface. In this worker it resolves only the bounded bundle.
  const oldImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
  class BundleImage {
    bitmap?: ImageBitmap;
    onload?: () => void;
    onerror?: () => void;
    set src(url: string) {
      const task = decode(url).then((bitmap) => {
        this.bitmap = bitmap;
        this.onload?.();
      });
      pending.push(task);
      void task.catch(() => this.onerror?.());
    }
  }
  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    value: BundleImage,
  });
  try {
    let object: Object3D;
    if (bundle.format === "obj") {
      const source = text();
      checkTextGraphic(source, 8 * 1024 * 1024);
      const loader = new OBJLoader(manager);
      const libraries = [...source.matchAll(/^mtllib\s+(.+)$/gmu)].map(
        (match) => match[1]!.trim(),
      );
      if (libraries.length > 1)
        throw new Error(
          "This preview supports one OBJ material library per file",
        );
      if (libraries[0]) {
        const key = normalizeGraphicPath(directory + libraries[0]);
        const materialSource = resource(key);
        const materials = new MTLLoader(manager).parse(
          new TextDecoder().decode(materialSource),
          key.includes("/") ? key.slice(0, key.lastIndexOf("/") + 1) : "",
        );
        loader.setMaterials(materials);
      }
      object = loader.parse(source);
    } else if (bundle.format === "ply") {
      const geometry = new PLYLoader(manager).parse(arrayBuffer(bundle.bytes));
      object = geometry.index
        ? new Mesh(
            geometry,
            new MeshStandardMaterial({
              vertexColors: geometry.hasAttribute("color"),
            }),
          )
        : new Points(
            geometry,
            new PointsMaterial({
              size: 0.012,
              vertexColors: geometry.hasAttribute("color"),
            }),
          );
    } else if (bundle.format === "stl")
      object = new Mesh(
        new STLLoader(manager).parse(arrayBuffer(bundle.bytes)),
        new MeshStandardMaterial(),
      );
    else if (bundle.format === "usda") {
      const source = text();
      checkTextGraphic(source, 8 * 1024 * 1024);
      object = new USDLoader(manager).parse(usdaPackage(bundle), "");
    } else {
      validateGltfBundle(bundle);
      const gltf = await new GLTFLoader(manager)
        .register((parser) => {
          (
            parser as unknown as { textureLoader: Loader<Texture<ImageBitmap>> }
          ).textureLoader = textureLoader;
          return { name: "studio-bounded-textures" };
        })
        .parseAsync(
          bundle.format === "gltf" ? text() : arrayBuffer(bundle.bytes),
          "",
        );
      object = gltf.scene;
    }
    await Promise.all(pending);
    object.updateMatrixWorld(true);
    const meshes: GraphicMesh[] = [];
    const images: ImageBitmap[] = [];
    let vertices = 0,
      bytes = 0;
    const attribute = (
      geometry: BufferGeometry,
      key: string,
      size: number,
    ): Float32Array | undefined => {
      const attribute = geometry.getAttribute(key);
      if (!attribute) return undefined;
      const result = new Float32Array(attribute.count * size);
      for (let i = 0; i < attribute.count; i++) {
        result[i * size] = attribute.getX(i);
        if (size > 1) result[i * size + 1] = attribute.getY(i);
        if (size > 2) result[i * size + 2] = attribute.getZ(i);
      }
      if (
        result.some(
          (value) => !Number.isFinite(value) || Math.abs(value) > 1e12,
        )
      )
        throw new Error("Geometry contains invalid coordinates");
      bytes += result.byteLength;
      if (bytes > 64 * 1024 * 1024)
        throw new Error("Decoded geometry exceeds 64 MiB");
      return result;
    };
    const projectMaterial = (material: Material): GraphicMaterial => {
      const value = material as MeshStandardMaterial;
      const image: unknown = value.map?.image;
      const bitmap =
        image instanceof BundleImage
          ? image.bitmap
          : typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap
            ? image
            : undefined;
      let map: number | undefined;
      if (bitmap) {
        map = images.indexOf(bitmap);
        if (map < 0) {
          map = images.length;
          images.push(bitmap);
        }
      }
      if (value.map?.matrixAutoUpdate) value.map.updateMatrix();
      if (
        value.normalMap ||
        value.roughnessMap ||
        value.metalnessMap ||
        value.emissiveMap ||
        value.aoMap
      ) {
        const warning =
          "Preview includes geometry and base color; advanced material maps are not rendered.";
        if (!warnings.includes(warning)) warnings.push(warning);
      }
      return {
        color: value.color?.getHex() ?? 0xb7a9ef,
        opacity: material.opacity,
        metalness: value.metalness ?? 0,
        roughness: value.roughness ?? 0.7,
        ...(map === undefined
          ? {}
          : {
              map,
              mapTransform: value.map!.matrix.toArray(),
              mapFlipY: value.map!.flipY,
              mapWrapS: value.map!.wrapS,
              mapWrapT: value.map!.wrapT,
            }),
      };
    };
    object.traverse((node) => {
      const mesh = node as Mesh;
      const geometry = mesh.geometry;
      if (!geometry) return;
      const count = geometry.getAttribute("position")?.count ?? 0;
      if (!count) return;
      vertices += count;
      if (vertices > 1_000_000 || meshes.length >= 512)
        throw new Error("Scene exceeds 1 million vertices or 512 objects");
      const position = attribute(geometry, "position", 3)!;
      const normal = attribute(geometry, "normal", 3),
        uv = attribute(geometry, "uv", 2),
        color = attribute(geometry, "color", 3);
      if ((geometry.index?.count ?? 0) > 3_000_000)
        throw new Error("Geometry exceeds 3 million indices");
      const index = geometry.index
        ? Uint32Array.from(geometry.index.array)
        : undefined;
      if (index?.some((i) => i >= count))
        throw new Error("Geometry has an invalid vertex index");
      bytes += index?.byteLength ?? 0;
      if (bytes > 64 * 1024 * 1024)
        throw new Error("Decoded geometry exceeds 64 MiB");
      if (!node.matrixWorld.elements.every(Number.isFinite))
        throw new Error("Invalid scene transform");
      const materials = (
        Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      ).map(projectMaterial);
      if (
        geometry.groups.some(
          (group) => (group.materialIndex ?? 0) >= materials.length,
        )
      )
        throw new Error("Geometry references a missing material");
      if (materials.length > 128) throw new Error("Too many materials");
      meshes.push({
        kind:
          node.type === "Points"
            ? "points"
            : node.type.includes("Line")
              ? "lines"
              : "mesh",
        position,
        ...(normal ? { normal } : {}),
        ...(uv ? { uv } : {}),
        ...(color ? { color } : {}),
        ...(index ? { index } : {}),
        matrix: node.matrixWorld.toArray(),
        groups: geometry.groups.map((group) => ({
          start: group.start,
          count: group.count,
          materialIndex: group.materialIndex ?? 0,
        })),
        materials,
      });
    });
    if (!meshes.length)
      throw new Error("No supported geometry was found in this file");
    for (const bitmap of bitmaps) if (!images.includes(bitmap)) bitmap.close();
    return { kind: "scene", meshes, images, warnings };
  } catch (error) {
    await Promise.allSettled(pending);
    for (const bitmap of bitmaps) bitmap.close();
    throw error;
  } finally {
    if (oldImage) Object.defineProperty(globalThis, "Image", oldImage);
    else Reflect.deleteProperty(globalThis, "Image");
    URL.createObjectURL = originalCreateURL;
    for (const url of created) URL.revokeObjectURL(url);
  }
}
