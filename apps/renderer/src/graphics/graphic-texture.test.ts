import { expect, it } from "vitest";
import { Matrix3, Vector2, RepeatWrapping } from "three";
import { graphicTexture } from "./graphic-texture";
it("keeps glTF orientation and applies OBJ flip after the source UV transform", () => {
  const bitmap = {} as ImageBitmap;
  const base = { color: 0xffffff, opacity: 1, metalness: 0, roughness: 1 };
  const transform = new Matrix3().setUvTransform(0.2, 0.1, 0.5, 0.75, 0, 0, 0);
  const gltf = graphicTexture(bitmap, {
    ...base,
    mapFlipY: false,
    mapTransform: transform.toArray(),
    mapWrapS: RepeatWrapping,
  });
  const obj = graphicTexture(bitmap, {
    ...base,
    mapFlipY: true,
    mapTransform: transform.toArray(),
  });
  expect(new Vector2(0.4, 0.2).applyMatrix3(gltf.matrix).toArray()).toEqual([
    0.4, 0.25,
  ]);
  expect(new Vector2(0.4, 0.2).applyMatrix3(obj.matrix).toArray()).toEqual([
    0.4, 0.75,
  ]);
  expect(gltf.wrapS).toBe(RepeatWrapping);
  expect(gltf.matrixAutoUpdate).toBe(false);
  expect(gltf.flipY).toBe(false);
  gltf.dispose();
  obj.dispose();
});
