import { useEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { ContextCategoryId, ContextEntrySummary, ContextViewIndex, ContextViewSourceMarker } from "@omp-studio/studio-protocol";
import { hostErrorMessage } from "../hostError";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import { formatCapturedAt } from "./contextViewMath";
import { PREVIEW_CONTEXT_VIEW, previewContextEntries, previewContextText, previewContextSourceMarkers } from "../preview/contextViewPreview";
import { ContextCategoryList } from "./ContextCategoryList";
import { ContextEntryList } from "./ContextEntryList";
import { ContextEntryPane } from "./ContextEntryPane";
import { ContextOverview } from "./ContextOverview";
import "./contextViewer.css";

type Phase = "idle" | "opening" | "ready" | "error";
type Load = "idle" | "loading" | "error";

/**
 * Read-only context snapshot in a two-column workbench: occupancy overview on top,
 * category legend and entry previews on the left, the selected entry on the right.
 * The snapshot is captured on open and released on close; nothing here re-reads live.
 */
export function ContextInspector({
  client,
  sessionId,
  sessionName,
  sourceKey,
  opened,
  available = true,
  unavailableReason,
  width = 1120,
  height = 820,
}: {
  client: StudioClient;
  sessionId?: string | undefined;
  sessionName?: string | undefined;
  sourceKey?: string | undefined;
  opened: boolean;
  available?: boolean;
  unavailableReason?: string | undefined;
  width?: number;
  height?: number;
}) {
  const { preview, marks } = usePreviewMode();
  const { t, resolvedLanguage } = useI18n();
  const surface = useSurfaceDocument();
  const narrow = width < 900;
  const compact = height < 520;
  const [reading, setReading] = useState(false);
  const [snapshot, setSnapshot] = useState<{ key: string; index: ContextViewIndex }>();
  const [phase, setPhase] = useState<Phase>("idle");
  const [attempt, setAttempt] = useState(0);
  const snapshotKey = JSON.stringify([opened, preview, sessionId, sourceKey, attempt, available]);
  const index = snapshot?.key === snapshotKey ? snapshot.index : undefined;
  const [category, setCategory] = useState<ContextCategoryId>("system-prompt");
  const [childKey, setChildKey] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<ContextEntrySummary[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | undefined>(undefined);
  const [selected, setSelected] = useState<ContextEntrySummary>();
  const [body, setBody] = useState("");
  const [sourceMarkers, setSourceMarkers] = useState<ContextViewSourceMarker[]>([]);
  const [sourceFocus, setSourceFocus] = useState<{ category: ContextCategoryId; entryId: string }>();
  const [totalChars, setTotalChars] = useState(0);
  const [nextBody, setNextBody] = useState<number | undefined>(undefined);
  const [entryTruncated, setEntryTruncated] = useState(false);
  const [listState, setListState] = useState<Load>("idle");
  const [bodyState, setBodyState] = useState<Load>("idle");
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const listGeneration = useRef(0);
  const bodyGeneration = useRef(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const generation = ++epoch.current;
    setSnapshot(undefined);
    setPhase(opened ? "opening" : "idle");
    setCategory("system-prompt");
    setChildKey(undefined);
    setSearch("");
    setEntries([]);
    setTotal(0);
    setNextOffset(undefined);
    setSelected(undefined);
    setBody("");
    setSourceMarkers([]);
    setSourceFocus(undefined);
    setTotalChars(0);
    setNextBody(undefined);
    setEntryTruncated(false);
    setListState("idle");
    setBodyState("idle");
    setError("");
    setReading(false);
    if (!opened) return;
    if (preview) {
      setSnapshot({ key: snapshotKey, index: PREVIEW_CONTEXT_VIEW });
      setPhase("ready");
      setCategory(PREVIEW_CONTEXT_VIEW.categories.find(item => item.openable !== false && item.entries > 0)?.id ?? "system-prompt");
      return;
    }
    if (!sessionId) {
      setError(t("contextViewer.error.noSession"));
      setPhase("error");
      return;
    }
    if (!available) {
      setError(unavailableReason ?? t("contextViewer.error.unavailable"));
      setPhase("error");
      return;
    }
    let acquired: ContextViewIndex | undefined;
    void client
      .query("context.view.open", { sessionId })
      .then(result => {
        if (generation !== epoch.current) {
          void client.query("context.view.release", { sessionId: result.sessionId, snapshotId: result.snapshotId }).catch(() => {});
          return;
        }
        acquired = result;
        setSnapshot({ key: snapshotKey, index: result });
        setPhase("ready");
        setCategory(result.categories.find(item => item.openable !== false && item.entries > 0)?.id ?? "system-prompt");
      })
      .catch(cause => {
        if (generation !== epoch.current) return;
        setError(hostErrorMessage(cause, t("contextViewer.error.open")));
        setPhase("error");
      });
    return () => {
      epoch.current++;
      bodyGeneration.current++;
      if (acquired)
        void client
          .query("context.view.release", { sessionId: acquired.sessionId, snapshotId: acquired.snapshotId })
          .catch(() => {});
    };
    // `t` is read once per open on purpose: a language switch must not re-sample the history.
  }, [opened, preview, sessionId, sourceKey, client, attempt, available, unavailableReason]);

  const read = async (entry: ContextEntrySummary, offset?: number) => {
    if (!index) return;
    const generation = ++bodyGeneration.current;
    setSelected(entry);
    if (offset === undefined) {
      setBody("");
      setSourceMarkers([]);
      setTotalChars(0);
      setNextBody(undefined);
      setEntryTruncated(false);
    }
    setBodyState("loading");
    setError("");
    try {
      if (preview) {
        const text = previewContextText(category, entry);
        if (generation !== bodyGeneration.current) return;
        setBody(previous => (offset === undefined ? text : previous + text));
        const markers = previewContextSourceMarkers(entry).map(marker => ({ ...marker, start: marker.start + (offset ?? 0), end: marker.end + (offset ?? 0) }));
        setSourceMarkers(previous => offset === undefined ? markers : [...previous, ...markers]);
        setTotalChars(text.length);
        setNextBody(undefined);
        setEntryTruncated(false);
        setBodyState("idle");
        return;
      }
      const result = await client.query("context.view.entry", {
        sessionId: index.sessionId,
        snapshotId: index.snapshotId,
        entryId: entry.id,
        ...(offset === undefined ? {} : { offset }),
      });
      if (generation !== bodyGeneration.current) return;
      setBody(previous => (offset === undefined ? result.text : previous + result.text));
      const markers = (result.sourceMarkers ?? []).map(marker => ({ ...marker, start: marker.start + (offset ?? 0), end: marker.end + (offset ?? 0) }));
      setSourceMarkers(previous => offset === undefined ? markers : [...previous, ...markers]);
      setTotalChars(result.totalChars);
      setNextBody(result.nextOffset);
      setEntryTruncated(result.truncated);
      setBodyState("idle");
    } catch (cause) {
      if (generation !== bodyGeneration.current) return;
      setError(hostErrorMessage(cause, t("contextViewer.error.entry")));
      setBodyState("error");
    }
  };

  useEffect(() => {
    if (!index || !opened || (!preview && (!sessionId || !available))) return;
    const generation = ++listGeneration.current;
    bodyGeneration.current++;
    const focusEntryId = sourceFocus?.category === category ? sourceFocus.entryId : undefined;
    setSelected(undefined);
    setBody("");
    setSourceMarkers([]);
    setTotalChars(0);
    setNextBody(undefined);
    setEntryTruncated(false);
    setBodyState("idle");
    setEntries([]);
    setTotal(0);
    setNextOffset(undefined);
    setListState("loading");
    setError("");
    const timer = setTimeout(() => {
      const query = search.trim().toLowerCase();
      const matches = (entry: ContextEntrySummary) =>
        !query || `${entry.label} ${entry.info ?? ""} ${entry.path ?? ""} ${entry.preview ?? ""}`.toLowerCase().includes(query);
      if (preview) {
        const all = previewContextEntries(category);
        // A search spans the whole category, matching the service.
        const rows = (query ? all : childKey ? all.filter(entry => entry.childKey === childKey) : all).filter(matches);
        if (generation !== listGeneration.current) return;
        setEntries(rows);
        setTotal(rows.length);
        setNextOffset(undefined);
        setListState("idle");
        const target = focusEntryId ? rows.find(entry => entry.id === focusEntryId) : rows[0];
        if (target) void read(target);
        else if (focusEntryId) setError(t("contextViewer.entry.sourceUnavailable"));
        return;
      }
      void client
        .query("context.view.list", {
          sessionId: index.sessionId,
          snapshotId: index.snapshotId,
          category,
          // A search spans the whole category, so the group key only applies while browsing.
          ...(childKey && !query ? { childKey } : {}),
          search,
          ...(focusEntryId ? { focusEntryId } : {}),
        })
        .then(page => {
          if (generation !== listGeneration.current) return;
          setEntries(page.entries);
          setTotal(page.total);
          setNextOffset(page.nextOffset);
          setListState("idle");
          const target = focusEntryId ? page.entries.find(entry => entry.id === focusEntryId) : page.entries[0];
          if (target) void read(target);
          else if (focusEntryId) setError(t("contextViewer.entry.sourceUnavailable"));
        })
        .catch(cause => {
          if (generation !== listGeneration.current) return;
          setError(hostErrorMessage(cause, t("contextViewer.error.list")));
          setListState("error");
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      listGeneration.current++;
    };
  }, [index, category, childKey, search, sourceFocus, opened, preview, client, sessionId, available]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) return;
      const target = event.target as HTMLElement | null;
      const typing =
        target?.matches("input, textarea") || target?.isContentEditable === true;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        setReading(false);
        if (narrow && reading) surface.defaultView?.requestAnimationFrame(() => searchRef.current?.focus());
        else searchRef.current?.focus();
      }
    };
    surface.addEventListener("keydown", onKey);
    return () => surface.removeEventListener("keydown", onKey);
  }, [surface, narrow, reading]);

  const moreEntries = async () => {
    if (!index || nextOffset === undefined) return;
    const generation = listGeneration.current;
    setListState("loading");
    try {
      const page = await client.query("context.view.list", {
        sessionId: index.sessionId,
        snapshotId: index.snapshotId,
        category,
        ...(childKey && !search.trim() ? { childKey } : {}),
        search,
        offset: nextOffset,
      });
      if (generation !== listGeneration.current) return;
      setEntries(previous => [...previous, ...page.entries]);
      setNextOffset(page.nextOffset);
      setListState("idle");
    } catch (cause) {
      if (generation !== listGeneration.current) return;
      setError(hostErrorMessage(cause, t("contextViewer.error.list")));
      setListState("error");
    }
  };

  const moreBody = () => {
    if (!selected || nextBody === undefined) return;
    void read(selected, nextBody);
  };

  return (
      <section className="cv" ref={rootRef} aria-label={t("contextViewer.title")} data-narrow={narrow || undefined} data-reading={narrow && reading || undefined} data-compact={compact || undefined}>
        <header className="cv-head">
          <div className="cv-head-info">
            <p className="cv-sub">{t("contextViewer.subtitle")}</p>
            <span className="cv-source">{sessionName ?? sessionId ?? "—"} · {index ? formatCapturedAt(index.capturedAt, resolvedLanguage === "zh" ? "zh-CN" : "en-US") : "—"} · {t("contextViewer.readonly")}</span>
          </div>
          <div className="cv-head-actions">
            {preview && marks ? <span className="chip gray xs">{t("contextViewer.demo")}</span> : null}
            {index?.truncated ? <span className="chip amber sm">{t("contextViewer.truncated")}</span> : null}
            <button type="button" className="btn small outline" disabled={!opened || (!preview && (!sessionId || !available)) || phase === "opening"} onClick={() => setAttempt(value => value + 1)}>
              {t("contextViewer.refresh")}
            </button>
          </div>
        </header>
        {index ? <ContextOverview index={index} compact={compact || narrow} /> : null}
        {index ? (
          <div className="cv-body">
            <aside className="cv-left" inert={narrow && reading}>
              <ContextCategoryList
                index={index}
                category={category}
                childKey={childKey}
                onSelect={(nextCategory, nextChildKey) => {
                  setSourceFocus(undefined);
                  setCategory(nextCategory);
                  setChildKey(nextChildKey);
                  setSearch("");
                }}
              />
              <ContextEntryList
                category={category}
                entries={entries}
                total={total}
                childKey={childKey}
                selectedId={selected?.id}
                listState={listState}
                search={search}
                onSearch={setSearch}
                onSelect={entry => { void read(entry); setReading(true); }}
                onMore={() => void moreEntries()}
                nextOffset={nextOffset}
                searchRef={searchRef}
              />
            </aside>
            <ContextEntryPane
              hidden={narrow && !reading}
              onBack={narrow ? () => setReading(false) : undefined}
              entry={selected}
              body={body}
              sourceMarkers={sourceMarkers}
              focusRequested={sourceFocus?.entryId === selected?.id && sourceFocus !== undefined}
              onOpenSource={marker => {
                if (!marker.entryId) return;
                setSourceFocus({ category: marker.category, entryId: marker.entryId });
                setCategory(marker.category);
                setChildKey(undefined);
                setSearch("");
                setReading(true);
              }}
              totalChars={totalChars}
              nextBody={nextBody}
              entryTruncated={entryTruncated}
              bodyState={bodyState}
              onMore={moreBody}
            />
          </div>
        ) : (
          <div className="cv-body cv-state">
            {phase === "error" ? (
              <div className="cv-error" role="alert">
                <span>{error}</span>
                {sessionId && !preview && available ? (
                  <button
                    type="button"
                    className="btn small outline"
                    onClick={() => {
                      setAttempt(value => value + 1);
                    }}
                  >
                    {t("contextViewer.retry")}
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="cv-open-state" role="status">
                <i aria-hidden="true" />
                <b>{t("contextViewer.loading")}</b>
                <small>{t("contextViewer.loadingHint")}</small>
              </p>
            )}
          </div>
        )}
        <footer className="cv-foot">
          <span className={index && error ? "cv-read-error" : undefined} role={index && error ? "alert" : undefined}>{index && error ? error : t("contextViewer.footHint")}</span>
          <span>
            {index ? index.snapshotId.slice(0, 8) : "—"} · {t("contextViewer.readonly")}
          </span>
        </footer>
      </section>
  );
}
