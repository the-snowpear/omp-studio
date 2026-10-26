/**
 * 背景媒体库：上传的图片 / 视频存在 IndexedDB，偏好存在 localStorage。
 *
 * 为什么复用独立数据库而不是 `omp-studio-ui`：`userMessageThumbs` 在该库
 * 里用 v2 升级并删表重建，两个模块各自 open 同一个库、各自 upgrade 会互相
 * 覆盖 object store。背景库用独立名字 `omp-studio-backgrounds`，版本只由
 * 本模块推进。
 *
 * 列表只读元数据，缩略图以 data URL 保存，避免为每个 tile 创建 object URL；
 * 只有当前背景会读 Blob 并创建一个 object URL（见 `BackgroundProvider`）。
 */

import { BACKGROUND_LIMITS } from "./backgroundSettings";

export type BackgroundAssetKind = "preset" | "image" | "video";

/** IDB `meta` store 的行。 */
export interface BackgroundAssetMeta {
  readonly id: string;
  readonly kind: "image" | "video";
  readonly name: string;
  readonly mime: string;
  readonly bytes: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  readonly createdAt: number;
  readonly luma: number;
  readonly avgColor: string;
  readonly thumbDataUrl?: string;
  /** 仅用于去重：文件名 + 大小 + 修改时间。 */
  readonly fingerprint: string;
}

/** 渲染层统一使用的资产视图（内置预设与上传项共用）。 */
export interface BackgroundAsset {
  readonly id: string;
  readonly source: "preset" | "upload";
  readonly kind: BackgroundAssetKind;
  readonly name: string;
  readonly nameZh?: string;
  readonly nameEn?: string;
  readonly mime?: string;
  readonly bytes?: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  readonly createdAt?: number;
  readonly luma: number;
  readonly avgColor: string;
  readonly thumbDataUrl?: string;
  /** 仅预设：写进 `style.background` 的静态 CSS。 */
  readonly presetCss?: string;
}

export interface BackgroundLibrary {
  readonly kind: "indexeddb" | "memory";
  list(): Promise<readonly BackgroundAssetMeta[]>;
  readBlob(id: string): Promise<Blob | null>;
  put(meta: BackgroundAssetMeta, blob: Blob): Promise<void>;
  remove(id: string): Promise<void>;
}

export const BACKGROUND_DB_NAME = "omp-studio-backgrounds";
export const BACKGROUND_DB_VERSION = 1;
const META_STORE = "meta";
const BLOB_STORE = "blobs";

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(BACKGROUND_DB_NAME, BACKGROUND_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(BLOB_STORE)) database.createObjectStore(BLOB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

async function withDatabase<T>(run: (database: IDBDatabase) => Promise<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await run(database);
  } finally {
    database.close();
  }
}

export function createIndexedDbBackgroundLibrary(): BackgroundLibrary {
  return {
    kind: "indexeddb",
    async list() {
      return withDatabase(async (database) => {
        const transaction = database.transaction(META_STORE, "readonly");
        const rows = await requestValue(transaction.objectStore(META_STORE).getAll() as IDBRequest<BackgroundAssetMeta[]>);
        await transactionDone(transaction);
        return rows;
      });
    },
    async readBlob(id) {
      return withDatabase(async (database) => {
        const transaction = database.transaction(BLOB_STORE, "readonly");
        const blob = await requestValue(transaction.objectStore(BLOB_STORE).get(id) as IDBRequest<Blob | undefined>);
        await transactionDone(transaction);
        return blob ?? null;
      });
    },
    async put(meta, blob) {
      await withDatabase(async (database) => {
        const transaction = database.transaction([META_STORE, BLOB_STORE], "readwrite");
        transaction.objectStore(META_STORE).put(meta);
        transaction.objectStore(BLOB_STORE).put(blob, meta.id);
        await transactionDone(transaction);
      });
    },
    async remove(id) {
      await withDatabase(async (database) => {
        const transaction = database.transaction([META_STORE, BLOB_STORE], "readwrite");
        transaction.objectStore(META_STORE).delete(id);
        transaction.objectStore(BLOB_STORE).delete(id);
        await transactionDone(transaction);
      });
    },
  };
}

export function createMemoryBackgroundLibrary(
  seed: ReadonlyArray<{ readonly meta: BackgroundAssetMeta; readonly blob?: Blob }> = [],
): BackgroundLibrary {
  const metas = new Map<string, BackgroundAssetMeta>();
  const blobs = new Map<string, Blob>();
  for (const entry of seed) {
    metas.set(entry.meta.id, entry.meta);
    if (entry.blob !== undefined) blobs.set(entry.meta.id, entry.blob);
  }
  return {
    kind: "memory",
    async list() {
      return [...metas.values()];
    },
    async readBlob(id) {
      return blobs.get(id) ?? null;
    },
    async put(meta, blob) {
      metas.set(meta.id, meta);
      blobs.set(meta.id, blob);
    },
    async remove(id) {
      metas.delete(id);
      blobs.delete(id);
    },
  };
}

let defaultLibrary: BackgroundLibrary | undefined;

export function getDefaultBackgroundLibrary(): BackgroundLibrary {
  if (defaultLibrary === undefined) {
    defaultLibrary = typeof indexedDB === "undefined"
      ? createMemoryBackgroundLibrary()
      : createIndexedDbBackgroundLibrary();
  }
  return defaultLibrary;
}

/** 测试辅助：换掉默认库（传 undefined 恢复惰性创建）。 */
export function __setDefaultBackgroundLibraryForTests(library: BackgroundLibrary | undefined): void {
  defaultLibrary = library;
}

/** 打开库并读一次元数据，成功即认为本地存储可用。 */
export async function probeBackgroundLibrary(library: BackgroundLibrary): Promise<boolean> {
  try {
    await library.list();
    return true;
  } catch {
    return false;
  }
}

export function uploadBytes(uploads: readonly BackgroundAssetMeta[]): number {
  let total = 0;
  for (const upload of uploads) total += upload.bytes;
  return total;
}

export function canAddUpload(
  uploads: readonly BackgroundAssetMeta[],
  bytes: number,
): "ok" | "library-full" {
  if (uploads.length >= BACKGROUND_LIMITS.count) return "library-full";
  if (uploadBytes(uploads) + bytes > BACKGROUND_LIMITS.totalBytes) return "library-full";
  return "ok";
}
