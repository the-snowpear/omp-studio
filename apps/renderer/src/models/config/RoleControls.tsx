import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { AvailableModelRecord, ModelRoleRecord } from "@omp-studio/client-contract";
import { Icon } from "../../icons";
import { useI18n } from "../../i18n";
import { ModelPickCaps, ProviderGlyph, ROLE_ICONS, type ModelPickItem, type ModelPickGroup } from "../modelPresentation";
import { assignedRoleIds, roleAssignDiff, roleThinkingUi } from "./drafts";
import { type ModelRoleDraft } from "./types";

function flattenModelGroups(
  groups: ReadonlyArray<ModelPickGroup>,
  orphan?: string,
): ModelPickItem[] {
  const items = groups.flatMap((group) => group.models);
  if (orphan && !items.some((item) => item.selector === orphan)) {
    return [{ provider: "", id: orphan, selector: orphan, name: orphan, reasoning: false, image: false, tools: false }, ...items];
  }
  return items;
}

export function thinkingMenuAnchor(btn: HTMLElement, menu?: HTMLElement | null): { top: number; left: number; width: number } {
  const rect = btn.getBoundingClientRect();
  const width = Math.max(rect.width, menu?.offsetWidth ?? 0);
  const height = menu?.offsetHeight ?? 220;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  let top = rect.bottom + 4;
  if (top + height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - height - 4);
  }
  return { top, left, width };
}

export function RoleThinkingSeg({
  role,
  model,
  onChange,
}: {
  role: ModelRoleRecord;
  model: AvailableModelRecord | undefined;
  onChange: (next: ModelRoleRecord) => void;
}) {
  const thinking = roleThinkingUi(role, model);
  const { t } = useI18n();
  return (
    <>
    <span className={`seg${thinking.disabled ? " is-disabled" : ""}`} role="tablist">
      <button type="button" className={thinking.value === "" ? "active" : undefined} onClick={() => { const { thinking: _old, ...rest } = role; onChange(rest); }}>{t("modelAdaptation.defaultThinking")}</button>
      {thinking.items.map((item) => (
        <button type="button" key={item.id} className={thinking.value === item.id ? "active" : undefined} disabled={thinking.disabled} onClick={() => {
          const { thinkingAdjustment: _mapping, ...next } = role as ModelRoleDraft;
          next.thinking = item.id;
          onChange(next);
        }}>{item.label}</button>
      ))}
    </span>
    {(role as ModelRoleDraft).thinkingAdjustment ? <small className="mc-thinking-adjustment">{(role as ModelRoleDraft).thinkingAdjustment}</small> : null}
    {model?.thinkingConfig?.requiresEffort ? <small className="mc-thinking-adjustment">{t("modelAdaptation.required")}</small> : null}
    </>
  );
}

export function RoleAssignControl({
  selector,
  open,
  roles,
  disabled,
  modCount,
  showSave,
  initialPicked,
  onToggle,
  onDraftChange,
  onCommit,
  onError,
}: {
  selector: string;
  open: boolean;
  roles: ReadonlyArray<ModelRoleRecord>;
  disabled?: boolean;
  modCount: number;
  showSave: boolean;
  initialPicked?: ReadonlyArray<string>;
  onToggle: (selector: string | null) => void;
  onDraftChange?: (selector: string, picked: string[]) => void;
  onCommit?: (selector: string, addedIds: string[], removedIds: string[]) => void;
  onError: (message: string) => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });
  const { t } = useI18n();
  const [picked, setPicked] = useState<string[]>([]);
  const baselineRef = useRef<string[]>([]);
  const pickedRef = useRef<string[]>([]);
  const rolesRef = useRef(roles);
  const errorRef = useRef(onError);
  const commitRef = useRef(onCommit);
  const draftRef = useRef(onDraftChange);
  const initialRef = useRef(initialPicked);
  pickedRef.current = picked;
  rolesRef.current = roles;
  errorRef.current = onError;
  commitRef.current = onCommit;
  draftRef.current = onDraftChange;
  initialRef.current = initialPicked;

  const trySave = () => {
    const { added, removed } = roleAssignDiff(pickedRef.current, baselineRef.current);
    commitRef.current?.(selector, added, removed);
    onToggle(null);
  };

  const dismiss = () => onToggle(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const width = popRef.current?.offsetWidth ?? 280;
    const height = popRef.current?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    let top = rect.bottom + 4;
    if (height > 0 && top + height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - height - 4);
    }
    setAnchor({ top, left });
  }, [open, picked.length, roles.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      dismiss();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, onToggle]);

  useEffect(() => {
    if (!open || showSave) return;
    draftRef.current?.(selector, picked);
  }, [open, showSave, selector, picked]);

  const baseline = new Set(baselineRef.current);
  const { added, removed } = roleAssignDiff(picked, baselineRef.current);
  const changeCount = added.length + removed.length;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`icon-btn small role-assign-btn${open ? " is-open" : ""}`}
        data-tip={t("modelConfig.tabRoles")}
        aria-label={t("modelConfig.selectRoles")}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (open) {
            dismiss();
            return;
          }
          const nextBaseline = assignedRoleIds(rolesRef.current, selector);
          baselineRef.current = nextBaseline;
          setPicked(initialRef.current ? [...initialRef.current] : nextBaseline);
          if (btnRef.current) {
            const rect = btnRef.current.getBoundingClientRect();
            const left = Math.max(8, Math.min(rect.right - 280, window.innerWidth - 288));
            setAnchor({ top: rect.bottom + 4, left });
          }
          onToggle(selector);
        }}
      >
        <Icon name="user" extra="sm" />
        {modCount > 0 ? <span className="role-assign-badge">{modCount > 99 ? "99+" : modCount}</span> : null}
      </button>
      {open
        ? createPortal(
            <div
              ref={popRef}
              className="menu role-assign-pop"
              role="listbox"
              aria-multiselectable="true"
              aria-label={t("modelConfig.selectRoles")}
              style={{ top: anchor.top, left: anchor.left }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="rap-head">
                <b>{t("modelConfig.selectRoles")}</b>
                <span className="mono">{selector}</span>
              </div>
              {roles.length === 0 ? (
                <div className="rap-empty">{t("modelConfig.noRoles")}</div>
              ) : (
                <div className="rap-list">
                  {roles.map((role) => {
                    const on = picked.includes(role.id);
                    const wasCurrent = baseline.has(role.id);
                    return (
                      <button
                        type="button"
                        key={role.id}
                        className={`menu-item pick-role${on ? " is-on" : ""}`}
                        role="option"
                        aria-selected={on}
                        onClick={() => {
                          setPicked((currentIds) => (
                            currentIds.includes(role.id)
                              ? currentIds.filter((id) => id !== role.id)
                              : [...currentIds, role.id]
                          ));
                        }}
                      >
                        <span className={`pick-check${on ? " on" : ""}`} aria-hidden="true">
                          {on ? <Icon name="check" extra="sm" /> : null}
                        </span>
                        <Icon name={ROLE_ICONS[role.id] ?? "cpu"} extra="sm" />
                        <span className="pick-copy">
                          <b>{role.name}</b>
                          <span className="mono muted small">{role.alias}</span>
                        </span>
                        <span className="hint ellipsis">
                          {on
                            ? (wasCurrent ? t("modelConfig.current") : (role.primary || t("modelConfig.unassigned")))
                            : (wasCurrent ? t("modelConfig.willCancel") : (role.primary || t("modelConfig.unassigned")))}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {showSave || changeCount > 0 ? (
                <div className="rap-foot">
                  <span>{changeCount > 0 ? t("modelConfig.roleChangeCount", { count: changeCount }) : t("modelConfig.noChanges")}</span>
                  {showSave ? <button type="button" className="btn small primary" onClick={trySave}>{t("common.save")}</button> : <span className="rap-hint">{t("modelConfig.savedOnProviderSave")}</span>}
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function RoleModelPicker({
  value,
  groups,
  disabled,
  ariaLabel,
  unavailableReason,
  allowClear = false,
  onChange,
}: {
  value: string;
  groups: ReadonlyArray<ModelPickGroup>;
  disabled?: boolean;
  ariaLabel?: string;
  unavailableReason?: string | undefined;
  allowClear?: boolean;
  onChange: (selector: string) => void;
}) {
  const uid = useId();
  const listId = `${uid}-list`;
  const { t } = useI18n();
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [anchor, setAnchor] = useState({ top: 0, left: 0, width: 300 });
  const [active, setActive] = useState(value);
  const all = useMemo(() => flattenModelGroups(groups, value), [groups, value]);
  const selected = all.find((item) => item.selector === value);
  const selectedGroup = groups.find((group) => group.models.some((item) => item.selector === value));
  const missing = Boolean(value) && (!selectedGroup || Boolean(unavailableReason));
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filteredGroups = groups.map(group => ({
    ...group,
    models: group.models.filter(model => terms.every(term => `${group.providerName} ${group.providerId} ${model.name} ${model.id}`.toLocaleLowerCase().includes(term))),
  })).filter(group => group.models.length > 0);
  const showOrphan = Boolean(value) && !selectedGroup && terms.every(term => value.toLocaleLowerCase().includes(term));
  const showAuto = allowClear && terms.length === 0;
  const flat = flattenModelGroups(filteredGroups, showOrphan ? value : undefined);
  if (showAuto) flat.unshift({ provider: "", id: "", selector: "", name: t("modelConfig.autoModel"), reasoning: false, image: false, tools: false });
  const activeItem = flat.find(item => item.selector === active) ?? flat[0];
  const optionId = (selector: string) => `${uid}-option-${flat.findIndex(item => item.selector === selector)}`;

  const place = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(Math.max(rect.width, 440), window.innerWidth - 16);
    const height = popRef.current?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    let top = rect.bottom + 4;
    if (height > 0 && top + height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - height - 4);
    }
    setAnchor({ top, left, width });
  };

  const dismiss = (restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) btnRef.current?.focus();
  };

  const pick = (selector: string) => {
    if (selector !== value) onChange(selector);
    dismiss(true);
  };

  const expand = () => {
    setQuery("");
    setActive(value);
    setOpen(true);
  };

  const onKey = (event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    const typing = event.target === searchRef.current;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) { expand(); return; }
      const index = flat.findIndex(item => item.selector === activeItem?.selector);
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = flat[(index + delta + flat.length) % flat.length];
      if (next) setActive(next.selector);
    } else if (open && !typing && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      const next = event.key === "Home" ? flat[0] : flat[flat.length - 1];
      if (next) setActive(next.selector);
    } else if (open && (event.key === "Enter" || (!typing && event.key === " "))) {
      event.preventDefault();
      if (activeItem) pick(activeItem.selector);
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, groups.length, flat.length]);

  useLayoutEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const node = popRef.current?.querySelector<HTMLElement>("[data-active='true']");
    node?.scrollIntoView({ block: "nearest" });
  }, [open, activeItem?.selector]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      dismiss();
    };
    const onReposition = (event: Event) => {
      if (event.target instanceof Node && popRef.current?.contains(event.target)) return;
      place();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open]);

  useEffect(() => { if (disabled) dismiss(); }, [disabled]);

  const label = selected?.name || value || t(allowClear ? "modelConfig.autoModel" : "modelConfig.selectModel");

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`rms-trigger${open ? " is-open" : ""}${missing ? " is-missing" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel ?? t("modelConfig.primaryModel")}
        data-tip={unavailableReason || value || undefined}
        onKeyDown={onKey}
        onClick={(event) => {
          event.stopPropagation();
          if (open) {
            dismiss();
            return;
          }
          expand();
        }}
      >
        <span className="rms-brand" aria-hidden="true">
          {allowClear && !value ? <Icon name="sparkles" extra="sm" /> : <ProviderGlyph id={selectedGroup?.providerId || selected?.provider || value.split("/")[0] || ""} local={selectedGroup?.local ?? false} />}
        </span>
        {missing ? <span className="rms-unavailable"><Icon name="alert" extra="sm" />{t("common.unavailable")}</span> : null}
        <span className="rms-copy">
          <span className="rms-name">{label}</span>
        </span>
        <Icon name={open ? "chevron-u" : "chevron-d"} extra="sm" />
      </button>
      {open
        ? createPortal(
            <div
              ref={popRef}
              className="menu rms-pop rms-picker-pop"
              style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
              onKeyDown={onKey}
            >
              <div className="rms-search">
                <Icon name="search" extra="sm" />
                <input ref={searchRef} value={query} onChange={event => { setQuery(event.target.value); setActive(""); }} placeholder={t("modelConfig.searchModels")} aria-label={t("modelConfig.searchModels")} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeItem ? optionId(activeItem.selector) : undefined} />
              </div>
              <div id={listId} className="rms-scroll" role="listbox" aria-label={t("modelConfig.pickByProvider")}>
              {showAuto ? <button type="button" id={optionId("")} role="option" aria-selected={!value} data-active={activeItem?.selector === "" ? "true" : undefined} className={`menu-item rms-option rms-option-auto${!value ? " is-on" : ""}${activeItem?.selector === "" ? " is-active" : ""}`} onFocus={() => setActive("")} onMouseDown={event => event.preventDefault()} onClick={() => pick("")}><Icon name="sparkles" extra="sm" /><span className="rms-option-copy"><b>{t("modelConfig.autoModel")}</b><span>{t("modelConfig.autoModelDesc")}</span></span>{!value ? <Icon name="check" extra="sm" /> : null}</button> : null}
              {flat.length === 0 ? (
                <div className="rms-empty">{t(query ? "modelConfig.noModelMatches" : "modelConfig.noAvailableModels")}</div>
              ) : (
                <>
                  {showOrphan ? (
                    <button
                      type="button"
                      id={optionId(value)}
                      role="option"
                      aria-selected="true"
                      data-active={activeItem?.selector === value ? "true" : undefined}
                      className={`menu-item rms-option is-missing${activeItem?.selector === value ? " is-active" : ""}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onFocus={() => setActive(value)}
                      onClick={() => pick(value)}
                    >
                      <span className="rms-option-copy">
                        <b>{value}</b>
                        <span>{unavailableReason || t("modelConfig.currentNotInList")}</span>
                      </span>
                      <span className="rms-unavailable">{t("common.unavailable")}</span>
                    </button>
                  ) : null}
                  {filteredGroups.map((group) => (
                    <div className="rms-group" key={group.providerId} role="group" aria-label={group.providerName}>
                      <div className="rms-group-label">
                        <span className="rms-brand" aria-hidden="true">
                          <ProviderGlyph id={group.providerId} local={group.local} />
                        </span>
                        <span className="rms-group-name">{group.providerName}</span>
                        <span className="rms-group-count">{group.models.length}</span>
                      </div>
                      {group.models.map((model) => {
                        const on = model.selector === value;
                        const isActive = model.selector === activeItem?.selector;
                        return (
                          <button
                            type="button"
                            key={model.selector}
                            id={optionId(model.selector)}
                            role="option"
                            aria-selected={on}
                            data-active={isActive ? "true" : undefined}
                            className={`menu-item rms-option${on ? " is-on" : ""}${isActive ? " is-active" : ""}${on && missing ? " is-missing" : ""}`}
                            onMouseDown={(event) => event.preventDefault()}
                            onFocus={() => setActive(model.selector)}
                            onClick={() => pick(model.selector)}
                          >
                            <span className="rms-option-copy">
                              <b>{model.name}</b>
                              {on && unavailableReason ? <span>{unavailableReason}</span> : model.id !== model.name ? <span>{model.id}</span> : null}
                            </span>
                            <ModelPickCaps model={model} />
                            {on ? <Icon name="check" extra="sm" /> : null}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </>
              )}
              </div>
              <div className="rms-foot"><span>{t("modelConfig.modelMatchCount", { count: filteredGroups.reduce((count, group) => count + group.models.length, 0) })}</span><span>↑ ↓ <kbd>Enter</kbd></span></div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
