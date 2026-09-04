/**
 * Composer 右下角的「选择模型」「思考强度」pill 与弹出菜单。
 *
 * 模型菜单第一层列出已设置模型的角色；底部「更多模型」悬停展开第二层
 * 弹窗（复用角色卡片 RoleModelPicker 的 .rms-pop 分组样式，紧凑版），
 * 底边与主菜单对齐，默认在右侧展开、右侧放不下才翻到左侧。
 * 思考强度按当前模型能力（roleThinkingControl）过滤档位。
 *
 * 数据：预览开 = modelConfigFixtures 演示数据 + 纯本地选择；预览关 = models.get
 * 提供目录，pill 显示的当前值只来自 snapshot.model（Runtime 真值），切换走
 * session.model.set / session.thinking.set，不做乐观填值。流式期间也可以换模型，
 * Runtime 把选择记到下一轮用户对话，当前请求和自动重试仍用原模型。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  CommandInput,
  CommandName,
  ModelConfigReadModel,
  ModelRoleRecord,
  SessionThinkingSelector,
  StudioClient,
} from "@omp-studio/client-contract";
import { SESSION_THINKING_SELECTORS, clampRoleThinking, roleThinkingControl } from "@omp-studio/client-contract";
import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";

import { Icon } from "./icons";
import { useI18n } from "./i18n";
import { hostErrorMessage } from "./hostError";
import { MODEL_THINKING, createPreviewModelConfig } from "./preview/modelConfigFixtures";
import { ModelPickCaps, ProviderGlyph, ROLE_ICONS, ROLE_TINTS, groupModelsByProvider } from "./ModelConfigPage";

type MenuKind = "none" | "model" | "thinking";

interface ComposerPick {
  readonly roleId: string | null;
  readonly selector: string;
  readonly thinking?: string;
}

const FLYOUT_CLOSE_GRACE_MS = 200;
const FLYOUT_WIDTH = 300;

/** exactOptionalPropertyTypes：thinking 为空时不能显式携带 undefined 键。 */
function pickWith(roleId: string | null, selector: string, thinking: string | undefined): ComposerPick {
  return thinking === undefined ? { roleId, selector } : { roleId, selector, thinking };
}

/** Runtime 的 model 投影 → pill 选择；roleId 由目录反查（同 selector + 同档位）。 */
function snapshotPick(
  snapshot: OperatorStateSnapshot | undefined,
  roles: ReadonlyArray<ModelRoleRecord>,
): ComposerPick | null {
  const model = snapshot?.model;
  if (!model) return null;
  const level = model.configuredThinking ?? model.thinking;
  const thinking = level === undefined || level === "off" ? undefined : level;
  const role = roles.find(
    (item) => item.primary === model.selector && (item.thinking ?? undefined) === thinking,
  ) ?? roles.find((item) => item.primary === model.selector);
  return pickWith(role?.id ?? null, model.selector, thinking);
}

/** 会话级思考档位只接受 contract 里的字面量；`off` 也是合法档位。 */
function asThinkingSelector(value: string | undefined): SessionThinkingSelector | undefined {
  if (value === undefined) return undefined;
  return SESSION_THINKING_SELECTORS.includes(value as SessionThinkingSelector)
    ? (value as SessionThinkingSelector)
    : undefined;
}

function modelShortName(selector: string): string {
  const tail = selector.split("/").pop() ?? selector;
  return tail.split(":")[0] || selector;
}

function labelInitial(label: string): string {
  return Array.from(label.trim())[0]?.toLocaleUpperCase() ?? "—";
}

/** Composer / 子代理编辑共用的模型菜单（角色列表 + 「更多模型」飞出层）。 */
export function ComposerModelMenu({
  data,
  loading,
  loadError,
  preview,
  disabled,
  placement = "up",
  note,
  header,
  inheritOption,
  isRoleSelected,
  isModelSelected,
  onChooseRole,
  onChooseModel,
  onClose,
}: {
  data: ModelConfigReadModel | null;
  loading: boolean;
  loadError: string | null;
  preview: boolean;
  disabled?: boolean;
  placement?: "up" | "down";
  note?: ReactNode;
  /** 渲染在角色列表上方的模式切换行（如 Task 子代理模式）；不传则不渲染。 */
  header?: ReactNode;
  /** 列表首位的「继承」选项；不传则不渲染（SubagentsPanel 等复用方不受影响）。 */
  inheritOption?: {
    label: string;
    selected: boolean;
    onChoose: () => void;
  };
  isRoleSelected: (role: ModelRoleRecord) => boolean;
  isModelSelected: (selector: string) => boolean;
  onChooseRole: (role: ModelRoleRecord) => void;
  onChooseModel: (selector: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [moreOpen, setMoreOpen] = useState(false);
  const [flyoutSide, setFlyoutSide] = useState<"right" | "left">("right");
  const flyoutTimer = useRef<number | undefined>(undefined);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => window.clearTimeout(flyoutTimer.current), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const bySelector = useMemo(
    () => new Map((data?.availableModels ?? []).map((model) => [model.selector, model])),
    [data],
  );
  const rolesWithModel = useMemo(
    () => (data?.roles ?? []).filter(
      (role) => Boolean(role.primary) && !role.issue && bySelector.has(role.primary),
    ),
    [data, bySelector],
  );
  const groups = useMemo(
    () => (data ? groupModelsByProvider(data.availableModels, data.providers) : []),
    [data],
  );

  const scheduleFlyoutClose = () => {
    window.clearTimeout(flyoutTimer.current);
    flyoutTimer.current = window.setTimeout(() => setMoreOpen(false), FLYOUT_CLOSE_GRACE_MS);
  };
  const keepFlyoutOpen = () => {
    window.clearTimeout(flyoutTimer.current);
    setMoreOpen(true);
  };

  useLayoutEffect(() => {
    if (!moreOpen) return;
    const rect = menuRef.current?.getBoundingClientRect();
    if (!rect) return;
    setFlyoutSide(rect.right + 8 + FLYOUT_WIDTH <= window.innerWidth - 8 ? "right" : "left");
  }, [moreOpen]);

  return (
    <>
      <div className="approval-menu-backdrop" onClick={onClose} />
      <div
        className={`cmp-menu${placement === "down" ? " cmp-menu-down" : ""}`}
        role="menu"
        aria-label={t("composer.selectModel")}
        ref={menuRef}
      >
        {header ? <div className="cmp-menu-header">{header}</div> : null}
        <div className="cmp-roles">
          {inheritOption ? (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={inheritOption.selected}
              className={`cmp-role cmp-role-inherit${inheritOption.selected ? " selected" : ""}`}
              disabled={disabled}
              onClick={() => inheritOption.onChoose()}
            >
              <span className="cmp-role-ic" data-tint="gray" aria-hidden="true">
                <Icon name="link" extra="sm" />
              </span>
              <span className="cmp-role-copy">
                <b>{inheritOption.label}</b>
              </span>
              {inheritOption.selected ? <Icon name="check" extra="sm" /> : null}
            </button>
          ) : null}
          {loading && !data ? (
            <div className="cmp-empty">{t("composer.loadingModels")}</div>
          ) : loadError && rolesWithModel.length === 0 ? (
            <div className="cmp-empty cmp-error">{loadError}</div>
          ) : rolesWithModel.length === 0 ? (
            <div className="cmp-empty">{t("composer.noRoleWithModel")}</div>
          ) : (
            rolesWithModel.map((role) => {
              const on = isRoleSelected(role);
              const modelName = bySelector.get(role.primary)?.name ?? modelShortName(role.primary);
              const think = role.thinking && role.thinking !== "off"
                ? MODEL_THINKING.find((item) => item.id === role.thinking)?.label ?? role.thinking
                : null;
              return (
                <button
                  type="button"
                  key={role.id}
                  role="menuitemradio"
                  aria-checked={on}
                  className={`cmp-role${on ? " selected" : ""}`}
                  disabled={disabled}
                  onClick={() => onChooseRole(role)}
                >
                  <span className="cmp-role-ic" data-tint={ROLE_TINTS[role.id] ?? "purple"} aria-hidden="true">
                    <Icon name={ROLE_ICONS[role.id] ?? "cpu"} extra="sm" />
                  </span>
                  <span className="cmp-role-copy">
                    <b>
                      {role.name}
                      <span className="cmp-role-alias">{role.alias}</span>
                    </b>
                    <span>
                      {modelName}
                      {think ? ` · ${think}` : ""}
                    </span>
                  </span>
                  {on ? <Icon name="check" extra="sm" /> : null}
                </button>
              );
            })
          )}
        </div>
        <div className="cmp-menu-sep" />
        <span
          className={`cmp-more-zone${moreOpen ? " is-open" : ""}`}
          onMouseEnter={keepFlyoutOpen}
          onMouseLeave={scheduleFlyoutClose}
        >
          <button
            type="button"
            className="cmp-more"
            aria-haspopup="listbox"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <Icon name="more" extra="sm" />
            <span>{t("composer.moreModels")}</span>
            <span className="spacer" />
            <Icon name={flyoutSide === "right" ? "chevron-r" : "chevron-l"} extra="sm" />
          </button>
        </span>
        {moreOpen ? (
          <div
            className={`menu rms-pop cmp-flyout side-${flyoutSide}`}
            role="listbox"
            aria-label={t("composer.allModels")}
            onMouseEnter={keepFlyoutOpen}
            onMouseLeave={scheduleFlyoutClose}
          >
            {groups.length === 0 ? (
              <div className="rms-empty">{t("composer.noAvailableModels")}</div>
            ) : (
              groups.map((group) => (
                <div className="rms-group" key={group.providerId} role="group" aria-label={group.providerName}>
                  <div className="rms-group-label">
                    <span className="rms-brand" aria-hidden="true">
                      <ProviderGlyph id={group.providerId} local={group.local} />
                    </span>
                    <span className="rms-group-name">{group.providerName}</span>
                    <span className="rms-group-count">{group.models.length}</span>
                  </div>
                  {group.models.map((model) => {
                    const on = isModelSelected(model.selector);
                    return (
                      <button
                        type="button"
                        key={model.selector}
                        role="option"
                        aria-selected={on}
                        className={`menu-item rms-option${on ? " is-on" : ""}`}
                        disabled={disabled}
                        onClick={() => onChooseModel(model.selector)}
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
              ))
            )}
          </div>
        ) : null}
        {preview ? (
          <div className="cmp-menu-note">
            <span className="chip gray xs">{t("common.demo")}</span>
            <span>{note ?? t("composer.previewModelNote")}</span>
          </div>
        ) : note ? (
          <div className="cmp-menu-note">{note}</div>
        ) : null}
      </div>
    </>
  );
}

export function ComposerModelPicker({
  preview,
  client,
  refreshKey = "",
  snapshot,
  can,
  onRun,
  openNonce = 0,
}: {
  preview: boolean;
  client: StudioClient;
  /** 会话/对话标识：切换时重取数据，菜单关闭状态也保持 pill 新鲜。 */
  refreshKey?: string;
  /** Runtime 真值；`snapshot.model` 是 pill 当前值的唯一来源。 */
  snapshot?: OperatorStateSnapshot;
  can: (id: string) => boolean;
  busy: boolean;
  onRun: <T extends CommandName>(name: T, input: CommandInput<T>) => Promise<boolean>;
  /** Increment to open the model menu from `/model`. */
  openNonce?: number;
}) {
  const [menu, setMenu] = useState<MenuKind>("none");
  const [data, setData] = useState<ModelConfigReadModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewPick, setPreviewPick] = useState<ComposerPick | null>(null);
  // Task 子代理模式：菜单内切换，激活后列表选择的是会话级 Task 模型而非会话模型。
  const [taskPicking, setTaskPicking] = useState(false);
  const [previewTaskPick, setPreviewTaskPick] = useState<ComposerPick | null>(null);

  useEffect(() => {
    if (openNonce > 0) setMenu("model");
  }, [openNonce]);

  // 取数：挂载、切预览、切对话（refreshKey）、打开菜单时都刷新，
  // 保证菜单关闭状态下 pill 标签也跟随当前数据源。
  const menuOpen = menu !== "none";
  useEffect(() => {
    let cancelled = false;
    if (preview) {
      setData(createPreviewModelConfig());
      setLoadError(null);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    client
      .query("models.get", {})
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setLoadError(next.unavailableReason ?? null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(hostErrorMessage(error, "models.get failed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [menuOpen, preview, client, refreshKey]);

  // 预览：无显式选择时默认跟随 default 角色（退而求其次第一个有模型的角色）。
  useEffect(() => {
    if (!preview || !data || previewPick) return;
    const fallback = data.roles.find((role) => role.id === "default" && role.primary)
      ?? data.roles.find((role) => role.primary);
    if (fallback) setPreviewPick(pickWith(fallback.id, fallback.primary, fallback.thinking));
  }, [preview, data, previewPick]);

  // 预览数据换源后选择失效则回到默认。
  useEffect(() => {
    if (!preview || !data || !previewPick) return;
    if (previewPick.roleId
      && data.roles.some((role) => role.id === previewPick.roleId && role.primary === previewPick.selector)) return;
    if (data.availableModels.some((model) => model.selector === previewPick.selector)) return;
    setPreviewPick(null);
  }, [preview, data, previewPick]);

  useEffect(() => {
    if (!preview) setPreviewPick(null);
  }, [preview]);

  useEffect(() => {
    if (!preview) setPreviewTaskPick(null);
  }, [preview]);

  const bySelector = useMemo(
    () => new Map((data?.availableModels ?? []).map((model) => [model.selector, model])),
    [data],
  );

  // 预览用本地选择，真实模式只认 Runtime 投影，避免 pill 和实际跑的模型不一致。
  const pick = useMemo(
    () => (preview ? previewPick : snapshotPick(snapshot, data?.roles ?? [])),
    [preview, previewPick, snapshot, data],
  );
  const modelReady = preview || can("session.model.set");
  const thinkingReady = preview || can("session.thinking.set");
  const taskReady = preview || can("session.taskModel.set");
  const nextTurnOnly = !preview && (snapshot?.isStreaming === true || snapshot?.isCompacting === true);

  // Task 模型只认 Runtime 投影（或预览本地选择）；显示名同样走目录反查。
  const taskModel = preview ? previewTaskPick : snapshot?.taskModel ?? null;
  const taskLabel = taskModel
    ? bySelector.get(taskModel.selector)?.name ?? modelShortName(taskModel.selector)
    : null;

  const selectedModel = pick ? bySelector.get(pick.selector) : undefined;
  const thinking = useMemo(() => {
    const control = roleThinkingControl(selectedModel);
    return {
      items: MODEL_THINKING.filter((item) => control.ids.includes(item.id)),
      disabled: control.disabled,
      value: clampRoleThinking(pick?.thinking, selectedModel) || "off",
    };
  }, [selectedModel, pick]);

  const modelLabel = pick
    ? selectedModel?.name ?? modelShortName(pick.selector)
    : "—";
  const thinkingLabel = thinking.items.find((item) => item.id === thinking.value)?.label ?? "—";

  const closeAll = () => {
    setMenu("none");
    setTaskPicking(false);
  };

  useEffect(() => {
    if (menu === "none") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAll();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  /** 失败由父级 onRun 报错；pill 始终跟 snapshot，不做乐观回填。 */
  const apply = <T extends CommandName>(name: T, input: CommandInput<T>) => {
    void onRun(name, input);
  };

  const chooseRole = (role: ModelRoleRecord) => {
    closeAll();
    if (!modelReady) return;
    if (preview) {
      setPreviewPick(pickWith(role.id, role.primary, role.thinking));
      return;
    }
    const thinking = asThinkingSelector(role.thinking);
    apply("session.model.set", thinking === undefined
      ? { selector: role.primary }
      : { selector: role.primary, thinking });
  };

  const chooseModel = (selector: string) => {
    closeAll();
    if (!modelReady) return;
    if (preview) {
      const model = bySelector.get(selector);
      setPreviewPick((prev) => pickWith(null, selector, clampRoleThinking(prev?.thinking, model) || undefined));
      return;
    }
    // 不带 thinking：由目标模型自己的默认档位决定，别把上一个模型的档位硬塞过去。
    apply("session.model.set", { selector });
  };

  const chooseThinking = (id: string) => {
    closeAll();
    if (!thinkingReady) return;
    if (preview) {
      setPreviewPick((prev) => (prev ? pickWith(prev.roleId, prev.selector, id === "off" ? undefined : id) : prev));
      return;
    }
    const level = asThinkingSelector(id);
    if (level === undefined) return;
    apply("session.thinking.set", { level });
  };

  /** Task 模式下选模型：会话级 override，选完退出 Task 模式并收起菜单。 */
  const chooseTaskModel = (selector: string) => {
    closeAll();
    if (!taskReady) return;
    if (preview) {
      setPreviewTaskPick(pickWith(null, selector, undefined));
      return;
    }
    apply("session.taskModel.set", { selector });
  };

  /** Task 模式恢复继承：清掉会话级 override（持久化配置仍在则回落到它）。 */
  const chooseTaskInherit = () => {
    closeAll();
    if (!taskReady) return;
    if (preview) {
      setPreviewTaskPick(null);
      return;
    }
    apply("session.taskModel.set", { selector: null });
  };

  const { t } = useI18n();

  return (
    <>
      <span className="cmp-pill-wrap">
        <button
          type="button"
          className="pill-btn meta-model"
          aria-haspopup="menu"
          aria-expanded={menu === "model"}
          aria-label={t("composer.selectModel")}
          data-tip={!modelReady ? t("common.notImplemented") : t("composer.model")}
          onClick={() => {
            if (menu === "model") {
              closeAll();
              return;
            }
            setMenu("model");
          }}
        >
          <span className="cmp-model-label-full">{modelLabel}</span>
          <span className="cmp-model-label-initial" aria-hidden="true">{labelInitial(modelLabel)}</span>
          {taskModel ? (
            <span
              className="cmp-task-dot"
              data-tip={`${t("composer.taskModelActive")}${taskLabel ? `：${taskLabel}` : ""}`}
              aria-label={t("composer.taskModelActive")}
            />
          ) : null}
          <Icon name="chevron-d" extra="sm cmp-pill-caret" />
        </button>
        {menu === "model" ? (
          <ComposerModelMenu
            data={data}
            loading={loading}
            loadError={loadError}
            preview={preview}
            disabled={taskPicking ? !taskReady : !modelReady}
            header={
              <button
                type="button"
                className={`cmp-task-toggle${taskPicking ? " is-on" : ""}`}
                aria-pressed={taskPicking}
                disabled={!taskReady}
                data-tip={!taskReady ? t("common.notImplemented") : taskLabel ?? t("composer.taskModelInheritTip")}
                onClick={() => setTaskPicking((on) => !on)}
              >
                <Icon name="bot" extra="sm" />
                <span>{t("composer.taskModelToggle")}</span>
                <span className="spacer" />
                {taskLabel ? <span className="cmp-task-current">{taskLabel}</span> : null}
              </button>
            }
            {...(taskPicking
              ? {
                  inheritOption: {
                    label: t("composer.taskModelInherit"),
                    selected: taskModel === null,
                    onChoose: chooseTaskInherit,
                  },
                  isRoleSelected: (role: ModelRoleRecord) => taskModel?.selector === role.primary,
                  isModelSelected: (selector: string) => taskModel?.selector === selector,
                  onChooseRole: (role: ModelRoleRecord) => chooseTaskModel(role.primary),
                  onChooseModel: chooseTaskModel,
                  note: t("composer.taskModelNote"),
                }
              : {
                  isRoleSelected: (role: ModelRoleRecord) => pick?.roleId === role.id,
                  isModelSelected: (selector: string) => pick?.selector === selector,
                  onChooseRole: chooseRole,
                  onChooseModel: chooseModel,
                })}
            {...(preview || (modelReady && !nextTurnOnly) || taskPicking
              ? {}
              : {
                  note: !modelReady
                    ? t("composer.runtimeNotExposedModelSet")
                    : t("composer.modelNoteNextTurn"),
                })}
            onClose={closeAll}
          />
        ) : null}
      </span>
      <span className="cmp-pill-wrap">
        <button
          type="button"
          className="pill-btn"
          disabled={!pick || thinking.disabled || !thinkingReady}
          aria-haspopup="menu"
          aria-expanded={menu === "thinking"}
          aria-label={t("composer.reasoningEffort")}
          data-tip={
            !thinkingReady
              ? t("common.notImplemented")
              : thinking.disabled
                ? t("composer.thinkingNotSupported")
                : t("composer.reasoningEffort")
          }
          onClick={() => setMenu((current) => (current === "thinking" ? "none" : "thinking"))}
        >
          <span>{thinkingLabel}</span>
          <Icon name="chevron-d" extra="sm cmp-pill-caret" />
        </button>
        {menu === "thinking" ? (
          <>
            <div className="approval-menu-backdrop" onClick={closeAll} />
            <div className="cmp-menu cmp-think-menu" role="menu" aria-label={t("composer.reasoningEffort")}>
              {thinking.items.map((item) => {
                const on = thinking.value === item.id;
                return (
                  <button
                    type="button"
                    key={item.id}
                    role="menuitemradio"
                    aria-checked={on}
                    className={`menu-item cmp-think-item${on ? " selected" : ""}`}
                    onClick={() => chooseThinking(item.id)}
                  >
                    <span>{item.label}</span>
                    {on ? <Icon name="check" extra="sm" /> : null}
                  </button>
                );
              })}
            </div>
          </>
        ) : null}
      </span>
    </>
  );
}
