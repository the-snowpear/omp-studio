/**
 * 背景功能的唯一状态源。
 *
 * 生命周期：读偏好 → 读图库元数据 → 只为「当前背景」读 Blob 并创建 object URL。
 * 状态变化只通知背景层与设置页两个消费者；AppShell 不订阅，所以拖动滑杆不会
 * 重渲染整棵工作台。
 *
 * 预览模式（`preview`）用内存库 + 演示设置，不写真实 localStorage / IndexedDB。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  BACKGROUND_RESET_KEYS,
  DEFAULT_BACKGROUND_SETTINGS,
  mergeBackgroundSettings,
  readBackgroundSettings,
  writeBackgroundSettings,
  type BackgroundSettings,
} from "./backgroundSettings";
import { BACKGROUND_PRESETS } from "./backgroundPresets";
import {
  getDefaultBackgroundLibrary,
  uploadBytes,
  type BackgroundAsset,
  type BackgroundAssetMeta,
  type BackgroundLibrary,
} from "./backgroundLibrary";
import { importBackgroundFile, type BackgroundImportErrorCode } from "./backgroundImport";
import { autoScrim, gradeBackgroundColor, type BackgroundTheme } from "./backgroundTint";
import { createPreviewBackgroundLibrary, readPreviewBackgroundSettings } from "../preview/backgroundPreview";
import "./background.css";

export interface BackgroundImportErrorEntry {
  readonly key: string;
  readonly name: string;
  readonly code: BackgroundImportErrorCode;
}

export interface BackgroundImportingEntry {
  readonly key: string;
  readonly name: string;
}

export type BackgroundNotice = "missing-active" | "removed-active";

interface ProviderState {
  readonly settings: BackgroundSettings;
  readonly uploads: readonly BackgroundAssetMeta[];
  readonly activeUrl: string | null;
  readonly loading: boolean;
  readonly storageAvailable: boolean | null;
  readonly importing: readonly BackgroundImportingEntry[];
  readonly errors: readonly BackgroundImportErrorEntry[];
  readonly notice: BackgroundNotice | undefined;
}

type ProviderAction =
  | { readonly type: "settings"; readonly settings: BackgroundSettings }
  | { readonly type: "uploads"; readonly uploads: readonly BackgroundAssetMeta[] }
  | { readonly type: "add-upload"; readonly upload: BackgroundAssetMeta }
  | { readonly type: "remove-upload"; readonly id: string }
  | { readonly type: "url"; readonly url: string | null }
  | { readonly type: "loading"; readonly loading: boolean }
  | { readonly type: "storage"; readonly available: boolean }
  | { readonly type: "importing"; readonly entry: BackgroundImportingEntry }
  | { readonly type: "imported"; readonly key: string }
  | { readonly type: "error"; readonly entry: BackgroundImportErrorEntry }
  | { readonly type: "dismiss-error"; readonly key: string }
  | { readonly type: "notice"; readonly notice: BackgroundNotice | undefined }
  | { readonly type: "dismiss-notice" };

function reducer(state: ProviderState, action: ProviderAction): ProviderState {
  switch (action.type) {
    case "settings":
      return state.settings === action.settings ? state : { ...state, settings: action.settings };
    case "uploads":
      return { ...state, uploads: action.uploads };
    case "add-upload":
      return { ...state, uploads: [...state.uploads, action.upload] };
    case "remove-upload":
      return { ...state, uploads: state.uploads.filter((upload) => upload.id !== action.id) };
    case "url":
      return state.activeUrl === action.url ? state : { ...state, activeUrl: action.url };
    case "loading":
      return state.loading === action.loading ? state : { ...state, loading: action.loading };
    case "storage":
      return state.storageAvailable === action.available ? state : { ...state, storageAvailable: action.available };
    case "importing":
      return { ...state, importing: [...state.importing, action.entry] };
    case "imported":
      return { ...state, importing: state.importing.filter((entry) => entry.key !== action.key) };
    case "error":
      return {
        ...state,
        errors: [...state.errors.filter((entry) => entry.key !== action.entry.key), action.entry],
      };
    case "dismiss-error":
      return { ...state, errors: state.errors.filter((entry) => entry.key !== action.key) };
    case "notice":
      return { ...state, notice: action.notice };
    case "dismiss-notice":
      return state.notice === undefined ? state : { ...state, notice: undefined };
    default:
      return state;
  }
}

const PRESET_ASSETS: readonly BackgroundAsset[] = BACKGROUND_PRESETS.map((preset) => ({
  id: preset.id,
  source: "preset",
  kind: "preset",
  name: preset.nameZh,
  nameZh: preset.nameZh,
  nameEn: preset.nameEn,
  luma: preset.luma,
  avgColor: preset.avgColor,
  presetCss: preset.css,
}));

function metaToAsset(meta: BackgroundAssetMeta): BackgroundAsset {
  return {
    id: meta.id,
    source: "upload",
    kind: meta.kind,
    name: meta.name,
    mime: meta.mime,
    bytes: meta.bytes,
    createdAt: meta.createdAt,
    luma: meta.luma,
    avgColor: meta.avgColor,
    ...(meta.width === undefined ? {} : { width: meta.width }),
    ...(meta.height === undefined ? {} : { height: meta.height }),
    ...(meta.durationMs === undefined ? {} : { durationMs: meta.durationMs }),
    ...(meta.thumbDataUrl === undefined ? {} : { thumbDataUrl: meta.thumbDataUrl }),
  };
}

function useMediaPreference(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    try {
      return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let list: MediaQueryList;
    try {
      if (typeof window.matchMedia !== "function") return undefined;
      list = window.matchMedia(query);
    } catch {
      return undefined;
    }
    const update = (): void => setMatches(list.matches);
    update();
    if (typeof list.addEventListener === "function") {
      list.addEventListener("change", update);
      return () => list.removeEventListener("change", update);
    }
    list.addListener(update);
    return () => list.removeListener(update);
  }, [query]);
  return matches;
}

export interface BackgroundActions {
  readonly set: (patch: Partial<BackgroundSettings>) => void;
  readonly toggleEnabled: () => void;
  readonly resetParams: () => void;
  readonly activate: (id: string) => void;
  readonly importFiles: (files: readonly File[]) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
  readonly clearUploads: () => Promise<void>;
  readonly dismissError: (key: string) => void;
  readonly dismissNotice: () => void;
}

export interface BackgroundContextValue {
  readonly preview: boolean;
  readonly theme: BackgroundTheme;
  readonly settings: BackgroundSettings;
  readonly presets: readonly BackgroundAsset[];
  readonly uploads: readonly BackgroundAsset[];
  readonly assets: readonly BackgroundAsset[];
  readonly activeAsset: BackgroundAsset | undefined;
  readonly activeAvgColor: string | undefined;
  readonly activeUrl: string | null;
  readonly effectiveScrim: number;
  readonly reducedMotion: boolean;
  readonly reducedTransparency: boolean;
  readonly loading: boolean;
  readonly storageAvailable: boolean | null;
  readonly importing: readonly BackgroundImportingEntry[];
  readonly errors: readonly BackgroundImportErrorEntry[];
  readonly notice: BackgroundNotice | undefined;
  readonly usageBytes: number;
  readonly actions: BackgroundActions;
}

const BackgroundContext = createContext<BackgroundContextValue | undefined>(undefined);

export interface BackgroundProviderProps {
  readonly preview: boolean;
  readonly theme: BackgroundTheme;
  readonly children: ReactNode;
  /** 测试注入；生产环境按 preview 选择 IndexedDB / 内存库。 */
  readonly library?: BackgroundLibrary;
  readonly initialSettings?: BackgroundSettings;
  readonly initialUploads?: readonly BackgroundAssetMeta[];
}

function initialState(props: BackgroundProviderProps): ProviderState {
  const settings = props.initialSettings
    ?? (props.preview ? readPreviewBackgroundSettings() : readBackgroundSettings());
  return {
    settings,
    uploads: props.initialUploads ?? [],
    activeUrl: null,
    loading: true,
    storageAvailable: null,
    importing: [],
    errors: [],
    notice: undefined,
  };
}

export function BackgroundProvider(props: BackgroundProviderProps) {
  const [state, dispatch] = useReducer(reducer, props, initialState);
  const libraryRef = useRef<BackgroundLibrary | undefined>(undefined);
  const library = libraryRef.current ?? (libraryRef.current = props.library
    ?? (props.preview ? createPreviewBackgroundLibrary() : getDefaultBackgroundLibrary()));

  const settingsRef = useRef(state.settings);
  settingsRef.current = state.settings;
  const uploadsRef = useRef(state.uploads);
  uploadsRef.current = state.uploads;

  const mountedRef = useRef(true);
  const urlRef = useRef<string | null>(null);

  const setActiveUrl = useCallback((next: string | null) => {
    const previous = urlRef.current;
    if (previous !== null && previous !== next) {
      try {
        URL.revokeObjectURL(previous);
      } catch {
        /* object URL 可能已被浏览器回收 */
      }
    }
    urlRef.current = next;
    if (mountedRef.current) dispatch({ type: "url", url: next });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (urlRef.current !== null) {
        try {
          URL.revokeObjectURL(urlRef.current);
        } catch {
          /* ignore */
        }
      }
      urlRef.current = null;
    };
  }, []);

  const reducedMotion = useMediaPreference("(prefers-reduced-motion: reduce)");
  const reducedTransparency = useMediaPreference("(prefers-reduced-transparency: reduce)");

  const uploads = useMemo(
    () => [...state.uploads]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(metaToAsset),
    [state.uploads],
  );
  const assets = useMemo(() => [...PRESET_ASSETS, ...uploads], [uploads]);
  const activeAsset = useMemo(
    () => assets.find((asset) => asset.id === state.settings.activeId),
    [assets, state.settings.activeId],
  );
  const effectiveStrength = reducedTransparency
    ? Math.min(state.settings.strength, 10)
    : state.settings.strength;
  const activeAvgColor = activeAsset === undefined
    ? undefined
    : gradeBackgroundColor(props.theme, activeAsset.avgColor, activeAsset.luma);
  const effectiveScrim = state.settings.scrimAuto && activeAvgColor !== undefined
    ? autoScrim(props.theme, {
      opacity: state.settings.opacity,
      strength: effectiveStrength,
      avgColor: activeAvgColor,
    })
    : state.settings.scrim;

  const applySettings = useCallback((next: BackgroundSettings) => {
    settingsRef.current = next;
    if (mountedRef.current) dispatch({ type: "settings", settings: next });
    if (!props.preview) writeBackgroundSettings(next);
  }, [props.preview]);

  const set = useCallback((patch: Partial<BackgroundSettings>) => {
    applySettings(mergeBackgroundSettings(settingsRef.current, patch));
  }, [applySettings]);

  const toggleEnabled = useCallback(() => {
    set({ enabled: !settingsRef.current.enabled });
  }, [set]);

  const resetParams = useCallback(() => {
    const defaults: Partial<BackgroundSettings> = {};
    for (const key of BACKGROUND_RESET_KEYS) {
      (defaults as Record<string, unknown>)[key] = DEFAULT_BACKGROUND_SETTINGS[key];
    }
    set(defaults);
  }, [set]);

  const activate = useCallback((id: string) => {
    set({ activeId: id, enabled: true });
    dispatch({ type: "dismiss-notice" });
  }, [set]);

  const dismissError = useCallback((key: string) => {
    dispatch({ type: "dismiss-error", key });
  }, []);

  const dismissNotice = useCallback(() => {
    dispatch({ type: "dismiss-notice" });
  }, []);

  const importFiles = useCallback(async (files: readonly File[]) => {
    let firstImported: string | undefined;
    for (const file of files) {
      const key = `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2, 8)}`;
      dispatch({ type: "importing", entry: { key, name: file.name } });
      try {
        const result = await importBackgroundFile(file, {
          library,
          uploads: uploadsRef.current,
        });
        if (result.ok) {
          if (!result.deduped) {
            uploadsRef.current = [...uploadsRef.current, result.meta];
            dispatch({ type: "add-upload", upload: result.meta });
          }
          firstImported ??= result.meta.id;
        } else {
          dispatch({ type: "error", entry: { key, name: file.name, code: result.code } });
        }
      } finally {
        dispatch({ type: "imported", key });
      }
    }
    if (firstImported !== undefined) {
      applySettings(mergeBackgroundSettings(settingsRef.current, {
        activeId: firstImported,
        enabled: true,
      }));
    }
  }, [applySettings, library]);

  const remove = useCallback(async (id: string) => {
    try {
      await library.remove(id);
    } catch {
      dispatch({ type: "error", entry: { key: `remove:${id}`, name: "", code: "storage-unavailable" } });
      return;
    }
    uploadsRef.current = uploadsRef.current.filter((upload) => upload.id !== id);
    dispatch({ type: "remove-upload", id });
    if (settingsRef.current.activeId === id) {
      applySettings(mergeBackgroundSettings(settingsRef.current, {
        enabled: false,
        activeId: DEFAULT_BACKGROUND_SETTINGS.activeId,
      }));
      dispatch({ type: "notice", notice: "removed-active" });
    }
  }, [applySettings, library]);

  const clearUploads = useCallback(async () => {
    const current = uploadsRef.current;
    const removed = new Set<string>();
    for (const upload of current) {
      try {
        await library.remove(upload.id);
        removed.add(upload.id);
      } catch {
        dispatch({ type: "error", entry: { key: `clear:${upload.id}`, name: upload.name, code: "storage-unavailable" } });
      }
    }
    uploadsRef.current = current.filter((upload) => !removed.has(upload.id));
    dispatch({ type: "uploads", uploads: uploadsRef.current });
    if (removed.has(settingsRef.current.activeId)) {
      applySettings(mergeBackgroundSettings(settingsRef.current, {
        enabled: false,
        activeId: DEFAULT_BACKGROUND_SETTINGS.activeId,
      }));
      dispatch({ type: "notice", notice: "removed-active" });
    }
  }, [applySettings, library]);

  const actions = useMemo<BackgroundActions>(() => ({
    set,
    toggleEnabled,
    resetParams,
    activate,
    importFiles,
    remove,
    clearUploads,
    dismissError,
    dismissNotice,
  }), [activate, clearUploads, dismissError, dismissNotice, importFiles, remove, resetParams, set, toggleEnabled]);

  useEffect(() => {
    let cancelled = false;
    void library.list().then((rows) => {
      if (cancelled) return;
      uploadsRef.current = rows;
      dispatch({ type: "uploads", uploads: rows });
      dispatch({ type: "storage", available: true });
      dispatch({ type: "loading", loading: false });
    }).catch(() => {
      if (cancelled) return;
      dispatch({ type: "storage", available: false });
      dispatch({ type: "loading", loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, [library]);

  useEffect(() => {
    if (!state.settings.enabled || activeAsset === undefined || activeAsset.source === "preset") {
      setActiveUrl(null);
      return undefined;
    }
    let cancelled = false;
    void library.readBlob(activeAsset.id).then((blob) => {
      if (cancelled || !mountedRef.current) return;
      if (blob === null) {
        uploadsRef.current = uploadsRef.current.filter((upload) => upload.id !== activeAsset.id);
        dispatch({ type: "remove-upload", id: activeAsset.id });
        dispatch({ type: "notice", notice: "missing-active" });
        applySettings(mergeBackgroundSettings(settingsRef.current, { enabled: false }));
        setActiveUrl(null);
        return;
      }
      if (typeof URL.createObjectURL !== "function") {
        setActiveUrl(null);
        return;
      }
      setActiveUrl(URL.createObjectURL(blob));
    }).catch(() => {
      if (cancelled || !mountedRef.current) return;
      dispatch({ type: "notice", notice: "missing-active" });
      applySettings(mergeBackgroundSettings(settingsRef.current, { enabled: false }));
      setActiveUrl(null);
    });
    return () => {
      cancelled = true;
    };
  }, [activeAsset, applySettings, library, setActiveUrl, state.settings.enabled]);

  useEffect(() => {
    if (state.loading) return;
    if (activeAsset !== undefined || state.settings.activeId === "") return;
    dispatch({ type: "notice", notice: "missing-active" });
    if (state.settings.enabled) {
      applySettings(mergeBackgroundSettings(settingsRef.current, { enabled: false }));
    }
  }, [state.loading, activeAsset, state.settings.activeId, state.settings.enabled, applySettings]);

  const value = useMemo<BackgroundContextValue>(() => ({
    preview: props.preview,
    theme: props.theme,
    settings: state.settings,
    presets: PRESET_ASSETS,
    uploads,
    assets,
    activeAsset,
    activeAvgColor,
    activeUrl: state.activeUrl,
    effectiveScrim,
    reducedMotion,
    reducedTransparency,
    loading: state.loading,
    storageAvailable: state.storageAvailable,
    importing: state.importing,
    errors: state.errors,
    notice: state.notice,
    usageBytes: uploadBytes(state.uploads),
    actions,
  }), [
    actions,
    activeAsset,
    activeAvgColor,
    assets,
    effectiveScrim,
    props.preview,
    props.theme,
    reducedMotion,
    reducedTransparency,
    state.activeUrl,
    state.errors,
    state.importing,
    state.loading,
    state.notice,
    state.settings,
    state.storageAvailable,
    state.uploads,
    uploads,
  ]);

  return <BackgroundContext.Provider value={value}>{props.children}</BackgroundContext.Provider>;
}

export function useBackground(): BackgroundContextValue {
  const context = useContext(BackgroundContext);
  if (context === undefined) {
    throw new Error("useBackground must be used inside BackgroundProvider");
  }
  return context;
}
