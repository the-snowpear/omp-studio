/**
 * Local preview bytes for sent user-bubble thumbnails.
 * Public transcript still strips images; this store is renderer UI memory
 * (IndexedDB), not Host / client-contract / Studio Bridge.
 */

import type { ComposerDoc, PromptImage } from "../composer/types";
import { toThumbnail } from "./thumbnailImage";

export type UserMessageThumb = {
  readonly label: string;
  readonly path?: string;
  readonly image: PromptImage;
};

export type UserThumbMap = { readonly [itemId: string]: readonly UserMessageThumb[] };

export type UserThumbStore = {
  load(sessionId: string): Promise<UserThumbMap>;
  save(sessionId: string, itemId: string, thumbs: readonly UserMessageThumb[]): Promise<void>;
  dropSession(sessionId: string): Promise<void>;
};

const DB_NAME = "omp-studio-ui";
const STORE_NAME = "user-message-thumbs";
/**
 * v2 起存的是降采样后的缩略图（`toThumbnail`），v1 存的是原图 base64。
 * 升级时直接删表重建：这是纯本地预览缓存，历史消息的缩略图退回附件占位而已，
 * 不值得为它写迁移，更不值得把一堆原图继续读进内存。
 */
const DB_VERSION = 2;

/** 落盘前把每张图压成缩略图；压不动的条目丢掉图片字节，只留标签。 */
async function thumbnailsForStorage(
  thumbs: readonly UserMessageThumb[],
): Promise<readonly UserMessageThumb[]> {
  return Promise.all(
    thumbs.map(async (thumb) => {
      const image = await toThumbnail(thumb.image);
      return image === undefined
        ? { label: thumb.label, ...(thumb.path === undefined ? {} : { path: thumb.path }) }
        : { ...thumb, image };
    }),
  ).then((rows) => rows.filter((row): row is UserMessageThumb => "image" in row && row.image !== undefined));
}

/**
 * 用户消息里图片字节的保留预算。
 *
 * `userDisplays` / `userThumbs` 原来只有 `slice(-maxRows)` 的**条数**上限（2000 条），
 * 没有字节上限，而每个 chip 携带的是**原图** base64（composer 侧允许单张 16 MiB、
 * 单次 64 MiB）。一张 4K 截图 base64 就是 6~7 MB，几十张就是 GB 级，而且
 * `trimAncillary` 只会在条目数超过 2000 时才开始丢。
 *
 * 8 MiB 与对话窗口本身的 `DEFAULT_MAX_BYTES`（24 MiB）同量级：图片是装饰，
 * 不该比转写正文更能占内存。超出预算时从最旧的消息开始丢，历史消息的行内缩略图
 * 退回附件占位，正文与附件名不受影响。
 */
export const USER_IMAGE_BUDGET_BYTES = 8 * 1024 * 1024;

/** base64 是 ASCII，一字符一字节，所以直接用长度即可，不必再编码一遍。 */
function imageBytes(image: PromptImage | undefined): number {
  return image === undefined ? 0 : image.data.length;
}

const docImageBytesCache = new WeakMap<object, number>();

/** 一个展示用 doc 携带的图片字节数。doc 不可变，所以按对象身份记忆。 */
export function docImageBytes(doc: ComposerDoc): number {
  const cached = docImageBytesCache.get(doc);
  if (cached !== undefined) return cached;
  let bytes = 0;
  for (const node of doc.nodes) {
    if (node.type === "chip" && node.chip.kind === "image") bytes += imageBytes(node.chip.image);
  }
  docImageBytesCache.set(doc, bytes);
  return bytes;
}

const thumbsImageBytesCache = new WeakMap<object, number>();

export function thumbsImageBytes(thumbs: readonly UserMessageThumb[]): number {
  const cached = thumbsImageBytesCache.get(thumbs);
  if (cached !== undefined) return cached;
  let bytes = 0;
  for (const thumb of thumbs) bytes += imageBytes(thumb.image);
  thumbsImageBytesCache.set(thumbs, bytes);
  return bytes;
}

/**
 * 从最新往回保留，直到图片字节超过预算为止。零字节的条目（纯文本消息）永不因为
 * 预算被丢弃 —— 它们不占图片预算，丢掉只会白白损失正文的展示副本。
 */
export function capByImageBytes<T>(
  entries: readonly (readonly [string, T])[],
  bytesOf: (value: T) => number,
  budget = USER_IMAGE_BUDGET_BYTES,
): Array<readonly [string, T]> {
  let spent = 0;
  const kept: Array<readonly [string, T]> = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const bytes = bytesOf(entry[1]);
    if (bytes > 0) {
      if (spent + bytes > budget) continue;
      spent += bytes;
    }
    kept.push(entry);
  }
  kept.reverse();
  return kept;
}

export function thumbsFromDoc(doc: ComposerDoc): UserMessageThumb[] {
  const thumbs: UserMessageThumb[] = [];
  for (const node of doc.nodes) {
    if (node.type !== "chip" || node.chip.kind !== "image" || node.chip.image === undefined) continue;
    thumbs.push({
      label: node.chip.label,
      image: node.chip.image,
      ...(node.chip.path === undefined ? {} : { path: node.chip.path }),
    });
  }
  return thumbs;
}

/**
 * 按 displays 对象身份缓存。派生链每帧都会调用它，而 displays 只在用户消息落地时
 * 变化；缓存之后缩略图数组身份也稳定，行缓存与 memo 才不会因为它每帧失效。
 */
const displayThumbsCache = new WeakMap<object, UserThumbMap>();

export function thumbsFromDisplays(displays: { readonly [itemId: string]: ComposerDoc }): UserThumbMap {
  const cached = displayThumbsCache.get(displays);
  if (cached !== undefined) return cached;
  const next: { [itemId: string]: readonly UserMessageThumb[] } = {};
  for (const [itemId, doc] of Object.entries(displays)) {
    const thumbs = thumbsFromDoc(doc);
    if (thumbs.length > 0) next[itemId] = thumbs;
  }
  displayThumbsCache.set(displays, next);
  return next;
}

export function attachUserThumbs(doc: ComposerDoc, thumbs: readonly UserMessageThumb[]): ComposerDoc {
  if (thumbs.length === 0) return doc;
  const byPath = new Map<string, PromptImage>();
  const byLabel = new Map<string, PromptImage>();
  const leftover: PromptImage[] = [];
  for (const thumb of thumbs) {
    if (thumb.path !== undefined) byPath.set(thumb.path, thumb.image);
    byLabel.set(thumb.label, thumb.image);
    leftover.push(thumb.image);
  }
  let unused = 0;
  return {
    nodes: doc.nodes.map((node) => {
      if (node.type !== "chip" || node.chip.kind !== "image" || node.chip.image !== undefined) return node;
      const fromPath = node.chip.path === undefined ? undefined : byPath.get(node.chip.path);
      const image = fromPath ?? byLabel.get(node.chip.label) ?? leftover[unused++];
      if (image === undefined) return node;
      return { type: "chip", chip: { ...node.chip, image } };
    }),
  };
}

export function mergeThumbMaps(base: UserThumbMap, extra: UserThumbMap): UserThumbMap {
  if (Object.keys(extra).length === 0) return base;
  return { ...base, ...extra };
}

type StoredRow = {
  readonly id: string;
  readonly sessionId: string;
  readonly itemId: string;
  readonly images: readonly UserMessageThumb[];
};

function recordId(sessionId: string, itemId: string): string {
  return `${sessionId}\u0000${itemId}`;
}

export function createMemoryThumbStore(): UserThumbStore {
  const sessions = new Map<string, Map<string, readonly UserMessageThumb[]>>();
  return {
    async load(sessionId) {
      const rows = sessions.get(sessionId);
      if (rows === undefined) return {};
      const out: { [itemId: string]: readonly UserMessageThumb[] } = {};
      for (const [itemId, thumbs] of rows) out[itemId] = thumbs;
      return out;
    },
    async save(sessionId, itemId, thumbs) {
      if (thumbs.length === 0) return;
      const stored = await thumbnailsForStorage(thumbs);
      if (stored.length === 0) return;
      const rows = sessions.get(sessionId) ?? new Map();
      rows.set(itemId, stored);
      sessions.set(sessionId, rows);
    },
    async dropSession(sessionId) {
      sessions.delete(sessionId);
    },
  };
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function openThumbDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // v1 的行是原图；删表重建，别把它们带进 v2。
      if (db.objectStoreNames.contains(STORE_NAME)) db.deleteObjectStore(STORE_NAME);
      const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
      store.createIndex("sessionId", "sessionId", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

export function createIndexedDbThumbStore(): UserThumbStore {
  const withStore = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>): Promise<T> => {
    const db = await openThumbDb();
    try {
      const tx = db.transaction(STORE_NAME, mode);
      return await run(tx.objectStore(STORE_NAME));
    } finally {
      db.close();
    }
  };
  return {
    async load(sessionId) {
      return withStore("readonly", async (store) => {
        const index = store.index("sessionId");
        const rows = await requestValue(index.getAll(sessionId)) as StoredRow[];
        const out: { [itemId: string]: readonly UserMessageThumb[] } = {};
        for (const row of rows) {
          if (row.images.length > 0) out[row.itemId] = row.images;
        }
        return out;
      });
    },
    async save(sessionId, itemId, thumbs) {
      if (thumbs.length === 0) return;
      // 降采样在事务之外做：`convertToBlob` 是异步的，IndexedDB 事务会在
      // 第一个 await 之后自动提交。
      const stored = await thumbnailsForStorage(thumbs);
      if (stored.length === 0) return;
      await withStore("readwrite", async (store) => {
        const row: StoredRow = { id: recordId(sessionId, itemId), sessionId, itemId, images: stored };
        await requestValue(store.put(row));
      });
    },
    async dropSession(sessionId) {
      await withStore("readwrite", async (store) => {
        const index = store.index("sessionId");
        const rows = await requestValue(index.getAll(sessionId)) as StoredRow[];
        for (const row of rows) await requestValue(store.delete(row.id));
      });
    },
  };
}

export function createDefaultThumbStore(): UserThumbStore {
  return typeof indexedDB === "undefined" ? createMemoryThumbStore() : createIndexedDbThumbStore();
}

let sharedThumbStore: UserThumbStore | undefined;

/**
 * Module-level shared thumbnail store. Conversation engines use this by
 * default so a deleted session's preview bytes can be dropped from IndexedDB
 * from anywhere (e.g. App after a successful session.delete). Tests inject
 * their own store through `input.thumbStore` and never touch this singleton.
 */
export function getDefaultThumbStore(): UserThumbStore {
  if (sharedThumbStore === undefined) sharedThumbStore = createDefaultThumbStore();
  return sharedThumbStore;
}
