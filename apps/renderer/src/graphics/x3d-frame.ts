import type X3D from "x_ite";
import { imageMeta } from "image-meta";
import { checkTextGraphic, normalizeGraphicPath } from "./graphic-bundle";
let browser: X3D.X3DBrowser | undefined;
let loaded = false;
// The opaque sandbox intentionally has no persistent storage; the viewer receives a per-frame memory store.
const memory: Record<string, string> = Object.create(null);
const storage = {
  getItem: (key: string) => memory[key] ?? null,
  setItem: (key: string, value: string) => {
    memory[key] = String(value);
  },
  removeItem: (key: string) => {
    delete memory[key];
  },
  clear: () => {
    for (const key of Object.keys(memory)) delete memory[key];
  },
  key: (index: number) => Object.keys(memory)[index] ?? null,
  get length() {
    return Object.keys(memory).length;
  },
};
Object.defineProperty(window, "localStorage", {
  value: new Proxy(storage, {
    get: (target, key) =>
      Reflect.has(target, key) ? Reflect.get(target, key) : memory[String(key)],
    set: (_target, key, value) => {
      memory[String(key)] = String(value);
      return true;
    },
    deleteProperty: (_target, key) => {
      delete memory[String(key)];
      return true;
    },
  }),
});
const report = (kind: string, message?: string) =>
  parent.postMessage({ kind, ...(message ? { message } : {}) }, "*");
window.addEventListener("message", (event) => {
  if (event.source !== parent) return;
  if (event.data?.kind === "graphic-fit") {
    browser?.viewAll(undefined, 0);
    return;
  }
  if (event.data?.kind !== "graphic-load" || loaded) return;
  loaded = true;
  void load(event.data).catch((error) =>
    report(
      "graphic-error",
      error instanceof Error ? error.message : String(error),
    ),
  );
});
async function load(input: {
  source: string;
  name: string;
  resources: Record<string, Uint8Array>;
}) {
  if (typeof input.source !== "string" || input.source.length > 256000)
    throw new Error("X3D source exceeds 256 kB");
  const module = (await import(
    /* @vite-ignore */ new URL("graphics-xite/x_ite.min.mjs", document.baseURI)
      .href
  )) as { default: typeof X3D };
  const X = module.default;
  const canvas = X.createBrowser();
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
  document.body.append(canvas);
  browser = canvas.browser;
  if (!browser)
    throw new Error("The X3D rendering context could not be initialized");
  browser.setBrowserOption("LoadUrlObjects", false);
  browser.setBrowserOption("ContextMenu", false);
  browser.setBrowserOption("Dashboard", false);
  browser.setBrowserOption("Mute", true);
  browser.setBrowserOption("XRSessionMode", "NONE");
  browser.setBrowserOption("MaximumFrameRate", 30);
  browser.setBrowserOption("PrimitiveQuality", "LOW");
  let nodes = 0;
  let drawables = 0;
  let totalText = 0;
  let textures = 0;
  const readResource = (name: string, url: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|[/\\])/iu.test(url))
      throw new Error("Use a local resource in the graphic ZIP");
    const directory = name.includes("/")
      ? name.slice(0, name.lastIndexOf("/") + 1)
      : "";
    const key = normalizeGraphicPath(directory + url);
    const bytes = input.resources[key];
    if (!(bytes instanceof Uint8Array))
      throw new Error(
        "Missing associated resource: " +
          key +
          ". Include it in the graphic ZIP.",
      );
    return { key, bytes };
  };
  const sceneFor = async (
    source: string,
    name: string,
    ancestors: Set<string>,
  ): Promise<X3D.X3DScene> => {
    checkTextGraphic(source, 256000);
    totalText += source.length;
    if (totalText > 800000 || ancestors.size > 8)
      throw new Error("Nested X3D resources exceed their parsing budget");
    if (/\b(?:Script|EXTERNPROTO|PROTO)\s*(?:\{|\[|[A-Za-z_])/u.test(source))
      throw new Error("Scene scripts and prototypes are disabled");
    const scene = await browser!.createX3DFromString(source);
    const seen = new Map<X3D.SFNode, X3D.SFNode>();
    const visit = async (
      node: X3D.SFNode | null,
    ): Promise<X3D.SFNode | null> => {
      if (!node) return null;
      if (seen.has(node)) return seen.get(node)!;
      if (++nodes > 512) throw new Error("X3D scene exceeds 512 nodes");
      seen.set(node, node);
      if (node.getNodeType().includes(X.X3DConstants.X3DGeometryNode))
        drawables++;
      const type = node.getNodeTypeName();
      const fields = node as unknown as Record<string, unknown>;
      if (type === "Script") throw new Error("Scene scripts are disabled");
      if (type === "ImageTexture") {
        const url = Array.from(fields.url as Iterable<string>)[0];
        if (!url) return node;
        if (++textures > 16) throw new Error("Too many X3D textures");
        const { bytes } = readResource(name, url);
        if (bytes.byteLength > 8 * 1024 * 1024)
          throw new Error("Texture exceeds 8 MiB");
        const meta = imageMeta(bytes);
        if (meta.width * meta.height > 4_000_000)
          throw new Error("Texture exceeds 4 million pixels");
        const scale = Math.min(1, 512 / Math.max(meta.width, meta.height));
        const bitmap = await createImageBitmap(
          new Blob([Uint8Array.from(bytes).buffer]),
          {
            resizeWidth: Math.max(1, Math.round(meta.width * scale)),
            resizeHeight: Math.max(1, Math.round(meta.height * scale)),
            imageOrientation: "flipY",
          },
        );
        try {
          const buffer = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = buffer.getContext("2d")!;
          context.drawImage(bitmap, 0, 0);
          const rgba = context.getImageData(
            0,
            0,
            bitmap.width,
            bitmap.height,
          ).data;
          const texture = scene.createNode("PixelTexture");
          const pixels = new X.MFInt32();
          pixels.length = bitmap.width * bitmap.height;
          for (let i = 0; i < pixels.length; i++)
            pixels[i] =
              (rgba[i * 4]! << 24) |
              (rgba[i * 4 + 1]! << 16) |
              (rgba[i * 4 + 2]! << 8) |
              rgba[i * 4 + 3]!;
          texture.image = new X.SFImage(bitmap.width, bitmap.height, 4, pixels);
          texture.repeatS = Boolean(fields.repeatS);
          texture.repeatT = Boolean(fields.repeatT);
          seen.set(node, texture);
          return texture;
        } finally {
          bitmap.close();
        }
      }
      if (type === "Inline") {
        const url = Array.from(fields.url as Iterable<string>)[0];
        if (!url) return node;
        const { key, bytes } = readResource(name, url);
        if (ancestors.has(key))
          throw new Error("Cyclic X3D resource reference");
        if (!/\.(wrl|x3dv)$/iu.test(key))
          throw new Error("Inline scenes must be local WRL or X3DV resources");
        const nested = await sceneFor(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          key,
          new Set([...ancestors, key]),
        );
        const group = scene.createNode("Group");
        group.children = nested.rootNodes as X3D.MFNode<X3D.X3DChildNodeProxy>;
        seen.set(node, group);
        return group;
      }
      if ("url" in fields) {
        const urls = fields.url as Iterable<string>;
        if (Array.from(urls).length)
          throw new Error(type + " URL resources are disabled in this preview");
      }
      for (const field of node.getFieldDefinitions()) {
        if (field.dataType === X.X3DConstants.SFNode)
          fields[field.name] = await visit(
            fields[field.name] as X3D.SFNode | null,
          );
        else if (field.dataType === X.X3DConstants.MFNode) {
          const children = fields[field.name] as X3D.MFNode;
          for (let i = 0; i < children.length; i++)
            children[i] = await visit(children[i]!);
        }
      }
      return node;
    };
    for (let i = 0; i < scene.rootNodes.length; i++)
      scene.rootNodes[i] = await visit(scene.rootNodes[i]!);
    return scene;
  };
  const scene = await sceneFor(input.source, input.name, new Set([input.name]));
  if (!scene.rootNodes.length || !drawables)
    throw new Error("No supported geometry found in this scene");
  await browser.replaceWorld(scene);
  browser.viewAll(undefined, 0);
  report("graphic-loaded");
}
window.addEventListener("pagehide", () => browser?.endUpdate());
report("graphic-ready");
