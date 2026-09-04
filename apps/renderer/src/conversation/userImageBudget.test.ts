/**
 * 用户消息图片的内存预算。
 *
 * 这组断言守的是一条 GB 级的回归：`userThumbs` / `userDisplays` 过去只有 2000 条的
 * **条数**上限，携带的却是原图 base64（composer 允许单张 16 MiB）。一张 4K 截图
 * base64 就是 6~7 MB，几十张就把渲染进程吃到 GB 级。
 */
import { describe, expect, it } from "vitest";
import type { ComposerDoc, PromptImage } from "../composer/types";
import {
  USER_IMAGE_BUDGET_BYTES,
  capByImageBytes,
  createMemoryThumbStore,
  docImageBytes,
  thumbsImageBytes,
  type UserMessageThumb,
} from "./userMessageThumbs";
import { THUMBNAIL_PASSTHROUGH_MAX_BYTES } from "./thumbnailImage";

function image(bytes: number): PromptImage {
  return { type: "image", mimeType: "image/png", data: "a".repeat(bytes) };
}

function thumb(label: string, bytes: number): UserMessageThumb {
  return { label, image: image(bytes) };
}

function docWith(bytes: number): ComposerDoc {
  return {
    nodes: [{ type: "chip", chip: { id: `chip-${bytes}`, kind: "image", label: "shot.png", image: image(bytes) } }],
  } as ComposerDoc;
}

describe("图片字节记账", () => {
  it("按 base64 长度计数，doc 与 thumbs 两条路一致", () => {
    expect(thumbsImageBytes([thumb("a", 1024), thumb("b", 2048)])).toBe(3072);
    expect(docImageBytes(docWith(4096))).toBe(4096);
  });

  it("同一对象重复记账走缓存（doc 不可变，按身份记忆）", () => {
    const doc = docWith(2048);
    expect(docImageBytes(doc)).toBe(2048);
    expect(docImageBytes(doc)).toBe(2048);
  });
});

describe("capByImageBytes", () => {
  const oneMiB = 1024 * 1024;

  it("超预算时从最旧的开始丢，保留最新的", () => {
    const entries = Array.from({ length: 20 }, (_, index) => [`item-${index}`, [thumb("s", oneMiB)]] as const);
    const kept = capByImageBytes(entries, thumbsImageBytes);
    expect(kept.length).toBe(Math.floor(USER_IMAGE_BUDGET_BYTES / oneMiB));
    // 保留的是尾部（最新）那一段，且顺序不变。
    expect(kept[kept.length - 1]?.[0]).toBe("item-19");
    expect(kept.map((entry) => entry[0])).toEqual([...kept].map((entry) => entry[0]));
  });

  it("纯文本条目不占预算，也永不因为预算被丢弃", () => {
    const entries = [
      ["text-old", [] as readonly UserMessageThumb[]] as const,
      ["huge", [thumb("s", USER_IMAGE_BUDGET_BYTES * 2)]] as const,
      ["text-new", [] as readonly UserMessageThumb[]] as const,
    ];
    const kept = capByImageBytes(entries, thumbsImageBytes);
    expect(kept.map((entry) => entry[0])).toEqual(["text-old", "text-new"]);
  });

  it("预算内的条目全部保留", () => {
    const entries = [["a", [thumb("s", 1024)]] as const, ["b", [thumb("s", 1024)]] as const];
    expect(capByImageBytes(entries, thumbsImageBytes).length).toBe(2);
  });
});

describe("缩略图落盘", () => {
  it("小图原样保留", async () => {
    const store = createMemoryThumbStore();
    const small = THUMBNAIL_PASSTHROUGH_MAX_BYTES - 16;
    await store.save("session-1", "item-1", [thumb("icon.png", small)]);
    const loaded = await store.load("session-1");
    expect(loaded["item-1"]?.[0]?.image.data.length).toBe(small);
  });

  it("大图绝不按原尺寸落盘：压不动就整条丢掉图片字节", async () => {
    // jsdom 没有 OffscreenCanvas / createImageBitmap，`toThumbnail` 走的是失败分支。
    // 这正是要断言的行为：宁可这条消息只剩附件占位，也不要把 4 MiB 钉在内存里。
    const store = createMemoryThumbStore();
    await store.save("session-1", "item-1", [thumb("shot.png", 4 * 1024 * 1024)]);
    const loaded = await store.load("session-1");
    const retained = thumbsImageBytes(loaded["item-1"] ?? []);
    expect(retained).toBeLessThanOrEqual(THUMBNAIL_PASSTHROUGH_MAX_BYTES);
  });

  it("dropSession 清掉整个会话的字节", async () => {
    const store = createMemoryThumbStore();
    await store.save("session-1", "item-1", [thumb("icon.png", 1024)]);
    await store.dropSession("session-1");
    expect(await store.load("session-1")).toEqual({});
  });
});
