// Reduced motion: the take is not scrubbed. Each caption gets one still frame
// of its shot instead, built from the same scene.
import iconUrl from "../shared/media/icon-256.webp";
import { buildWorld, SENTENCE, SNAP_STEPS, WORLD, type Rect, type WorldState } from "./world";

const FULL: WorldState = { typed: SENTENCE.length, sent: true, replies: 99, snap: 0, pins: 0 };

export function buildStills(stage: HTMLElement): void {
  const caps = [...stage.querySelectorAll<HTMLElement>(".b-cap")];
  const frames: { state: WorldState; near?: boolean; focus: (r: ReturnType<ReturnType<typeof buildWorld>["rects"]>) => Rect }[] = [
    { state: { ...FULL, sent: false, replies: 0 }, near: true, focus: (r) => ({ x: r.sentence.x - 26, y: r.sentence.y - 40, w: r.sentence.w + 150, h: 104 }) },
    { state: FULL, near: true, focus: (r) => ({ x: r.chat.x - 20, y: r.chat.y - 20, w: r.chat.w + 40, h: r.chat.h + 40 }) },
    { state: { ...FULL, snap: SNAP_STEPS.length - 1 }, focus: (r) => ({ x: r.app.x - 24, y: r.app.y - 24, w: r.app.w + 48, h: r.app.h + 48 }) },
    { state: { ...FULL, snap: SNAP_STEPS.length - 1, pins: 2 }, focus: () => ({ x: -24, y: -24, w: WORLD.w + 48, h: WORLD.h + 48 }) },
  ];

  frames.forEach((frame, n) => {
    const still = document.createElement("div");
    still.className = "b-still";
    const world = buildWorld();
    world.root.style.setProperty("--mon", "1");
    world.root.toggleAttribute("data-near", !!frame.near);
    still.append(world.root);
    caps[n]!.append(still);
    world.set(frame.state);
    const focus = frame.focus(world.rects());
    const fitStill = () => {
      const width = still.clientWidth;
      const s = Math.min(width / focus.w, n === 0 ? 3.2 : 1.15);
      still.style.height = `${focus.h * s}px`;
      world.root.style.transform = `translate(${(width - focus.w * s) / 2 - focus.x * s}px, ${-focus.y * s}px) scale(${s})`;
    };
    fitStill();
    addEventListener("resize", fitStill);
  });

  const icon = document.createElement("img");
  icon.src = iconUrl;
  icon.alt = "";
  icon.width = icon.height = 128;
  icon.className = "b-still-icon";
  caps[4]!.prepend(icon);
}
