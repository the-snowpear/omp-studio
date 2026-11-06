import { useState } from "react";
import type {
  EvaluationRecord,
  EvaluationResultPage,
  EvaluationMetricRow,
} from "@omp-studio/studio-protocol";
import { evaluationComparable } from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import { asObject, displayNumber as number, configDifferences } from "./model";

type T = (cn: string, en: string) => string;
function NativeDetails({ value, t }: { value: unknown; t: T }) {
  return (
    <details className="eval-advanced">
      <summary>{t("原生数据", "Native data")}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
function Probability({ value }: { value: unknown }) {
  return (
    <span className="eval-probability">
      <span className="eval-probability-track">
        <i style={{ width: `${typeof value === "number" ? value * 100 : 0}%` }} />
      </span>
      {typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "—"}
    </span>
  );
}
function RatchetChart({ metrics, t }: { metrics: EvaluationMetricRow[]; t: T }) {
  const values = metrics
    .flatMap((r) => [r.metrics.train, r.metrics.test])
    .filter((x): x is number => x !== null && x !== undefined);
  if (!values.length) return null;
  const low = Math.min(...values),
    high = Math.max(...values),
    extent = high - low || 0.1;
  const x = (i: number) => 28 + i * (584 / Math.max(1, metrics.length - 1));
  const y = (n: number) => 130 - ((n - low) / extent) * 100;
  return (
    <figure className="eval-trend">
      <figcaption>
        <strong>{t("训练与留出集", "Train and held-out")}</strong>
        <span>
          <i className="eval-train-dot" />
          {t("训练", "Train")} <i className="eval-test-dot" />
          {t("留出", "Held-out")}
        </span>
      </figcaption>
      <svg
        viewBox="0 0 640 166"
        role="img"
        aria-label={t("各轮目标指标变化", "Target metric across rounds")}
      >
        {[0, 0.5, 1].map((p) => (
          <g key={p}>
            <line x1="28" x2="612" y1={30 + p * 100} y2={30 + p * 100} stroke="var(--border)" />
            <text x="8" y={34 + p * 100} fontSize="9" fill="var(--text-3)">
              {number(high - p * extent, 2)}
            </text>
          </g>
        ))}
        {(["train", "test"] as const).map((key) => (
          <g key={key} className={`eval-line-${key}`}>
            <polyline
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              points={metrics
                .map((m, i) => (m.metrics[key] == null ? "" : `${x(i)},${y(m.metrics[key]!)}`))
                .filter(Boolean)
                .join(" ")}
            />
            {metrics.map((m, i) =>
              m.metrics[key] == null ? null : (
                <circle key={m.id} cx={x(i)} cy={y(m.metrics[key]!)} r="3" fill="currentColor">
                  <title>
                    {m.label}: {number(m.metrics[key], 3)}
                  </title>
                </circle>
              ),
            )}
          </g>
        ))}
        {metrics.map((m, i) => (
          <text key={m.id} x={x(i)} y="154" textAnchor="middle" fontSize="10" fill="var(--text-3)">
            {m.label}
          </text>
        ))}
      </svg>
    </figure>
  );
}

export function EvaluationResults({
  record,
  page,
  t,
}: {
  record: EvaluationRecord;
  page: EvaluationResultPage | undefined;
  t: T;
}) {
  const [expanded, setExpanded] = useState<string>();
  const [metric, setMetric] = useState("ttft");
  const ranked =
    record.spec.kind === "benchmark"
      ? [...record.metrics].sort((a, b) => {
          const x = a.metrics[metric],
            y = b.metrics[metric];
          if (x == null) return y == null ? 0 : 1;
          if (y == null) return -1;
          return ["ttft", "ttftP95", "cold.ttft", "warm.ttft", "cost"].includes(metric)
            ? x - y
            : y - x;
        })
      : record.metrics;
  const kind = record.spec.kind;
  const columns: Array<[string, string]> =
    kind === "benchmark"
      ? record.spec.profile === "detailed"
        ? [
            ["ttft", "TTFT p50 · ms"],
            ["single.aggregateTps", t("单请求 tok/s", "Single tok/s")],
            ["parallel.aggregateTps", t("并发总 tok/s", "Parallel tok/s")],
            ["scaling", t("扩展倍率", "Scaling ×")],
            ["prefill.prefill", "Prefill tok/s"],
          ]
        : record.spec.profile === "cache"
          ? [
              ["cold.ttft", t("冷 TTFT p50 · ms", "Cold TTFT p50 · ms")],
              ["warm.ttft", t("热 TTFT p50 · ms", "Warm TTFT p50 · ms")],
              ["cacheProof", t("有缓存证据的配对", "Pairs with cache proof")],
              ["prewarmed", t("冷请求已预热", "Prewarmed cold requests")],
            ]
          : [
              ["ttft", "TTFT p50 · ms"],
              ["ttftP95", "p95 · ms"],
              ["prefill", "Prefill tok/s"],
              ["decode", "Decode tok/s"],
              ["cost", "USD / req"],
            ]
      : kind === "judgment" ? [["mean", t("均值 / P(是)", "Mean / P(yes)")], ["confidence", t("平均置信度", "Mean confidence")], ["answered", t("成功样本数", "Answered items")]] : kind === "instruction"
        ? [
            ["turnsPassed", t("通过轮数", "Turns passed")],
            ["actionsPassed", t("正确动作", "Actions passed")],
            ["durationMs", t("耗时 ms", "Duration ms")],
            ["cost", "USD"],
          ]
        : [
            ["train", t("训练均值", "Train mean")],
            ["test", t("留出均值", "Held-out mean")],
            ["testHalf", t("95% 区间半宽", "95% CI half-width")],
          ];
  const best = asObject(record.detail.best).variant;
  return (
    <>
      {kind === "ratchet" ? <RatchetChart metrics={record.metrics} t={t} /> : null}
      {kind === "benchmark" ? (
        <div className="eval-toolbar eval-ranking">
          <label>
            {t("排名指标", "Rank by")}
            <AppSelect value={metric} onChange={(e) => setMetric(e.target.value)}>
              <option value="ttft">TTFT p50 ↓</option>
              {record.spec.kind === "benchmark" && record.spec.profile === "cache" ? (
                <>
                  <option value="cold.ttft">{t("冷 TTFT ↓", "Cold TTFT ↓")}</option>
                  <option value="warm.ttft">{t("热 TTFT ↓", "Warm TTFT ↓")}</option>
                </>
              ) : null}
              <option value="decode">Decode ↑</option>
              <option value="prefill">Prefill ↑</option>
              <option value="parallel.aggregateTps">
                {t("并发吞吐 ↑", "Parallel throughput ↑")}
              </option>
              <option value="cost">USD ↓</option>
            </AppSelect>
          </label>
        </div>
      ) : null}
      {record.metrics.length ? (
        <div className="eval-table-wrap">
          <table className="eval-table">
            <thead>
              <tr>
                <th>{kind === "ratchet" ? t("版本", "Variant") : kind === "judgment" ? t("问题", "Question") : t("模型", "Model")}</th>
                <th>{t("进度／判定", "Progress / decision")}</th>
                {columns.map(([key, label]) => (
                  <th key={key} className="numeric">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ranked.map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.label}</strong>
                    {row.id === best ? <span className="eval-tag">{t("最佳", "Best")}</span> : null}
                    {row.detail?.change ? <small>{String(row.detail.change)}</small> : null}
                    <NativeDetails value={row.detail ?? row.metrics} t={t} />
                  </td>
                  <td>
                    {kind === "ratchet"
                      ? ({
                          baseline: t("基线", "Baseline"),
                          keep: t("保留", "Keep"),
                          revert: t("还原", "Revert"),
                          rerun: t("重测", "Rerun"),
                        }[row.state] ?? row.state)
                      : `${row.completed} / ${row.total}`}
                    {row.failed ? (
                      <small className="eval-error">
                        {row.failed} {t("失败", "failed")}
                      </small>
                    ) : null}
                    {Array.isArray(row.detail?.reasons)
                      ? row.detail.reasons.map((reason, i) => (
                          <small key={i}>{String(reason)}</small>
                        ))
                      : null}
                  </td>
                  {columns.map(([key]) => (
                    <td className="numeric" key={key}>
                      {number(row.metrics[key], key === "cost" ? 5 : kind === "ratchet" ? 3 : 1)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {kind === "benchmark" &&
      (record.spec.profile === "mix" || record.spec.profile === "detailed") ? (
        <details className="eval-advanced">
          <summary>{t("各阶段独立统计", "Statistics by phase")}</summary>
          <div className="eval-table-wrap">
            <table className="eval-table">
              <thead>
                <tr>
                  <th>{t("模型 / 阶段", "Model / phase")}</th>
                  <th>TTFT p50 / p95</th>
                  <th>Prefill p50</th>
                  <th>Decode p50</th>
                  <th>Total p50</th>
                  <th>USD / req</th>
                </tr>
              </thead>
              <tbody>
                {record.metrics.flatMap((row) =>
                  Object.entries(
                    asObject(
                      record.spec.kind === "benchmark" && record.spec.profile === "mix"
                        ? row.detail?.byChallenge
                        : row.detail?.phases,
                    ),
                  ).map(([phase, raw]) => {
                    const entry = asObject(raw),
                      stats = asObject(entry.stats ?? raw);
                    return (
                      <tr key={row.id + phase}>
                        <td>
                          {row.label}
                          <small>{phase}</small>
                        </td>
                        <td>
                          {number(asObject(stats.ttftMs).p50)} /{" "}
                          {number(asObject(stats.ttftMs).p95)}
                        </td>
                        <td>{number(asObject(stats.prefillTps).p50)}</td>
                        <td>{number(asObject(stats.generationTps).p50)}</td>
                        <td>{number(asObject(stats.tokensPerSecond).p50)}</td>
                        <td>{number(stats.cost, 5)}</td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
      {kind === "benchmark" && record.spec.profile === "mix" ? (
        <p className="eval-hint">
          {t(
            "概览采用 Chat 指标；展开原生数据查看各工作负载的独立统计。",
            "Overview uses Chat metrics. Native details retain each workload's statistics.",
          )}
        </p>
      ) : null}
      <div className="eval-section-heading">
        <h3>
          {kind === "judgment"
            ? t("样本结果", "Item results")
            : kind === "instruction"
              ? t("逐轮记录", "Turn records")
              : kind === "ratchet"
                ? t("轮次证据", "Round evidence")
                : t("请求明细", "Request details")}
        </h3>
        <span>
          {page?.total ?? 0} {t("条", "records")}
        </span>
      </div>
      {!page?.rows.length ? (
        <div className="eval-inline-empty">
          {t(
            "尚无已完成的结果。运行后的记录会自动出现在这里。",
            "No settled results yet. Completed work appears here automatically.",
          )}
        </div>
      ) : (
        <div className="eval-result-list">
          {page.rows.map((row) => {
            const data = asObject(row.data),
              open = expanded === row.key,
              failed = !!data.error || data.ok === false || data.passed === false;
            const source =
              record.spec.kind === "judgment"
                ? record.spec.items.find((item) => String(item.key) === String(data.key ?? row.key))
                : undefined;
            return (
              <article className={`eval-result-item${open ? " expanded" : ""}`} key={row.key}>
                <button
                  className="eval-result-toggle"
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? undefined : row.key)}
                >
                  <span className={`eval-result-dot${failed ? " failed" : ""}`} />
                  <span>
                    <strong>
                      {kind === "instruction"
                        ? `${t("第", "Turn")} ${data.turn} ${t("轮", "")}`
                        : kind === "ratchet"
                          ? String(data.variant)
                          : String(data.key ?? row.key.split(":").at(-1))}
                    </strong>
                    {row.model ? <small>{row.model}</small> : null}
                  </span>
                  <span className="eval-result-summary">
                    {kind === "judgment" ? (
                      <span className="eval-answer-summary">
                        {Object.entries(asObject(data.answers))
                          .slice(0, 3)
                          .map(([id, raw]) => {
                            const answer = asObject(raw);
                            return (
                              <span key={id}>
                                {id} ·{" "}
                                {answer.type === "bool"
                                  ? `${number(Number(answer.bool) * 100)}%`
                                  : String(answer.choice ?? number(answer.score, 3))}
                              </span>
                            );
                          })}
                      </span>
                    ) : kind === "instruction" ? (
                      failed ? (
                        t("未通过", "Failed")
                      ) : (
                        t("通过", "Passed")
                      )
                    ) : kind === "ratchet" ? (
                      String(data.change ?? "")
                    ) : row.phase === "cache" ? (
                      t("冷／热配对", "Cold / warm pair")
                    ) : (
                      `${number(data.ttftMs, 0)} ms`
                    )}
                    <span className="eval-chevron">{open ? "−" : "+"}</span>
                  </span>
                </button>
                {open ? (
                  <div className="eval-result-body">
                    {failed ? (
                      <p className="eval-error">
                        {String(data.error ?? data.failure ?? t("请求未成功", "Request failed"))}
                      </p>
                    ) : null}
                    {source ? (
                      <section>
                        <h4>{t("原始样本", "Original input")}</h4>
                        <pre>
                          {typeof source.state === "string"
                            ? source.state
                            : JSON.stringify(source.state, null, 2)}
                        </pre>
                        {source.images?.length ? (
                          <p>
                            {t("图片", "Images")}: {source.images.join(", ")}
                          </p>
                        ) : null}
                      </section>
                    ) : null}
                    {kind === "judgment"
                      ? Object.entries(asObject(data.answers)).map(([id, raw]) => {
                          const answer = asObject(raw);
                          return (
                            <section key={id}>
                              <h4>{id}</h4>
                              <p>
                                {record.spec.kind === "judgment"
                                  ? record.spec.questions[id]?.instructions
                                  : ""}
                              </p>
                              {answer.type === "bool" ? (
                                <Probability value={answer.bool} />
                              ) : (
                                <>
                                  <strong>
                                    {String(answer.choice ?? number(answer.score, 3))}
                                  </strong>
                                  <div className="eval-probabilities">
                                    {Object.entries(asObject(answer.probabilities)).map(
                                      ([label, probability]) => (
                                        <div key={label}>
                                          <span>{label}</span>
                                          <Probability value={probability} />
                                        </div>
                                      ),
                                    )}
                                  </div>
                                  <small>
                                    {t("置信度", "Confidence")} ·{" "}
                                    {number(Number(answer.confidence) * 100)}%
                                  </small>
                                </>
                              )}
                            </section>
                          );
                        })
                      : null}
                    {kind === "instruction" ? (
                      <div className="eval-fields">
                        <section>
                          <h4>{t("预期结果", "Expected")}</h4>
                          <pre>{String(data.expected ?? "")}</pre>
                        </section>
                        <section>
                          <h4>{t("模型响应", "Response")}</h4>
                          <pre>{String(data.response ?? "")}</pre>
                        </section>
                      </div>
                    ) : null}
                    {row.phase === "cache" ? (
                      <>
                        {data.coldAlreadyWarm ? (
                          <p className="eval-warning">
                            {t(
                              "冷请求已观察到缓存复用，不能作为真正的冷基线。",
                              "The cold request already reused cache and is not a true cold baseline.",
                            )}
                          </p>
                        ) : null}
                        <div className="eval-fields">
                          {["cold", "warm"].map((phase) => {
                            const part = asObject(data[phase]),
                              result = asObject(part.result),
                              usage = asObject(part.usage);
                            return (
                              <section key={phase}>
                                <h4>
                                  {phase === "cold" ? t("冷请求", "Cold") : t("热请求", "Warm")}
                                </h4>
                                <dl className="eval-facts">
                                  <dt>TTFT</dt>
                                  <dd>{number(result.ttftMs)} ms</dd>
                                  <dt>{t("缓存读取", "Cache read")}</dt>
                                  <dd>{number(usage.cacheReadTokens, 0)} tok</dd>
                                  <dt>{t("缓存写入", "Cache write")}</dt>
                                  <dd>{number(usage.cacheWriteTokens, 0)} tok</dd>
                                </dl>
                                <p className="eval-hint">
                                  {Array.isArray(part.observations)
                                    ? part.observations
                                        .map(
                                          (proof) =>
                                            ({
                                              prompt_cache_read_observed: t(
                                                "已观察到提示缓存读取",
                                                "Prompt cache read observed",
                                              ),
                                              prompt_cache_write_observed: t(
                                                "已观察到提示缓存写入",
                                                "Prompt cache write observed",
                                              ),
                                              response_cache_hit_observed: t(
                                                "已观察到响应缓存命中",
                                                "Response cache hit observed",
                                              ),
                                              no_provider_proof: t(
                                                "供应商未提供缓存证据",
                                                "No provider proof",
                                              ),
                                            })[String(proof)] ?? String(proof),
                                        )
                                        .join(" · ")
                                    : t("无缓存证据", "No cache evidence")}
                                </p>
                              </section>
                            );
                          })}
                        </div>
                      </>
                    ) : null}
                    {kind === "ratchet" ? (
                      <>
                        <p>{Array.isArray(data.reasons) ? data.reasons.join(" · ") : ""}</p>
                        <GateEvidence value={data.gate} t={t} />
                        <NativeDetails
                          value={{ train: data.train, heldOut: data.test, gate: data.gate }}
                          t={t}
                        />
                      </>
                    ) : (
                      <NativeDetails value={row.data} t={t} />
                    )}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}

function GateEvidence({ value, t }: { value: unknown; t: T }) {
  const gate = asObject(value),
    deltas = asObject(gate.deltas);
  return (
    <>
      {Array.isArray(gate.warnings)
        ? gate.warnings.map((warning, index) => (
            <p className="eval-warning" key={index}>
              {String(warning)}
            </p>
          ))
        : null}
      {Object.keys(deltas).length ? (
        <div className="eval-table-wrap">
          <table className="eval-table">
            <thead>
              <tr>
                <th>{t("目标／保护指标", "Target / guardrail")}</th>
                <th>{t("训练变化", "Train delta")}</th>
                <th>{t("留出变化", "Held-out delta")}</th>
                <th>{t("原生判定", "Native verdict")}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(deltas).map(([metric, raw]) => {
                const delta = asObject(raw),
                  train = asObject(delta.train),
                  test = asObject(delta.test);
                return (
                  <tr key={metric}>
                    <td>{metric}</td>
                    <td>
                      {number(train.mean, 4)} ± {number(train.half, 4)}
                    </td>
                    <td>
                      {number(test.mean, 4)} ± {number(test.half, 4)}
                    </td>
                    <td>{String(test.verdict ?? "—")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {gate.plateau ? (
        <p>
          {t(
            "原生判定已进入停滞，应检查剩余失败原因。",
            "The native gate detected a plateau. Review the remaining failure causes.",
          )}
        </p>
      ) : null}
    </>
  );
}
export function EvaluationComparison({
  before,
  after,
  t,
}: {
  before: EvaluationRecord;
  after: EvaluationRecord;
  t: T;
}) {
  const comparable = evaluationComparable(before, after),
    differences = configDifferences(before, after);
  return (
    <div className="eval-comparison">
      <h3>
        {before.title} <span>→</span> {after.title}
      </h3>
      <p className={comparable ? "eval-hint" : "eval-warning"}>
        {comparable
          ? t(
              "配置一致，可结合样本规模解读指标变化。",
              "Matching configuration. Interpret changes alongside sample size.",
            )
          : t(
              "配置或 Runtime 版本不同，以下数值不构成直接的改善／回退结论。",
              "Configuration or Runtime versions differ. These values do not establish an improvement or regression.",
            )}
      </p>
      {differences.length ? (
        <details open>
          <summary>{t("配置差异", "Configuration differences")}</summary>
          <dl className="eval-config-diff">
            {differences.map((d) => (
              <div key={d.field}>
                <dt>{d.field}</dt>
                <dd>
                  <del>{d.before}</del>
                  <span>{d.after}</span>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      <div className="eval-table-wrap">
        <table className="eval-table">
          <thead>
            <tr>
              <th>{t("模型／版本", "Model / variant")}</th>
              <th>{t("指标", "Metric")}</th>
              <th>{t("之前", "Before")}</th>
              <th>{t("之后", "After")}</th>
              <th>Δ</th>
            </tr>
          </thead>
          <tbody>
            {after.metrics.flatMap((row) => {
              const previous = before.metrics.find((r) => r.id === row.id);
              return Object.entries(row.metrics)
                .filter(([, value]) => value !== null)
                .map(([key, value]) => (
                  <tr key={`${row.id}:${key}`}>
                    <td>{row.label}</td>
                    <td>{key}</td>
                    <td>{number(previous?.metrics[key], 3)}</td>
                    <td>{number(value, 3)}</td>
                    <td>
                      {typeof previous?.metrics[key] === "number" && value !== null
                        ? number(value - previous.metrics[key]!, 3)
                        : "—"}
                    </td>
                  </tr>
                ));
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
