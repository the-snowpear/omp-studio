import { useEffect, useState, type ReactNode } from "react";
import type { StudioClient, WorkspaceFileNode, WorkspaceId } from "@omp-studio/client-contract";
import type {
  EvaluationSpec,
  EvaluationContext,
  EvaluationQuestion,
} from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import { WorkspaceDialog } from "../workspaces/Workspace";
import { hostErrorMessage } from "../hostError";
import { useExecutionTarget } from "../workspaces/ExecutionTargets";

type T = (cn: string, en: string) => string;
export const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="eval-field">
      <span>{label}</span>
      {children}
      {help ? <small>{help}</small> : null}
    </label>
  );
}
function NumberField({
  label,
  value,
  placeholder,
  onChange,
  min = 1,
  step = 1,
}: {
  label: string;
  value: number | undefined;
  placeholder: string;
  onChange(value: number | undefined): void;
  min?: number;
  step?: number;
}) {
  return (
    <Field label={label}>
      <input
        className="input"
        type="number"
        min={min}
        step={step}
        placeholder={placeholder}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      />
    </Field>
  );
}
function JsonField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: object;
  onChange(value: object): void;
}) {
  const [text, setText] = useState(JSON.stringify(value, null, 2)),
    [error, setError] = useState("");
  return (
    <Field label={label}>
      <textarea
        className="input mono"
        rows={5}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const value: unknown = JSON.parse(e.target.value);
            if (!value || typeof value !== "object")
              throw new Error("Expected JSON object or array");
            onChange(value);
            setError("");
          } catch (error) {
            setError(String(error));
          }
        }}
      />
      {error ? (
        <span className="eval-error" role="alert">
          {error}
        </span>
      ) : null}
    </Field>
  );
}
function PathPicker({
  client,
  workspaceId,
  preview,
  t,
  onPick,
  onClose,
}: {
  client: StudioClient;
  workspaceId: string | undefined;
  preview: boolean;
  t: T;
  onPick(path: string): void;
  onClose(): void;
}) {
  const [path, setPath] = useState(""),
    [nodes, setNodes] = useState<readonly WorkspaceFileNode[]>([]),
    [error, setError] = useState("");
  const load = async (next: string) => {
    setPath(next);
    if (preview) {
      setNodes([
        { type: "file", name: "cases.jsonl", path: "eval/cases.jsonl" },
        { type: "file", name: "run.py", path: "eval/run.py" },
        { type: "dir", name: "prompts", path: "prompts" },
      ]);
      return;
    }
    if (!workspaceId) return;
    try {
      setNodes(
        (
          await client.query("workspace.fileTree", {
            workspaceId: workspaceId as WorkspaceId,
            path: next,
          })
        ).nodes,
      );
    } catch (cause) {
      setError(hostErrorMessage(cause, "Cannot read files"));
    }
  };
  useEffect(() => {
    void load("");
  }, []);
  return (
    <WorkspaceDialog title={t("选择工作区路径", "Choose workspace paths")} onClose={onClose}>
      <div className="eval-toolbar">
        <code>{path || "/"}</code>
        <button
          className="btn small"
          onClick={() => void load(path.split("/").slice(0, -1).join("/"))}
        >
          {t("上一级／读取", "Parent / Load")}
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div className="eval-path-list">
        {nodes.map((node) => (
          <div key={node.path}>
            <span>
              {node.name}
              {node.type === "dir" ? "/" : ""}
            </span>
            {node.type === "dir" ? (
              <button className="btn small" onClick={() => void load(node.path)}>
                {t("打开", "Open")}
              </button>
            ) : null}
            <button className="btn small" onClick={() => onPick(node.path)}>
              {t("选择", "Select")}
            </button>
          </div>
        ))}
      </div>
    </WorkspaceDialog>
  );
}

export function EvaluationConfig({
  spec,
  onChange,
  context,
  client,
  workspaceId,
  currentSessionId,
  preview,
  t,
}: {
  spec: EvaluationSpec;
  onChange(spec: EvaluationSpec): void;
  context: EvaluationContext | undefined;
  client: StudioClient;
  workspaceId: string | undefined;
  currentSessionId?: string | undefined;
  preview: boolean;
  t: T;
}) {
  const executionTarget = useExecutionTarget();
  const [imagePicker, setImagePicker] = useState<number>();
  const [search, setSearch] = useState(""),
    [step, setStep] = useState(0),
    [error, setError] = useState("");
  const [picker, setPicker] = useState<
    "cases" | "harness" | "change" | "offLimits" | "cachePrefixFile"
  >();
  const set = (key: string, value: unknown) => {
    const next = { ...spec } as Record<string, unknown>;
    if (key === "cachePrefixFile" || key === "cachePrefixBytes") delete next.cachePrefixContent;
    if (value === undefined || value === "") delete next[key];
    else next[key] = value;
    onChange(next as unknown as EvaluationSpec);
  };
  const numeric = (key: string, label: string, placeholder: string, min = 1, step = 1) => (
    <NumberField
      key={key}
      label={label}
      value={(spec as unknown as Record<string, number>)[key]}
      placeholder={placeholder}
      onChange={(value) => set(key, value)}
      min={min}
      step={step}
    />
  );
  const pathField = (key: "cases" | "harness" | "change" | "offLimits", label: string) =>
    spec.kind === "ratchet" ? (
      <div className="eval-path-field">
        <Field
          label={label}
          help={t("相对于工作区，每行一个路径", "Workspace-relative paths, one per line")}
        >
          <textarea
            className="input mono"
            rows={2}
            value={spec[key].join("\n")}
            onChange={(e) => set(key, lines(e.target.value))}
          />
        </Field>
        <button className="btn small" onClick={() => setPicker(key)}>
          {t("选择文件或目录", "Choose files or folders")}
        </button>
      </div>
    ) : null;
  const modelFields =
    spec.kind === "benchmark" || spec.kind === "instruction" ? (
      <section className="eval-config-section">
        <h3>{t("选择模型", "Models")}</h3>
        <div className="eval-model-search">
          <input
            className="input"
            aria-label={t("搜索模型", "Search models")}
            placeholder={t("搜索名称或供应商", "Search model or provider")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span>
            {spec.models.length} {t("已选", "selected")}
          </span>
        </div>
        <div className="eval-model-options">
          {context?.models
            .filter(
              (m) =>
                m.kind === "chat" &&
                `${m.name} ${m.selector}`.toLowerCase().includes(search.toLowerCase()),
            )
            .map((m) => (
              <label key={m.selector}>
                <input
                  type="checkbox"
                  checked={spec.models.includes(m.selector)}
                  onChange={(e) =>
                    set(
                      "models",
                      e.target.checked
                        ? [...spec.models, m.selector]
                        : spec.models.filter((s) => s !== m.selector),
                    )
                  }
                />
                <span>
                  <strong>{m.name}</strong>
                  <small>{m.provider}</small>
                </span>
              </label>
            ))}
        </div>
        <details className="eval-advanced">
          <summary>{t("模型标识与推理档位", "Selectors and thinking levels")}</summary>
          <Field
            label={t("每行一个原生模型选择器", "One native selector per line")}
            help={t(
              "支持 provider/model、原生别名和 :thinking 后缀；确认页展示解析结果。",
              "Supports provider/model, native aliases and :thinking suffixes. Review shows resolved models.",
            )}
          >
            <textarea
              className="input mono"
              value={spec.models.join("\n")}
              rows={3}
              onChange={(e) => set("models", lines(e.target.value))}
            />
          </Field>
        </details>
      </section>
    ) : null;
  return (
    <div className="eval-config">
      {error ? (
        <p className="eval-error" role="alert">
          {error}
        </p>
      ) : null}
      {modelFields}
      {spec.kind === "benchmark" ? (
        <section className="eval-config-section">
          <h3>{t("测试设置", "Workload")}</h3>
          <div className="eval-fields">
            <Field label={t("工作负载", "Profile")}>
              <AppSelect
                value={spec.profile}
                onChange={(e) => {
                  const next = { ...spec, profile: e.target.value as typeof spec.profile };
                  delete next.prompt;
                  delete next.prefillBytes;
                  delete next.cachePrefixFile;
                  delete next.cachePrefixBytes;
                  delete next.runs;
                  delete next.concurrency;
                  onChange(next);
                }}
              >
                <option value="chat">Chat · {t("综合响应", "balanced")}</option>
                <option value="prefill">Prefill · {t("输入处理", "input processing")}</option>
                <option value="generation">Generation · {t("持续输出", "sustained output")}</option>
                <option value="mix">Mix · {t("混合工作负载", "rotating workloads")}</option>
                <option value="cache">Cache · {t("冷／热缓存", "cold / warm")}</option>
                <option value="detailed">
                  Detailed · {t("完整阶段", "single / parallel / prefill")}
                </option>
              </AppSelect>
            </Field>
            {numeric(
              "runs",
              spec.profile === "cache"
                ? t("冷／热对数", "Cold / warm pairs")
                : spec.profile === "detailed"
                  ? t("每阶段请求数", "Requests per phase")
                  : t("每模型请求数", "Requests per model"),
              t("原生默认", "Native default"),
            )}
            {numeric(
              "concurrency",
              spec.profile === "cache"
                ? t("并发缓存对", "Concurrent pairs")
                : t("单模型并发", "Concurrency per model"),
              spec.profile === "cache" ? "1" : "4",
              spec.profile === "detailed" ? 2 : 1,
            )}
            {numeric(
              "maxTokens",
              t("每次最大输出 token", "Max output tokens"),
              t("按工作负载使用原生默认", "Native default per workload"),
            )}
            {["prefill", "mix", "detailed"].includes(spec.profile)
              ? numeric("prefillBytes", t("Prefill 输入字节数", "Prefill input bytes"), "32768")
              : null}
            {spec.profile === "cache" ? (
              <>
                {numeric("cachePrefixBytes", t("缓存前缀字节数", "Cache prefix bytes"), "8192")}
                <div>
                  <Field label={t("缓存前缀文件", "Cache prefix file")}>
                    <input
                      className="input mono"
                      value={spec.cachePrefixFile ?? ""}
                      onChange={(e) => set("cachePrefixFile", e.target.value)}
                      placeholder={t("留空使用合成前缀", "Blank uses synthetic input")}
                    />
                  </Field>
                  <button className="btn small" onClick={() => setPicker("cachePrefixFile")}>
                    {t("选择文件", "Choose file")}
                  </button>
                </div>
              </>
            ) : null}
            <Field label={t("服务档位", "Service tier")}>
              <AppSelect
                value={spec.serviceTier ?? ""}
                onChange={(e) => set("serviceTier", e.target.value)}
              >
                <option value="">{t("继承原生配置", "Native configuration")}</option>
                {["none", "auto", "default", "flex", "scale", "priority", "ultrafast"].map(
                  (tier) => (
                    <option key={tier}>{tier}</option>
                  ),
                )}
              </AppSelect>
            </Field>
          </div>
          {["chat", "generation"].includes(spec.profile) ? (
            <Field
              label={t("自定义提示词", "Custom prompt")}
              help={t("留空使用原生随机工作负载。", "Blank uses native randomized workloads.")}
            >
              <textarea
                className="input"
                rows={4}
                value={spec.prompt ?? ""}
                onChange={(e) => set("prompt", e.target.value)}
              />
            </Field>
          ) : null}
        </section>
      ) : null}
      {spec.kind === "instruction" ? (
        <section className="eval-config-section">
          <h3>{t("测试设置", "Test settings")}</h3>
          <div className="eval-fields">
            {numeric("turns", t("最大轮数", "Maximum turns"), "24")}
            {numeric(
              "length",
              t("数组长度（8–26 的偶数）", "Array length (even, 8–26)"),
              "24",
              8,
              2,
            )}
            {numeric("maxTokens", t("每轮输出上限", "Output tokens per turn"), "32768")}
            {numeric(
              "nyaMax",
              t("原生指令长度参数 nya-max", "Native directive length · nya-max"),
              "8",
            )}
            {numeric("concurrency", t("同时测试的模型数", "Concurrent models"), "4")}
          </div>
          <p className="eval-hint">
            {t(
              "每个模型的轮次连续执行，首次违约后停止；题目、温度和判分沿用原生算法。",
              "Turns stay sequential per model and stop at the first failure. Prompts, temperature and scoring follow the native engine.",
            )}
          </p>
        </section>
      ) : null}
      {spec.kind === "judgment" ? (
        <>
          <section className="eval-config-section">
            <h3>{t("评判内容", "Items")}</h3>
            <Field label={t("文本样本（每行一个）", "Text items (one per line)")}>
              <textarea
                className="input"
                rows={6}
                placeholder={t(
                  "粘贴内容，或导入文本／JSON 文件",
                  "Paste items or import text / JSON",
                )}
                value={spec.items
                  .map((item) =>
                    typeof item.state === "string" ? item.state : JSON.stringify(item.state),
                  )
                  .join("\n")}
                onChange={(e) =>
                  set(
                    "items",
                    e.target.value
                      .split(/\r?\n/)
                      .filter(Boolean)
                      .map((state, key) => ({
                        key: spec.items[key]?.key ?? key,
                        state,
                        ...(spec.items[key]?.images ? { images: spec.items[key]!.images } : {}),
                      })),
                  )
                }
              />
            </Field>
            <div className="eval-toolbar">
              <label className="btn small outline eval-file-button">
                {t("导入样本", "Import items")}
                <input
                  type="file"
                  accept=".txt,.json,.jsonl"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    void file
                      .text()
                      .then((text) => {
                        const values: unknown = file.name.endsWith(".json")
                          ? JSON.parse(text)
                          : file.name.endsWith(".jsonl")
                            ? lines(text).map((line) => JSON.parse(line))
                            : text
                                .split(/\r?\n/)
                                .filter(Boolean)
                                .map((state) => ({ state }));
                        if (!Array.isArray(values)) throw new Error("Expected an array of items");
                        set(
                          "items",
                          values.map((row: unknown, i) =>
                            typeof row === "string"
                              ? { key: i, state: row }
                              : { key: i, ...(row as object) },
                          ),
                        );
                        setError("");
                      })
                      .catch((cause) => setError(String(cause)));
                  }}
                />
              </label>
              <span className="eval-hint">
                {spec.items.length}{" "}
                {t("个样本；一个样本即单项试评", "items · one item is a single judgment")}
              </span>
            </div>
            {spec.items.length ? (
              <details className="eval-advanced">
                <summary>{t("样本图片", "Item images")}</summary>
                {spec.items.map((item, i) => (
                  <div className="eval-image-item" key={item.key}>
                    <Field label={`${t("样本", "Item")} ${item.key}`}>
                      <input
                        className="input mono"
                        placeholder={t(
                          "图片路径，使用分号分隔",
                          "Image paths separated by semicolons",
                        )}
                        value={item.images?.join("; ") ?? ""}
                        onChange={(e) =>
                          set(
                            "items",
                            spec.items.map((row, index) =>
                              index === i
                                ? {
                                    ...row,
                                    images: e.target.value
                                      .split(";")
                                      .map((s) => s.trim())
                                      .filter(Boolean),
                                  }
                                : row,
                            ),
                          )
                        }
                      />
                    </Field>
                    <button
                      className="btn small"
                      disabled={
                        !preview &&
                        (!!executionTarget.id || !globalThis.ompStudioChrome?.importArtifact)
                      }
                      onClick={() => {
                        if (preview) {
                          set(
                            "items",
                            spec.items.map((row, index) =>
                              index === i ? { ...row, images: ["sample-image.png"] } : row,
                            ),
                          );
                          return;
                        }
                        void globalThis.ompStudioChrome
                          ?.importArtifact?.({
                            kind: "image",
                            ...(workspaceId ? { workspaceId } : {}),
                          })
                          .then((result) => {
                            if (result?.ok && result.artifact)
                              set(
                                "items",
                                spec.items.map((row, index) =>
                                  index === i
                                    ? {
                                        ...row,
                                        images: [
                                          ...(row.images ?? []),
                                          `artifact://${result.artifact!.artifactId}`,
                                        ],
                                      }
                                    : row,
                                ),
                              );
                          });
                      }}
                    >
                      {t("添加本机图片", "Add local image")}
                    </button>
                    <button className="btn small" onClick={() => setImagePicker(i)}>
                      {t("选择工作区图片", "Choose workspace image")}
                    </button>
                  </div>
                ))}
              </details>
            ) : null}
            <details className="eval-advanced">
              <summary>{t("结构化输入", "Structured input")}</summary>
              <JsonField
                key={spec.items.length}
                label={t("JSON 样本数组", "JSON item array")}
                value={spec.items}
                onChange={(value) => {
                  if (Array.isArray(value)) set("items", value);
                }}
              />
            </details>
          </section>
          <section className="eval-config-section">
            <h3>{t("问题与评分标准", "Questions and criteria")}</h3>
            {Object.entries(spec.questions).map(([id, q], index) => (
              <div className="eval-question" key={id}>
                <div className="eval-toolbar">
                  <strong>
                    {index + 1}. {id}
                  </strong>
                  <AppSelect
                    aria-label={`${id} ${t("题型", "type")}`}
                    value={q.type}
                    onChange={(e) => {
                      const type = e.target.value as EvaluationQuestion["type"];
                      set("questions", {
                        ...spec.questions,
                        [id]:
                          type === "bool"
                            ? { type, instructions: q.instructions }
                            : type === "score"
                              ? { type, instructions: q.instructions, criteria: ["", ""] }
                              : { type, instructions: q.instructions, criteria: { A: "", B: "" } },
                      });
                    }}
                  >
                    <option value="bool">{t("是／否概率", "Yes / no")}</option>
                    <option value="choice">{t("分类选择", "Choice")}</option>
                    <option value="score">{t("分级评分", "Score")}</option>
                  </AppSelect>
                  <button
                    className="btn small"
                    disabled={Object.keys(spec.questions).length === 1}
                    onClick={() => {
                      const next = { ...spec.questions };
                      delete next[id];
                      set("questions", next);
                    }}
                  >
                    {t("移除", "Remove")}
                  </button>
                </div>
                <Field label={t("判断说明", "Instructions")}>
                  <textarea
                    className="input"
                    rows={2}
                    value={q.instructions}
                    onChange={(e) =>
                      set("questions", {
                        ...spec.questions,
                        [id]: { ...q, instructions: e.target.value },
                      })
                    }
                  />
                </Field>
                {q.type === "bool" ? (
                  <div className="eval-fields">
                    {(["true", "false"] as const).map((side) => (
                      <Field
                        key={side}
                        label={
                          side === "true"
                            ? t("满足时的标准", "Yes criterion")
                            : t("不满足时的标准", "No criterion")
                        }
                      >
                        <input
                          className="input"
                          value={q.criteria?.[side] ?? ""}
                          onChange={(e) =>
                            set("questions", {
                              ...spec.questions,
                              [id]: { ...q, criteria: { ...q.criteria, [side]: e.target.value } },
                            })
                          }
                        />
                      </Field>
                    ))}
                  </div>
                ) : (
                  <Field
                    label={
                      q.type === "score"
                        ? t(
                            "等级标准：从最低到最高，每行一级",
                            "Levels, lowest to highest, one per line",
                          )
                        : t("选项：每行 标签: 标准", "Options: label: criterion, one per line")
                    }
                  >
                    <textarea
                      className="input"
                      rows={3}
                      value={
                        q.type === "score"
                          ? q.criteria.join("\n")
                          : Object.entries(q.criteria)
                              .map(([key, value]) => `${key}: ${value ?? ""}`)
                              .join("\n")
                      }
                      onChange={(e) =>
                        set("questions", {
                          ...spec.questions,
                          [id]: {
                            ...q,
                            criteria:
                              q.type === "score"
                                ? e.target.value.split("\n")
                                : Object.fromEntries(
                                    e.target.value.split("\n").map((line) => {
                                      const i = line.indexOf(":");
                                      return i < 0
                                        ? [line, null]
                                        : [
                                            line.slice(0, i).trim(),
                                            line.slice(i + 1).trim() || null,
                                          ];
                                    }),
                                  ),
                          },
                        })
                      }
                    />
                  </Field>
                )}
              </div>
            ))}
            <button
              className="btn small outline"
              onClick={() => {
                let index = Object.keys(spec.questions).length + 1;
                while (spec.questions[`q${index}`]) index++;
                set("questions", {
                  ...spec.questions,
                  [`q${index}`]: { type: "bool", instructions: "" },
                });
              }}
            >
              {t("添加问题", "Add question")}
            </button>
          </section>
          <details className="eval-advanced">
            <summary>
              {t("接入当前会话中的原生批次", "Attach a native batch from the current session")}
            </summary>
            <Field
              label={t("批次 ID", "Batch ID")}
              help={t(
                "填写后只接入已有任务，不创建新的付费请求。",
                "Attaching observes an existing batch without creating paid work.",
              )}
            >
              <input
                className="input mono"
                value={spec.attachId ?? ""}
                onChange={(e) =>
                  onChange({
                    ...spec,
                    attachId: e.target.value,
                    ...(currentSessionId ? { attachSessionId: currentSessionId } : {}),
                  })
                }
              />
            </Field>
          </details>
          <section className="eval-config-section">
            <h3>{t("执行配置", "Execution")}</h3>
            <div className="eval-fields">
              <Field
                label={t("Judge 模型／角色链", "Judge model / role chain")}
                help={t(
                  "只影响本次评测，留空继承原生角色链。",
                  "Applies to this evaluation only. Blank inherits the native role chain.",
                )}
              >
                <input
                  className="input"
                  value={spec.judgeModel ?? ""}
                  onChange={(e) => set("judgeModel", e.target.value)}
                  placeholder={t("原生默认", "Native default")}
                />
              </Field>
              {numeric("concurrency", t("并发", "Concurrency"), "32")}
              {numeric("retries", t("每项重试次数", "Retries per item"), "1", 0)}
              {numeric("minOk", t("最少成功数", "Minimum successes"), "1")}
            </div>
          </section>
        </>
      ) : null}
      {spec.kind === "ratchet" ? (
        <>
          <div className="eval-steps" role="group" aria-label={t("配置步骤", "Setup steps")}>
            {[
              t("目标与范围", "Goal"),
              t("样本", "Cases"),
              t("评分器", "Grader"),
              t("计划", "Plan"),
            ].map((label, index) => (
              <button
                className={step === index ? "active" : ""}
                key={label}
                onClick={() => setStep(index)}
                aria-current={step === index ? "step" : undefined}
              >
                <span>{index + 1}</span>
                {label}
              </button>
            ))}
          </div>
          {step === 0 ? (
            <section className="eval-config-section">
              <div className="eval-fields">
                <Field label={t("流程标识", "Flow name")}>
                  <input
                    className="input"
                    value={spec.flow}
                    placeholder="support-routing"
                    onChange={(e) => set("flow", e.target.value)}
                  />
                </Field>
                <Field label={t("准备方式", "Preparation")}>
                  <AppSelect
                    value={spec.assist ? "assist" : "existing"}
                    onChange={(e) => set("assist", e.target.value === "assist")}
                  >
                    <option value="existing">{t("接入已有评测", "Use existing evaluation")}</option>
                    <option value="assist">
                      {t("让原生代理辅助准备", "Prepare with the native agent")}
                    </option>
                  </AppSelect>
                </Field>
              </div>
              <Field label={t("希望改进什么", "Objective")}>
                <textarea
                  className="input"
                  rows={3}
                  value={spec.objective}
                  onChange={(e) => set("objective", e.target.value)}
                />
              </Field>
              <div className="eval-fields">
                {pathField("change", t("允许修改的范围", "Allowed changes"))}
                {pathField("offLimits", t("禁止修改的范围", "Off limits"))}
              </div>
            </section>
          ) : null}
          {step === 1 ? (
            <section className="eval-config-section">
              {pathField("cases", t("样本与参考答案", "Cases and reference answers"))}
              <h3>{t("案例分组", "Case cohorts")}</h3>
              {Object.entries(spec.cohorts).map(([id, cohort]) => (
                <div className="eval-cohort" key={id}>
                  <input
                    className="input mono"
                    aria-label={t("案例 ID", "Case ID")}
                    defaultValue={id}
                    onBlur={(e) => {
                      const nextId = e.target.value.trim();
                      if (nextId && nextId !== id) {
                        const next = { ...spec.cohorts };
                        delete next[id];
                        next[nextId] = cohort;
                        set("cohorts", next);
                      }
                    }}
                  />
                  <input
                    className="input"
                    aria-label={`${id} ${t("分组", "cohort")}`}
                    value={cohort}
                    onChange={(e) => set("cohorts", { ...spec.cohorts, [id]: e.target.value })}
                  />
                  <button
                    className="btn small"
                    onClick={() => {
                      const next = { ...spec.cohorts };
                      delete next[id];
                      set("cohorts", next);
                    }}
                  >
                    {t("移除", "Remove")}
                  </button>
                </div>
              ))}
              <button
                className="btn small"
                onClick={() => {
                  let n = Object.keys(spec.cohorts).length + 1;
                  while (spec.cohorts[`case-${n}`]) n++;
                  set("cohorts", { ...spec.cohorts, [`case-${n}`]: "default" });
                }}
              >
                {t("添加案例", "Add case")}
              </button>
              <details className="eval-advanced">
                <summary>{t("导入或编辑分组 JSON", "Import / edit cohort JSON")}</summary>
                <JsonField
                  label={t("案例 ID → 分组", "Case ID → cohort")}
                  value={spec.cohorts}
                  onChange={(value) => set("cohorts", value)}
                />
              </details>
              <div className="eval-fields">
                {numeric("testFraction", t("留出集比例", "Held-out fraction"), "0.4", 0.01, 0.01)}
                {numeric(
                  "seed",
                  t("划分种子", "Split seed"),
                  t("随机并记录", "Random, recorded"),
                  0,
                )}
              </div>
            </section>
          ) : null}
          {step === 2 ? (
            <section className="eval-config-section">
              {pathField("harness", t("运行器与评分器", "Runner and grader"))}
              <Field
                label={t("原生评测命令", "Native runner command")}
                help={t(
                  "支持 {variant} 和 {flow_dir} 占位符。",
                  "Supports {variant} and {flow_dir} placeholders.",
                )}
              >
                <input
                  className="input mono"
                  value={spec.command}
                  onChange={(e) => set("command", e.target.value)}
                  placeholder="python eval/run.py --variant {variant}"
                />
              </Field>
              <p className="eval-hint">
                {t(
                  "创建后可审查材料，并单独运行一次基线／试评。代理辅助准备不会自动开始优化。",
                  "After preparation, review the materials and run a baseline separately. Assisted preparation does not start optimization automatically.",
                )}
              </p>
            </section>
          ) : null}
          {step === 3 ? (
            <section className="eval-config-section">
              <div className="eval-fields">
                <Field label={t("目标指标", "Target metric")}>
                  <input
                    className="input"
                    value={spec.metric}
                    onChange={(e) => set("metric", e.target.value)}
                  />
                </Field>
                <Field label={t("优化方向", "Direction")}>
                  <AppSelect
                    value={spec.direction}
                    onChange={(e) => set("direction", e.target.value)}
                  >
                    <option value="higher">{t("越高越好", "Higher is better")}</option>
                    <option value="lower">{t("越低越好", "Lower is better")}</option>
                  </AppSelect>
                </Field>
                {numeric("reps", t("每案例重复数", "Repetitions per case"), "1")}
                {numeric("plateau", t("停滞轮数", "Plateau rounds"), "3", 2)}
                {numeric(
                  "roundsLimit",
                  t("最大轮数", "Round limit"),
                  t("原生未设上限", "Native: no round cap"),
                )}
                {numeric(
                  "costLimit",
                  t("代理费用阈值（USD）", "Agent cost threshold (USD)"),
                  t("可选", "Optional"),
                  0.01,
                  0.01,
                )}
              </div>
              <Field label={t("保护指标（每行一个）", "Guardrail metrics (one per line)")}>
                <textarea
                  className="input"
                  rows={2}
                  value={spec.hold?.join("\n") ?? ""}
                  onChange={(e) => set("hold", lines(e.target.value))}
                  placeholder="cost_usd"
                />
              </Field>
              <details className="eval-advanced">
                <summary>
                  {t("指标方向与价格覆盖", "Metric directions and price overrides")}
                </summary>
                <JsonField
                  label={t("保护指标方向", "Guardrail directions")}
                  value={spec.directions ?? {}}
                  onChange={(value) => set("directions", value)}
                />
                <JsonField
                  label={t("每百万 token 价格", "Prices per million tokens")}
                  value={spec.prices ?? {}}
                  onChange={(value) => set("prices", value)}
                />
              </details>
            </section>
          ) : null}
          <div className="eval-toolbar">
            <button className="btn" disabled={step === 0} onClick={() => setStep(step - 1)}>
              {t("上一步", "Previous")}
            </button>
            <button className="btn" disabled={step === 3} onClick={() => setStep(step + 1)}>
              {t("下一步", "Next")}
            </button>
            <span className="eval-hint">{step + 1} / 4</span>
          </div>
        </>
      ) : null}
      {picker ? (
        <PathPicker
          client={client}
          workspaceId={workspaceId}
          preview={preview}
          t={t}
          onClose={() => setPicker(undefined)}
          onPick={(path) => {
            if (picker === "cachePrefixFile") set(picker, path);
            else if (spec.kind === "ratchet") set(picker, [...new Set([...spec[picker], path])]);
            setPicker(undefined);
          }}
        />
      ) : null}
      {imagePicker !== undefined && spec.kind === "judgment" ? (
        <PathPicker
          client={client}
          workspaceId={workspaceId}
          preview={preview}
          t={t}
          onClose={() => setImagePicker(undefined)}
          onPick={(path) => {
            set(
              "items",
              spec.items.map((item, index) =>
                index === imagePicker ? { ...item, images: [...(item.images ?? []), path] } : item,
              ),
            );
            setImagePicker(undefined);
          }}
        />
      ) : null}
    </div>
  );
}
