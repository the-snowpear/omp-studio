/**
 * 头像裁切视口数学：圆形取景框相对原图像素的映射。
 * 解码 / 编码在 operatorProfile.ts，避免把 DOM 读写缠进这些纯函数。
 */

export const AVATAR_CROP_VIEW_SIZE = 280;
export const AVATAR_CROP_CIRCLE_SIZE = 220;
export const AVATAR_CROP_MAX_ZOOM = 8;

export interface AvatarCropView {
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly viewSize: number;
  readonly circleSize: number;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface AvatarCropSource {
  readonly sx: number;
  readonly sy: number;
  readonly size: number;
}

export function coverScale(naturalWidth: number, naturalHeight: number, circleSize: number): number {
  return Math.max(circleSize / naturalWidth, circleSize / naturalHeight);
}

export function initialCropView(
  naturalWidth: number,
  naturalHeight: number,
  viewSize = AVATAR_CROP_VIEW_SIZE,
  circleSize = AVATAR_CROP_CIRCLE_SIZE,
): AvatarCropView {
  return clampCropView({
    naturalWidth,
    naturalHeight,
    viewSize,
    circleSize,
    x: 0,
    y: 0,
    scale: coverScale(naturalWidth, naturalHeight, circleSize),
  });
}

export function clampCropView(view: AvatarCropView): AvatarCropView {
  const minScale = coverScale(view.naturalWidth, view.naturalHeight, view.circleSize);
  const scale = Math.min(Math.max(view.scale, minScale), minScale * AVATAR_CROP_MAX_ZOOM);
  const imgW = view.naturalWidth * scale;
  const imgH = view.naturalHeight * scale;
  const circleLeft = (view.viewSize - view.circleSize) / 2;
  const circleTop = (view.viewSize - view.circleSize) / 2;
  const minX = circleLeft + view.circleSize - imgW;
  const maxX = circleLeft;
  const minY = circleTop + view.circleSize - imgH;
  const maxY = circleTop;
  return {
    ...view,
    scale,
    x: Math.min(maxX, Math.max(minX, view.x)),
    y: Math.min(maxY, Math.max(minY, view.y)),
  };
}

export function zoomCropView(view: AvatarCropView, factor: number): AvatarCropView {
  const cx = view.viewSize / 2;
  const cy = view.viewSize / 2;
  const scale = view.scale * factor;
  return clampCropView({
    ...view,
    scale,
    x: cx - (cx - view.x) * (scale / view.scale),
    y: cy - (cy - view.y) * (scale / view.scale),
  });
}

export function panCropView(view: AvatarCropView, dx: number, dy: number): AvatarCropView {
  return clampCropView({ ...view, x: view.x + dx, y: view.y + dy });
}

export function cropSourceRect(view: AvatarCropView): AvatarCropSource {
  const circleLeft = (view.viewSize - view.circleSize) / 2;
  const circleTop = (view.viewSize - view.circleSize) / 2;
  const size = Math.min(view.circleSize / view.scale, view.naturalWidth, view.naturalHeight);
  const sx = Math.min(Math.max(0, (circleLeft - view.x) / view.scale), Math.max(0, view.naturalWidth - size));
  const sy = Math.min(Math.max(0, (circleTop - view.y) / view.scale), Math.max(0, view.naturalHeight - size));
  return { sx, sy, size };
}
