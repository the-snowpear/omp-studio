import type { WebStatus } from "../../../desktop/src/web/shared";

export function webAccessPreview(zh: boolean): WebStatus {
  return {
    origin: "http://127.0.0.1:8560",
    addresses: [],
    control: {
      version: "preview",
      owner: { id: "preview", name: zh ? "工作电脑" : "Work computer" },
    },
    devices: [
      {
        id: "preview-laptop",
        name: zh ? "我的笔记本" : "My laptop",
        createdAt: 1795392000000,
        lastSeenAt: 1795392000000,
      },
      {
        id: "preview-phone",
        name: zh ? "我的手机" : "My phone",
        createdAt: 1795392000000,
        lastSeenAt: 1795392000000,
      },
    ],
  };
}
