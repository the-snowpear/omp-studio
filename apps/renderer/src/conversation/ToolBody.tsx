import { RasterPreview, TerminalGraphicView } from "../TerminalGraphicView";
import { TerminalGraphicsDecoder } from "../terminalGraphics";
import { createContext, memo, useContext, useMemo, type ComponentProps, type MouseEvent } from "react";
import type { JsonValue } from "@omp-studio/client-contract";
import { Icon } from "../icons";
import { bashDisplay } from "./bashDisplay";
import { ChunkedRows, ChunkedText } from "./textChunks";
import { jsonRecord, jsonString, type ToolView } from "./conversationViewModel";
import {
  askAnswer,
  jsonNumber,
  jsonStringArray,
  parseTaskBrief,
  taskJobs,
  toolFields,
  toolKind,
} from "./toolMeta";
import { ToolCardScroll } from "./useToolCardFollowScroll";

const ToolCardLive = createContext(false);

function ScrollPane(props: Omit<ComponentProps<typeof ToolCardScroll>, "follow">) {
  return <ToolCardScroll follow={useContext(ToolCardLive)} {...props} />;
}

export function TruncationMark() {
  return (
    <span className="chip gray xs" role="note" aria-label="已截断">
      已截断
    </span>
  );
}

function displayValue(value: JsonValue | undefined): string | number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

function Kv({ pairs }: { pairs: ReadonlyArray<readonly [string, JsonValue | string | number | undefined]> }) {
  const bits = pairs.filter((pair) => pair[1] !== undefined && pair[1] !== "" && pair[1] !== null);
  if (bits.length === 0) return null;
  return (
    <div className="tc-kv">
      {bits.map(([label, value]) => (
        <span key={label} className="kv">
          <span className="k">{label}</span>
          <span className="v">{String(displayValue(value as JsonValue))}</span>
        </span>
      ))}
    </div>
  );
}

function MediaList({ value, alt = "Image / 图片" }: { value: unknown; alt?: string }) {
  const items = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return items.length === 0 ? null : <div className="tool-media-list">{items.slice(0, 8).map((item, i) => <RasterPreview key={i} value={item} alt={alt} />)}</div>;
}

function ToolMedia({ tool }: { tool: ToolView }) {
  const data = jsonRecord(tool.result?.data);
  const graphics = useMemo(() => new TerminalGraphicsDecoder().push(tool.result?.output ?? tool.output ?? ""), [tool.result?.output, tool.output]);
  return <>
    <MediaList value={data?.media} />
    {graphics.images.map((image, index) => <TerminalGraphicView key={index} image={image} />)}
    {graphics.errors.map((error, index) => <p role="status" key={index}>{error}</p>)}
    {typeof data?.mediaOmitted === "number" ? <p role="status">{data.mediaOmitted} image(s) omitted: unsupported format or size limit / 图片超限或格式不受支持</p> : null}
  </>;
}

/**
 * \u6309\u884c\u6e32\u67d3\u7684\u5de5\u5177\u5361\u7684\u884c\u6570\u4e0a\u9650\uff0c\u4e0e `BASH_DISPLAY_MAX_ROWS` \u5bf9\u9f50\u3002
 *
 * bash \u5361\u65e9\u5c31\u6709\u8fd9\u6761\u4e0a\u9650\uff0c\u6309\u884c\u6e32\u67d3\u7684 Read / Write / Edit / Grep / Glob / Lsp \u4e00\u76f4\u6ca1\u6709\uff1a
 * \u4e00\u6b21 Read \u4e24\u4e07\u884c\u7684\u6587\u4ef6\u4f1a\u5728\u4e00\u5f20 220px \u9ad8\u7684\u5361\u91cc\u6302\u51fa\u516d\u4e07\u4e2a\u5143\u7d20\uff0c\u800c\u865a\u62df\u5217\u8868\u53ea\u9650\u5236\u6302\u8f7d
 * \u884c\u6570\u3001\u4e0d\u9650\u5236\u5355\u884c\u5185\u7684\u8282\u70b9\u6570\uff0c\u4e8e\u662f\u539f\u751f\u5185\u5b58\u968f\u56de\u770b\u6df1\u5ea6\u5355\u8c03\u4e0a\u6da8\u3002
 *
 * \u4e0e bash \u76f8\u53cd\uff0c\u8fd9\u91cc\u4fdd\u7559**\u5f00\u5934**\uff1abash \u662f\u4e00\u6761\u5728\u8dd1\u7684\u65e5\u5fd7\uff0c\u6709\u4ef7\u503c\u7684\u662f\u5c3e\u90e8\uff1b\u800c Read \u9884\u89c8\u3001
 * diff\u3001grep/glob \u7ed3\u679c\u90fd\u662f\u4ece\u5934\u8bfb\u7684\u5217\u8868\u3002
 */
export const TOOL_ROWS_MAX = 1500;

/** \u4fdd\u7559\u5f00\u5934\u81f3\u591a `TOOL_ROWS_MAX` \u884c\uff1b`omitted` \u662f\u88ab\u4e22\u6389\u7684\u5c3e\u90e8\u884c\u6570\u3002 */
function capRows<T>(rows: readonly T[], max = TOOL_ROWS_MAX): { rows: readonly T[]; omitted: number } {
  if (rows.length <= max) return { rows, omitted: 0 };
  return { rows: rows.slice(0, max), omitted: rows.length - max };
}

function OmittedRows({ count }: { count: number }) {
  return <div className="tc-note">\u53e6\u6709 {count} \u884c\u672a\u663e\u793a</div>;
}

function CodeLines({ lines, start = 1 }: { lines: readonly string[]; start?: number }) {
  const capped = capRows(lines);
  return (
    <ScrollPane className="tc-code tool-card-scroll" data-tool-scroll="both">
      <ChunkedRows
        count={capped.rows.length}
        chunkClassName="cv-chunk-rows"
        renderRow={(index) => (
          <div key={index} className="cl">
            <span className="ln">{start + index}</span>
            <span className="lx">{capped.rows[index] || "\u00a0"}</span>
          </div>
        )}
      />
      {capped.omitted > 0 ? <OmittedRows count={capped.omitted} /> : null}
    </ScrollPane>
  );
}

function prettyJson(value: JsonValue): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

function JsonBlock({ value }: { value: JsonValue }) {
  return <ScrollPane className="codeblock tc-json">{prettyJson(value)}</ScrollPane>;
}

function prettyText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
}

function stringLines(value: JsonValue | undefined): string[] | undefined {
  const listed = jsonStringArray(value);
  if (listed) return listed;
  if (typeof value === "string") return value.split("\n");
  return undefined;
}

function contentLines(value: JsonValue | undefined): string[] | undefined {
  const listed = jsonStringArray(value);
  if (listed) return listed;
  if (typeof value === "string") return prettyText(value).split("\n");
  if (value !== undefined && typeof value === "object") return JSON.stringify(value, null, 2).split("\n");
  return undefined;
}

function outputText(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((line) => (Array.isArray(line) ? String(line[0] ?? "") : String(line))).join("\n");
  }
  return JSON.stringify(value, null, 2);
}

function durationText(value: JsonValue | undefined): string | undefined {
  const milliseconds = jsonNumber(value);
  if (milliseconds === undefined) return undefined;
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds % 1000 === 0 ? 1 : 2)}s`;
}

/**
 * Preview gallery cards pass their whole `{ kind, name, … }` display record as
 * arguments, so dumping it as Args is noise. A real tool that merely happens to
 * take a `kind` argument must still show its args.
 */
function isPreviewCard(fields: { readonly [key: string]: JsonValue }): boolean {
  return jsonString(fields.kind) !== undefined && jsonString(fields.name) !== undefined;
}

function DefaultBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const args = fields.args !== undefined
    ? fields.args
    : isPreviewCard(fields)
      ? undefined
      : tool.arguments;
  const output = fields.output;
  const summary = jsonString(fields.summary);
  return (
    <>
      {args !== undefined ? (
        <>
          <div className="tc-label">Args</div>
          <JsonBlock value={args} />
        </>
      ) : null}
      {output !== undefined ? (
        <>
          <div className="tc-label">Output</div>
          <ScrollPane className="codeblock"><ChunkedText text={outputText(output) ?? ""} /></ScrollPane>
        </>
      ) : null}
      {args === undefined && output === undefined && summary ? <div className="tc-summary">{summary}</div> : null}
    </>
  );
}

function MatchTree({ matches, count }: { matches: JsonValue | undefined; count?: string }) {
  const files: Array<{ file: string; count?: number; rows: Array<{ line: string; text: string }> }> = [];
  if (Array.isArray(matches)) {
    const grouped = new Map<string, { count?: number; rows: Array<{ line: string; text: string }> }>();
    for (const entry of matches) {
      const record = jsonRecord(entry);
      const file = jsonString(record?.file) ?? jsonString(record?.path);
      const text = jsonString(record?.text) ?? jsonString(record?.content);
      if (!file) continue;
      const group = grouped.get(file) ?? { rows: [] };
      const fileCount = jsonNumber(record?.count);
      if (fileCount !== undefined) group.count = fileCount;
      if (text !== undefined) {
        group.rows.push({ line: String(jsonNumber(record?.line) ?? jsonString(record?.line) ?? ""), text });
      }
      grouped.set(file, group);
    }
    for (const [file, group] of grouped) files.push({ file, ...group });
  }
  // 命中总数是无界维度：一次 grep 命中上万行时，按文件分组的结构照样会铺出上万个
  // `.tt-hit`。先按总命中数截断，再把每个文件的命中行分块。
  let budget = TOOL_ROWS_MAX;
  const shown: typeof files = [];
  let omitted = 0;
  for (const file of files) {
    if (budget <= 0) {
      omitted += file.rows.length;
      continue;
    }
    if (file.rows.length <= budget) {
      shown.push(file);
      budget -= file.rows.length;
      continue;
    }
    shown.push({ ...file, rows: file.rows.slice(0, budget) });
    omitted += file.rows.length - budget;
    budget = 0;
  }
  return (
    <>
      {count ? <div className="tc-summary">{count}</div> : null}
      <ScrollPane className="tc-tree">
        {shown.map((file) => (
          <div key={file.file}>
            <div className="tt-file">{file.file}{file.count === undefined ? null : ` · ${file.count}`}</div>
            <ChunkedRows
              count={file.rows.length}
              renderRow={(index) => {
                const row = file.rows[index]!;
                return (
                  <div key={`${row.line}-${index}`} className="tt-hit">
                    <span className="m-line">{row.line}</span>
                    <span className="m-text">{row.text}</span>
                  </div>
                );
              }}
            />
          </div>
        ))}
        {omitted > 0 ? <OmittedRows count={omitted} /> : null}
      </ScrollPane>
    </>
  );
}

function inlineCode(text: string): Array<string | { code: string }> {
  const parts: Array<string | { code: string }> = [];
  const pattern = /`([^`]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ code: match[1]! });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function RichText({ text }: { text: string }) {
  return (
    <>
      {inlineCode(text).map((part, index) => (
        typeof part === "string" ? <span key={index}>{part}</span> : <span key={index} className="chip-code">{part.code}</span>
      ))}
    </>
  );
}

function ReadBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const offset = jsonNumber(fields.offset) ?? jsonNumber(fields.startLine);
  const displayContent = jsonRecord(fields.displayContent);
  const preview = stringLines(fields.preview) ?? stringLines(displayContent?.text);
  const summary = jsonString(fields.summary);
  return (
    <>
      <Kv pairs={[["行", fields.lines ?? fields.totalLines], ["编码", fields.encoding], ["大小", fields.size ?? fields.fileSize], ["问题", fields.q ?? fields.question]]} />
      {preview ? <CodeLines lines={preview} start={offset ?? 1} /> : summary ? <div className="tc-summary">{summary}</div> : tool.output ? <CodeLines lines={tool.output.split("\n")} start={offset ?? 1} /> : null}
      <MediaList value={fields.media ?? fields.image ?? fields.images} alt="读取结果" />
    </>
  );
}

function WriteBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const preview = stringLines(fields.preview) ?? contentLines(fields.content);
  const created = fields.created === true ? true : fields.created === false ? false : undefined;
  const lines = jsonNumber(fields.lines) ?? preview?.length;
  const operation = created === true ? "新建" : created === false ? "覆盖" : "写入";
  return (
    <>
      <Kv pairs={[
        [operation, lines !== undefined ? `${lines} 行` : ""],
        ["编码", fields.encoding],
      ]} />
      {preview ? <CodeLines lines={preview} /> : null}
      {fields.executable === true ? <div className="tc-note">已设为可执行</div> : null}
    </>
  );
}

function EditBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const diff = fields.diff;
  const summary = jsonString(fields.summary) ?? jsonString(fields.i);
  const summaryNode = summary ? <div className="tc-edit-summary">{summary}</div> : null;
  if (typeof diff === "string" && diff.length > 0) {
    const capped = capRows(diff.split("\n"));
    return (
      <>
        {summaryNode}
        <ScrollPane className="tc-diff tool-card-scroll" data-tool-scroll="both">
          <ChunkedRows
            count={capped.rows.length}
            chunkClassName="cv-chunk-rows"
            renderRow={(index) => {
              const line = capped.rows[index]!;
              const match = /^([ +\-])(\d*)\|(.*)$/.exec(line);
              const marker = match?.[1] ?? " ";
              const cls = marker === "+" ? "add" : marker === "-" ? "del" : "";
              return (
                <div key={index} className={`dl ${cls}`}>
                  <span className="ln">{match?.[2] ?? ""}</span>
                  <span className="dm" aria-hidden="true">{marker === "-" ? "−" : marker}</span>
                  <span className="lc">{match?.[3] ?? line}</span>
                </div>
              );
            }}
          />
          {capped.omitted > 0 ? <OmittedRows count={capped.omitted} /> : null}
        </ScrollPane>
      </>
    );
  }
  if (!Array.isArray(diff) || diff.length === 0) {
    return (
      <>
        {summaryNode}
        {tool.output ? <ScrollPane className="codeblock">{tool.output}</ScrollPane> : <DefaultBody tool={tool} />}
      </>
    );
  }
  const cappedDiff = capRows(diff);
  return (
    <>
      {summaryNode}
      <ScrollPane className="tc-diff tool-card-scroll" data-tool-scroll="both">
        <ChunkedRows
          count={cappedDiff.rows.length}
          chunkClassName="cv-chunk-rows"
          renderRow={(index) => {
            const row = cappedDiff.rows[index];
            if (!Array.isArray(row)) return null;
            const mark = row[0] === "+" ? "+" : row[0] === "-" ? "−" : " ";
            const cls = row[0] === "+" ? "add" : row[0] === "-" ? "del" : "";
            return (
              <div key={index} className={`dl ${cls}`}>
                <span className="ln">{String(row[1] ?? "")}</span>
                <span className="ln">{String(row[2] ?? "")}</span>
                <span className="dm" aria-hidden="true">{mark}</span>
                <span className="lc">{String(row[3] ?? "")}</span>
              </div>
            );
          }}
        />
        {cappedDiff.omitted > 0 ? <OmittedRows count={cappedDiff.omitted} /> : null}
      </ScrollPane>
    </>
  );
}

function BashBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const cmd = jsonString(fields.cmd) ?? jsonString(fields.command) ?? jsonString(fields.target) ?? "";
  const exit = jsonNumber(fields.exit) ?? jsonNumber(fields.exitCode);
  const running = tool.status === "running";
  const failed = tool.status === "failed" || (!running && exit !== undefined && exit !== 0);
  // Streaming output re-renders this card on every published frame. `bashDisplay`
  // strips ANSI, slices the retained tail and merges same-class line runs, so it
  // must not rerun while the output itself is unchanged.
  const blocks = useMemo(() => bashDisplay(fields.output).blocks, [fields.output]);
  return (
    <>
      <Kv pairs={[["cwd", fields.cwd]]} />
      <ScrollPane className="codeblock">
        {cmd ? <div className="c-cmd">$ {cmd}</div> : null}
        {blocks.map((block, index) => (
          <div key={index} className={block.cls || undefined}>
            <ChunkedText text={block.text || "\u00a0"} />
          </div>
        ))}
      </ScrollPane>
      <div className="tc-foot">
        {running ? (
          <span className="chip blue xs">运行中</span>
        ) : (
          <span className={`chip ${failed ? "red" : "green"} xs`}>
            {exit !== undefined ? `exit ${exit}` : failed ? "failed" : "exit 0"}
          </span>
        )}
        {jsonString(fields.dur) || durationText(fields.wallTimeMs) ? (
          <span className="tc-dur">{jsonString(fields.dur) ?? durationText(fields.wallTimeMs)}</span>
        ) : null}
      </div>
    </>
  );
}

function AskBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const question = jsonString(fields.question) ?? jsonString(fields.prompt) ?? jsonString(fields.target) ?? "";
  const picked = askAnswer(tool);
  const raw = fields.options;
  const options: Array<{ label: string; selected: boolean; rec: boolean }> = [];
  if (Array.isArray(raw)) {
    for (const option of raw) {
      if (typeof option === "string") {
        options.push({ label: option, selected: option === picked, rec: false });
      } else {
        const record = jsonRecord(option);
        const label = jsonString(record?.label);
        if (!label) continue;
        options.push({
          label,
          selected: record?.selected === true || label === picked,
          rec: record?.rec === true,
        });
      }
    }
  }
  if (picked && !options.some((option) => option.label === picked)) {
    options.push({ label: picked, selected: true, rec: false });
  }
  if (!options.length && !question) return <div className="tc-note">无回答</div>;
  return (
    <div className="tc-ask">
      {question ? <div className="ask-q">{question}</div> : null}
      {options.length ? (
        <div className="ask-opts">
          {options.map((option) => (
            <div key={option.label} className={`ask-opt ${option.selected ? "is-on" : "is-off"}`}>
              <span className={`ask-mark${option.selected ? " on" : ""}`} aria-hidden="true">
                {option.selected ? <Icon name="check" extra="sm" /> : null}
              </span>
              <span className="ask-label">{option.label}</span>
              {option.rec ? <span className="chip purple xs">推荐</span> : null}
              {option.selected ? <span className="ask-chosen">已选</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TaskBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const brief = parseTaskBrief(fields);
  const jobs = taskJobs(fields);
  const progress = Array.isArray(fields.progress) ? fields.progress : [];
  const spawnAgent = jsonString(jsonRecord(fields.spawn)?.agent);
  return (
    <div className="tc-task">
      {brief.goal ? (
        <div className="task-sec">
          <div className="task-h">Goal</div>
          <div className="task-p">{brief.goal.split("\n").map((line, index) => (
            <span key={index}>{index > 0 ? <br /> : null}<RichText text={line} /></span>
          ))}</div>
        </div>
      ) : null}
      {brief.constraints.length ? (
        <div className="task-sec">
          <div className="task-h">Constraints</div>
          <ul className="task-ul">
            {brief.constraints.map((line) => (
              <li key={line}><RichText text={line} /></li>
            ))}
          </ul>
        </div>
      ) : null}
      {jobs.length && progress.length === 0 ? (
        <div className="task-agents">
          {jobs.map((job) => {
            const agent = job.agent ?? spawnAgent ?? "";
            const tag = agent && !/^(default|worker)$/i.test(agent);
            return (
              <div key={job.name} className="task-agent">
                <span className="task-dot" aria-hidden="true" />
                <span className="task-aname">{job.name}</span>
                {tag ? <span className="task-atype">[{agent}]</span> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {progress.length ? (
        <div className="task-agents">
          {progress.map((entry, index) => {
            const item = jsonRecord(entry) ?? {};
            const name = jsonString(item.id) ?? jsonString(item.name) ?? `agent-${index + 1}`;
            return (
              <div key={name} className="task-agent">
                <span className="task-dot" aria-hidden="true" />
                <span className="task-aname">{name}</span>
                <span className="task-atype">[{jsonString(item.status) ?? "pending"}]</span>
                {durationText(item.durationMs) ? <span className="tc-dur">{durationText(item.durationMs)}</span> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {!brief.goal && !brief.constraints.length && !jobs.length && !progress.length ? <DefaultBody tool={tool} /> : null}
    </div>
  );
}

function GrepBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const matchCount = jsonNumber(fields.matchCount);
  const fileCount = jsonNumber(fields.fileCount);
  const count = jsonString(fields.count) ?? (matchCount === undefined
    ? undefined
    : `${matchCount} matches${fileCount === undefined ? "" : ` · ${fileCount} files`}`);
  const matches = Array.isArray(fields.matches) ? fields.matches : fields.fileMatches;
  const display = jsonString(fields.displayContent);
  return (
    <>
      <Kv pairs={[
        ["pattern", fields.pattern],
        ["lang", fields.lang],
        ["scope", fields.paths ?? fields.path ?? fields.glob],
        ["searched", fields.searched],
      ]} />
      {Array.isArray(matches) ? (
        <>
          <MatchTree
            matches={matches}
            {...(count === undefined ? {} : { count })}
          />
          {display ? <ScrollPane className="codeblock">{display}</ScrollPane> : null}
        </>
      ) : tool.output ? <ScrollPane className="codeblock">{tool.output}</ScrollPane> : null}
    </>
  );
}

function GlobBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const listed = jsonStringArray(fields.files);
  const files = listed ?? (tool.output ? tool.output.split("\n").filter(Boolean) : []);
  const cappedFiles = capRows(files);
  return (
    <>
      <Kv pairs={[
        ["pattern", fields.pattern ?? fields.target],
        ["files", files.length],
      ]} />
      <ScrollPane className="tc-tree">
        {files.length ? (
          <>
            <ChunkedRows
              count={cappedFiles.rows.length}
              renderRow={(index) => <div key={cappedFiles.rows[index]} className="tt-file">{cappedFiles.rows[index]}</div>}
            />
            {cappedFiles.omitted > 0 ? <OmittedRows count={cappedFiles.omitted} /> : null}
          </>
        ) : <div className="tc-note">No files found</div>}
      </ScrollPane>
    </>
  );
}

function AstEditBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const changes = Array.isArray(fields.changes) ? fields.changes : [];
  return (
    <>
      <Kv pairs={[
        ["pattern", fields.pattern],
        ["rewrite", fields.rewrite],
        ["replacements", fields.replacements],
        ["files", fields.filesChanged],
      ]} />
      <ScrollPane className="tc-tree">
        {changes.map((entry, index) => {
          const record = jsonRecord(entry);
          const file = jsonString(record?.file) ?? `change-${index}`;
          const before = jsonString(record?.before) ?? "";
          const after = jsonString(record?.after) ?? "";
          return (
            <div key={file}>
              <div className="tt-file">{file}</div>
              <div className="tt-hit del"><span className="m-text">{before}</span></div>
              {after ? <div className="tt-hit add"><span className="m-text">{after}</span></div> : null}
            </div>
          );
        })}
      </ScrollPane>
    </>
  );
}

function DebugBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const lines = stringLines(fields.output);
  return (
    <>
      <Kv pairs={[["action", fields.action], ["program", fields.program]]} />
      {jsonString(fields.snapshot) ? <div className="tc-summary">{jsonString(fields.snapshot)}</div> : null}
      {lines ? (
        <ScrollPane className="codeblock">
          {lines.map((line, index) => <div key={index}>{line}</div>)}
        </ScrollPane>
      ) : null}
    </>
  );
}

function EvalBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const cells = Array.isArray(fields.cells) ? fields.cells : [];
  return (
    <div className="tc-eval">
      <Kv pairs={[["status", fields.status], ["id", fields.id], ["duration", fields.durationMs]]} />
      <MediaList value={fields.media ?? fields.image ?? fields.images ?? fields.screenshot ?? (fields.screenshotData !== undefined ? { data: fields.screenshotData, mimeType: fields.mimeType } : undefined)} alt="评估结果" />
      {cells.map((entry, index) => {
        const cell = jsonRecord(entry) ?? {};
        const code = jsonString(cell.code) ?? "";
        const stdout = jsonString(cell.stdout) ?? jsonString(cell.output);
        const stderr = jsonString(cell.stderr);
        return (
          <div key={index} className="ev-cell">
            <div className="tc-label">{jsonString(fields.lang) ?? jsonString(cell.lang) ?? "code"}</div>
            <CodeLines lines={code.split("\n")} />
            {stdout ? <ScrollPane className="codeblock"><div className="c-ok">{stdout}</div></ScrollPane> : null}
            {stderr ? <ScrollPane className="codeblock"><div className="c-err">{stderr}</div></ScrollPane> : null}
            <div className="tc-foot">
              {jsonString(cell.status) ? <span className="chip gray xs">{jsonString(cell.status)}</span> : null}
              {jsonNumber(cell.exitCode) !== undefined ? <span className="chip green xs">exit {jsonNumber(cell.exitCode)}</span> : null}
              {durationText(cell.durationMs) ? <span className="tc-dur">{durationText(cell.durationMs)}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GithubBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  return (
    <>
      <Kv pairs={[["op", fields.op], ["repo", fields.repo], ["pr", fields.pr]]} />
      {fields.output !== undefined ? <JsonBlock value={fields.output} /> : <DefaultBody tool={tool} />}
    </>
  );
}

function LspBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const rows = Array.isArray(fields.diagnostics) ? fields.diagnostics : Array.isArray(fields.refs) ? fields.refs : [];
  const cappedRows = capRows(rows);
  return (
    <>
      <Kv pairs={[["action", fields.action]]} />
      <div className="tc-lsp">
        <ChunkedRows
          count={cappedRows.rows.length}
          renderRow={(index) => {
            const row = jsonRecord(cappedRows.rows[index]) ?? {};
            const sev = jsonString(row.sev) ?? "info";
            return (
              <div key={index} className={`lsp-row ${sev}`}>
                <span className="lsp-sev">{jsonString(row.sev) ?? "ref"}</span>
                <span className="m-file">{jsonString(row.file)}</span>
                <span className="m-line">{String(jsonNumber(row.line) ?? jsonString(row.line) ?? "")}</span>
                <span className="m-text">{jsonString(row.msg) ?? jsonString(row.text) ?? ""}</span>
              </div>
            );
          }}
        />
        {cappedRows.omitted > 0 ? <OmittedRows count={cappedRows.omitted} /> : null}
      </div>
      {rows.length === 0 && jsonString(fields.output) ? <ScrollPane className="codeblock">{jsonString(fields.output)}</ScrollPane> : null}
    </>
  );
}

function InspectBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const answer = jsonString(fields.answer) ?? jsonString(fields.output);
  return (
    <>
      <Kv pairs={[["mime", fields.mime], ["model", fields.model]]} />
      {jsonString(fields.question) ? <div className="tc-summary">{jsonString(fields.question)}</div> : null}
      {answer ? <div className="tc-answer">{answer}</div> : null}
      <MediaList value={fields.media ?? fields.image ?? fields.images} alt="图片问题结果" />
    </>
  );
}

function BrowserBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const code = jsonString(fields.code);
  const output = fields.output;
  return (
    <>
      <Kv pairs={[["action", fields.action], ["tab", fields.tab], ["url", fields.url ?? fields.target], ["element", fields.elementHandle ?? fields.handle]]} />
      {code ? (
        <>
          <div className="tc-label">script</div>
          <CodeLines lines={code.split("\n")} />
        </>
      ) : null}
      {output !== undefined ? <ScrollPane className="codeblock">{typeof output === "string" ? output : JSON.stringify(output)}</ScrollPane> : null}
      {fields.result !== undefined ? <JsonBlock value={fields.result} /> : null}
      <MediaList value={fields.media ?? fields.screenshot ?? fields.image ?? fields.images ?? (fields.screenshotData !== undefined ? { data: fields.screenshotData, mimeType: fields.mimeType } : undefined)} alt="Browser evaluation" />
    </>
  );
}

function ComputerBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const code = jsonString(fields.code);
  return (
    <>
      <Kv pairs={[["screenshots", fields.shots ?? fields.screenshot], ["status", fields.status], ["action", fields.action]]} />
      {code ? (
        <>
          <div className="tc-label">script</div>
          <CodeLines lines={code.split("\n")} />
        </>
      ) : null}
      {jsonString(fields.output) ? <ScrollPane className="codeblock">{jsonString(fields.output)}</ScrollPane> : null}
      <MediaList value={fields.media ?? fields.images ?? fields.screenshot ?? fields.shots} alt="Computer evaluation" />
    </>
  );
}

function HubBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const jobs = Array.isArray(fields.jobs) ? fields.jobs : [];
  if (jobs.length > 0) {
    return (
      <>
        <Kv pairs={[["op", fields.op], ["jobs", jobs.length], ["queue", fields.queue], ["concurrency", fields.concurrency]]} />
        <div className="tc-task">
          <div className="task-agents">
            {jobs.map((entry, index) => {
              const job = jsonRecord(entry) ?? {};
              const name = jsonString(job.label) ?? jsonString(job.id) ?? `job-${index + 1}`;
              return (
                <div key={name} className="task-agent">
                  <span className="task-dot" aria-hidden="true" />
                  <span className="task-aname">{name}</span>
                  <span className="task-atype">[{jsonString(job.status) ?? "unknown"}]</span>
                  {durationText(job.durationMs) ? <span className="tc-dur">{durationText(job.durationMs)}</span> : null}
                </div>
              );
            })}
          </div>
        </div>
      </>
    );
  }
  if (fields.status !== undefined || fields.jobId !== undefined || fields.result !== undefined) {
    return <>
      <Kv pairs={[["status", fields.status], ["job", fields.jobId ?? fields.id], ["op", fields.op]]} />
      {fields.result !== undefined ? <JsonBlock value={fields.result} /> : null}
    </>;
  }
  if (jsonString(fields.hubKind) === "irc") {
    return (
      <>
        <Kv pairs={[["to", fields.to], ["receipt", fields.receipt]]} />
        <div className="tc-answer">{jsonString(fields.text) ?? ""}</div>
      </>
    );
  }
  if (jsonString(fields.hubKind) === "launch") {
    const log = stringLines(fields.log);
    return (
      <>
        <Kv pairs={[["name", fields.app], ["pid", fields.pid], ["state", fields.state]]} />
        {log ? (
          <ScrollPane className="codeblock">
            {log.map((line, index) => <div key={index}>{line}</div>)}
          </ScrollPane>
        ) : null}
      </>
    );
  }
  return <DefaultBody tool={tool} />;
}

function TodoBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const phases = Array.isArray(fields.phases) ? fields.phases : [];
  return (
    <>
      <Kv pairs={[["op", fields.op]]} />
      <div className="tc-todo">
        {phases.map((entry, phaseIndex) => {
          const phase = jsonRecord(entry) ?? {};
          const tasks = Array.isArray(phase.tasks) ? phase.tasks : [];
          return (
            <div key={jsonString(phase.name) ?? phaseIndex}>
              <div className="todo-ph">{jsonString(phase.name)}</div>
              {tasks.map((taskEntry, taskIndex) => {
                const task = jsonRecord(taskEntry) ?? {};
                const status = jsonString(task.status) ?? "";
                return (
                  <div key={taskIndex} className={`todo-task ${status}`}>
                    <span className="todo-box" aria-hidden="true">
                      {status === "completed" ? <Icon name="check" extra="sm" /> : null}
                    </span>
                    <span>{jsonString(task.content)}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}

function WebSearchBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const data = jsonRecord(tool.result?.data);
  const response = jsonRecord(data?.response) ?? jsonRecord(fields.response) ?? {};
  const raw = response.sources ?? fields.cites ?? data?.sources;
  const cites = Array.isArray(raw) ? raw : [];
  const answer = jsonString(data?.answer) ?? jsonString(response.answer) ?? jsonString(fields.answer) ?? jsonString(fields.output);
  const provider = jsonString(data?.provider) ?? jsonString(response.provider) ?? jsonString(fields.provider);
  const openExternal = (event: MouseEvent<HTMLAnchorElement>, url: string) => {
    const chrome = (globalThis as { ompStudioChrome?: { openUrl?: (args: { url: string }) => unknown } }).ompStudioChrome;
    if (chrome?.openUrl === undefined) return;
    event.preventDefault(); chrome.openUrl({ url });
  };
  const normalizeUrl = (value: string): string | undefined => {
    const candidate = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
    try { const url = new URL(candidate); return /^https?:$/.test(url.protocol) ? url.href : undefined; } catch { return undefined; }
  };
  return (
    <>
      <Kv pairs={[["provider", provider], ["sources", cites.length]]} />
      {answer ? <div className="tc-answer">{answer}</div> : null}
      {cites.length > 0 ? <div className="tc-cites">
        {cites.map((entry, index) => {
          const cite = jsonRecord(entry) ?? {};
          const rawUrl = jsonString(cite.url) ?? (typeof entry === "string" ? entry : undefined);
          const url = rawUrl === undefined ? undefined : normalizeUrl(rawUrl);
          if (url === undefined) return null;
          const title = jsonString(cite.title) ?? rawUrl;
          return (
            <a key={index} className="tc-cite" href={url} title={title === url ? url : `${title} · ${url}`} target="_blank" rel="noreferrer noopener" onClick={(event) => openExternal(event, url)}>
              <Icon name="link" extra="sm" /><span className="tc-cite-text"><span className="tc-cite-title">{title}</span><span className="tc-cite-url">{url}</span></span>
            </a>
          );
        })}
      </div> : null}
    </>
  );
}

function RetainBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const items = jsonStringArray(fields.items) ?? [];
  return (
    <>
      <Kv pairs={[["stored", fields.stored]]} />
      <ul className="tc-mem">
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </>
  );
}

function RecallBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const excerpts = jsonStringArray(fields.excerpts) ?? [];
  return (
    <>
      <Kv pairs={[["query", fields.query], ["matches", fields.count]]} />
      <div className="tc-mem">
        {excerpts.length ? excerpts.map((item) => <div key={item} className="mem-ex">{item}</div>) : <div className="tc-note">0 matches</div>}
      </div>
    </>
  );
}

function GoalBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  return (
    <>
      <Kv pairs={[["op", fields.op], ["status", fields.statusLabel], ["budget", fields.budget]]} />
      {jsonString(fields.objective) ? <div className="tc-answer">{jsonString(fields.objective)}</div> : null}
      {jsonString(fields.report) ? <div className="tc-summary">{jsonString(fields.report)}</div> : null}
    </>
  );
}

function GenerateImageBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  return (
    <>
      <Kv pairs={[["images", fields.images]]} />
      <div className="tc-answer">{jsonString(fields.subject) ?? jsonString(fields.target) ?? ""}</div>
      {jsonString(fields.output) ? <div className="tc-note">{jsonString(fields.output)}</div> : null}
    </>
  );
}

function vibeIcon(status: string) {
  if (status === "running") return <span className="spinner" />;
  if (status === "done") return <Icon name="check" extra="sm" />;
  if (status === "error") return <Icon name="x" extra="sm" />;
  if (status === "pending") return <Icon name="clock" extra="sm" />;
  if (status === "aborted") return <Icon name="stop" extra="sm" />;
  return <Icon name="box" extra="sm" />;
}

function VibeBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const sessions = Array.isArray(fields.sessions) ? fields.sessions : [];
  return (
    <div className="tc-vibe">
      {sessions.map((entry, index) => {
        const session = jsonRecord(entry) ?? {};
        const status = jsonString(session.status) ?? "";
        return (
          <div key={jsonString(session.id) ?? index} className="vibe-row">
            <span className={`tc-st ${status}`}>{vibeIcon(status)}</span>
            <span className="ta-name">{jsonString(session.id)}</span>
            <span className="ta-detail">{jsonString(session.tool) ?? ""}</span>
            <span className="tc-dur">{jsonString(session.elapsed) ?? ""}</span>
          </div>
        );
      })}
    </div>
  );
}

function ResolveBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const action = jsonString(fields.action) ?? "";
  const accept = action === "accept";
  return (
    <div className={`tc-resolve ${accept ? "ok" : "no"}`}>
      <span className={`chip ${accept ? "green" : "red"} xs`}>{accept ? "Accept" : "Discard"}</span>
      <span>{jsonString(fields.reason) ?? jsonString(fields.target) ?? ""}</span>
    </div>
  );
}

function ManageSkillBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  const args = jsonRecord(fields.args) ?? {};
  const action = jsonString(args.action) ?? jsonString(fields.action) ?? "";
  const skill = jsonString(args.name) ?? jsonString(fields.skill) ?? "";
  const output = fields.output;
  return (
    <>
      <Kv pairs={[["action", action], ["skill", skill]]} />
      {output !== undefined ? <div className="tc-note">{typeof output === "string" ? output : JSON.stringify(output)}</div> : null}
    </>
  );
}

function McpBody({ tool }: { tool: ToolView }) {
  const fields = toolFields(tool);
  return (
    <>
      <div className="tc-label">args</div>
      <JsonBlock value={fields.args ?? {}} />
      <div className="tc-label">result</div>
      <JsonBlock value={fields.output ?? ""} />
    </>
  );
}

/**
 * Memoised on the frozen `tool` view. A streaming chain republishes only the
 * tool that changed and reuses the identity of every sibling, so without this
 * every card in the chain — including collapsed ones — re-rendered its whole
 * payload on each published frame.
 */
export const ToolBody = memo(function ToolBody({ tool, follow }: { tool: ToolView; follow?: boolean }) {
  const kind = toolKind(tool);
  const fields = toolFields(tool);
  const live = follow ?? tool.status === "running";
  const inner =
    kind === "read" ? <ReadBody tool={tool} /> :
    kind === "write" ? <WriteBody tool={tool} /> :
    kind === "edit" ? <EditBody tool={tool} /> :
    kind === "bash" ? <BashBody tool={tool} /> :
    kind === "grep" || kind === "ast_grep" ? <GrepBody tool={tool} /> :
    kind === "glob" ? <GlobBody tool={tool} /> :
    kind === "ast_edit" ? <AstEditBody tool={tool} /> :
    kind === "ask" || kind === "askuser" ? <AskBody tool={tool} /> :
    kind === "debug" ? <DebugBody tool={tool} /> :
    kind === "eval" ? <EvalBody tool={tool} /> :
    kind === "github" ? <GithubBody tool={tool} /> :
    kind === "lsp" ? <LspBody tool={tool} /> :
    kind === "inspect_image" ? <InspectBody tool={tool} /> :
    kind === "browser" ? <BrowserBody tool={tool} /> :
    kind === "computer" ? <ComputerBody tool={tool} /> :
    kind === "task" ? <TaskBody tool={tool} /> :
    kind === "hub" ? <HubBody tool={tool} /> :
    kind === "todo" ? <TodoBody tool={tool} /> :
    kind === "web_search" || kind === "web" ? <WebSearchBody tool={tool} /> :
    kind === "retain" ? <RetainBody tool={tool} /> :
    kind === "recall" ? <RecallBody tool={tool} /> :
    kind === "reflect" ? (
      <>
        <Kv pairs={[["query", fields.query]]} />
        <div className="tc-answer">{jsonString(fields.answer) ?? ""}</div>
      </>
    ) :
    kind === "mcp" ? <McpBody tool={tool} /> :
    kind === "goal" ? <GoalBody tool={tool} /> :
    kind === "generate_image" ? <GenerateImageBody tool={tool} /> :
    kind === "vibe" ? <VibeBody tool={tool} /> :
    kind === "resolve" ? <ResolveBody tool={tool} /> :
    kind === "manage_skill" ? <ManageSkillBody tool={tool} /> :
    kind === "checkpoint" || kind === "rewind" || kind === "security_scan" || kind === "memory_edit" || kind === "learn" || kind === "yield" || kind === "tts" ? <DefaultBody tool={tool} /> :
    jsonString(fields.summary) ? <div className="tc-summary">{jsonString(fields.summary)}</div> :
    <DefaultBody tool={tool} />;
  return (
    <ToolCardLive.Provider value={live}>
      {tool.truncated === true ? <TruncationMark /> : null}
      {inner}
      <ToolMedia tool={tool} />
    </ToolCardLive.Provider>
  );
});
