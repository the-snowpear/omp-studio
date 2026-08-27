/**
 * Local preview bytes for sent user-bubble thumbnails.
 * Public transcript still strips images; this store is renderer UI memory
 * (IndexedDB), not Host / client-contract / Studio Bridge.
 */

import type { ComposerDoc, PromptImage } from "../composer/types";

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
const DB_VERSION = 1;

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
      const rows = sessions.get(sessionId) ?? new Map();
      rows.set(itemId, thumbs);
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
      if (db.objectStoreNames.contains(STORE_NAME)) return;
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
      await withStore("readwrite", async (store) => {
        const row: StoredRow = { id: recordId(sessionId, itemId), sessionId, itemId, images: thumbs };
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
