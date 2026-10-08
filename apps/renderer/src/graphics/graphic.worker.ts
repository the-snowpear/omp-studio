import { parseGraphic } from "./graphic-parser";
self.onmessage = async (
  event: MessageEvent<{ name: string; data: ArrayBuffer }>,
) => {
  try {
    const result = await parseGraphic(event.data.name, event.data.data);
    const transfer: Transferable[] = [];
    if (result.kind === "scene") {
      for (const mesh of result.meshes)
        for (const data of [
          mesh.position,
          mesh.normal,
          mesh.uv,
          mesh.color,
          mesh.index,
        ])
          if (data) transfer.push(data.buffer as ArrayBuffer);
      transfer.push(...result.images);
    }
    self.postMessage({ ok: true, result }, { transfer });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
