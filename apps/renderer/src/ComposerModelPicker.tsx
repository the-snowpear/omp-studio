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
 * session.model.set / session.thinking.set，不做乐观填值。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

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

export function ComposerModelPicker({
  preview,
  client,
  refreshKey = "",
  snapshot,
  can,
  busy,
  onRun,
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
}) {
  const [menu, setMenu] = useState<MenuKind>("none");
  const [moreOpen, setMoreOpen] = useState(false);
  const [data, setData] = useState<ModelConfigReadModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewPick, setPreviewPick] = useState<ComposerPick | null>(null);
  const [flyoutSide, setFlyoutSide] = useState<"right" | "left">("right");
  const flyoutTimer = useRef<number | undefined>(undefined);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => window.clearTimeout(flyoutTimer.current), []);

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

  const bySelector = useMemo(
    () => new Map((data?.availableModels ?? []).map((model) => [model.selector, model])),
    [data],
  );
  // 只列「当前能直接切过去」的角色：已分配模型、无 issue 且模型在可用列表。
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

  // 预览用本地选择，真实模式只认 Runtime 投影，避免 pill 和实际跑的模型不一致。
  const pick = useMemo(
    () => (preview ? previewPick : snapshotPick(snapshot, data?.roles ?? [])),
    [preview, previewPick, snapshot, data],
  );
  const modelReady = preview || can("session.model.set");
  const thinkingReady = preview || can("session.thinking.set");
  // Runtime 在 streaming / compacting 时会直接拒绝切换，所以流式期间先禁用。
  const locked = !preview && (busy || snapshot?.isStreaming === true);

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
    window.clearTimeout(flyoutTimer.current);
    setMoreOpen(false);
    setMenu("none");
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
    if (!modelReady || locked) return;
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
    if (!modelReady || locked) return;
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
    if (!thinkingReady || locked) return;
    if (preview) {
      setPreviewPick((prev) => (prev ? pickWith(prev.roleId, prev.selector, id === "off" ? undefined : id) : prev));
      return;
    }
    const level = asThinkingSelector(id);
    if (level === undefined) return;
    apply("session.thinking.set", { level });
  };

  const scheduleFlyoutClose = () => {
    window.clearTimeout(flyoutTimer.current);
    flyoutTimer.current = window.setTimeout(() => setMoreOpen(false), FLYOUT_CLOSE_GRACE_MS);
  };
  const keepFlyoutOpen = () => {
    window.clearTimeout(flyoutTimer.current);
    setMoreOpen(true);
  };

  // 二级弹窗默认在主菜单右侧展开，右侧视口空间不足才翻到左侧。
  useLayoutEffect(() => {
    if (!moreOpen) return;
    const rect = modelMenuRef.current?.getBoundingClientRect();
    if (!rect) return;
    setFlyoutSide(rect.right + 8 + FLYOUT_WIDTH <= window.innerWidth - 8 ? "right" : "left");
  }, [moreOpen]);

  const roleName = pick?.roleId ? data?.roles.find((role) => role.id === pick.roleId)?.name ?? pick.roleId : null;
  const modelPillTitle = !modelReady
    ? "Runtime 未暴露 session.model.set"
    : pick
      ? `${pick.selector}${roleName ? `（${roleName}）` : ""}${preview ? " · 演示" : ""}`
      : "选择模型";

  return (
    <>
      <span className="cmp-pill-wrap">
        <button
          type="button"
          className="pill-btn meta-model"
          aria-haspopup="menu"
          aria-expanded={menu === "model"}
          aria-label="选择模型"
          title={modelPillTitle}
          onClick={() => {
            if (menu === "model") {
              closeAll();
              return;
            }
            window.clearTimeout(flyoutTimer.current);
            setMoreOpen(false);
            setMenu("model");
          }}
        >
          <Icon name="cpu" extra="sm" />
          <span className="cmp-model-label-full">{modelLabel}</span>
          <span className="cmp-model-label-initial" aria-hidden="true">{labelInitial(modelLabel)}</span>
        </button>
        {menu === "model" ? (
          <>
            <div className="approval-menu-backdrop" onClick={closeAll} />
            <div className="cmp-menu" role="menu" aria-label="选择模型" ref={modelMenuRef}>
              <div className="cmp-roles">
              {loading && !data ? (
                <div className="cmp-empty">加载模型配置…</div>
              ) : loadError && rolesWithModel.length === 0 ? (
                <div className="cmp-empty cmp-error">{loadError}</div>
              ) : rolesWithModel.length === 0 ? (
                <div className="cmp-empty">没有已分配可用模型的角色</div>
              ) : (
                rolesWithModel.map((role) => {
                  const on = pick?.roleId === role.id;
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
                      disabled={!modelReady || locked}
                      title={role.primary}
                      onClick={() => chooseRole(role)}
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
                  <span>更多模型</span>
                  <span className="spacer" />
                  <Icon name={flyoutSide === "right" ? "chevron-r" : "chevron-l"} extra="sm" />
                </button>
              </span>
              {moreOpen ? (
                <div
                  className={`menu rms-pop cmp-flyout side-${flyoutSide}`}
                  role="listbox"
                  aria-label="全部模型"
                  onMouseEnter={keepFlyoutOpen}
                  onMouseLeave={scheduleFlyoutClose}
                >
                    {groups.length === 0 ? (
                    <div className="rms-empty">没有可用模型</div>
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
                          const on = pick?.selector === model.selector;
                          return (
                            <button
                              type="button"
                              key={model.selector}
                              role="option"
                              aria-selected={on}
                              className={`menu-item rms-option${on ? " is-on" : ""}`}
                              disabled={!modelReady || locked}
                              title={model.selector}
                              onClick={() => chooseModel(model.selector)}
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
                  <span className="chip gray xs">演示</span>
                  <span>演示数据，不写入本机配置</span>
                </div>
              ) : !modelReady ? (
                <div className="cmp-menu-note">Runtime 未暴露 session.model.set</div>
              ) : locked ? (
                <div className="cmp-menu-note">Runtime 忙，本轮结束后才能切换模型</div>
              ) : (
                <div className="cmp-menu-note">只改当前会话，不写 models.yml</div>
              )}
            </div>
          </>
        ) : null}
      </span>
      <span className="cmp-pill-wrap">
        <button
          type="button"
          className="pill-btn"
          disabled={!pick || thinking.disabled || !thinkingReady || locked}
          aria-haspopup="menu"
          aria-expanded={menu === "thinking"}
          aria-label="思考强度"
          title={
            !thinkingReady
              ? "Runtime 未暴露 session.thinking.set"
              : thinking.disabled
                ? "当前模型不支持思考强度"
                : locked
                  ? "Runtime 忙，本轮结束后才能改思考强度"
                  : `思考强度：${thinkingLabel}`
          }
          onClick={() => setMenu((current) => (current === "thinking" ? "none" : "thinking"))}
        >
          <Icon name="brain" extra="sm" />
          <span>{thinkingLabel}</span>
        </button>
        {menu === "thinking" ? (
          <>
            <div className="approval-menu-backdrop" onClick={closeAll} />
            <div className="cmp-menu cmp-think-menu" role="menu" aria-label="思考强度">
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
