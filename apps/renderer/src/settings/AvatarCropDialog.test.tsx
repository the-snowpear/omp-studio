import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AvatarCropDialog } from "./AvatarCropDialog";
import type { LoadedAvatarImage } from "./operatorProfile";

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
});

afterEach(() => {
  cleanup();
});

describe("AvatarCropDialog", () => {
  it("shows a circular preview with confirm, retake, and close", () => {
    const source = document.createElement("canvas");
    source.width = 400;
    source.height = 300;
    const image: LoadedAvatarImage = {
      source,
      width: 400,
      height: 300,
      close() {},
    };
    const closed: string[] = [];
    render(
      <AvatarCropDialog
        image={image}
        onConfirm={() => undefined}
        onRetake={() => closed.push("retake")}
        onClose={() => closed.push("close")}
      />,
    );
    expect(screen.getByRole("dialog", { name: "裁切头像" })).toBeTruthy();
    expect(document.querySelector(".avatar-crop-circle")).toBeInstanceOf(HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "重拍" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(closed).toEqual(["retake", "close"]);
  });
});
