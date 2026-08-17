import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "../icons";
import {
  AVATAR_CROP_CIRCLE_SIZE,
  AVATAR_CROP_VIEW_SIZE,
  cropSourceRect,
  initialCropView,
  panCropView,
  zoomCropView,
  type AvatarCropView,
} from "./avatarCrop";
import { encodeAvatarCrop, type LoadedAvatarImage, type ProcessedAvatar } from "./operatorProfile";

export function AvatarCropDialog({
  image,
  locked = false,
  notice,
  onConfirm,
  onRetake,
  onClose,
}: {
  image: LoadedAvatarImage;
  locked?: boolean | undefined;
  notice?: string | undefined;
  onConfirm: (avatar: ProcessedAvatar) => void;
  onRetake: () => void;
  onClose: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [view, setView] = useState<AvatarCropView>(() =>
    initialCropView(image.width, image.height, AVATAR_CROP_VIEW_SIZE, AVATAR_CROP_CIRCLE_SIZE),
  );
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    setView(initialCropView(image.width, image.height, AVATAR_CROP_VIEW_SIZE, AVATAR_CROP_CIRCLE_SIZE));
    setError(undefined);
  }, [image]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = view.viewSize * dpr;
    canvas.height = view.viewSize * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0b0b0f";
    ctx.fillRect(0, 0, view.viewSize, view.viewSize);
    ctx.drawImage(image.source, view.x, view.y, image.width * view.scale, image.height * view.scale);
  }, [image, view]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
      setView((current) => zoomCropView(current, factor));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  const inactive = busy || locked;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || inactive) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { x: view.x, y: view.y, px: event.clientX, py: event.clientY };
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setView((current) => panCropView(
      { ...current, x: drag.x, y: drag.y },
      event.clientX - drag.px,
      event.clientY - drag.py,
    ));
  };

  const endDrag = () => {
    dragRef.current = null;
    setDragging(false);
  };

  return (
    <div
      className="modal-backdrop avatar-crop-backdrop"
      role="presentation"
      onMouseDown={() => { if (!inactive) onClose(); }}
    >
      <section
        className="modal avatar-crop-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatarCropTitle"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head profile-edit-head">
          <h2 id="avatarCropTitle">裁切头像</h2>
          <button type="button" className="icon-btn" aria-label="关闭" disabled={inactive} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body avatar-crop-body">
          <div
            ref={stageRef}
            className={`avatar-crop-stage${dragging ? " is-dragging" : ""}`}
            style={{
              width: view.viewSize,
              height: view.viewSize,
              ["--avatar-crop-circle" as string]: `${view.circleSize}px`,
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <canvas
              ref={canvasRef}
              className="avatar-crop-canvas"
              width={view.viewSize}
              height={view.viewSize}
            />
            <div className="avatar-crop-circle" aria-hidden="true" />
          </div>
          <p className="muted small">拖动调整位置，滚轮缩放</p>
          {notice || error ? (
            <p className="profile-edit-error" role="alert">
              <Icon name="alert" extra="sm" />{notice ?? error}
            </p>
          ) : null}
        </div>
        <div className="modal-foot avatar-crop-foot">
          <button type="button" className="btn outline" disabled={inactive} onClick={onRetake}>重拍</button>
          <button
            type="button"
            className="btn primary"
            disabled={inactive}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              void encodeAvatarCrop(image.source, cropSourceRect(view)).then(
                (avatar) => onConfirm(avatar),
                (cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : "无法处理图片。");
                  setBusy(false);
                },
              );
            }}
          >
            {busy ? "处理中…" : "确认"}
          </button>
        </div>
      </section>
    </div>
  );
}
