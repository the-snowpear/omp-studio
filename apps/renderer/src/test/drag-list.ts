import { fireEvent } from "@testing-library/react";
import { vi } from "vitest";

/** Give jsdom differently sized rows, then drag between their visual centers. */
export function dragList(rows: readonly HTMLElement[], from: number, to: number, gap: number, handleSelector: string) {
  let top = 0;
  const centers = rows.map((row, index) => {
    const height = 50 + index * 20;
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ top, height } as DOMRect);
    const center = top + height / 2;
    top += height + gap;
    return center;
  });
  const handle = rows[from]!.querySelector<HTMLElement>(handleSelector)!;
  Object.assign(handle, { setPointerCapture() {}, releasePointerCapture() {} });
  const pointer = (type: string, clientY: number) => Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY }), { pointerId: 1 });
  fireEvent(handle, pointer("pointerdown", 0));
  fireEvent(handle, pointer("pointermove", centers[to]! - centers[from]!));
  fireEvent(handle, pointer("pointerup", centers[to]! - centers[from]!));
}
