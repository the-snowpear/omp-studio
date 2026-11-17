import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { Icon, type IconName } from "../../icons";
import { useI18n } from "../../i18n";
import { usePreviewMode } from "../../preview/PreviewContext";
import { previewRate, previewStageMarks } from "../../preview/agentDeckPreview";
import { useAppSettings, type AgentRosterDensity } from "../../settings/appSettings";
import type { AgentRosterSource } from "../AgentRosterMeter";
import { AgentInspector, SwarmSummary, type InspectorActions } from "./AgentInspector";
import { CommsView } from "./CommsView";
import { rosterKeyOf, useSwarmComms, type SwarmComms } from "./comms";
import { useDeckCommands, type DeckCommandContext } from "./deckActions";
import { buildDeck, deckTotals, filterDeck, type DeckAgent, type DeckGroup } from "./deckModel";
import { useDeckUi, type DeckStageView, type DeckView } from "./deckState";
import { FormationView } from "./FormationView";
import { OrbitView } from "./OrbitView";
import { PulseHeader } from "./PulseHeader";
import { useSwarmMemory, type SwarmSample } from "./swarmRecorder";
import { TimelineView } from "./TimelineView";
import { TimeScrubber, useReplayDriver } from "./TimeScrubber";
import { buildLanes, eventInstants, laneRange, replayLanes } from "./timelineModel";
import "./deck.css";

/** From this body width the deck is a bridge: crew, stage and inspector side by side. */
export const DECK_BRIDGE_MIN = 880;
const SIDE_VIEWS: readonly DeckView[] = ["formation", "timeline", "orbit", "comms"];
const STAGE_VIEWS: readonly DeckStageView[] = ["orbit", "timeline", "comms"];
const VIEW_ICON: Record<DeckView, IconName> = { formation: "formation", timeline: "timeline", orbit: "orbit", comms: "message" };
const GROUPS: readonly DeckGroup[] = ["running", "waiting", "failed", "settled"];

export type DeckLinks = Omit<InspectorActions, "caps" | "run" | "busy" | "notice">;

/**
 * A deck hosted by a page that has its own inspector (the Agent Hub): the host
 * owns the selection, and the deck shows the whole swarm and picks members.
 */
export type DeckEmbedding = {
  selectedId: string | null;
  onSelect: (id: string) => void;
};

export function AgentDeck({ instanceKey, scope, agents, ready, source, visible, width, height, region, openedIds, links, commandContext, embedded, comms: hostComms }: {
  /** Panel instance + scope: what the user set up in this deck is remembered under it. */
  instanceKey: string;
  /** Recorder scope: target, workspace, parent session, preview. */
  scope: string;
  agents: readonly StudioAgentSnapshot[];
  ready: boolean;
  source: AgentRosterSource;
  visible: boolean;
  width: number;
  height: number;
  region: string;
  openedIds: readonly string[];
  links: DeckLinks;
  commandContext: DeckCommandContext;
  /** Set by a host page: selection is controlled and the deck renders no inspector of its own. */
  embedded?: DeckEmbedding;
  /** Agent messages a host page already reads (the Hub shares them with its Messages tab). */
  comms?: SwarmComms;
}) {
  const { preview, marks } = usePreviewMode();
  const { t, resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const d = useCallback((key: string, params?: Record<string, string | number>) => t(`agentDeck.${key}`, params), [t]);
  const [ui, update] = useDeckUi(instanceKey);
  const replay = ui.replay;
  const { settings, update: updateSettings } = useAppSettings();
  const [demoDensity, setDemoDensity] = useState<AgentRosterDensity>("standard");
  const density = preview ? demoDensity : settings.agentRosterDensity;
  const setDensity = (next: AgentRosterDensity) => preview ? setDemoDensity(next) : updateSettings({ agentRosterDensity: next });

  const liveRows = useMemo(() => buildDeck(agents, preview, zh), [agents, preview, zh]);
  const live = visible && (preview || source === "live");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  const memory = useSwarmMemory(scope, visible);
  const samples = useMemo<readonly SwarmSample[]>(() => preview
    ? Array.from({ length: 90 }, (_, index) => { const at = now - (89 - index) * 1000; return { at, tps: previewRate(at), running: 3 }; })
    : memory.samples, [preview, now, memory.version, memory.samples]);
  const lanes = useMemo(() => buildLanes(liveRows, memory, now, preview ? id => previewStageMarks(id, zh) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [liveRows, memory.version, now, preview, zh]);
  const range = useMemo(() => laneRange(lanes, now), [lanes, now]);
  const events = useMemo(() => eventInstants(lanes), [lanes]);
  const shownLanes = useMemo(() => replay === null ? lanes : replayLanes(lanes, replay, zh), [lanes, replay, zh]);
  const rows = useMemo(() => replay === null ? liveRows : shownLanes.map(lane => lane.row), [liveRows, shownLanes, replay]);
  const totals = useMemo(() => deckTotals(rows, replay !== null), [rows, replay]);
  const groups = useMemo(() => new Set(ui.groups), [ui.groups]);
  const filter = useMemo(() => filterDeck(rows, { query: ui.query, groups }), [rows, ui.query, groups]);
  const collapsed = useMemo(() => new Set(ui.collapsed), [ui.collapsed]);
  const rosterKey = useMemo(() => rosterKeyOf(agents), [agents]);
  const ownComms = useSwarmComms({ preview, zh, live, client: commandContext.client,
    sessionId: commandContext.viewingLive ? commandContext.sessionId : undefined, rosterKey, enabled: hostComms === undefined });
  const comms = hostComms ?? ownComms;
  // Preview is read here too: a demo deck must never reach the Host, whatever its caller passed.
  const commands = useDeckCommands({ ...commandContext, preview: commandContext.preview || preview,
    viewingLive: commandContext.viewingLive && replay === null }, zh);

  const rootRef = useRef<HTMLElement>(null);
  const [playing, setPlaying] = useState(false);
  const onReplay = useCallback((at: number | null) => update({ replay: at }), [update]);
  useReplayDriver({ playing, replay, range, speed: ui.speed, byEvent: ui.byEvent, events, anchor: rootRef, onReplay, onStop: () => setPlaying(false) });
  useEffect(() => { if (!visible) setPlaying(false); }, [visible]);

  const bridge = width >= DECK_BRIDGE_MIN && region !== "left";
  const short = bridge && height > 0 && height < 380;
  const narrow = width > 0 && width < 340;
  // A low sidebar section (the left column split with Explorer) keeps the ribbon and gives the metrics' row to the views.
  const low = !bridge && height > 0 && height < 420;
  const selectedId = embedded ? embedded.selectedId : ui.selected;
  const selected = rows.find(row => row.id === selectedId) ?? null;
  const sheetOpen = !embedded && visible && selected !== null && ui.sheet && (!bridge || short);
  const sheetRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (!sheetOpen || !sheet) return;
    const origin = sheet.ownerDocument.activeElement as HTMLElement | SVGElement | null;
    sheet.querySelector<HTMLElement>(".ad-ins-close")?.focus({ preventScroll: true });
    return () => { queueMicrotask(() => {
      if (origin?.isConnected && !origin.closest("[hidden], [inert]")) origin.focus({ preventScroll: true });
    }); };
  }, [sheetOpen]);

  const select = useCallback((id: string | null) => update({ selected: id, sheet: id !== null }), [update]);
  /** A bridge with its own inspector toggles on a second click; narrow tiers open the sheet; a host page just hears the pick. */
  const choose = (id: string, toggle = true) => {
    if (embedded) { embedded.onSelect(id); return; }
    if (bridge && !short) update({ selected: toggle && ui.selected === id ? null : id });
    else update({ selected: id, sheet: true });
  };
  const open = (row: DeckAgent) => row.main ? links.onMain() : links.onOpen(row);
  const actions: InspectorActions = { ...links, caps: commands.caps, run: commands.run, busy: commands.busy, notice: commands.notice };
  const toggleGroup = (group: DeckGroup) => update(current => {
    const next = current.groups.includes(group) ? current.groups.filter(item => item !== group) : [...current.groups, group];
    return { groups: next, lens: next.length > 0 || current.lens };
  });

  // Tab panes cross in the direction of travel along the strip.
  const order = bridge ? STAGE_VIEWS : SIDE_VIEWS;
  const current: DeckView = bridge ? ui.stage : ui.view;
  const previous = useRef(current);
  const direction = useRef<"fwd" | "back">("fwd");
  if (previous.current !== current) {
    direction.current = order.indexOf(current) >= order.indexOf(previous.current) ? "fwd" : "back";
    previous.current = current;
  }
  const setView = (view: DeckView) => bridge ? update({ stage: view as DeckStageView }) : update({ view });

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // A host page owns the selection, so Esc is left to it (closing its drawer, say).
    if (embedded || event.key !== "Escape" || event.defaultPrevented) return;
    if (ui.sheet && (!bridge || short) && ui.selected) { event.preventDefault(); update({ sheet: false }); return; }
    if (bridge && ui.selected) { event.preventDefault(); update({ selected: null }); }
  };

  if (liveRows.length === 0) {
    return <section className="ad ad-is-empty" ref={rootRef} aria-label={d("label")} data-region={region || undefined} data-embedded={embedded ? "" : undefined}>
      <div className="ad-empty">
        <div className="ad-empty-art" aria-hidden="true">{[0, 1, 2].map(index => <span key={index} />)}</div>
        <h3>{ready ? d("empty.none") : d("empty.loading")}</h3>
        {ready ? <p>{d("empty.noneDetail")}</p> : null}
      </div>
    </section>;
  }

  const lens = <div className="ad-lens" data-inline={bridge || undefined}>
    <label className="ad-search">
      <Icon name="search" extra="sm" />
      <input type="search" value={ui.query} placeholder={d("search")} aria-label={d("search")} spellCheck={false}
        onChange={event => update({ query: event.target.value })}
        onKeyDown={event => { if (event.key === "Escape" && ui.query) { event.preventDefault(); update({ query: "" }); } }} />
    </label>
    <div className="ad-chips" role="group" aria-label={d("ribbonLabel")}>
      {GROUPS.map(group => <button key={group} type="button" className="ad-chip" data-group={group} aria-pressed={groups.has(group)} onClick={() => toggleGroup(group)}>
        <i aria-hidden="true" />{d(`groups.${group}`)}<span>{totals.groups[group]}</span>
      </button>)}
      {ui.groups.length || ui.query ? <button type="button" className="ad-link" onClick={() => update({ groups: [], query: "" })}>{d("clearFilter")}</button> : null}
    </div>
  </div>;

  const formationHead = <div className="ad-pane-head">
    <span className="ad-pane-title">{d("views.formation")}<em>{filter.matched.size}/{rows.length}</em></span>
    <span className="seg ad-seg" role="group" aria-label={d("groupingLabel")}>
      <button type="button" className={ui.grouping === "tree" ? "active" : undefined} aria-pressed={ui.grouping === "tree"} data-tip={d("grouping.tree")} aria-label={d("grouping.tree")} onClick={() => update({ grouping: "tree" })}><Icon name="formation" extra="sm" /></button>
      <button type="button" className={ui.grouping === "status" ? "active" : undefined} aria-pressed={ui.grouping === "status"} data-tip={d("grouping.status")} aria-label={d("grouping.status")} onClick={() => update({ grouping: "status" })}><Icon name="layers" extra="sm" /></button>
    </span>
    <span className="seg ad-seg" role="group" aria-label={d("densityLabel")}>
      <button type="button" className={density === "standard" ? "active" : undefined} aria-pressed={density === "standard"} data-tip={d("density.standard")} aria-label={d("density.standard")} onClick={() => setDensity("standard")}><Icon name="rows" extra="sm" /></button>
      <button type="button" className={density === "minimal" ? "active" : undefined} aria-pressed={density === "minimal"} data-tip={d("density.minimal")} aria-label={d("density.minimal")} onClick={() => setDensity("minimal")}><Icon name="menu" extra="sm" /></button>
    </span>
  </div>;

  const formation = <FormationView rows={rows} visible={filter.visible} matched={filter.matched} selectedId={selectedId} openedIds={openedIds}
    grouping={ui.grouping} collapsed={collapsed} filtering={ui.query.trim() !== "" || ui.groups.length > 0}
    density={short ? "minimal" : density} compact={short} now={replay ?? now} query={ui.query}
    onSelect={id => choose(id)} onOpen={open} d={d}
    onToggle={id => update(state => ({ collapsed: state.collapsed.includes(id) ? state.collapsed.filter(item => item !== id) : [...state.collapsed, id] }))} />;

  const scrubber = (compact: boolean) => <TimeScrubber range={range} replay={replay} playing={playing} speed={ui.speed} byEvent={ui.byEvent} events={events}
    onReplay={onReplay} onPlaying={setPlaying} onSpeed={speed => update({ speed })} onByEvent={byEvent => update({ byEvent })} d={d} compact={compact} />;

  const stageView = (view: DeckView) => {
    if (view === "formation") return <div className="ad-pane-fill">{formationHead}{formation}</div>;
    if (view === "timeline") return <div className="ad-pane-fill">
      <TimelineView lanes={shownLanes.filter(lane => filter.visible.has(lane.row.id))} range={range} now={now} replay={replay} ui={ui.timeline}
        onTimeline={patch => update(state => ({ timeline: { ...state.timeline, ...patch } }))} selectedId={selectedId} matched={filter.matched}
        onSelect={id => choose(id)} onOpen={open}
        onScrub={at => { setPlaying(false); onReplay(at); }} labelWidth={narrow ? 104 : bridge ? 168 : 132} d={d} />
      {bridge ? null : scrubber(true)}
    </div>;
    if (view === "orbit") return <div className="ad-pane-fill">
      <OrbitView rows={rows} lanes={shownLanes} replay={replay} comms={comms} selectedId={selectedId} matched={filter.matched} ui={ui.orbit}
        onOrbit={patch => update(state => ({ orbit: { ...state.orbit, ...patch } }))}
        onSelect={id => choose(id)} onOpen={open} d={d} />
      {bridge ? null : scrubber(true)}
    </div>;
    return <CommsView comms={comms} rows={rows} now={replay ?? now} replay={replay} query={ui.query} selectedId={selectedId}
      onSelect={id => choose(id, false)} d={d} />;
  };

  const tabs = <div className="ad-tabs" role="tablist" aria-label={d("viewsLabel")}>
    {order.map(view => {
      const count = view === "formation" ? rows.length : view === "comms" && comms.status === "ready" ? comms.messages.length : undefined;
      return <button key={view} type="button" role="tab" className="ad-tab" aria-selected={current === view} aria-controls={`${instanceKey}-pane`}
        data-tip={narrow ? d(`views.${view}`) : undefined} aria-label={d(`views.${view}`)}
        onClick={() => setView(view)}>
        <Icon name={VIEW_ICON[view]} extra="sm" /><span className="ad-tab-label">{d(`views.${view}`)}</span>
        {count !== undefined ? <em>{count}</em> : view === "comms" && comms.status !== "ready" ? <span className="ad-tab-pending" aria-hidden="true" /> : null}
      </button>;
    })}
  </div>;

  const sheet = selected && sheetOpen
    ? <div ref={sheetRef} className={`ad-sheet${short ? " is-side" : ""}`} role="dialog" aria-label={selected.name} tabIndex={-1}
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
        const index = items.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLElement);
        if (event.shiftKey && index <= 0) { event.preventDefault(); (items.at(-1) ?? event.currentTarget).focus(); }
        else if (!event.shiftKey && (index < 0 || index === items.length - 1)) { event.preventDefault(); (items[0] ?? event.currentTarget).focus(); }
      }}>
      <AgentInspector row={selected} rows={rows} lane={shownLanes.find(lane => lane.row.id === selected.id)} now={replay ?? now} actions={actions}
        onSelect={id => update({ selected: id, sheet: id !== null })} onClose={() => update({ sheet: false })} d={d} />
    </div> : null;

  const paneClass = `ad-pane tab-pane-enter-${direction.current}`;
  return <section ref={rootRef} className="ad" data-tier={bridge ? "bridge" : "side"} data-embedded={embedded ? "" : undefined} data-short={short || undefined} data-narrow={narrow || undefined} data-low={low || undefined}
    data-region={region || undefined} data-live={live || undefined} data-replay={replay !== null || undefined} aria-label={d("label")} onKeyDown={onKeyDown}>
    <PulseHeader totals={totals} samples={samples} source={source} preview={preview} marks={marks} now={now} replayAt={replay}
      groups={groups} onGroup={toggleGroup} d={d} compact={narrow || short || low} />
    {bridge
      ? <div className="ad-bridge">
        <aside className="ad-crew" aria-label={d("views.formation")}>
          {formationHead}
          {lens}
          <div className="ad-crew-list">{formation}</div>
        </aside>
        <div className="ad-stage">
          <div className="ad-pane-fill" inert={sheetOpen} aria-hidden={sheetOpen || undefined}>
            <div className="ad-bar">{tabs}</div>
            <div className={paneClass} key={current} id={`${instanceKey}-pane`} role="tabpanel">{stageView(current)}</div>
            {current !== "comms" ? scrubber(short) : null}
          </div>
          {sheet}
        </div>
        {short || embedded ? null : <aside className="ad-side" aria-label={selected ? selected.name : d("summary.title")}>
          <div className="ad-side-body" key={selected?.id ?? "summary"}>
            {selected
              ? <AgentInspector row={selected} rows={rows} lane={shownLanes.find(lane => lane.row.id === selected.id)} now={replay ?? now} actions={actions} onSelect={select} d={d} />
              : <SwarmSummary rows={rows} totals={totals} lanes={shownLanes} range={replay === null ? range : { ...range, end: replay }} now={replay ?? now} onSelect={id => update({ selected: id })} d={d} />}
          </div>
        </aside>}
      </div>
      : <>
        <div className="ad-bar">
          {tabs}
          <button type="button" className="icon-btn small ad-lens-toggle" aria-expanded={ui.lens} aria-label={d("searchToggle")} data-tip={d("searchToggle")}
            data-active={ui.query !== "" || ui.groups.length > 0 || undefined} onClick={() => update({ lens: !ui.lens })}><Icon name="search" extra="sm" /></button>
        </div>
        {ui.lens ? lens : null}
        <div className="ad-body">
          <div className={paneClass} key={current} id={`${instanceKey}-pane`} role="tabpanel" inert={sheetOpen} aria-hidden={sheetOpen || undefined}>{stageView(current)}</div>
          {sheet}
        </div>
      </>}
  </section>;
}
