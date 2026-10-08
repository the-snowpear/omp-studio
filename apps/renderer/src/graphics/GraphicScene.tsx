import { useEffect, useRef, useState } from "react";
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  BufferAttribute,
  BufferGeometry,
  DirectionalLight,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  Texture,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { GraphicResult } from "./graphic-types";
import { graphicTexture } from "./graphic-texture";
import { useI18n } from "../i18n";
export default function GraphicScene({
  data, onFailure,
}: {
  data: Extract<GraphicResult, { kind: "scene" }>;
  onFailure: (reason: string) => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const fit = useRef(() => {});
  const [error, setError] = useState("");
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  useEffect(() => {
    if (!mount.current) return;
    const host = mount.current;
    let renderer: WebGLRenderer | undefined;
    let controls: OrbitControls | undefined;
    let observer: ResizeObserver | undefined;
    let frame = 0;
    const geometries: BufferGeometry[] = [];
    const materials: Array<
      MeshStandardMaterial | LineBasicMaterial | PointsMaterial
    > = [];
    const textures: Texture[] = [];
    try {
      renderer = new WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "low-power",
      });
      renderer.toneMapping = ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.8;
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
      renderer.setClearColor(0x000000, 0);
      host.append(renderer.domElement);
      const scene = new Scene();
      const group = new Group();
      const camera = new PerspectiveCamera(40, 1, 0.01, 10000);
      scene.add(group);
      scene.add(new AmbientLight(0xffffff, 0.8));
      const light = new DirectionalLight(0xffffff, 2);
      light.position.set(3, 5, 4);
      scene.add(light);
      for (const item of data.meshes) {
        const geometry = new BufferGeometry();
        geometries.push(geometry);
        geometry.setAttribute(
          "position",
          new BufferAttribute(item.position, 3),
        );
        if (item.index) geometry.setIndex(new BufferAttribute(item.index, 1));
        if (item.normal)
          geometry.setAttribute("normal", new BufferAttribute(item.normal, 3));
        else if (item.kind === "mesh") geometry.computeVertexNormals();
        if (item.uv)
          geometry.setAttribute("uv", new BufferAttribute(item.uv, 2));
        if (item.color)
          geometry.setAttribute("color", new BufferAttribute(item.color, 3));
        if (item.index) geometry.setIndex(new BufferAttribute(item.index, 1));
        for (const part of item.groups)
          geometry.addGroup(part.start, part.count, part.materialIndex);
        const material = item.materials.map((value) => {
          const bitmap =
            value.map === undefined ? undefined : data.images[value.map];
          const map = bitmap ? graphicTexture(bitmap, value) : undefined;
          if (map) textures.push(map);
          const shared = {
            color: value.color,
            opacity: value.opacity,
            transparent: value.opacity < 1,
            vertexColors: !!item.color,
          };
          const result =
            item.kind === "points"
              ? new PointsMaterial({ ...shared, size: 0.012 })
              : item.kind === "lines"
                ? new LineBasicMaterial(shared)
                : new MeshStandardMaterial({
                    ...shared,
                    metalness: value.metalness,
                    roughness: value.roughness,
                    ...(map ? { map } : {}),
                  });
          materials.push(result);
          return result;
        });
        const node =
          item.kind === "points"
            ? new Points(geometry, material[0] as PointsMaterial)
            : item.kind === "lines"
              ? new LineSegments(geometry, material[0] as LineBasicMaterial)
              : new Mesh(
                  geometry,
                  material.length === 1
                    ? (material[0] as MeshStandardMaterial)
                    : (material as MeshStandardMaterial[]),
                );
        node.applyMatrix4(new Matrix4().fromArray(item.matrix));
        group.add(node);
      }
      const bounds = new Box3().setFromObject(group);
      const center = bounds.getCenter(new Vector3());
      const span = Math.max(bounds.getSize(new Vector3()).length(), 0.01);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = false;
      controls.target.copy(center);
      const draw = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          renderer?.render(scene, camera);
        });
      };
      fit.current = () => {
        camera.position.copy(center).add(new Vector3(span, span * 0.65, span));
        camera.near = Math.max(span / 10000, 0.0001);
        camera.far = span * 100;
        camera.updateProjectionMatrix();
        controls?.target.copy(center);
        controls?.update();
        draw();
      };
      controls.addEventListener("change", draw);
      fit.current();
      observer = new ResizeObserver(() => {
        const width = Math.max(1, host.clientWidth),
          height = Math.max(1, host.clientHeight);
        renderer?.setSize(Math.min(width, 1600), Math.min(height, 1000), false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        draw();
      });
      observer.observe(host);
      setError("");
    } catch (cause) {
      onFailure(cause instanceof Error ? cause.message : String(cause));
    }
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      controls?.dispose();
      for (const texture of textures) texture.dispose();
      for (const material of materials) material.dispose();
      for (const geometry of geometries) geometry.dispose();
      renderer?.dispose();
      renderer?.forceContextLoss();
      renderer?.domElement.remove();
      fit.current = () => {};
    };
  }, [data, onFailure]);
  return (
    <div className="graphic-scene">
      <div
        ref={mount}
        className="graphic-canvas"
        aria-label={zh ? "三维模型预览" : "3D model preview"}
      />
      <div className="graphic-controls">
        <span>
          {zh ? "拖动旋转 · 滚轮缩放" : "Drag to orbit · Scroll to zoom"}
        </span>
        <button className="btn small outline" onClick={() => fit.current()}>
          {zh ? "适配视图" : "Fit view"}
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
