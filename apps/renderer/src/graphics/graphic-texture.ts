import { Matrix3, SRGBColorSpace, Texture, type Wrapping } from "three";
import type { GraphicMaterial } from "./graphic-types";
/** ImageBitmap ignores WebGL's unpack flip flag; preserve the source orientation in UV space. */
export function graphicTexture(
  bitmap: ImageBitmap,
  material: GraphicMaterial,
): Texture {
  const texture = new Texture(bitmap);
  texture.colorSpace = SRGBColorSpace;
  texture.flipY = false;
  texture.matrixAutoUpdate = false;
  if (material.mapTransform) texture.matrix.fromArray(material.mapTransform);
  if (material.mapFlipY)
    texture.matrix.premultiply(new Matrix3().set(1, 0, 0, 0, -1, 1, 0, 0, 1));
  if (material.mapWrapS !== undefined)
    texture.wrapS = material.mapWrapS as Wrapping;
  if (material.mapWrapT !== undefined)
    texture.wrapT = material.mapWrapT as Wrapping;
  texture.needsUpdate = true;
  return texture;
}
