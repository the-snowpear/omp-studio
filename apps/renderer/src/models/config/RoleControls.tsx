import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  onChange,
}: {
  value: string;
  groups: ReadonlyArray<ModelPickGroup>;
  disabled?: boolean;
  ariaLabel?: string;
  onChange: (selector: string) => void;
}) {
  const uid = useId();
  const listId = `${uid}-list`;
  const { t } = useI18n();
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, left: 0, width: 300 });
  const [active, setActive] = useState(value);
  const activeRef = useRef(active);
  const onChangeRef = useRef(onChange);
  activeRef.current = active;
  onChangeRef.current = onChange;
  const flat = useMemo(() => flattenModelGroups(groups, value), [groups, value]);
  const selected = flat.find((item) => item.selector === value);
  const selectedGroup = groups.find((group) => group.models.some((item) => item.selector === value));

  const place = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(rect.width, 380);
    const height = popRef.current?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    let top = rect.bottom + 4;
    if (height > 0 && top + height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - height - 4);
    }
    setAnchor({ top, left, width });
  };

  const dismiss = () => setOpen(false);

  const pick = (selector: string) => {
    onChangeRef.current(selector);
    dismiss();
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, groups.length, flat.length]);

  useLayoutEffect(() => {
    if (!open) return;
    const node = popRef.current?.querySelector<HTMLElement>("[data-active='true']");
    node?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    setActive(value);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
        btnRef.current?.focus();
        return;
      }
      const currentActive = activeRef.current;
      const index = Math.max(0, flat.findIndex((item) => item.selector === currentActive));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (flat.length === 0) return;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next = flat[(index + delta + flat.length) % flat.length];
        if (next) setActive(next.selector);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        const first = flat[0];
        if (first) setActive(first.selector);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        const last = flat[flat.length - 1];
        if (last) setActive(last.selector);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const current = flat.find((item) => item.selector === currentActive) ?? flat[index];
        if (current) pick(current.selector);
      }
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      dismiss();
    };
    const onReposition = () => place();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, flat, value]);

  const label = selected?.name || value || t("modelConfig.selectModel");
  const missing = Boolean(value) && !selectedGroup;

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
        data-tip={value || undefined}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (open && event.detail === 0) return;
          if (open) {
            dismiss();
            return;
          }
          setActive(value);
          setOpen(true);
        }}
      >
        <span className="rms-brand" aria-hidden="true">
          <ProviderGlyph id={selectedGroup?.providerId || selected?.provider || ""} local={selectedGroup?.local ?? false} />
        </span>
        <span className="rms-copy">
          <span className="rms-name">{label}</span>
        </span>
        <Icon name={open ? "chevron-u" : "chevron-d"} extra="sm" />
      </button>
      {open
        ? createPortal(
            <div
              ref={popRef}
              id={listId}
              className="menu rms-pop"
              role="listbox"
              aria-label={t("modelConfig.pickByProvider")}
              style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              {flat.length === 0 ? (
                <div className="rms-empty">{t("modelConfig.noAvailableModels")}</div>
              ) : (
                <>
                  {missing ? (
                    <button
                      type="button"
                      role="option"
                      aria-selected={value === active}
                      data-active={active === value ? "true" : undefined}
                      className={`menu-item rms-option is-missing${active === value ? " is-active" : ""}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => pick(value)}
                    >
                      <span className="rms-option-copy">
                        <b>{value}</b>
                        <span>{t("modelConfig.currentNotInList")}</span>
                      </span>
                    </button>
                  ) : null}
                  {groups.map((group) => (
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
                        const isActive = model.selector === active;
                        return (
                          <button
                            type="button"
                            key={model.selector}
                            role="option"
                            aria-selected={on}
                            data-active={isActive ? "true" : undefined}
                            className={`menu-item rms-option${on ? " is-on" : ""}${isActive ? " is-active" : ""}`}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => pick(model.selector)}
                          >
                            <span className="rms-option-copy">
                              <b>{model.name}</b>
                              {model.id !== model.name ? <span>{model.id}</span> : null}
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
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
