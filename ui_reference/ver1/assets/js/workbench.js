/* ============================================================
   OMP Studio — 工作台逻辑
   对话流（user / assistant / batch 工具链）· Minimap · Telemetry ·
   输入区 · 右侧面板 · 底部面板 · Todo Dock · Deck · 场景
   ============================================================ */
(function () {
  const D = window.OMP_DATA;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const { toast, openOverlay, menu, mi } = OMP.ui;

  /* ================= 对话内容区 v2 ================= */
  const $convo = () => $('#convoDoc');

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const TST_LABEL = { pending: '等待', running: '运行中', done: '完成', error: '失败', aborted: '已中止' };
  const KIND_ICON = {
    think: 'brain', read: 'file', write: 'file-plus', edit: 'pencil', bash: 'terminal',
    grep: 'search', glob: 'folder', ast_grep: 'search', ast_edit: 'pencil', ask: 'message',
    debug: 'bug', eval: 'flask', github: 'commit', lsp: 'cpu', inspect_image: 'image',
    browser: 'globe', computer: 'monitor', checkpoint: 'commit', rewind: 'rewind',
    security_scan: 'shield', task: 'bot', hub: 'network', todo: 'check', web_search: 'globe',
    web: 'globe', retain: 'archive', recall: 'search', reflect: 'brain', memory_edit: 'pencil',
    learn: 'book', manage_skill: 'sparkles', yield: 'export', goal: 'pin',
    generate_image: 'image', tts: 'pulse', vibe: 'zap', mcp: 'plug', resolve: 'check'
  };
  const KIND_LABEL = {
    think: 'Think', read: 'Read', write: 'Write', edit: 'Edit', bash: 'Bash',
    grep: 'Grep', glob: 'Glob', ast_grep: 'AST Grep', ast_edit: 'AST Edit', ask: 'Ask',
    debug: 'Debug', eval: 'Eval', github: 'GitHub', lsp: 'LSP', inspect_image: 'Inspect',
    browser: 'Browser', computer: 'Computer', checkpoint: 'Checkpoint', rewind: 'Rewind',
    security_scan: 'Security Scan', task: 'Task', hub: 'Hub', todo: 'Todo', web_search: 'Web Search',
    retain: 'Retain', recall: 'Recall', reflect: 'Reflect', memory_edit: 'Memory Edit',
    learn: 'Learn', manage_skill: 'Manage Skill', yield: 'Submit Result', goal: 'Goal',
    generate_image: 'GenerateImage', tts: 'Speech Generation', vibe: 'Vibe', mcp: 'MCP',
    resolve: 'Resolve'
  };
  const KIND_VERB = {
    think: 'thinking', read: 'reading', grep: 'grepping', ast_grep: 'grepping', glob: 'reading',
    web_search: 'fetching', web: 'fetching', mcp: 'fetching', inspect_image: 'reading',
    browser: 'fetching', github: 'fetching', edit: 'editing', ast_edit: 'editing', write: 'editing',
    bash: 'running', eval: 'running', debug: 'running', computer: 'running', task: 'running',
    hub: 'running', lsp: 'running', todo: 'running', vibe: 'running'
  };
  const PATH_KINDS = {
    read: 1, write: 1, edit: 1, inspect_image: 1, glob: 1, generate_image: 1, tts: 1
  };

  function tstIcon(st) {
    if (st === 'running') return '<span class="spinner"></span>';
    return OMP.icon({ done: 'check', error: 'x', pending: 'clock', aborted: 'stop' }[st] || 'box');
  }

  function fileBase(p) {
    const s = String(p || '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function batchSummary(items) {
    const files = new Set();
    let searches = 0, commands = 0, fetches = 0, agents = 0, asks = 0;
    let editing = '';
    let editingRun = false;
    let thinkDur = '';
    let askFirst = '';
    let add = 0, del = 0;
    (items || []).forEach(t => {
      if (t.kind === 'think') thinkDur = t.dur || '';
      if (t.kind === 'read' || t.kind === 'write' || t.kind === 'edit') {
        if (t.target) files.add(t.target);
        if (t.kind === 'edit' || t.kind === 'write') {
          editing = t.target;
          editingRun = t.status === 'running';
        }
      }
      if (t.kind === 'grep' || t.kind === 'ast_grep') searches += 1;
      if (t.kind === 'glob') searches += 1;
      if (t.kind === 'bash') commands += 1;
      if (t.kind === 'web' || t.kind === 'web_search' || t.kind === 'mcp' || t.kind === 'browser' || t.kind === 'github') fetches += 1;
      if (t.kind === 'task' && t.agents) agents += t.agents.length;
      if (t.kind === 'ask') {
        const ans = askAnswer(t);
        if (ans) {
          asks += 1;
          if (!askFirst) askFirst = ans;
        }
      }
      if (t.kind === 'write' && t.lines) add += t.lines;
      if (t.kind === 'edit' && t.diff) {
        t.diff.forEach(row => {
          if (row[0] === '+') add += 1;
          if (row[0] === '-') del += 1;
        });
      }
    });
    const parts = [];
    if (editing) parts.push((editingRun ? '正在编辑 ' : '编辑 ') + fileBase(editing));
    if (files.size) parts.push('阅读 ' + files.size + ' 个文件');
    if (searches) parts.push('搜索 ' + searches + ' 次');
    if (commands) parts.push('运行 ' + commands + ' 条命令');
    if (fetches) parts.push('请求 ' + fetches + ' 次');
    if (agents) parts.push(agents + ' 个子 Agent');
    if (asks === 1 && askFirst && !parts.length) parts.push('Ask · ' + askFirst);
    else if (asks) parts.push('回答 ' + asks + ' 次');
    if (!parts.length && thinkDur) parts.push('思考了 ' + thinkDur);
    if (!parts.length) parts.push('工具调用');
    return { text: parts.join(' · '), add, del };
  }

  function batchDiffHtml(sum) {
    const bits = [];
    if (sum.add) bits.push(`<span class="add">+${sum.add}</span>`);
    if (sum.del) bits.push(`<span class="del">−${sum.del}</span>`);
    return bits.length ? `<span class="batch-diff">${bits.join('')}</span>` : '';
  }

  function chainItemLabel(t) {
    if (t.kind === 'think') return t.name || 'Think';
    if (t.kind === 'mcp') return t.name || 'MCP';
    if (t.kind === 'vibe') return t.name || ('Vibe ' + (t.vibeOp || ''));
    return t.name || KIND_LABEL[t.kind] || t.kind;
  }

  function chainItemDetail(t) {
    if (t.kind === 'think') return t.preview || ('思考了 ' + (t.dur || ''));
    if (t.kind === 'bash') return t.cmd || t.target || '';
    if (t.kind === 'grep' || t.kind === 'ast_grep' || t.kind === 'glob') return t.pattern || t.target || '';
    if (t.kind === 'web_search' || t.kind === 'web') return t.query || t.target || '';
    if (t.kind === 'lsp') return [t.action, t.target].filter(Boolean).join(' · ');
    if (t.kind === 'browser') return [t.action, t.url || t.target].filter(Boolean).join(' · ');
    if (t.kind === 'github') return t.op || t.target || '';
    if (t.kind === 'eval') return t.lang || t.target || '';
    if (t.kind === 'todo') return t.op || t.target || '';
    if (t.kind === 'hub') return t.target || t.hubKind || '';
    if (t.kind === 'ask') return askAnswer(t) || t.question || t.target || '';
    if (t.kind === 'goal') return t.op || t.objective || t.target || '';
    if (t.kind === 'vibe') return t.target || t.vibeOp || '';
    if (t.kind === 'task') {
      const spawn = t.spawn || {};
      const n = (spawn.tasks && spawn.tasks.length) || (t.agents && t.agents.length) || 0;
      return n ? n + ' agents' : '';
    }
    if (t.kind === 'debug') return t.action || t.target || '';
    if (t.kind === 'resolve') return t.action || t.target || '';
    return t.target || t.summary || t.query || '';
  }

  function askAnswer(t) {
    if (!t) return '';
    if (t.answer) return String(t.answer);
    const sel = (t.options || []).find(o => o.selected);
    return sel ? sel.label : '';
  }

  function askOptionList(t) {
    const picked = askAnswer(t);
    const opts = (t.options || []).map(o => ({
      label: o.label,
      rec: !!o.rec,
      selected: !!o.selected || (!!picked && o.label === picked)
    }));
    if (picked && !opts.some(o => o.label === picked)) {
      opts.push({ label: picked, selected: true });
    }
    return opts;
  }

  function isAskPending(t) {
    return t && t.kind === 'ask' && t.status !== 'done' && t.status !== 'error' && !askAnswer(t);
  }

  function renderThinkCard(t) {
    const body = esc(t.full || t.preview || '').replace(/\n/g, '<br>');
    return `<div class="tl-card think-card"><div class="think-scroll">${body}</div></div>`;
  }

  function renderChainItem(t, open) {
    if (isAskPending(t)) return '';
    const running = t.status === 'running';
    const err = t.status === 'error';
    const label = chainItemLabel(t);
    const detail = chainItemDetail(t);
    const isPath = !!PATH_KINDS[t.kind];
    const aria = `${label}${detail ? ' · ' + detail : ''}，${TST_LABEL[t.status] || t.status}`;
    const card = t.kind === 'think' ? renderThinkCard(t) : `<div class="tl-card"><div class="tc-body">${renderToolBody(t)}</div></div>`;
    return `<div class="tl-item${open ? ' open' : ''}${running ? ' is-running' : ''}" data-kind="${esc(t.kind)}" data-status="${esc(t.status || '')}">
      <button class="tl-row${err ? ' is-error' : ''}${running ? ' is-running' : ''}" aria-expanded="${open ? 'true' : 'false'}" aria-label="${esc(aria)}，${open ? '收起' : '展开'}详情">
        <span class="tl-icon">${OMP.icon(KIND_ICON[t.kind] || 'box', 'sm')}</span>
        <span class="tl-name">${esc(label)}</span>
        ${detail ? `<span class="tl-sep">·</span><span class="tl-detail${isPath ? ' is-path' : ''}">${esc(detail)}</span>` : ''}
        ${OMP.icon('chevron-d', 'sm tl-chev')}
      </button>
      ${card}
    </div>`;
  }

  function collectAgents(items) {
    const out = [];
    (items || []).forEach(t => {
      if (t.kind !== 'task') return;
      (t.agents || []).forEach(a => out.push(a));
    });
    return out;
  }

  function saPill(a) {
    const st = a.status || 'pending';
    if (a.statusText) {
      const text = String(a.statusText);
      const cls = a.activity === 'tool' || /^Running Tool/i.test(text) ? 'tool'
        : st === 'running' || a.activity === 'thinking' || /^Thinking$/i.test(text) ? 'thinking'
        : st === 'waiting' || a.activity === 'waiting' || /Waiting/i.test(text) ? 'waiting'
        : st === 'error' || st === 'failed' || st === 'aborted' || a.activity === 'failed' ? 'aborted'
        : st === 'done' ? 'idle'
        : 'parked';
      return { cls, label: text };
    }
    if (st === 'running') {
      const tool = a.currentTool && a.currentTool.name;
      if (a.activity === 'tool' || tool) {
        return { cls: 'tool', label: tool ? 'Running Tool · ' + tool : 'Running Tool' };
      }
      return { cls: 'thinking', label: 'Thinking' };
    }
    if (st === 'waiting') return { cls: 'waiting', label: 'Waiting for User' };
    if (st === 'error' || st === 'failed') return { cls: 'aborted', label: 'Failed' };
    if (st === 'aborted') return { cls: 'aborted', label: 'Aborted' };
    if (st === 'done') return { cls: 'idle', label: 'Done' };
    if (st === 'parked') return { cls: 'parked', label: 'Parked' };
    return { cls: 'parked', label: TST_LABEL[st] || st };
  }

  function saTokCount(tokens) {
    if (typeof tokens === 'number' && Number.isFinite(tokens)) return tokens;
    const s = String(tokens || '');
    const k = s.match(/([\d.]+)\s*k/i);
    if (k) return parseFloat(k[1]) * 1000;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  }

  function saSpark(tokens) {
    const hot = Math.max(1, Math.min(3, Math.round(saTokCount(tokens) / 40000)));
    const bars = [1, 2, 3].map(i =>
      `<rect class="hb-bar${i <= hot ? ' hot' : ''}" x="${(i - 1) * 5}" y="${8 - i * 2}" width="3" height="${i * 2}" rx="1"/>`).join('');
    return `<svg class="hc-spark" width="13" height="8" viewBox="0 0 13 8" aria-hidden="true">${bars}</svg>`;
  }

  function saLastTool(a) {
    if (a.lastTool) return a.lastTool;
    const t = a.currentTool;
    if (!t || !t.name) return '';
    return t.args ? `${t.name} · ${t.args}` : t.name;
  }

  function saArts(a) {
    return (a.arts || [a.outputPath && 'out', a.patchPath && 'patch', a.branchName && 'branch']).filter(Boolean);
  }

  function agentMetricsHtml(a, compact) {
    const tok = a.tokens;
    const tools = a.tools;
    const req = a.requests != null ? a.requests : a.req;
    const cost = a.cost;
    const files = a.files;
    const bits = [];
    if (tok != null && tok !== '') {
      bits.push(`<span class="sa-tok"><b>${esc(String(tok))}</b><i>tok</i>${compact ? '' : saSpark(tok)}</span>`);
    }
    if (tools != null && tools !== '') bits.push(`<span class="hub-num"><i>tools</i><b>${esc(String(tools))}</b></span>`);
    if (req != null && req !== '') bits.push(`<span class="hub-num"><i>req</i><b>${esc(String(req))}</b></span>`);
    if (files != null && files !== '') bits.push(`<span class="hub-num"><i>files</i><b>${esc(String(files))}</b></span>`);
    if (cost) bits.push(`<span class="sa-cost">${esc(String(cost))}</span>`);
    return bits.join('');
  }

  function agentCardInner(a, compact) {
    const pill = saPill(a);
    const dur = a.dur || a.time || '';
    const metrics = agentMetricsHtml(a, compact);
    const last = compact ? '' : saLastTool(a);
    const arts = compact ? [] : saArts(a);
    const model = compact ? '' : (a.resolvedModel || a.model || '');
    const effort = compact ? '' : (a.thinking || a.effort || '');
    return `<div class="sa-top">
        <span class="hub-act ${pill.cls}">${esc(pill.label)}</span>
        <span class="sa-name">${esc(a.name)}</span>
        ${dur ? `<span class="sa-dur">${esc(dur)}</span>` : ''}
      </div>
      ${(model || effort || arts.length) ? `<div class="sa-foot">
        ${model ? `<span class="sa-model">${esc(model)}</span>` : ''}
        ${effort ? `<span class="sa-effort">${esc(effort)}</span>` : ''}
        ${arts.map(x => `<span class="hub-art">${esc(x)}</span>`).join('')}
      </div>` : ''}
      ${metrics ? `<div class="sa-metrics">${metrics}</div>` : ''}
      ${last ? `<div class="sa-last">${esc(last)}</div>` : ''}`;
  }

  function renderSubagentStrip(agents) {
    if (!agents.length) return '';
    return `<div class="subagent-strip">${agents.map(a => {
      const st = a.status || 'pending';
      const pill = saPill(a);
      const aria = [a.name, pill.label, a.dur || a.time, a.tokens != null ? a.tokens + ' tok' : '']
        .filter(Boolean).join('，');
      return `<div class="sa-card ${esc(st)}" role="group" aria-label="${esc(aria)}">${agentCardInner(a, true)}</div>`;
    }).join('')}</div>`;
  }

  function renderBatch(ev) {
    const items = ev.items || [];
    const agents = collectAgents(items);
    const running = items.some(t => t.status === 'running') || agents.some(a => a.status === 'running');
    const lastRun = running ? items.reduce((acc, t, i) => t.status === 'running' ? i : acc, -1) : -1;
    const sum = batchSummary(items);
    const askOnly = items.length > 0 && items.every(t => t.kind === 'ask');
    const openAll = !!ev.openAll;
    const open = running || openAll || askOnly;
    return `<div class="ev ev-batch${open ? ' open' : ''}${running ? ' is-running' : ''}${openAll || askOnly ? ' is-pinned-open' : ''}" id="ev-${ev.id}">
      ${renderSubagentStrip(agents)}
      <button class="batch-sum" aria-expanded="${open ? 'true' : 'false'}">
        <span class="batch-text">${esc(sum.text)}</span>
        ${batchDiffHtml(sum)}
      </button>
      <div class="batch-chain">${items.map((t, i) => renderChainItem(t, openAll || i === lastRun || (open && t.kind === 'ask' && !isAskPending(t)))).join('')}</div>
    </div>`;
  }

  function kvMeta(pairs) {
    const bits = (pairs || []).filter(p => p && p[1] !== undefined && p[1] !== '' && p[1] !== null);
    if (!bits.length) return '';
    return `<div class="tc-kv">${bits.map(([k, v]) =>
      `<span class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></span>`).join('')}</div>`;
  }

  function lineCell(lines, start) {
    const n0 = start || 1;
    return `<div class="tc-code">${(lines || []).map((l, i) =>
      `<div class="cl"><span class="ln">${n0 + i}</span><span class="lx">${esc(l) || '&nbsp;'}</span></div>`).join('')}</div>`;
  }

  function jsonBlock(value) {
    let text = '';
    if (value == null) text = '';
    else if (typeof value === 'string') {
      try { text = JSON.stringify(JSON.parse(value), null, 2); }
      catch (e) { text = value; }
    } else text = JSON.stringify(value, null, 2);
    return `<div class="codeblock tc-json">${esc(text)}</div>`;
  }

  function inlineCode(s) {
    return esc(s).replace(/`([^`]+)`/g, '<span class="chip-code">$1</span>');
  }

  function parseTaskBrief(spawn) {
    if (!spawn) return { goal: '', constraints: [] };
    if (spawn.goal || (spawn.constraints && spawn.constraints.length)) {
      return { goal: spawn.goal || '', constraints: spawn.constraints || [] };
    }
    const ctx = String(spawn.context || '');
    if (!ctx.trim()) return { goal: '', constraints: [] };
    const goal = [];
    const constraints = [];
    let mode = '';
    ctx.split('\n').forEach(line => {
      const h = line.trim();
      if (/^#+\s*goal\b/i.test(h)) { mode = 'goal'; return; }
      if (/^#+\s*constraints\b/i.test(h)) { mode = 'constraints'; return; }
      if (/^#+\s+/.test(h)) { mode = ''; return; }
      if (!h) return;
      if (mode === 'goal') goal.push(h.replace(/^[-*]\s+/, ''));
      else if (mode === 'constraints') constraints.push(h.replace(/^[-*]\s+/, ''));
    });
    if (!goal.length && !constraints.length) return { goal: ctx.trim(), constraints: [] };
    return { goal: goal.join('\n'), constraints };
  }

  function defaultArgsOut(t) {
    const parts = [];
    if (t.args !== undefined) {
      parts.push(`<div class="tc-label">Args</div>${jsonBlock(t.args)}`);
    }
    if (t.output !== undefined) {
      const out = Array.isArray(t.output)
        ? t.output.map(l => Array.isArray(l) ? l[0] : l).join('\n')
        : (typeof t.output === 'string' ? t.output : JSON.stringify(t.output, null, 2));
      parts.push(`<div class="tc-label">Output</div><div class="codeblock">${esc(out)}</div>`);
    }
    return parts.join('') || (t.summary ? `<div class="tc-summary">${esc(t.summary)}</div>` : '');
  }

  function matchTree(matches, count) {
    const map = new Map();
    (matches || []).forEach(m => {
      const arr = map.get(m.file) || [];
      arr.push(m);
      map.set(m.file, arr);
    });
    const files = Array.from(map.entries());
    return `${count ? `<div class="tc-summary">${esc(count)}</div>` : ''}
      <div class="tc-tree">${files.map(([file, rows]) =>
        `<div class="tt-file">${esc(file)}</div>` +
        rows.map(m => `<div class="tt-hit"><span class="m-line">${esc(m.line)}</span><span class="m-text">${esc(m.text)}</span></div>`).join('')
      ).join('')}</div>`;
  }

  function renderToolBody(t) {
    switch (t.kind) {
      case 'read':
        return `${kvMeta([['行', t.lines], ['编码', t.encoding], ['大小', t.size]])}
          ${t.preview ? lineCell(t.preview, t.offset) : (t.summary ? `<div class="tc-summary">${esc(t.summary)}</div>` : '')}
          ${t.truncated ? '<div class="tc-note">输出已截断</div>' : ''}`;
      case 'write':
        return `${kvMeta([[t.created ? '新建' : '覆盖', (t.lines ? t.lines + ' 行' : '')], ['编码', t.encoding]])}
          ${t.preview ? lineCell(t.preview, 1) : ''}
          ${t.executable ? '<div class="tc-note">已设为可执行</div>' : ''}`;
      case 'edit':
        return `<div class="tc-diff">${(t.diff || []).map(l => {
            const cls = l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : '';
            const mark = l[0] === '+' ? '+' : l[0] === '-' ? '−' : ' ';
            return `<div class="dl ${cls}"><span class="ln">${l[1]}</span><span class="ln">${l[2]}</span><span class="dm" aria-hidden="true">${mark}</span><span class="lc">${esc(l[3])}</span></div>`;
          }).join('')}</div>`;
      case 'bash':
        return `${kvMeta([['cwd', t.cwd]])}
          <div class="codeblock">
            <div class="c-cmd">$ ${esc(t.cmd || t.target || '')}</div>
            ${(t.output || []).map(l => `<div class="${l[1] ? 'c-' + l[1] : ''}">${esc(l[0]) || '&nbsp;'}</div>`).join('')}
          </div>
          <div class="tc-foot">
            <span class="chip ${t.exit ? 'red' : 'green'} xs">${t.exit ? 'exit ' + t.exit : 'exit 0'}</span>
            ${t.dur ? `<span class="tc-dur">${esc(t.dur)}</span>` : ''}
          </div>`;
      case 'grep':
      case 'ast_grep':
        return `${kvMeta([['pattern', t.pattern], ['lang', t.lang], ['scope', t.paths], ['searched', t.searched]])}
          ${matchTree(t.matches, t.count)}`;
      case 'glob':
        return `${kvMeta([['pattern', t.pattern || t.target], ['files', (t.files || []).length]])}
          <div class="tc-tree">${(t.files || []).map(f => `<div class="tt-file">${esc(f)}</div>`).join('') || '<div class="tc-note">No files found</div>'}</div>`;
      case 'ast_edit':
        return `${kvMeta([['pattern', t.pattern], ['rewrite', t.rewrite], ['replacements', t.replacements], ['files', t.filesChanged]])}
          <div class="tc-tree">${(t.changes || []).map(c =>
            `<div class="tt-file">${esc(c.file)}</div>
             <div class="tt-hit del"><span class="m-text">${esc(c.before)}</span></div>
             ${c.after ? `<div class="tt-hit add"><span class="m-text">${esc(c.after)}</span></div>` : ''}`
          ).join('')}</div>`;
      case 'ask': {
        const opts = askOptionList(t);
        const q = t.question || t.target || '';
        if (!opts.length && !q) return '<div class="tc-note">无回答</div>';
        return `<div class="tc-ask">
          ${q ? `<div class="ask-q">${esc(q)}</div>` : ''}
          <div class="ask-opts">${opts.map(o =>
            `<div class="ask-opt ${o.selected ? 'is-on' : 'is-off'}">
              <span class="ask-mark${o.selected ? ' on' : ''}" aria-hidden="true">${o.selected ? OMP.icon('check', 'sm') : ''}</span>
              <span class="ask-label">${esc(o.label)}</span>
              ${o.rec ? '<span class="chip purple xs">推荐</span>' : ''}
              ${o.selected ? '<span class="ask-chosen">已选</span>' : ''}
            </div>`).join('')}</div>
        </div>`;
      }
      case 'debug':
        return `${kvMeta([['action', t.action], ['program', t.program]])}
          ${t.snapshot ? `<div class="tc-summary">${esc(t.snapshot)}</div>` : ''}
          ${t.output ? `<div class="codeblock">${(t.output || []).map(l => `<div>${esc(l)}</div>`).join('')}</div>` : ''}`;
      case 'eval':
        return `<div class="tc-eval">${(t.cells || []).map(c =>
          `<div class="ev-cell">
            <div class="tc-label">${esc(t.lang || c.lang || 'code')}</div>
            ${lineCell((c.code || '').split('\n'), 1)}
            ${c.stdout ? `<div class="codeblock"><div class="c-ok">${esc(c.stdout)}</div></div>` : ''}
            ${c.stderr ? `<div class="codeblock"><div class="c-err">${esc(c.stderr)}</div></div>` : ''}
          </div>`).join('')}</div>`;
      case 'github':
        return `${kvMeta([['op', t.op], ['repo', t.repo], ['pr', t.pr]])}
          ${t.output ? jsonBlock(t.output) : defaultArgsOut(t)}`;
      case 'lsp':
        return `${kvMeta([['action', t.action]])}
          <div class="tc-lsp">${(t.diagnostics || t.refs || []).map(d =>
            `<div class="lsp-row ${esc(d.sev || 'info')}">
              <span class="lsp-sev">${esc(d.sev || 'ref')}</span>
              <span class="m-file">${esc(d.file)}</span>
              <span class="m-line">${esc(d.line)}</span>
              <span class="m-text">${esc(d.msg || d.text || '')}</span>
            </div>`).join('')}</div>`;
      case 'inspect_image':
        return `${kvMeta([['mime', t.mime], ['model', t.model]])}
          ${t.question ? `<div class="tc-summary">${esc(t.question)}</div>` : ''}
          ${t.answer ? `<div class="tc-answer">${esc(t.answer)}</div>` : ''}`;
      case 'browser':
        return `${kvMeta([['action', t.action], ['tab', t.tab], ['url', t.url || t.target]])}
          ${t.code ? `<div class="tc-label">script</div>${lineCell((t.code || '').split('\n'), 1)}` : ''}
          ${t.output ? `<div class="codeblock">${esc(typeof t.output === 'string' ? t.output : JSON.stringify(t.output))}</div>` : ''}`;
      case 'computer':
        return `${kvMeta([['screenshots', t.shots]])}
          ${t.code ? `<div class="tc-label">script</div>${lineCell((t.code || '').split('\n'), 1)}` : ''}
          ${t.output ? `<div class="codeblock">${esc(t.output)}</div>` : ''}`;
      case 'task': {
        const spawn = t.spawn || {};
        const jobs = spawn.tasks || (spawn.task ? [{ name: spawn.name, agent: spawn.agent, task: spawn.task }] : []);
        const brief = parseTaskBrief(spawn);
        const goal = brief.goal
          ? `<div class="task-sec"><div class="task-h">Goal</div><div class="task-p">${inlineCode(brief.goal).replace(/\n/g, '<br>')}</div></div>`
          : '';
        const cons = brief.constraints.length
          ? `<div class="task-sec"><div class="task-h">Constraints</div><ul class="task-ul">${brief.constraints.map(c => `<li>${inlineCode(c)}</li>`).join('')}</ul></div>`
          : '';
        const list = jobs.length
          ? `<div class="task-agents">${jobs.map(s => {
              const agent = s.agent || spawn.agent || '';
              const tag = agent && !/^(default|worker)$/i.test(agent);
              return `<div class="task-agent"><span class="task-dot" aria-hidden="true"></span><span class="task-aname">${esc(s.name || '')}</span>${tag ? `<span class="task-atype">[${esc(agent)}]</span>` : ''}</div>`;
            }).join('')}</div>`
          : '';
        return `<div class="tc-task">${goal}${cons}${list}</div>`;
      }
      case 'hub':
        if (t.hubKind === 'irc') {
          return `${kvMeta([['to', t.to], ['receipt', t.receipt]])}
            <div class="tc-answer">${esc(t.text || '')}</div>`;
        }
        if (t.hubKind === 'launch') {
          return `${kvMeta([['name', t.app], ['pid', t.pid], ['state', t.state]])}
            ${t.log ? `<div class="codeblock">${(t.log || []).map(l => `<div>${esc(l)}</div>`).join('')}</div>` : ''}`;
        }
        return defaultArgsOut(t);
      case 'todo':
        return `${kvMeta([['op', t.op]])}
          <div class="tc-todo">${(t.phases || []).map(ph =>
            `<div class="todo-ph">${esc(ph.name)}</div>` +
            (ph.tasks || []).map(task =>
              `<div class="todo-task ${esc(task.status)}">
                <span class="todo-box" aria-hidden="true">${task.status === 'completed' ? OMP.icon('check', 'sm') : ''}</span>
                <span>${esc(task.content)}</span>
              </div>`
            ).join('')
          ).join('')}</div>`;
      case 'web_search':
      case 'web':
        return `${kvMeta([['provider', t.provider], ['sources', t.sources]])}
          <div class="tc-answer">${esc(t.answer || '')}</div>
          <div class="tc-cites">${(t.cites || []).map(c =>
            `<span class="tc-cite">${OMP.icon('link', 'sm')}${esc(c.title)}<span class="c-dim"> · ${esc(c.url)}</span></span>`).join('')}</div>`;
      case 'retain':
        return `${kvMeta([['stored', t.stored]])}
          <ul class="tc-mem">${(t.items || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
      case 'recall':
        return `${kvMeta([['query', t.query], ['matches', t.count]])}
          <div class="tc-mem">${(t.excerpts || []).map(x => `<div class="mem-ex">${esc(x)}</div>`).join('') || '<div class="tc-note">0 matches</div>'}</div>`;
      case 'reflect':
        return `${kvMeta([['query', t.query]])}
          <div class="tc-answer">${esc(t.answer || '')}</div>`;
      case 'mcp':
        return `<div class="tc-label">args</div>${jsonBlock(t.args)}
          <div class="tc-label">result</div>${jsonBlock(t.output)}`;
      case 'goal':
        return `${kvMeta([['op', t.op], ['status', t.statusLabel], ['budget', t.budget]])}
          ${t.objective ? `<div class="tc-answer">${esc(t.objective)}</div>` : ''}
          ${t.report ? `<div class="tc-summary">${esc(t.report)}</div>` : ''}`;
      case 'generate_image':
        return `${kvMeta([['images', t.images]])}
          <div class="tc-answer">${esc(t.subject || t.target || '')}</div>
          ${t.output ? `<div class="tc-note">${esc(t.output)}</div>` : ''}`;
      case 'vibe':
        return `<div class="tc-vibe">${(t.sessions || []).map(s =>
          `<div class="vibe-row">
            <span class="tc-st ${s.status}">${tstIcon(s.status)}</span>
            <span class="ta-name">${esc(s.id)}</span>
            <span class="ta-detail">${esc(s.tool || '')}</span>
            <span class="tc-dur">${esc(s.elapsed || '')}</span>
          </div>`).join('')}</div>`;
      case 'resolve':
        return `<div class="tc-resolve ${t.action === 'accept' ? 'ok' : 'no'}">
          <span class="chip ${t.action === 'accept' ? 'green' : 'red'} xs">${t.action === 'accept' ? 'Accept' : 'Discard'}</span>
          <span>${esc(t.reason || t.target || '')}</span>
        </div>`;
      case 'manage_skill': {
        const args = t.args || {};
        const action = args.action || t.action || '';
        const skill = args.name || t.skill || '';
        return `${kvMeta([['action', action], ['skill', skill]])}
          ${t.output ? `<div class="tc-note">${esc(typeof t.output === 'string' ? t.output : JSON.stringify(t.output))}</div>` : ''}`;
      }
      case 'checkpoint':
      case 'rewind':
      case 'security_scan':
      case 'memory_edit':
      case 'learn':
      case 'yield':
      case 'tts':
        return defaultArgsOut(t);
      default:
        return t.summary ? `<div class="tc-summary">${esc(t.summary)}</div>` : defaultArgsOut(t);
    }
  }

  function renderEvent(ev) {
    switch (ev.type) {
      case 'user':
        return `<div class="ev ev-user" id="ev-${ev.id}">
          <div class="u-bubble">
            <div class="ev-body">${ev.html}</div>
            ${ev.refs && ev.refs.length ? `<div class="ev-refs">${ev.refs.map(r =>
              `<button class="chip-file" data-file="${esc(r)}">${OMP.icon('file-code', 'sm')}${esc(r)}</button>`).join('')}</div>` : ''}
          </div>
          <div class="u-meta">
            <div class="u-actions">
              <button class="icon-btn small" data-user-act="copy" data-tip="复制" aria-label="复制消息">${OMP.icon('copy', 'sm')}</button>
              <button class="icon-btn small" data-user-act="retry" data-tip="重试" aria-label="重新发送这条消息">${OMP.icon('refresh', 'sm')}</button>
              <button class="icon-btn small" data-user-act="fork" data-tip="Fork" aria-label="从这条消息 Fork 对话">${OMP.icon('fork', 'sm')}</button>
            </div>
            <span class="u-time">${esc(ev.time)}</span>
          </div>
        </div>`;
      case 'batch':
        return renderBatch(ev);
      case 'assistant':
        return `<div class="ev ev-assistant" id="ev-${ev.id}">
          <div class="a-head">
            <span class="a-badge">${OMP.icon('bot')}</span>
            <span class="a-name">OMP</span>
            <span class="a-meta">${esc(ev.model || '')}${ev.time ? ' · ' + ev.time : ''}</span>
          </div>
          <div class="ev-body">${ev.html}${ev.streaming ? '<span class="stream-caret"></span>' : ''}</div>
        </div>`;
      case 'approval': {
        const ok = ev.status === 'allowed';
        return `<div class="ev ev-note" id="ev-${ev.id}">
          <div class="ap-line">
            <span class="tc-st ${ok ? 'done' : 'error'}">${OMP.icon('shield')}</span>
            <span class="ap-text">${ok ? '已允许' : '已拒绝'} <b>${esc(ev.kind)}</b></span>
            <span class="ap-cmd">${esc(ev.cmd)}</span>
            <span class="ev-time">${ev.time}</span>
          </div>
        </div>`;
      }
      case 'error':
        return `<div class="ev" id="ev-${ev.id}">
          <div class="error-card">
            <div class="err-head">${OMP.icon('alert-c', 'sm')}${esc(ev.title)}</div>
            <div class="err-body">${ev.html}</div>
            <div class="err-actions">
              <button class="btn small primary" data-err="fix">${OMP.icon('wrench', 'sm')}请求 OMP 修复</button>
              <button class="btn small outline" data-err="copy">${OMP.icon('copy', 'sm')}复制错误</button>
            </div>
          </div>
        </div>`;
      case 'checkpoint':
        return `<div class="ev" id="ev-${ev.id}">
          <div class="checkpoint-card">
            <span class="cp-line" aria-hidden="true"></span>
            <div class="cp-main">
              ${OMP.icon('commit', 'sm')}
              <span class="cp-no">Checkpoint #${ev.no}</span>
              <span class="cp-stats">${ev.files} 文件 · +${ev.add}/-${ev.del} · 构建${ev.build}</span>
              <span class="cp-actions">
                <button class="icon-btn small" data-cp="both" data-tip="恢复代码与对话" aria-label="恢复代码与对话">${OMP.icon('rewind', 'sm')}</button>
                <button class="icon-btn small" data-cp="fork" data-tip="从这里 Fork" aria-label="从这里 Fork">${OMP.icon('fork', 'sm')}</button>
              </span>
            </div>
            <span class="cp-line" aria-hidden="true"></span>
          </div>
        </div>`;
      case 'compact':
        return `<div class="ev" id="ev-${ev.id}">
          <div class="compact-bar">
            <span class="cp-line" aria-hidden="true"></span>
            ${OMP.icon('minimize', 'sm')}
            <span class="cmp-label">Compact</span>
            <span class="meter cmp-meter" aria-hidden="true"><i style="width:${ev.pct}%"></i></span>
            <span>${esc(ev.summary)}</span>
            <span class="cp-line" aria-hidden="true"></span>
          </div>
        </div>`;
      default:
        return '';
    }
  }

  function bindConvo(root) {
    $$('.chip-file', root).forEach(c => c.addEventListener('click', () =>
      toast('已在编辑器打开：' + (c.dataset.file || c.textContent), 'file-code')));
    $$('[data-err]', root).forEach(b => b.addEventListener('click', () => {
      if (b.dataset.err === 'fix') { addCtxChip('TS2322 错误'); toast('错误已加入上下文，OMP 将在下一条消息中修复', 'wrench'); }
      else toast('错误详情已复制', 'copy');
    }));
    $$('[data-cp]', root).forEach(b => b.addEventListener('click', () => openCheckpointModal(b.dataset.cp)));
    $$('[data-user-act]', root).forEach(b => b.addEventListener('click', () => {
      const act = b.dataset.userAct;
      const card = b.closest('.ev-user');
      if (act === 'copy') {
        const body = card && card.querySelector('.ev-body');
        const text = body ? body.textContent.trim() : '';
        try { navigator.clipboard.writeText(text); } catch (e) {}
        toast('已复制消息', 'copy');
      } else if (act === 'retry') {
        toast('已重新发送该消息（原型不真正执行）', 'refresh');
      } else if (act === 'fork') {
        toast('已从这条消息 Fork 新 Thread', 'fork');
      }
    }));
    $$('.batch-sum', root).forEach(b => b.addEventListener('click', () => {
      const batch = b.closest('.ev-batch');
      if (!batch) return;
      const open = batch.classList.toggle('open');
      b.setAttribute('aria-expanded', String(open));
    }));
    $$('.tl-row', root).forEach(row => row.addEventListener('click', () => {
      const item = row.closest('.tl-item');
      if (!item) return;
      const open = item.classList.toggle('open');
      row.setAttribute('aria-expanded', String(open));
      const think = item.querySelector('.think-scroll');
      if (open && think) think.scrollTop = think.scrollHeight;
    }));
  }

  function renderConvo() {
    const doc = $convo();
    if (!doc) return;
    const wrap = doc.closest('.convo-wrap');
    if (!D.events || !D.events.length) {
      doc.innerHTML = emptyStateHtml();
      if (wrap) wrap.classList.add('is-empty');
      bindEmptyState(doc);
      return;
    }
    if (wrap) wrap.classList.remove('is-empty');
    doc.innerHTML = D.events.map(renderEvent).join('');
    bindConvo(doc);
  }

  /* ================= 空态 / 新对话欢迎区 =================
     品牌表达：巨型淡紫边线 π 作为背景水印，入场时描边自绘，下半部分
     渐隐并被问候语遮住。下方为 GitHub 风格紫色活动热力图。 */
  const EVENTS_SEED = D.events;

  /* 热力图数据：mulberry32 确定性伪随机，保证每次渲染网格与统计一致。
     活跃度随时间爬升 + 偶发冲刺周 + 周末回落，模拟真实使用节奏。 */
  function ceHeatmap() {
    let seed = 20260817;
    const rnd = () => {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    const WEEKS = 39;
    const WD = ['一', '二', '三', '四', '五', '六', '日'];
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - ((WEEKS - 1) * 7 + (now.getDay() + 6) % 7)); // 对齐到周一
    let tasks = 0, days = 0;
    const months = [];
    const cells = [];
    let prevM = -1;
    for (let w = 0; w < WEEKS; w++) {
      const weekDate = new Date(start);
      weekDate.setDate(weekDate.getDate() + w * 7);
      const m = weekDate.getMonth();
      if (m !== prevM) { months.push(`<span style="grid-column-start:${w + 1}">${m + 1}月</span>`); prevM = m; }
      const ramp = 0.3 + 0.7 * (w / (WEEKS - 1));
      const burst = rnd() < 0.2 ? 0.5 : 0;
      for (let d = 0; d < 7; d++) {
        const date = new Date(start);
        date.setDate(date.getDate() + w * 7 + d);
        if (date > now) {
          cells.push(`<span class="ce-hc is-future" style="--cw:${w};--cd:${d}"></span>`);
          continue;
        }
        const p = ramp + burst - (d >= 5 ? 0.3 : 0);
        let n = 0;
        if (rnd() < p * 0.62) n = 1 + Math.floor(rnd() * rnd() * 10);
        const l = n === 0 ? 0 : n < 3 ? 1 : n < 5 ? 2 : n < 7 ? 3 : 4;
        tasks += n; if (n) days++;
        const day = `${date.getMonth() + 1}月${date.getDate()}日 周${WD[d]}`;
        const tip = n ? `${n} 次任务 · ${day}` : `无任务 · ${day}`;
        cells.push(`<span class="ce-hc" data-l="${l}" style="--cw:${w};--cd:${d}" data-tip="${tip}"></span>`);
      }
    }
    const legend = [0, 1, 2, 3, 4].map(l => `<i data-l="${l}"></i>`).join('');
    return `
      <section class="ce-heat" aria-labelledby="ceHeatH">
        <div class="ce-heat-head ce-anim" style="--d:700ms">
          <h2 id="ceHeatH"><span class="ce-heat-pi" aria-hidden="true">π</span>活动轨迹</h2>
          <span class="ce-heat-stats">近 ${WEEKS} 周 · <b>${tasks}</b> 次任务 · <b>${days}</b> 活跃天</span>
        </div>
        <div class="ce-heat-board">
          <div class="ce-heat-months" aria-hidden="true">${months.join('')}</div>
          <div class="ce-heat-days" aria-hidden="true"><span style="grid-row-start:1">一</span><span style="grid-row-start:3">三</span><span style="grid-row-start:5">五</span></div>
          <div class="ce-heat-cells">${cells.join('')}</div>
          <div class="ce-heat-legend" aria-hidden="true">少${legend}多</div>
        </div>
      </section>`;
  }

  function ceGreeting() {
    const h = new Date().getHours();
    const part = h < 5 ? '夜深了' : h < 12 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
    const nameEl = document.querySelector('.sb-user .u-name');
    const name = (nameEl && nameEl.textContent.trim()) || 'snowpear';
    return part + '，' + name;
  }

  function ceRecents() {
    const toMin = s => {
      const m = /(\d+)\s*(m|h|d)/.exec(s || '');
      if (!m) return 99999;
      const n = +m[1];
      return m[2] === 'm' ? n : m[2] === 'h' ? n * 60 : n * 1440;
    };
    return D.projects
      .flatMap(p => (p.threads || []).map(t => Object.assign({}, t, { project: p.name })))
      .filter(t => t.status !== 'archived')
      .sort((a, b) => toMin(a.time) - toMin(b.time))
      .slice(0, 3);
  }

  function emptyStateHtml() {
    const recents = ceRecents().map(t => {
      const dot = t.status === 'running' ? 'green pulse' : t.status === 'approval' ? 'amber' : 'gray';
      const statusLabel = t.status === 'running' ? '运行中' : t.status === 'approval' ? '等待审批' : '空闲';
      return `
      <button class="ce-row" data-title="${esc(t.title)}" aria-label="继续对话：${esc(t.title)}（${statusLabel}，${esc(t.time)}）">
        <span class="dot ${dot}" aria-hidden="true"></span>
        <span class="ce-row-title">${esc(t.title)}</span>
        <span class="ce-row-meta"><span class="ce-meta-proj">${esc(t.project)}</span><span class="ce-meta-sep" aria-hidden="true"></span>${esc(t.time)}</span>
      </button>`;
    }).join('');
    return `
    <div class="convo-empty" role="region" aria-labelledby="ceGreet">
      <div class="ce-hero">
        <svg class="ce-pi ce-anim" style="--d:0ms" viewBox="0 0 321 309" aria-hidden="true">
          <defs>
            <linearGradient id="piStroke" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#a78bf0" stop-opacity=".95"/>
              <stop offset=".5" stop-color="#a78bf0" stop-opacity=".75"/>
              <stop offset="1" stop-color="#a78bf0" stop-opacity=".55"/>
            </linearGradient>
          </defs>
          <!-- 官方图标轮廓：横杠 281×59，腿宽 58；左腿高 140、挑檐 38；右腿高 210、挑檐 70。直角，无圆角。 -->
          <path class="ce-pi-glyph" d="M20 20 H301 V79 H231 V289 H173 V79 H116 V219 H58 V79 H20 Z"/>
        </svg>
        <h1 class="ce-greet ce-anim" style="--d:500ms" id="ceGreet">${esc(ceGreeting())}</h1>
        <p class="ce-sub ce-anim" style="--d:620ms">OMP 已就绪。开始一个新任务，或继续最近的对话。</p>
      </div>
      ${ceHeatmap()}
      <section class="ce-recent ce-anim" style="--d:820ms" aria-labelledby="ceRecentH">
        <div class="ce-recent-head">
          <h2 id="ceRecentH">最近对话</h2>
          <a class="ce-history" href="#!history">${OMP.icon('history', 'sm')}全部历史</a>
        </div>
        <div class="ce-rows">${recents}</div>
      </section>
      <div class="ce-tips ce-anim" style="--d:880ms">
        <span class="ce-tip"><span class="kbd">Ctrl ⇧ O</span>新建对话</span>
        <span class="ce-tip"><span class="kbd">Ctrl K</span>统一搜索</span>
        <span class="ce-tip"><span class="kbd">/</span>命令</span>
        <span class="ce-tip"><span class="kbd">@</span>引用上下文</span>
      </div>
    </div>`;
  }

  function bindEmptyState(doc) {
    $$('.ce-row', doc).forEach(b => b.addEventListener('click', () => {
      toast('继续对话：' + (b.dataset.title || ''), 'history');
    }));
  }

  function appendStreamEvent(html) {
    const doc = $convo();
    if (!doc) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const node = wrap.firstElementChild;
    if (!node) return;
    node.classList.add('anim');
    doc.appendChild(node);
    bindConvo(node);
    const sc = $('#convoScroll');
    if (sc) sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' });
  }

  /* ================= Deck（审批 / 提问 · 固定在输入框上方，队列化 1/N） ================= */
  let deckPos = 0;
  const INBOX_SEED = JSON.parse(JSON.stringify(D.inbox));
  const TODOS_SEED = JSON.parse(JSON.stringify(D.todos.items));

  function queueNav(pos, total) {
    if (total <= 1) return '';
    return `<span class="dk-queue">
      <button class="icon-btn small" data-qnav="-1" aria-label="上一个请求"${pos === 0 ? ' disabled' : ''}>${OMP.icon('chevron-l', 'sm')}</button>
      <span class="q-pos">${pos + 1}/${total}</span>
      <button class="icon-btn small" data-qnav="1" aria-label="下一个请求"${pos === total - 1 ? ' disabled' : ''}>${OMP.icon('chevron-r', 'sm')}</button>
    </span>`;
  }

  function renderDeckCard(it, pos, total) {
    if (it.type === 'approval') {
      const high = it.risk === 'high';
      return `<div class="deck-card approval" data-id="${it.id}">
        <div class="dk-top">
          <span class="dk-kind ${high ? 'high' : 'med'}">${OMP.icon('shield')}</span>
          <span class="dk-title">审批请求</span>
          <span class="chip ${high ? 'red' : 'amber'} xs">${high ? '高风险' : '中风险'}</span>
          <span class="dk-agent">${esc(it.agent)} · ${esc(it.time)}</span>
          ${queueNav(pos, total)}
        </div>
        <div class="dk-sub">${esc(it.title)}</div>
        <div class="codeblock dk-cmd"><div class="c-cmd">$ ${esc(it.cmd)}</div></div>
        <div class="dk-reason">${esc(it.reason)}</div>
        <div class="dk-scope">${OMP.icon('folder', 'sm')}范围：${esc(it.scope)}</div>
        <div class="dk-actions">
          <button class="btn small danger" data-resolve="deny">拒绝</button>
          <button class="btn small outline" data-resolve="always" data-tip="加入「始终允许」规则">始终允许</button>
          <button class="btn small primary" data-resolve="allow">允许一次</button>
        </div>
      </div>`;
    }
    return `<div class="deck-card ask" data-id="${it.id}">
      <div class="dk-top">
        <span class="dk-kind ask">${OMP.icon('message')}</span>
        <span class="dk-title">Agent 提问</span>
        <span class="dk-agent">${esc(it.agent)} · ${esc(it.time)}</span>
        ${queueNav(pos, total)}
      </div>
      <div class="dk-sub">${esc(it.title)}</div>
      <div class="dk-reason">${esc(it.desc)}</div>
      <div class="dk-opts" role="radiogroup" aria-label="${esc(it.title)}">
        ${it.options.map(o => `<button class="dk-opt" role="radio" aria-checked="false" data-opt="${esc(o.label)}">
          <span class="o-radio" aria-hidden="true"></span>
          <span class="o-label">${esc(o.label)}</span>
          ${o.rec ? '<span class="chip purple xs">推荐</span>' : ''}
        </button>`).join('')}
      </div>
      <div class="dk-custom">
        <input class="input dk-input" placeholder="自定义回答…" aria-label="自定义回答">
        <button class="btn small primary" data-send-custom>发送</button>
      </div>
    </div>`;
  }

  function renderDeck() {
    const deck = $('#deck');
    if (!deck) return;
    const items = D.inbox;
    if (!items.length) {
      deck.innerHTML = '';
      deck.classList.add('hidden');
      return;
    }
    deckPos = Math.max(0, Math.min(deckPos, items.length - 1));
    deck.classList.remove('hidden');
    deck.innerHTML = renderDeckCard(items[deckPos], deckPos, items.length);
    $$('[data-qnav]', deck).forEach(b => b.addEventListener('click', () => {
      deckPos += Number(b.dataset.qnav);
      renderDeck();
    }));
    $$('[data-resolve]', deck).forEach(b => b.addEventListener('click', () =>
      resolveInbox(items[deckPos].id, b.dataset.resolve)));
    $$('.dk-opt', deck).forEach(o => o.addEventListener('click', () => {
      $$('.dk-opt', deck).forEach(x => {
        x.classList.toggle('sel', x === o);
        x.setAttribute('aria-checked', String(x === o));
      });
      setTimeout(() => resolveInbox(items[deckPos].id, 'answer:' + o.dataset.opt), 160);
    }));
    const sendBtn = $('[data-send-custom]', deck);
    if (sendBtn) {
      const input = $('.dk-input', deck);
      const send = () => { const v = input.value.trim(); if (v) resolveInbox(items[deckPos].id, 'answer:' + v); };
      sendBtn.addEventListener('click', send);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
    }
  }

  function resolveInbox(id, action) {
    const idx = D.inbox.findIndex(x => x.id === id);
    if (idx < 0) return;
    const it = D.inbox[idx];
    const card = $(`.deck-card[data-id="${id}"]`);
    const done = () => {
      D.inbox.splice(idx, 1);
      renderDeck();
      appendStreamEvent(resolvedHtml(it, action));
    };
    if (card) { card.classList.add('removing'); setTimeout(done, 130); }
    else done();
  }

  function resolvedHtml(it, action) {
    const rid = 'res-' + it.id;
    if (it.type === 'approval') {
      const map = { allow: ['已允许', 'done'], always: ['已始终允许', 'done'], deny: ['已拒绝', 'error'] };
      const [txt, st] = map[action] || map.allow;
      return `<div class="ev ev-note" id="ev-${rid}">
        <div class="ap-line">
          <span class="tc-st ${st}">${OMP.icon('shield')}</span>
          <span class="ap-text">${txt} <b>${esc(it.kind)}</b></span>
          <span class="ap-cmd">${esc(it.cmd)}</span>
          <span class="ev-time">刚刚</span>
        </div>
      </div>`;
    }
    const answer = String(action).replace(/^answer:/, '');
    const options = (it.options || []).map(o => ({
      label: o.label,
      rec: !!o.rec,
      selected: o.label === answer
    }));
    if (answer && !options.some(o => o.selected)) options.push({ label: answer, selected: true });
    return renderBatch({
      id: 'res-' + it.id,
      items: [{
        kind: 'ask',
        name: 'Ask',
        status: 'done',
        question: it.title,
        target: it.title,
        options,
        answer
      }]
    });
  }

  function pulseDeck() {
    const deck = $('#deck');
    if (!deck || deck.classList.contains('hidden')) return;
    const card = $('.deck-card', deck);
    if (card) { card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash'); }
  }

  /* ================= Todo Dock（固定在输入框上方） ================= */
  let tdCollapsed = true;

  function tdIcon(st) {
    if (st === 'done') return OMP.icon('check', 'sm');
    if (st === 'doing') return '<span class="dot purple pulse" aria-hidden="true"></span>';
    return '<span class="td-hollow" aria-hidden="true"></span>';
  }

  function renderTodoDock() {
    const dock = $('#todoDock');
    if (!dock) return;
    const items = D.todos.items || [];
    if (!items.length) {
      dock.innerHTML = '';
      dock.classList.add('hidden');
      return;
    }
    const done = items.filter(i => i.status === 'done').length;
    const cur = items.find(i => i.status === 'doing');
    dock.classList.remove('hidden');
    dock.classList.toggle('collapsed', tdCollapsed);
    dock.innerHTML = `
      <button class="td-head" aria-expanded="${!tdCollapsed}" aria-label="Todo 清单，${done}/${items.length} 完成，${tdCollapsed ? '展开' : '收起'}">
        ${OMP.icon('queue', 'sm td-ic')}
        <span class="td-current ellipsis">${tdCollapsed && cur ? esc(cur.text) : 'Todo 清单'}</span>
        ${!tdCollapsed ? `<span class="td-updated">${esc(D.todos.updatedAt)} 更新</span>` : ''}
        <span class="meter td-meter" aria-hidden="true"><i style="width:${Math.round(done / items.length * 100)}%"></i></span>
        <span class="td-progress">${done}/${items.length}</span>
        ${OMP.icon('chevron-d', 'sm td-chev')}
      </button>
      <div class="td-collapse"><div class="td-body"><div class="td-list" role="list" aria-label="Todo 清单">
        ${items.map(it => `<div class="td-item ${it.status}" role="listitem"${it.status === 'doing' ? ' aria-current="true"' : ''}>
          <span class="td-ic">${tdIcon(it.status)}</span>
          <span class="td-text">${esc(it.text)}</span>
        </div>`).join('')}
      </div></div></div>`;
    $('.td-head', dock).addEventListener('click', () => { tdCollapsed = !tdCollapsed; renderTodoDock(); });
  }

  function flashTodoDock() {
    const dock = $('#todoDock');
    if (!dock || dock.classList.contains('hidden')) return;
    dock.classList.remove('flash'); void dock.offsetWidth; dock.classList.add('flash');
  }

  /* Checkpoint 恢复确认（明确影响范围） */
  function openCheckpointModal(kind) {
    const scope = {
      both: ['恢复代码与对话', '工作区文件将回滚到 Checkpoint #12 状态（4 个文件的当前修改会被覆盖）；对话将回滚到该节点，之后的 2 条消息会移除。'],
      code: ['仅恢复代码', '仅工作区文件回滚到 Checkpoint #12；对话历史保持不变。'],
      convo: ['仅恢复对话', '仅对话回滚到 Checkpoint #12；工作区文件保持不变。'],
      fork: ['从这里 Fork', '以 Checkpoint #12 为起点创建新 Thread，当前对话与代码均不受影响。'],
      commit: ['创建 Git Commit', '将当前 8 个变更文件提交为一个 Commit（不会影响对话）。']
    }[kind];
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal">
      <div class="modal-head">${scope[0]}</div>
      <div class="modal-body">
        <p>${scope[1]}</p>
        <div class="card" style="margin-top:10px;padding:10px 12px;font-size:12px" >
          <div class="mono small">Checkpoint #12 · 14:06 · 3 个文件 · +218/-4</div>
          <div class="tiny muted" style="margin-top:4px">docs/UPSTREAM-SYNC.md · README.md · components/MermaidBlock.tsx</div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn outline" data-x>取消</button>
        <button class="btn ${kind === 'both' || kind === 'code' ? 'danger' : 'primary'}" data-ok>确认${scope[0]}</button>
      </div>
    </div>`;
    wrap.addEventListener('mousedown', e => { if (e.target === wrap || e.target.closest('[data-x]')) wrap.remove(); });
    wrap.querySelector('[data-ok]').addEventListener('click', () => { wrap.remove(); toast(scope[0] + ' 完成', 'check'); });
    document.body.appendChild(wrap);
  }

  /* ================= Conversation Minimap（参照 omp-web ChatMinimap） ================= */
  const MM_LABEL = {
    user: '用户消息', assistant: 'Assistant', file: '文件变化',
    approval: '审批', bash: 'Bash', error: '错误', ask: 'Ask User',
    checkpoint: 'Checkpoint', compact: 'Compact'
  };

  function renderMinimap() {
    const track = $('#mmTrack');
    const sc = $('#convoScroll');
    const vp = $('#mmViewport');
    // 轨道参考线
    track.innerHTML = `<div class="mm-rail"></div>` + D.minimap.map((m, i) =>
      `<div class="mm-mark ${m.type}" style="top:${m.at}%" data-mm="${i}"></div>`).join('');
    const marks = $$('.mm-mark', track);
    const preview = $('#mmTip');

    // —— hover 预览浮层（回合序号 + 用户消息 + assistant 标题大纲） ——
    function showPreview(i, el) {
      const m = D.minimap[i];
      const no = String(i + 1).padStart(2, '0');
      const typeLabel = MM_LABEL[m.type] || m.type;
      const isSpecial = m.type === 'error' || m.type === 'approval' || m.type === 'ask' || m.type === 'checkpoint';
      preview.innerHTML = `
        <div class="mp-no">${no} · ${isSpecial ? `<span style="color:${m.type === 'error' ? 'var(--red)' : m.type === 'approval' ? 'var(--amber)' : 'var(--accent)'}">${typeLabel}</span>` : typeLabel}</div>
        <div class="mp-user">${m.userPreview}</div>
        ${m.headings.length ? m.headings.map(h => `<div class="mp-heading" data-hd="${h}"># ${h}</div>`).join('') : ''}
        <div class="tiny muted" style="margin-top:4px">点击圆点跳转 · 点击标题跳转到大纲位置</div>`;
      preview.classList.remove('hidden');
      // 定位：与圆点同高，靠右弹出
      const r = el.getBoundingClientRect();
      const wrap = $('#minimap').getBoundingClientRect();
      preview.style.top = Math.max(8, Math.min(r.top - wrap.top - 60, wrap.height - preview.offsetHeight - 40)) + 'px';
      // 标题跳转
      $$('.mp-heading', preview).forEach(h => h.addEventListener('click', () => {
        scrollToHeading(m, h.dataset.hd);
      }));
    }
    function scrollToHeading(m, text) {
      const node = $('#ev-' + m.evId);
      if (!node) return;
      const h = $$('h3, h2, h1', node).find(x => x.textContent.includes(text));
      if (h) { h.scrollIntoView({ behavior: 'smooth', block: 'center' }); flash(h); }
      else { node.scrollIntoView({ behavior: 'smooth', block: 'center' }); flash(node); }
    }
    function flash(el) {
      el.style.transition = 'background .3s';
      el.style.background = 'var(--accent-softer)';
      setTimeout(() => el.style.background = '', 900);
    }
    function scrollToEv(id) {
      const node = $('#ev-' + id);
      if (node) { node.scrollIntoView({ behavior: 'smooth', block: 'center' }); flash(node); }
    }

    let hideTimer = null;
    marks.forEach((el, i) => {
      el.addEventListener('mouseenter', () => { clearTimeout(hideTimer); showPreview(i, el); });
      el.addEventListener('mouseleave', () => { hideTimer = setTimeout(() => preview.classList.add('hidden'), 250); });
      preview.addEventListener('mouseenter', () => clearTimeout(hideTimer));
      preview.addEventListener('mouseleave', () => hideTimer = setTimeout(() => preview.classList.add('hidden'), 250));
      el.addEventListener('click', () => { preview.classList.add('hidden'); scrollToEv(D.minimap[i].evId); });
    });

    // —— 拖拽期间压制残余 smooth 动画帧 ——
    // 取消动画后 Chrome 仍可能落地一帧残余样本写入 scrollTop；拖动期间每帧把
    // scrollTop 拉回拖拽目标值（dragTarget），直到 mouseup。
    function startScrollStomp() {
      let raf = 0;
      const loop = () => {
        if (sc.scrollTop !== dragTarget) {
          sc.scrollTo({ top: dragTarget, behavior: 'instant' });
          syncActive();
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(raf);
    }

    // —— 轨道拖动/点击（按比例滚动）：拖动跟手；单击空白处平滑滚到该位置 ——
    let dragging = false;
    track.addEventListener('mousedown', e => {
      if (e.target.closest('.mm-mark')) return;
      dragging = true;
      const downY = e.clientY;
      let moved = false;
      const maxScroll = () => sc.scrollHeight - sc.clientHeight;
      dragTarget = sc.scrollTop;
      const stop = startScrollStomp();
      const move = ev => {
        if (Math.abs(ev.clientY - downY) > 3) moved = true;
        const r = track.getBoundingClientRect();
        const ratio = (ev.clientY - r.top) / r.height;
        dragTarget = ratio * maxScroll();
        // behavior:'instant' 绕过 .convo-scroll 的 scroll-behavior:smooth，拖动才能跟手
        sc.scrollTo({ top: dragTarget, behavior: 'instant' });
        syncActive(); // 程序化滚动不保证触发 scroll 事件，直接同步指示条
      };
      const up = () => {
        dragging = false;
        stop();
        dragTarget = null;
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (!moved) { // 单击空白区：平滑滚动到点击位置（滚动条行为）
          const r = track.getBoundingClientRect();
          const ratio = Math.min(1, Math.max(0, (downY - r.top) / r.height));
          sc.scrollTo({ top: ratio * maxScroll() });
        }
      };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });

    // —— 拖动视口指示条：滑块语义，保持抓取偏移，滚动自然跟随 ——
    vp.addEventListener('mousedown', e => {
      const trackH = () => track.clientHeight;
      const maxScroll = () => sc.scrollHeight - sc.clientHeight;
      // clientY / grab 都是视口坐标；dragTarget 公式需要 minimap 相对坐标，
      // 必须减去 minimap 的视口偏移，否则第一次移动条会瞬间偏离鼠标（跳动一下）
      const mmTop = track.getBoundingClientRect().top;
      dragTarget = sc.scrollTop;
      const stop = startScrollStomp();
      const grab = e.clientY - vp.getBoundingClientRect().top;
      const move = ev => {
        const vpH = parseFloat(vp.style.height) || 18;
        if (maxScroll() <= 0) return;
        const top = Math.min(Math.max(0, ev.clientY - grab - mmTop), trackH() - 52 - vpH);
        dragTarget = top / (trackH() - 52 - vpH) * maxScroll();
        sc.scrollTo({ top: dragTarget, behavior: 'instant' });
        syncActive(); // 程序化滚动不保证触发 scroll 事件，直接同步指示条
      };
      const up = () => {
        stop();
        dragTarget = null;
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    // —— 滚动时同步 active 节点（最接近视口中部的回合） + 离开底部提示 ——
    // 视口指示：长方形高度 = 视口占比，位置 = 滚动进度，宽度撑满 minimap；
    // 顶部与 minimap 齐平，行程下端让开底部工具按钮（52px）。
    // 拖动期间以 dragTarget 为准（而非实时 scrollTop）：取消 smooth 动画后
    // 仍会有一帧残余样本写入 scrollTop，若条跟随它就会相对鼠标跳动。
    let dragTarget = null;
    function syncViewport() {
      const maxScroll = sc.scrollHeight - sc.clientHeight;
      if (maxScroll <= 0) { vp.hidden = true; return; }
      vp.hidden = false;
      const trackH = track.clientHeight;
      const range = trackH - 52;
      const ratio = (dragTarget !== null ? dragTarget : sc.scrollTop) / maxScroll;
      const vpH = Math.max(18, (sc.clientHeight / sc.scrollHeight) * range);
      vp.style.height = vpH + 'px';
      vp.style.top = (ratio * (range - vpH)) + 'px';
    }
    function syncActive() {
      syncViewport(); // 拖动中也要实时跟随（scrollTop 已由拖动更新）
      if (dragging) return;
      let best = null, bestDist = Infinity;
      const mid = sc.clientHeight * 0.5;
      marks.forEach(el => {
        const r = el.getBoundingClientRect();
        const c = r.top + r.height / 2 - sc.getBoundingClientRect().top;
        const d = Math.abs(c - mid);
        if (d < bestDist) { bestDist = d; best = el; }
      });
      marks.forEach(el => el.classList.toggle('active', el === best));
      // 离开底部提示
      const atBottom = sc.scrollTop + sc.clientHeight > sc.scrollHeight - 60;
      $('#newContentPill').classList.toggle('hidden', atBottom || !document.body.dataset.hasNew);
    }
    sc.addEventListener('scroll', syncActive);
    // 底栏展开/收起/拖动调高、侧栏宽度变化等都会改变滚动区尺寸，此时不触发 scroll
    // 事件，指示条的高度与行程会停留在旧几何。监听尺寸变化即时重算。
    if (window.ResizeObserver) {
      new ResizeObserver(() => syncActive()).observe(sc);
    } else {
      window.addEventListener('resize', () => syncActive());
    }
    setTimeout(syncActive, 50);
    $('#mmBottom').addEventListener('click', () => sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' }));
    $('#newContentPill').addEventListener('click', () => sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' }));

    // —— 筛选 / 跳转工具 ——
    $('#mmFilter').addEventListener('click', e => {
      const m = menu(`
        <div class="menu-label">Minimap 导航</div>
        ${mi('x', '跳到上一个错误')}
        ${mi('diff', '跳到上一个文件修改')}
        ${mi('user', '跳到上一个用户消息')}
        <div class="menu-sep"></div>
        ${mi('check', '仅显示错误与审批')}
        ${mi('refresh', '显示全部事件')}
      `);
      m.style.minWidth = '200px';
      m.addEventListener('click', ev => {
        const act = ev.target.closest('.menu-item');
        if (act) {
          const label = act.textContent.trim();
          const typeMap = { '跳到上一个错误': 'error', '跳到上一个文件修改': 'file', '跳到上一个用户消息': 'user' };
          const t = typeMap[label];
          if (t) {
            const idx = [...marks].findIndex(x => x.classList.contains('active'));
            const list = D.minimap.filter(m2 => m2.type === t);
            if (list.length) { const cur = D.minimap[idx]; const next = list.find(m2 => m2.at > (cur ? cur.at : 0)) || list[0]; scrollToEv(next.evId); }
          } else {
            toast(label === '仅显示错误与审批' ? '已筛选：仅显示错误与审批' : '已显示全部事件');
          }
        }
        OMP.ui.closeOverlay();
      });
      openOverlay(m, e.currentTarget, 'up-right');
    });
  }

  /* ================= Telemetry 详情（Token / Context 两个独立预览） ================= */
  function initTelemetry() {
    const t = D.telemetry;

    // —— Token 用量预览（点击 ↑↓ / cache 区域） ——
    $('#tgTokens').addEventListener('click', e => {
      e.stopPropagation();
      // 三层信息结构：头部关键数字 → 输入/输出占比 → 明细行
      const inPct = 72, outPct = 12, cachePct = 16;
      const m = menu(`
        <div class="tp-head">${OMP.icon('zap', 'sm')}Token 用量<span class="spacer"></span><span class="chip blue">会话</span></div>
        <div class="tok-hero">
          <div class="th-cell">
            <div class="th-k">总消耗</div>
            <div class="th-v">220.4k</div>
            <div class="th-sub">本轮 48.9k</div>
          </div>
          <div class="th-cell">
            <div class="th-k">Cost</div>
            <div class="th-v">${t.cost}</div>
            <div class="th-sub">缓存已省 <b>78%</b></div>
          </div>
        </div>
        <div class="tok-split">
          <div class="ts-top"><span>构成</span><b>${t.inputTokens} 入 / ${t.outputTokens} 出</b></div>
          <div class="tok-bar">
            <i class="tb-in" style="width:${inPct}%"></i>
            <i class="tb-out" style="width:${outPct}%"></i>
            <i class="tb-cache" style="width:${cachePct}%"></i>
          </div>
          <div class="tok-keys">
            <span><i class="tb-in"></i>输入</span>
            <span><i class="tb-out"></i>输出</span>
            <span><i class="tb-cache"></i>缓存 ${t.cacheTokens}</span>
          </div>
        </div>
        <div class="tok-rows">
          <div class="tr-row">本轮输入 / 输出<span class="tr-v">42.1k / 6.8k</span></div>
          <div class="tr-row">本轮耗时<span class="tr-v">${t.turnTime}</span></div>
          <div class="tr-row">会话总耗时<span class="tr-v">${t.sessionTime}</span></div>
          <div class="tr-row">子 Agent 消耗<span class="tr-v">${t.subagentCost}</span></div>
          <div class="tr-row">重试 / Fallback<span class="tr-v ${t.retries ? '' : 'ok'}">${t.retries} 次 / 无</span></div>
        </div>
        <div class="tp-ctx">
          <div class="tiny muted">当前模型 ${t.model} · Thinking ${t.thinking} · Fast ${t.fastMode ? 'on' : 'off'} · Service Tier ${t.serviceTier}</div>
        </div>
      `, 'telemetry-pop tok-pop');
      openOverlay(m, e.currentTarget, 'down-right');
    });

    // —— Context 构成预览（点击 ctx 环 / 百分比区域），彩色堆叠条 ——
    $('#tgCtx').addEventListener('click', e => {
      e.stopPropagation();
      const parts = [
        { name: '系统提示词', v: '13k',  pct: 5.9,  color: '#8a919c' },
        { name: 'Skills',     v: '24k',  pct: 10.9, color: '#6e56cf' },
        { name: '对话历史',   v: '119k', pct: 54.0, color: '#3b9bd4' },
        { name: '文件内容',   v: '42k',  pct: 19.1, color: '#d9930d' },
        { name: '工具定义',   v: '18k',  pct: 8.2,  color: '#64748b' },
        { name: '子 Agent 汇总', v: '4.3k', pct: 2.0, color: '#2f9e6e' }
      ];
      const m = menu(`
        <div class="tp-head">${OMP.icon('layers', 'sm')}CONTEXT 构成<span class="spacer"></span><span class="chip ${t.ctxPct > 80 ? 'red' : t.ctxPct > 60 ? 'amber' : 'green'}">${t.ctxPct}%</span></div>
        <div class="tp-ctx" style="padding-top:12px">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span>已使用</span>
            <b class="mono" style="font-size:13px">220,400 / 1,000,000（22.0%）</b>
          </div>
          <div class="ctxbar">${parts.map(p => `<i style="width:${p.pct}%;background:${p.color}" title="${p.name} ${p.v}"></i>`).join('')}</div>
          <div class="ctx-legend">
            ${parts.map(p => `<div class="cl-row"><span class="cl-dot" style="background:${p.color}"></span><span>${p.name}</span><span class="cl-v">${p.v}</span></div>`).join('')}
          </div>
          <div class="tiny muted" style="border-top:1px solid var(--border);padding-top:8px">Compact：${t.compact} · 上次 Compact：3 天前 · 阈值 80%</div>
        </div>
      `, 'telemetry-pop ctx-pop');
      openOverlay(m, e.currentTarget, 'down-right');
    });
  }

  /* ================= 输入区 ================= */
  function addCtxChip(label) {
    const wrap = $('#ctxChips');
    const c = document.createElement('span');
    c.className = 'ctx-chip';
    // The remove affordance was a <span> with a click handler holding only an
    // icon: not focusable, no name, so a reference could be added by keyboard
    // but never removed by one.
    c.innerHTML = `${label}<button class="x" aria-label="移除引用 ${label}">${OMP.icon('x', 'sm')}</button>`;
    c.querySelector('.x').addEventListener('click', () => {
      c.remove();
      // Removing the chip destroys the focused button; move focus somewhere
      // sensible instead of letting it fall to <body>.
      const next = wrap.querySelector('.ctx-chip .x') || $('#composerInput');
      if (next) next.focus();
    });
    wrap.appendChild(c);
  }

  const AT_ITEMS = [
    ['file-code', 'components/MermaidBlock.tsx', '文件'], ['folder', 'components/', '目录'],
    ['diff', '当前 Turn 的 Changes', 'Diff'], ['bot', 'preview 子 Agent', 'Agent'],
    ['terminal', 'Terminal 输出 · typecheck', 'Terminal'], ['alert', 'TS2322 错误', '错误'],
    ['globe', 'Preview 页面 · 127.0.0.1:30141', 'Preview'], ['camera', 'Preview 截图', '截图'],
    ['commit', 'Checkpoint #12', 'Checkpoint']
  ];
  const SLASH_ITEMS = D.slashCommands.map(c => ['slash', c.name + ' ' + c.args, c.desc]);

  /* The @ / completion popup was mouse-only in a way that made it unusable
     without a pointer, on the app's primary input:
       - Items bound only `mousedown`, so there was no keyboard path at all.
       - Nothing tracked a highlighted item, so arrow keys did nothing and
         Enter fell straight through to send the message mid-completion.
       - The list was invisible to assistive tech: no listbox/option roles and
         no aria-activedescendant, so the textarea gave no hint that a menu had
         appeared or how many matches there were.
     It is now a standard combobox popup: arrows move, Enter/Tab accept, Escape
     dismisses, and the match count is announced. */
  function initComposer() {
    const input = $('#composerInput');
    const pop = $('#completePop');
    const live = $('#completeCount');
    let items = [];
    let sel = -1;

    function hideComplete() {
      pop.classList.add('hidden');
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      items = [];
      sel = -1;
    }

    function paintSel() {
      $$('.complete-item', pop).forEach((el, i) => {
        const on = i === sel;
        el.classList.toggle('sel', on);
        el.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) {
          input.setAttribute('aria-activedescendant', el.id);
          el.scrollIntoView({ block: 'nearest' });
        }
      });
      if (sel < 0) input.removeAttribute('aria-activedescendant');
    }

    function showComplete(list) {
      if (!list.length) { hideComplete(); return; }
      items = list;
      // Starts at the first match so Enter has an unambiguous target, matching
      // how the command palette behaves.
      sel = 0;
      pop.innerHTML = list.map((i, idx) =>
        `<div class="complete-item" id="cmpItem${idx}" role="option" aria-selected="false" data-idx="${idx}">
          ${OMP.icon(i[0], 'sm')}<span class="ci-label">${i[1]}</span><span class="ci-type">${i[2]}</span>
        </div>`).join('');
      pop.classList.remove('hidden');
      input.setAttribute('aria-expanded', 'true');
      if (live) live.textContent = `${list.length} 个匹配项，使用上下方向键选择`;
      $$('.complete-item', pop).forEach(el => el.addEventListener('mousedown', e => {
        e.preventDefault();
        accept(+el.dataset.idx);
      }));
      paintSel();
    }

    function accept(idx) {
      const it = items[idx];
      if (!it) return;
      addCtxChip(it[1]);
      // Strip the partial @/ token that triggered the popup.
      input.value = input.value.replace(/[@/]\S*$/, '');
      hideComplete();
      input.focus();
    }

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(200, input.scrollHeight) + 'px';
      const v = input.value;
      const last = v.slice(0, input.selectionStart).split(/\s/).pop();
      if (last.startsWith('@')) showComplete(AT_ITEMS.filter(i => i[1].toLowerCase().includes(last.slice(1).toLowerCase())));
      else if (last.startsWith('/')) showComplete(SLASH_ITEMS.filter(i => i[1].toLowerCase().includes(last.slice(1).toLowerCase())));
      else hideComplete();
    });

    input.addEventListener('keydown', e => {
      const open = !pop.classList.contains('hidden') && items.length;
      if (open) {
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % items.length; paintSel(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; paintSel(); return; }
        if (e.key === 'Home') { e.preventDefault(); sel = 0; paintSel(); return; }
        if (e.key === 'End') { e.preventDefault(); sel = items.length - 1; paintSel(); return; }
        // While the popup is open Enter accepts the highlighted item rather than
        // sending — otherwise a half-typed @reference gets fired off as a message.
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(sel); return; }
        if (e.key === 'Escape') { e.preventDefault(); hideComplete(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#btnSend').click(); }
      if (e.key === 'Escape') hideComplete();
    });

    document.addEventListener('mousedown', e => { if (!pop.contains(e.target) && e.target !== input) hideComplete(); });
    // Tabbing away should not leave an orphaned popup floating over the page.
    input.addEventListener('blur', () => setTimeout(() => {
      if (!pop.contains(document.activeElement)) hideComplete();
    }, 0));

    $('#btnSend').addEventListener('click', () => {
      const v = input.value.trim();
      if (!v) return;
      input.value = ''; input.dispatchEvent(new Event('input'));
      if (document.body.dataset.running === '1') {
        // 运行中：进入 Follow-up 队列
        const chip = $('#fqChip');
        chip.innerHTML = `${OMP.icon('queue', 'sm')}Follow-up ×2`;
        toast('已加入 Follow-up 队列，当前 Run 完成后继续执行', 'queue');
      } else {
        toast('消息已发送（原型不真正执行）', 'send');
      }
    });
  }

  /* ================= 模型 / 权限切换 =================
     Each of these three pills shows a bare value ("gemini-3.6-flash", "high",
     "default") and carries the "what" in its aria-label. The handlers updated
     the visible text but never the label, so after one switch the announced
     name and the painted value disagreed — the pill would still read
     "当前模型：gemini-3.6-flash" while showing claude-sonnet-4.5. This helper
     keeps the two in lockstep, and is the single place that writes either. */
  function setPillValue(btnId, labelId, value, prefix) {
    $(labelId).textContent = value;
    $(btnId).setAttribute('aria-label', `${prefix}：${value}`);
  }

  /* The old handlers read the chosen item with `.querySelector('span')`, which
     grabs whichever span is first — that also matches the `.hint` and `.kbd`
     spans mi() emits, so an item with a hint could resolve to the wrong text.
     Reading the labelled span directly removes the ambiguity. */
  function menuItemLabel(ev) {
    const item = ev.target.closest('.menu-item');
    if (!item) return null;
    const span = item.querySelector('span:not(.hint):not(.kbd)');
    return span ? span.textContent.trim() : null;
  }

  function initTopMenus() {
    $('#btnModel').addEventListener('click', e => {
      const models = ['gemini-3.6-flash (default)', 'claude-sonnet-4.5', 'gpt-5.2-codex', 'gemini-3.6-pro'];
      const m = menu('<div class="menu-label">当前模型</div>' + models.map(x => mi('cpu', x)).join('') + '<div class="menu-sep"></div>' + mi('settings', 'Models and Providers…'));
      m.addEventListener('click', ev => {
        const label = menuItemLabel(ev);
        if (label && label.includes('Providers')) OMP.router.goto('settings', 'models');
        else if (label) {
          setPillValue('#btnModel', '#modelLabel', label.split(' ')[0], '当前模型');
          toast('模型已切换：' + label, 'cpu');
        }
        OMP.ui.closeOverlay();
      });
      openOverlay(m, e.currentTarget, 'up-right');
    });
    $('#btnThinking').addEventListener('click', e => {
      const levels = ['high', 'medium', 'low', 'off'];
      const m = menu('<div class="menu-label">思考强度 (Thinking Level)</div>' + levels.map(x => mi('brain', x)).join(''));
      m.addEventListener('click', ev => {
        const label = menuItemLabel(ev);
        if (label) {
          setPillValue('#btnThinking', '#thinkingLabel', label, '思考强度');
          toast('思考强度：' + label, 'brain');
        }
        OMP.ui.closeOverlay();
      });
      openOverlay(m, e.currentTarget, 'up-right');
    });
    $('#btnPermission').addEventListener('click', e => {
      const m = menu('<div class="menu-label">权限模式</div>' +
        mi('eye', 'Review · 所有写操作需审批') +
        mi('shield', 'Workspace · 工作区内自动允许') +
        mi('unlock', 'Full Access · 完全信任') +
        '<div class="menu-sep"></div>' + mi('settings', 'Permissions 设置…'));
      m.addEventListener('click', ev => {
        const label = menuItemLabel(ev);
        if (label && label.includes('Permissions')) OMP.router.goto('settings', 'permissions');
        else if (label) {
          const mode = label.split(' ')[0].toLowerCase();
          setPillValue('#btnPermission', '#permLabel', mode, '权限模式');
          // Full Access 为高风险模式：橙红色警示。The amber tint was the only
          // signal that the app had been put in its most permissive state, and
          // colour alone cannot carry that — the label now says so too.
          const risky = mode === 'full';
          $('#btnPermission').classList.toggle('warn', risky);
          if (risky) $('#btnPermission').setAttribute('aria-label', '权限模式：full access（高风险，完全信任）');
          toast('权限模式：' + mode, 'shield');
        }
        OMP.ui.closeOverlay();
      });
      openOverlay(m, e.currentTarget, 'up-right');
    });
    $('#btnFork').addEventListener('click', () => toast('已 Fork 当前对话为新 Thread', 'fork'));
    $('#btnHandoff').addEventListener('click', () => toast('已创建 Handoff：新 Thread 将携带当前摘要与 Changes', 'handoff'));
    // 顶部 Compact 按钮
    $('#btnCompact').addEventListener('click', () => {
      toast('正在压缩上下文（Compact）… 压缩后 Context 释放，历史将以摘要保留', 'minimize');
    });
    /* #btnLayout = Codex 式「展开右侧面板」按钮：点击直接开/关右侧功能面板
       （按当前激活 tab 打开），不再弹模式选择菜单。 */
    $('#btnLayout').addEventListener('click', () => {
      const sp = $('#sidePanel');
      if (sp.classList.contains('open')) {
        closeSidePanel();
      } else {
        const tab = $('#spTabs button.active')?.dataset.sp || 'changes';
        openSidePanel(tab);
      }
    });
  }

  /* ================= 右侧功能面板 ================= */
  /* Git status was a bare coloured letter with no text equivalent — "M" alone
     tells a screen reader nothing, and the colour is the only other signal. */
  const GIT_LABEL = { M: '已修改', A: '新增', D: '已删除', '?': '未跟踪' };

  function fstatChip(s) {
    const map = { M: 'm', A: 'a', D: 'd', '?': 'u' };
    const icon = { M: 'pencil', A: 'plus', D: 'trash', '?': 'file-plus' };
    const cls = map[s] || 'm';
    /* SVG 图标 + 色底（双通道，不单靠颜色）；sr-only 文字供读屏 */
    return `<span class="fstat ${cls}">${OMP.icon(icon[s] || 'pencil')}<span class="sr-only"> ${GIT_LABEL[s] || ''}</span></span>`;
  }

  function renderChanges() {
    /* Rows are now real <button>s inside a group. As <div>s they were the primary
       way to open a diff and were mouse-only. The +/- counts also read as bare
       signed numbers, so each gets a unit. */
    const g = (title, rows, id) => `
      <div class="ch-group" role="group" aria-labelledby="${id}">
        <div class="ch-group-title" id="${id}">
          <span>${title}</span><span class="ch-count" aria-label="${rows.length} 个文件">${rows.length}</span>
        </div>
        ${rows.map(r => `<button class="ch-row" data-file="${r.file}">
          ${fstatChip(r.status)}<span class="ch-file ellipsis">${r.file}</span>
          ${r.agent ? `<span class="ch-note">${r.agent}</span>` : `<span class="ch-note">${r.note || ''}</span>`}
          <span class="ch-delta">
            <span class="ch-add">+${r.add}<span class="sr-only"> 行新增</span></span>
            <span class="ch-del">-${r.del}<span class="sr-only"> 行删除</span></span>
          </span>
        </button>`).join('')}
      </div>`;
    /* The grouping control was a <button> wrapping a <span class="seg"> wrapping
       three more <button>s — nested interactive content, which is invalid HTML and
       makes the inner buttons unreliable to activate. Flattened to one segmented
       group; it is a single-choice control, so radios rather than buttons. */
    $('#spChanges').innerHTML = `
      <div class="ch-toolbar">
        <span class="seg" role="radiogroup" aria-label="变更分组方式">
          <button role="radio" aria-checked="true" class="active" data-group="turn" tabindex="0">按 Turn</button>
          <button role="radio" aria-checked="false" data-group="folder" tabindex="-1">按文件夹</button>
          <button role="radio" aria-checked="false" data-group="agent" tabindex="-1">按 Agent</button>
        </span>
        <span class="spacer"></span>
        <button class="btn small outline" id="chReviewAll">查看全部 Diff</button>
        <button class="btn small primary" id="chCommit">创建 Commit</button>
      </div>
      <div class="ch-list" id="chList">
        ${g('当前 Turn', D.changes.turn, 'chgTurn')}
        ${g('本 Thread 累积', D.changes.thread, 'chgThread')}
        ${g('Agent 开始前已存在', D.changes.preexisting, 'chgPre')}
      </div>
      <!-- Diff 区域高度调节条：展开 Diff 时出现（renderDiff 控制 hidden） -->
      <div class="ch-diff-resizer" id="chDiffResizer" role="separator" tabindex="0"
           aria-orientation="horizontal" aria-label="调整 Diff 区域高度" hidden></div>
      <div class="ch-diff-slot" id="diffSlot"></div>`;
    $('#chReviewAll').addEventListener('click', () => toast('已展开全部 8 个文件的连续 Diff'));
    $('#chCommit').addEventListener('click', () => toast('已创建 Commit：docs: upstream sync v0.8.1', 'commit'));
    $$('#spChanges [data-group]').forEach(b => b.addEventListener('click', () => {
      $$('#spChanges [data-group]').forEach(x => {
        const on = x === b;
        x.classList.toggle('active', on);
        x.setAttribute('aria-checked', on ? 'true' : 'false');
        x.setAttribute('tabindex', on ? '0' : '-1');
      });
      toast('分组方式：' + b.textContent.trim());
    }));
    $$('#spChanges .ch-row').forEach(r => r.addEventListener('click', () => {
      $$('#spChanges .ch-row').forEach(x => {
        x.classList.remove('sel');
        x.setAttribute('aria-current', 'false');
      });
      r.classList.add('sel');
      r.setAttribute('aria-current', 'true');
      renderDiff(r.dataset.file);
    }));
    initChDiffResizer();
    OMP.ui.labelIconButtons($('#spChanges'));
  }

  /* Diff 区域高度调节：文件列表与 Diff 之间的可拖拽分隔条。
     交互与底部面板 resizer 一致：鼠标拖拽 + 方向键微调 + Home/End 跳极值
     （WCAG 2.5.7 单一指针/键盘替代方案）。 */
  const CH_MIN = 96;
  let chDiffH = null;   // 会话内记住上次高度，重开 Diff 沿用

  function initChDiffResizer() {
    const res = $('#chDiffResizer');
    if (!res) return;
    const sp = $('#spChanges');
    const slot = $('#diffSlot');
    const maxH = () => Math.max(CH_MIN, sp.clientHeight - 150);
    function setH(px) {
      chDiffH = Math.min(maxH(), Math.max(CH_MIN, Math.round(px)));
      slot.style.height = chDiffH + 'px';
      res.setAttribute('aria-valuenow', String(chDiffH));
    }
    res.setAttribute('aria-valuemin', String(CH_MIN));
    res.setAttribute('aria-valuemax', String(maxH()));
    res.addEventListener('mousedown', e => {
      e.preventDefault();
      res.classList.add('dragging');
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      const startY = e.clientY;
      const startH = slot.getBoundingClientRect().height;
      const move = ev => { ev.preventDefault(); setH(startH - (ev.clientY - startY)); };
      const up = () => {
        res.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    res.addEventListener('keydown', e => {
      const step = e.shiftKey ? 60 : 20;
      const cur = chDiffH ?? slot.getBoundingClientRect().height;
      let handled = true;
      if (e.key === 'ArrowUp') setH(cur + step);
      else if (e.key === 'ArrowDown') setH(cur - step);
      else if (e.key === 'Home') setH(maxH());
      else if (e.key === 'End') setH(CH_MIN);
      else handled = false;
      if (handled) e.preventDefault();
    });
  }

  function renderDiff(file) {
    const d = D.diff;
    let split = false;
    const slot = $('#diffSlot');
    const res = $('#chDiffResizer');
    if (chDiffH == null) {
      const sp = $('#spChanges');
      chDiffH = Math.max(CH_MIN, Math.round(sp.clientHeight * 0.45));
    }
    slot.style.height = chDiffH + 'px';
    if (res) {
      res.hidden = false;
      res.setAttribute('aria-valuenow', String(chDiffH));
    }
    slot.innerHTML = `
      <div class="diff-toolbar">
        ${OMP.icon('file-code', 'sm')}<span class="mono small ellipsis">${file || d.file}</span>
        <span class="ch-add">+${d.add}</span><span class="ch-del">-${d.del}</span>
        <span class="spacer"></span>
        <span class="seg" role="radiogroup" aria-label="Diff 显示模式">
          <button role="radio" aria-checked="${!split}" class="${split ? '' : 'active'}" data-m="inline">Inline</button>
          <button role="radio" aria-checked="${split}" class="${split ? 'active' : ''}" data-m="split">Split</button>
        </span>
        <button class="icon-btn small" data-tip="撤销文件">${OMP.icon('rewind', 'sm')}</button>
        <button class="icon-btn small" data-tip="在外部编辑器打开">${OMP.icon('external', 'sm')}</button>
        <button class="icon-btn small" data-tip="关闭 Diff" id="diffClose">${OMP.icon('x', 'sm')}</button>
      </div>
      <div class="diff-scroll" id="diffScroll"></div>`;
    const scroll = $('#diffScroll');
    /* 行内词级 diff：相邻 -/+ 行对按词元（单词/非单词）做 LCS，变化片段
       用 mark 高亮（GitHub 风格）。字符级 LCS 在 string→const 这类词内
       变更上会产出碎片，词元级输出干净。任一侧超长退化整行高亮。 */
    function tokenize(s) {
      const toks = [];
      let i = 0;
      while (i < s.length) {
        let j = i;
        const isWord = /\w/.test(s[i]);
        while (j < s.length && /\w/.test(s[j]) === isWord) j++;
        toks.push(s.slice(i, j));
        i = j;
      }
      return toks;
    }
    function inlineSegments(a, b) {
      const ta = tokenize(a), tb = tokenize(b);
      if (ta.length > 400 || tb.length > 400) return null;
      const m = ta.length, n = tb.length;
      const W = n + 1;
      const dp = new Uint32Array((m + 1) * W);
      for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
          dp[i * W + j] = ta[i] === tb[j]
            ? dp[(i + 1) * W + j + 1] + 1
            : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
        }
      }
      const opsA = [], opsB = [];
      let i = 0, j = 0;
      while (i < m && j < n) {
        if (ta[i] === tb[j]) { opsA.push(0); opsB.push(0); i++; j++; }
        else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { opsA.push(1); i++; }
        else { opsB.push(1); j++; }
      }
      while (i < m) { opsA.push(1); i++; }
      while (j < n) { opsB.push(1); j++; }
      const runs = (src, ops) => {
        const out = [];
        let k = 0;
        while (k < src.length) {
          const t = ops[k];
          let s = '';
          while (k < src.length && ops[k] === t) { s += src[k]; k++; }
          out.push({ t, s });
        }
        return out;
      };
      return { a: runs(ta, opsA), b: runs(tb, opsB) };
    }
    function inlineHtml(segments, markCls) {
      return segments.map(sg => sg.t === 0 ? escapeHtml(sg.s) : `<mark class="${markCls}">${escapeHtml(sg.s)}</mark>`).join('');
    }
    function paint() {
      scroll.className = 'diff-scroll' + (split ? ' diff-split' : '');
      const lines = d.hunks[0].lines;
      scroll.innerHTML = `<div class="diff-head-row">@@ ${d.file} · hunk 1/2 @@</div>` + lines.map((l, idx) => {
        // Was a clickable div — the only way to reveal collapsed context, and it
        // was mouse-only.
        if (l[0] === 'collapse') return `<button class="dl collapse">${OMP.icon('chevron-ud', 'sm')} ${l[1]} · 点击展开</button>`;
        const cls = l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : '';
        // Added/removed lines were distinguished by background tint alone. The
        // +/- marker is the conventional non-colour cue and is what a screen
        // reader has to go on; it is aria-hidden'd out of the line text so the
        // code itself still reads cleanly, and announced via the row label.
        const mark = l[0] === '+' ? '+' : l[0] === '-' ? '−' : ' ';
        const srLabel = l[0] === '+' ? '新增行' : l[0] === '-' ? '删除行' : '';
        const sr = srLabel ? `<span class="sr-only">${srLabel}: </span>` : '';
        // 行内高亮：相邻 -/+ 配对时只标变化片段；- 行用旧侧片段，+ 行用新侧片段
        let seg = null;
        if (l[0] === '+' && idx > 0 && lines[idx - 1][0] === '-') seg = inlineSegments(lines[idx - 1][3], l[3]);
        else if (l[0] === '-' && idx + 1 < lines.length && lines[idx + 1][0] === '+') seg = inlineSegments(l[3], lines[idx + 1][3]);
        const codeDel = seg ? inlineHtml(seg.a, 'wd-del') : escapeHtml(l[3]);
        const codeAdd = seg ? inlineHtml(seg.b, 'wd-add') : escapeHtml(l[3]);
        const code = l[0] === '-' ? codeDel : codeAdd;
        if (split) {
          const left = l[0] !== '+' ? `<div class="half"><span class="ln">${l[1]}</span><span class="lc">${codeDel}</span></div>` : `<div class="half"><span class="ln"></span><span class="lc"></span></div>`;
          const right = l[0] !== '-' ? `<div class="half"><span class="ln">${l[2]}</span><span class="lc">${codeAdd}</span></div>` : `<div class="half"><span class="ln"></span><span class="lc"></span></div>`;
          return `<div class="dl ${cls}">${sr}${left}${right}</div>`;
        }
        return `<div class="dl ${cls}"><span class="ln">${l[1]}</span><span class="ln">${l[2]}</span>${sr}<span class="dm" aria-hidden="true">${mark}</span><span class="lc">${code}</span></div>`;
      }).join('');
      $$('.dl.collapse', scroll).forEach(c => c.addEventListener('click', () => toast('已展开 52 行未变化区域')));
    }
    function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    paint();
    $$('#diffSlot [data-m]').forEach(b => b.addEventListener('click', () => {
      split = b.dataset.m === 'split';
      $$('#diffSlot [data-m]').forEach(x => {
        const on = x === b;
        x.classList.toggle('active', on);
        x.setAttribute('aria-checked', String(on));
      });
      paint();
    }));
    $('#diffClose').addEventListener('click', () => {
      slot.innerHTML = '';
      slot.style.height = '';
      if (res) res.hidden = true;
      $$('#spChanges .ch-row').forEach(x => { x.classList.remove('sel'); x.setAttribute('aria-current', 'false'); });
      // Focus was left on a button that no longer exists once the slot is emptied.
      const back = $('#spChanges .ch-row.sel') || $('#spChanges .ch-row');
      if (back) back.focus();
    });
    OMP.ui.labelIconButtons(slot);
  }

  /* ---------- Preview ---------- */
  function renderPreview(mode) {
    mode = mode || 'ok';
    const p = D.preview;
    const statusMap = {
      ok: ['green', '页面正常 · 热更新已连接'],
      hmr: ['blue', '热更新中 · MermaidBlock.tsx'],
      error: ['red', '编译失败 · 1 个错误'],
      select: ['purple', '元素选择模式 · 点击页面元素']
    };
    const [clr, txt] = statusMap[mode];
    $('#spPreview').innerHTML = `
      <div class="pv-toolbar">
        <button class="icon-btn small">${OMP.icon('arrow-l', 'sm')}</button>
        <button class="icon-btn small">${OMP.icon('arrow-r', 'sm')}</button>
        <button class="icon-btn small" id="pvRefresh">${OMP.icon('refresh', 'sm')}</button>
        <div class="pv-url ellipsis">${OMP.icon('lock', 'sm')}<span class="ellipsis">${p.url}${p.path}</span></div>
        <span class="seg"><button class="active" data-vp="desktop">${OMP.icon('monitor', 'sm')}</button><button data-vp="tablet">${OMP.icon('tablet', 'sm')}</button><button data-vp="phone">${OMP.icon('phone', 'sm')}</button></span>
        <button class="icon-btn small" data-tip="截图" id="pvShot">${OMP.icon('camera', 'sm')}</button>
        <button class="icon-btn small ${mode === 'select' ? 'active' : ''}" data-tip="元素选择" id="pvSelect">${OMP.icon('cursor', 'sm')}</button>
        <button class="icon-btn small" data-tip="在系统浏览器打开">${OMP.icon('external', 'sm')}</button>
      </div>
      <div class="pv-statusbar"><span class="dot ${clr}${mode === 'hmr' ? ' pulse' : ''}"></span><span>${txt}</span><span class="spacer"></span><span class="tiny muted mono">vite v5.4.11 · pid 21996</span><button class="btn small outline" id="pvRestart">重启 Dev Server</button></div>
      <div class="pv-view ${mode === 'select' ? 'pv-selecting' : ''}" id="pvView">
        ${mode === 'error' ? `
          <div class="pv-error">
            <div class="pe-head">${OMP.icon('alert', 'sm')}编译失败 · ${p.error.summary}</div>
            <div class="pe-body">
              <div>${OMP.icon('file-code', 'sm')} <span class="chip-file">${p.error.file}:${p.error.line}</span></div>
              <pre>${p.error.stack}</pre>
              <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
                <button class="btn small primary" id="pvAskFix">请求 OMP 修复</button>
                <button class="btn small outline">打开文件</button>
                <button class="btn small outline">复制错误</button>
                <button class="btn small outline">加入 OMP 上下文</button>
                <button class="btn small outline">查看完整日志</button>
              </div>
            </div>
          </div>` : `
          <div class="pv-frame" id="pvFrame">
            <div class="mock-page">
              <div class="mp-nav"><span style="color:var(--accent)">OMP Web</span><span class="muted">Docs</span><span class="muted">Sessions</span><span class="muted">Settings</span></div>
              <div class="mp-hero" data-el="hero">
                <div style="font-size:18px;font-weight:600;margin-bottom:6px">Upstream Sync v0.8.1</div>
                <div class="muted small" style="margin-bottom:12px">Mermaid 全屏缩放拖拽 · IDE 风格 Directory Picker · Loopback 安全增强</div>
                <span class="mp-btn" data-el="btn">提交订单</span>
              </div>
              <div class="card" style="padding:14px;margin-bottom:12px" data-el="card1">
                <b>MermaidBlock</b><div class="muted small">全屏缩放 · 拖拽平移 · 主题选择器</div>
              </div>
              <div class="card" style="padding:14px" data-el="card2">
                <b>DirectoryPicker</b><div class="muted small">IDE 风格目录选择 · 最近路径</div>
              </div>
            </div>
          </div>`}
      </div>
      <div class="pv-console">${p.logs.map(l => `<div>${l}</div>`).join('')}${mode === 'hmr' ? '<div style="color:var(--blue)">[vite] hmr update /components/MermaidBlock.tsx …</div>' : ''}</div>`;

    $('#pvRefresh').addEventListener('click', () => { toast('Preview 已刷新', 'refresh'); });
    $('#pvRestart').addEventListener('click', () => toast('正在重启 Dev Server…', 'refresh'));
    $('#pvShot').addEventListener('click', () => { addCtxChip('Preview 截图'); toast('截图已加入输入区上下文', 'camera'); });
    const ask = $('#pvAskFix'); if (ask) ask.addEventListener('click', () => { addCtxChip('Preview 编译错误'); toast('错误已加入上下文，OMP 将在下一条消息中修复', 'wrench'); });
    $$('#spPreview [data-vp]').forEach(b => b.addEventListener('click', () => {
      $$('#spPreview [data-vp]').forEach(x => x.classList.toggle('active', x === b));
      const f = $('#pvFrame'); if (f) f.className = 'pv-frame' + (b.dataset.vp === 'desktop' ? '' : ' ' + b.dataset.vp);
    }));
    // 元素选择
    const selBtn = $('#pvSelect');
    selBtn.addEventListener('click', () => {
      const view = $('#pvView');
      view.classList.toggle('pv-selecting');
      selBtn.classList.toggle('active');
      $$('#spPreview [data-el]').forEach(el => {
        el.onmouseenter = view.classList.contains('pv-selecting') ? () => el.classList.add('pv-el-hover') : null;
        el.onmouseleave = view.classList.contains('pv-selecting') ? () => el.classList.remove('pv-el-hover') : null;
        el.onclick = view.classList.contains('pv-selecting') ? ev => {
          ev.stopPropagation();
          el.classList.remove('pv-el-hover');
          view.classList.remove('pv-selecting');
          selBtn.classList.remove('active');
          const label = el.dataset.el === 'btn' ? 'Button “提交订单”' : el.dataset.el;
          addCtxChip('@Preview ' + label);
          toast(`已选择元素：@Preview ${label}（含 Selector / DOM 摘要 / 截图）`, 'cursor');
        } : null;
      });
    });
  }

  /* ---------- Agent Hub ----------
     The row was a clickable <div> that *contained* two icon buttons — interactive
     content nested inside interactive content. That is invalid, and it made the
     buttons unreliable (their clicks needed stopPropagation to avoid also firing
     the row). Restructured so the row is a plain container and the agent name is
     the button that opens details: three sibling controls, no nesting, and every
     one reachable by keyboard.

     Status was also chip-colour + an unlabelled icon; both now carry text. */
  function renderAgents() {
    $('#spAgents').innerHTML = `
      ${D.agents.map(a => {
        const st = a.status || 'pending';
        const pill = saPill(a);
        const aria = [a.name, pill.label, a.time || a.dur].filter(Boolean).join('，');
        return `<div class="agent-row" data-agent="${a.id}">
          <span class="ag-tree" aria-hidden="true">${a.parent ? '└' : ''}</span>
          <button class="ag-open sa-card ${esc(st)}" data-ag-open="${a.id}" aria-label="${esc(aria)}">${agentCardInner(a)}</button>
          <div class="ag-acts">
            <button class="icon-btn small" data-tip="在 Agent Hub 中打开 ${a.name}" data-ag-open-hub="${a.id}">${OMP.icon('external', 'sm')}</button>
            <button class="icon-btn small" data-tip="向 ${a.name} 发送 Steering" data-ag-act="steer">${OMP.icon('steering', 'sm')}</button>
            <button class="icon-btn small" data-tip="${a.status === 'running' ? '中止 ' + a.name : '重新运行 ' + a.name}" data-ag-act="stop">${OMP.icon(a.status === 'running' ? 'stop' : 'refresh', 'sm')}</button>
          </div>
        </div>`;
      }).join('')}
      <div class="card ag-fail">
        <div class="ag-fail-head">${OMP.icon('alert', 'sm')}lint 子 Agent 失败</div>
        <div class="tiny muted ag-fail-detail">Bash · eslint . 退出码 2 — 与上游 .eslintrc 合并冲突</div>
        <div class="ag-fail-acts">
          <button class="btn small primary" id="agRerun">重新运行</button>
          <button class="btn small outline">查看输出</button>
          <button class="btn small outline">加入上下文</button>
        </div>
      </div>`;
    $$('#spAgents [data-ag-act]').forEach(b => b.addEventListener('click', () => {
      toast(b.dataset.agAct === 'steer' ? '已向该 Agent 发送 Steering' : '已发送指令', 'bot');
    }));
    const rr = $('#agRerun'); if (rr) rr.addEventListener('click', () => toast('lint 子 Agent 已重新运行', 'refresh'));
    /* 工作台 → Agent Hub 联动：行名与外部链接都写一次性意图，由 hub 页消费选中。
       注意用 a.hubId（agent-*）而非 a.id（a1/a2…），否则永远匹配不到 hub agent。 */
    function goHub(agentId) {
      const wa = agentId && D.agents.find(x => x.id === agentId);
      const hubId = wa && D.hub && D.hub.agents.some(x => x.id === wa.hubId) ? wa.hubId : null;
      try { sessionStorage.setItem('omp.hubIntent', JSON.stringify({ agentId: hubId })); } catch (e) {}
      OMP.router.goto('agent-hub');
    }
    $$('#spAgents [data-ag-open]').forEach(r => r.addEventListener('click', () => goHub(r.dataset.agOpen)));
    $$('#spAgents [data-ag-open-hub]').forEach(b => b.addEventListener('click', () => goHub(b.dataset.agOpenHub)));
    OMP.ui.labelIconButtons($('#spAgents'));
  }

  function openSidePanel(tab) {
    const sp = $('#sidePanel');
    sp.classList.add('open');
    const layoutBtn = $('#btnLayout');
    if (layoutBtn) layoutBtn.setAttribute('aria-expanded', 'true');
    $$('#spTabs button').forEach(b => {
      const on = b.dataset.sp === tab;
      b.classList.toggle('active', on);
      // The .active class drove the visuals but nothing drove the ARIA state, so
      // a screen reader announced all three tabs as unselected.
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.setAttribute('tabindex', on ? '0' : '-1');
    });
    $$('.sp-page').forEach(p => p.classList.remove('active'));
    $('#sp' + tab[0].toUpperCase() + tab.slice(1)).classList.add('active');
  }

  /* Closing the panel used to be a one-way door: #spClose removed .open, and
     because the tabs live *inside* the panel they went away with it — leaving no
     control anywhere that could bring it back. #btnLayout now toggles the panel
     directly (Codex 式展开右栏), so it doubles as the re-entry point. */
  function closeSidePanel() {
    $('#sidePanel').classList.remove('open');
    // Focus would otherwise be left on a button inside a display:none subtree.
    const back = $('#btnLayout');
    if (back) { back.focus(); back.setAttribute('aria-expanded', 'false'); }
  }

  /* 右侧面板宽度拖拽（对齐左侧栏体验）：面板左缘分隔条。
     鼠标拖拽 + ←/→ 方向键微调 + Home/End 跳极值；宽度由 --panel-w 驱动，
     CSS 的 min/max-width 兜底。 */
  const SP_MIN = 360, SP_MAX = 640;
  let spW = null;

  function initSidePanelResize() {
    const res = $('#spResizer');
    if (!res) return;
    const sp = $('#sidePanel');
    function setW(px) {
      spW = Math.min(SP_MAX, Math.max(SP_MIN, Math.round(px)));
      sp.style.setProperty('--panel-w', spW + 'px');
      res.setAttribute('aria-valuenow', String(spW));
    }
    res.setAttribute('aria-valuemin', String(SP_MIN));
    res.setAttribute('aria-valuemax', String(SP_MAX));
    res.addEventListener('mousedown', e => {
      e.preventDefault();
      res.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const startX = e.clientX;
      const startW = sp.getBoundingClientRect().width;
      const move = ev => { ev.preventDefault(); setW(startW + (startX - ev.clientX)); };
      const up = () => {
        res.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    res.addEventListener('keydown', e => {
      const step = e.shiftKey ? 60 : 20;
      const cur = spW ?? sp.getBoundingClientRect().width;
      let handled = true;
      if (e.key === 'ArrowLeft') setW(cur - step);
      else if (e.key === 'ArrowRight') setW(cur + step);
      else if (e.key === 'Home') setW(SP_MAX);
      else if (e.key === 'End') setW(SP_MIN);
      else handled = false;
      if (handled) e.preventDefault();
    });
  }

  /* ================= 底部运行面板 ================= */
  let activeTid = 'tm1';
  function renderTerminalPage() {
    /* Terminal list entries were clickable <div>s — the only way to switch
       terminals, and mouse-only. They select one of a set, so they are a
       listbox: that is what conveys "this one is current" rather than the
       accent tint alone. The OMP/YOU badge also needed a name — two letters of
       provenance meant nothing read aloud. */
    const list = D.terminals.map(t => `
      <div class="term-item${t.id === activeTid ? ' active' : ''}${t.status === 'ended' ? ' ended' : ''}" data-tid="${t.id}"
           role="option" tabindex="${t.id === activeTid ? '0' : '-1'}" aria-selected="${t.id === activeTid}">
        <span class="ti-icon" aria-hidden="true">${OMP.icon(t.src === 'YOU' ? 'terminal' : 'zap', 'sm')}</span>
        <span class="ti-main">
          <span class="ti-name ellipsis">${t.name}</span>
          <span class="ti-sub">${t.status === 'ended' ? '已结束' : 'PID ' + t.pid}</span>
        </span>
        <span class="ti-badge ${t.src === 'OMP' ? 'purple' : 'gray'}">${t.src}<span class="sr-only">${t.src === 'OMP' ? ' 启动的终端' : ' 手动创建的终端'}</span></span>
      </div>`).join('');
    const cur = D.terminals.find(t => t.id === activeTid) || D.terminals[0];
    $('#bpTerminal').innerHTML = `
      <div class="term-layout">
        <div class="term-list" role="listbox" aria-label="终端列表" id="termList">
          ${list}
          <button class="term-new" id="termNew">${OMP.icon('plus', 'sm')}新建终端</button>
        </div>
        <div class="term-view">
          <div class="term-cwd">${OMP.icon('folder', 'sm')} ${cur.cwd} ${cur.status === 'ended' ? '<span class="chip gray xs" style="margin-left:auto">已结束</span>' : `<span class="chip green xs" style="margin-left:auto">PID ${cur.pid}</span>`}</div>
          <!-- Terminal output is an append-only stream. Without a live region a
               screen reader user gets nothing as a command runs; log + polite
               announces new lines without interrupting. -->
          <div class="term term-out" role="log" aria-live="polite" aria-label="终端输出" tabindex="0">${cur.lines.map(l => `<div class="${l[1]}">${l[0] || '&nbsp;'}</div>`).join('')}</div>
        </div>
      </div>`;

    function selectTerminal(id, focus) {
      activeTid = id;
      renderTerminalPage();
      // This function re-renders via innerHTML, so the node that had focus is
      // gone; re-find the equivalent row and restore focus to it.
      if (focus) {
        const el = $(`#bpTerminal [data-tid="${id}"]`);
        if (el) el.focus();
      }
    }

    $$('#bpTerminal .term-item').forEach(el => el.addEventListener('click', () => selectTerminal(el.dataset.tid)));

    // Arrow keys move between terminals, matching the listbox role above.
    const tlist = $('#termList');
    tlist.addEventListener('keydown', e => {
      const items = $$('.term-item', tlist);
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      let next = null;
      if (e.key === 'ArrowDown') next = items[(i + 1) % items.length];
      else if (e.key === 'ArrowUp') next = items[(i - 1 + items.length) % items.length];
      else if (e.key === 'Home') next = items[0];
      else if (e.key === 'End') next = items[items.length - 1];
      if (!next) return;
      e.preventDefault();
      selectTerminal(next.dataset.tid, true);
    });
    $('#termNew').addEventListener('click', () => {
      const n = D.terminals.filter(t => t.src === 'YOU').length + 1;
      const tid = 'tm-new-' + Date.now();
      D.terminals.push({ id: tid, name: 'pwsh', pid: 17300 + n, src: 'YOU', status: 'running',
        cwd: 'C:\\Aspace\\Tools\\omp-web',
        lines: [['PS C:\\Aspace\\Tools\\omp-web> ', 'cmd'], ['', ''], ['', '']] });
      activeTid = tid;
      renderTerminalPage();
      toast('已新建终端 pwsh', 'terminal');
    });
  }

  /* Collapse state lived in three places that could disagree: the .collapsed
     class, the chevron direction (rewritten by innerHTML on every toggle), and
     aria-expanded (never set at all). A tab click forced open without flipping
     the chevron, so the button pointed the wrong way. One writer now owns all
     three. */
  function setBottomCollapsed(collapsed) {
    const bp = $('#bottomPanel');
    bp.classList.toggle('collapsed', collapsed);
    const t = $('#bpToggle');
    t.innerHTML = OMP.icon(collapsed ? 'chevron-u' : 'chevron-d', 'sm');
    t.setAttribute('aria-expanded', String(!collapsed));
    t.setAttribute('data-tip', collapsed ? '展开运行面板 (Ctrl J)' : '收起运行面板 (Ctrl J)');
    t.setAttribute('aria-label', collapsed ? '展开运行面板' : '收起运行面板');
    // A collapsed panel is only 36px tall with its body clipped by overflow, so
    // the terminal and problem rows stayed tabbable while invisible.
    const body = $('.bp-body');
    if (body) body.inert = collapsed;
  }

  function renderBottom() {
    renderTerminalPage();
    // 顶部「新建终端」快捷按钮与列表内按钮行为一致
    const bn = $('#bpNewTerm');
    if (bn) bn.addEventListener('click', () => {
      $$('#bpTabs button')[0].click();
      const b = $('#termNew'); if (b) b.click();
    });
    /* Severity was an icon tinted by an inline `style="color:var(--red)"` and
       nothing else: no text, so the distinction between an error and a warning
       was carried entirely by hue. Each severity now has a visible-to-AT label,
       and the tint moved to a class so it is themeable. Rows are buttons because
       clicking one is meant to jump to the problem. */
    const sevIcon = {
      error: ['alert-c', 'red', '错误'],
      warn: ['alert', 'amber', '警告'],
      info: ['info', 'blue', '信息']
    };
    $('#bpProblems').innerHTML = D.problems.map(p => {
      const [ic, tone, label] = sevIcon[p.sev];
      return `
      <div class="prob-row">
        <button class="prob-open" data-prob="${p.file || ''}">
          <span class="prob-sev sev-${tone}" role="img" aria-label="${label}">${OMP.icon(ic, 'sm')}</span>
          <span class="chip gray xs">${p.src}</span>
          <span class="ellipsis">${p.msg}</span>
          <span class="pfile">${p.file ? p.file + (p.line ? ':' + p.line : '') : ''}</span>
        </button>
        <button class="btn small outline prob-at" data-tip="加入 OMP 上下文">${OMP.icon('at', 'sm')}</button>
      </div>`;
    }).join('');
    $$('#bpProblems .prob-open').forEach(b => b.addEventListener('click', () =>
      toast('已定位到问题：' + (b.dataset.prob || '当前文件'), 'alert-c')));
    $$('#bpProblems .prob-at').forEach(b => b.addEventListener('click', () =>
      toast('已加入 OMP 上下文', 'at')));

    /* Same colour-only problem on test results: a green check and a red cross
       differ by hue and glyph, but neither was announced. */
    $('#bpTests').innerHTML = D.tests.map(t => {
      const pass = t.status === 'pass';
      return `
      <div class="test-row">
        <span class="prob-sev sev-${pass ? 'green' : 'red'}" role="img" aria-label="${pass ? '通过' : '失败'}">${OMP.icon(pass ? 'check' : 'x', 'sm')}</span>
        <b class="mono test-suite">${t.suite}</b>
        <span class="chip ${pass ? 'green' : 'red'} sm">${t.pass}/${t.total} 通过</span>
        <span class="tiny muted mono">${t.time}</span>
        <span class="spacer"></span>
        ${pass ? '' : `<button class="btn small primary">请求 OMP 修复<span class="sr-only">：${t.suite}</span></button>`}
        <button class="btn small outline">重新运行<span class="sr-only">：${t.suite}</span></button>
      </div>
      ${t.failDetail ? `<pre class="test-fail">${t.failDetail}</pre>` : ''}`;
    }).join('');
    $('#bpOutput').innerHTML = `<div class="term">
      <div class="ok">[omp-bridge] connected · rpc/2.1 · 14 capabilities negotiated</div>
      <div>[omp-cli t1] turn 3 started · model=gemini-3.6-flash thinking=high</div>
      <div>[omp-cli t1] tool Write docs/UPSTREAM-SYNC.md ok (1.8s)</div>
      <div class="err">[mcp playwright] transport closed unexpectedly (code 1006) · retrying</div>
      <div>[preview] vite ready in 412ms · http://127.0.0.1:30141</div></div>`;
    $('#bpLogs').innerHTML = `<div class="term">
      <div class="muted">13:58:12.481 [rpc] ← capability.call preview.dom (session t1)</div>
      <div class="muted">13:58:12.512 [rpc] → ok 31ms</div>
      <div class="muted">13:58:14.002 [watcher] change components/MermaidBlock.tsx</div>
      <div class="muted">13:58:14.110 [fs] write docs/UPSTREAM-SYNC.md (214 lines)</div>
      <div class="err">13:58:15.901 [mcp playwright] reconnect attempt 3 failed</div>
      <div class="muted">13:58:16.233 [checkpoint] #12 created · 3 files</div></div>`;
    $('#bpPvlogs').innerHTML = `<div class="term">
      <div class="ok">[vite] connected. (ws://127.0.0.1:30141)</div>
      <div>[vite] hmr update /components/MermaidBlock.tsx</div>
      <div>[vite] hmr update /docs/UPSTREAM-SYNC.md</div>
      <div class="warn">[preview] console.warn · React Hook useCallback has a missing dependency (useCodeTheme.ts:31)</div>
      <div class="err">[preview] console.error · Failed to resolve import "@earendil-works/pi-mermaid" (MermaidBlock.tsx:12)</div>
      <div>[omp] preview attached, session=019fac94 · dom snapshot ok</div>
      <div class="muted">[network] GET /api/session → 200 (18ms)</div>
      <div class="muted">[network] GET /api/threads → 200 (9ms)</div></div>`;

    $$('#bpTabs button').forEach(b => b.addEventListener('click', () => {
      $$('#bpTabs button').forEach(x => {
        const on = x === b;
        x.classList.toggle('active', on);
        x.setAttribute('aria-selected', on ? 'true' : 'false');
        x.setAttribute('tabindex', on ? '0' : '-1');
      });
      $$('.bp-page').forEach(p => p.classList.remove('active'));
      $('#bp' + b.dataset.bp[0].toUpperCase() + b.dataset.bp.slice(1)).classList.add('active');
      setBottomCollapsed(false);
    }));
    $('#bpToggle').addEventListener('click', () => {
      setBottomCollapsed(!$('#bottomPanel').classList.contains('collapsed') );
    });
    document.addEventListener('keydown', e => {
      // Ctrl+J 是工作台底部面板的快捷键，二级页视图不响应（原多页行为一致）。
      if (!OMP.router.isWorkbench()) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); $('#bpToggle').click(); }
    });
    /* 高度拖拽
       Three fixes, same shape as the sidebar resizers:
       - It called classList.remove('collapsed') directly, bypassing the single
         writer — so dragging a collapsed panel open left the chevron pointing up
         and aria-expanded reading false.
       - Drag-only, no keyboard path (WCAG SC 2.5.7 wants a single-pointer/keyboard
         alternative to dragging).
       - No cursor lock or selection guard, so a fast drag looked dropped and
         selected text across the panel. */
    const res = $('#bpResizer');
    const BP_MIN = 120, BP_MAX = 480;
    const bpHeight = () => $('#bottomPanel').getBoundingClientRect().height;

    function setBpHeight(px) {
      const h = Math.min(BP_MAX, Math.max(BP_MIN, px));
      $('#bottomPanel').style.height = h + 'px';
      res.setAttribute('aria-valuenow', String(Math.round(h)));
    }

    res.setAttribute('role', 'separator');
    res.setAttribute('tabindex', '0');
    res.setAttribute('aria-orientation', 'horizontal');
    res.setAttribute('aria-label', '调整运行面板高度');
    res.setAttribute('aria-valuemin', String(BP_MIN));
    res.setAttribute('aria-valuemax', String(BP_MAX));

    res.addEventListener('mousedown', e => {
      e.preventDefault();
      setBottomCollapsed(false);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      // 面板带 height transition（收起/展开动画用）；拖动时每一步都会触发过渡，
      // 高度永远追不上光标（不跟手）。拖动期间临时禁用，结束时恢复。
      const bp = $('#bottomPanel');
      bp.style.transition = 'none';
      const move = ev => { ev.preventDefault(); setBpHeight(window.innerHeight - ev.clientY); };
      const up = () => {
        bp.style.transition = '';
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    res.addEventListener('keydown', e => {
      const step = e.shiftKey ? 60 : 20;
      if (e.key === 'ArrowUp') { e.preventDefault(); setBottomCollapsed(false); setBpHeight(bpHeight() + step); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setBpHeight(bpHeight() - step); }
      else if (e.key === 'Home') { e.preventDefault(); setBottomCollapsed(false); setBpHeight(BP_MAX); }
      else if (e.key === 'End') { e.preventDefault(); setBpHeight(BP_MIN); }
    });
  }

  /* ================= 演示场景 ================= */
  const scenarios = [
    ['4', '工作台空闲状态', s => {
      // 从「新对话空态」恢复：把清空的事件流 / 审批队列 / Todo 放回来再渲染。
      if (!D.events.length) {
        D.events = EVENTS_SEED;
        D.inbox = JSON.parse(JSON.stringify(INBOX_SEED));
        D.todos.items = JSON.parse(JSON.stringify(TODOS_SEED));
        renderConvo(); renderDeck(); renderTodoDock();
      }
      setRunning(false); hideBanner();
    }],
    ['43', '新对话空态（π + 热力图）', () => {
      setRunning(false); hideBanner();
      // 新对话 = 无事件、无待决审批、无 Todo；三者都清空才是诚实的空态。
      D.events = [];
      D.inbox = [];
      D.todos.items = [];
      deckPos = 0;
      renderConvo(); renderDeck(); renderTodoDock();
      toast('新对话空态：热力图悬停查看详情，最近对话可继续', 'sparkles');
    }],
    ['5', 'OMP 流式回答', s => { setRunning(true); simulateStream(); }],
    ['6', '连续工具调用（聚合）', s => { setRunning(true); showRunningBatchDemo(); }],
    ['42', 'OMP 原生工具卡图鉴', s => { setRunning(false); showToolCardGallery(); }],
      ['7', 'Bash 等待审批', () => {
        if (!D.inbox.some(x => x.id === 'ib1')) {
          const seed = INBOX_SEED.find(x => x.id === 'ib1');
          if (seed) D.inbox.unshift(JSON.parse(JSON.stringify(seed)));
        }
        deckPos = Math.max(0, D.inbox.findIndex(x => x.id === 'ib1'));
        renderDeck(); pulseDeck();
      }],
    ['8', '文件正在被修改', s => { toast('DirectoryPicker.tsx 正在写入…（文件树蓝点标记）', 'pencil'); }],
    ['9', '多文件 Changes', s => { openSidePanel('changes'); }],
    ['10', 'Split Diff 审查', s => { openSidePanel('changes'); renderDiff(); $$('#diffSlot [data-m]')[1]?.click(); }],
    ['11', 'Preview 正常运行', s => { openSidePanel('preview'); renderPreview('ok'); }],
    ['12', 'Preview 热更新', s => { openSidePanel('preview'); renderPreview('hmr'); }],
    ['13', 'Preview 编译失败', s => { openSidePanel('preview'); renderPreview('error'); }],
    ['14', 'Preview 元素选择', s => { openSidePanel('preview'); renderPreview('ok'); $('#pvSelect').click(); }],
    ['15', '多 Agent 并行', s => { openSidePanel('agents'); }],
      ['16', 'Agent 等待用户', () => {
        openSidePanel('agents');
        if (!D.inbox.some(x => x.id === 'ib2')) {
          const seed = INBOX_SEED.find(x => x.id === 'ib2');
          if (seed) D.inbox.push(JSON.parse(JSON.stringify(seed)));
        }
        deckPos = Math.max(0, D.inbox.findIndex(x => x.id === 'ib2'));
        renderDeck(); pulseDeck();
      }],
    ['17', 'Agent 失败', s => { openSidePanel('agents'); }],
    ['18', '长会话 Minimap 导航', s => { $('#convoScroll').scrollTo({ top: 0, behavior: 'smooth' }); toast('点击右侧 Minimap 标记可跳转 · Hover 查看摘要', 'filter'); }],
    ['19', 'Steering（运行中调整）', s => { setRunning(true); $('#btnSteer').focus(); toast('Steering：输入会立即调整当前 Run', 'steering'); }],
    ['20', 'Follow-up 队列', s => { setRunning(true); $('#fqChip').innerHTML = OMP.icon('queue', 'sm') + 'Follow-up ×2'; }],
      ['21', 'Compact', () => appendStreamEvent(`<div class="ev" id="ev-cmp-${Date.now()}">
        <div class="compact-bar">
          <span class="cp-line" aria-hidden="true"></span>
          ${OMP.icon('minimize', 'sm')}
          <span class="cmp-label">Compact</span>
          <span class="meter cmp-meter" aria-hidden="true"><i style="width:24%"></i></span>
          <span>手动 Compact 完成 · 释放 38k Context（24%）</span>
          <span class="cp-line" aria-hidden="true"></span>
        </div>
      </div>`)],
    ['22', 'Checkpoint 恢复', s => { openCheckpointModal('both'); }],
    ['24', 'OMP 断开并自动重连', s => { showBanner(); }],
    ['37', '左下 OMP 状态菜单', s => { $('#btnOmpMenu').click(); }],
    ['38', '左上应用菜单', s => { $('#btnAppMenu').click(); }],
    ['39', 'Command Palette', s => { OMP.ui.openPalette(); }],
    ['40', '底部 Terminal / Problems', s => { $('#bottomPanel').classList.remove('collapsed'); $$('#bpTabs button')[1].click(); }],
      ['41', 'Todo 列表 Dock', () => { tdCollapsed = false; renderTodoDock(); flashTodoDock(); }]
  ];

  function collapseFinishedBatches() {
    $$('.ev-batch.open').forEach(batch => {
      if (batch.classList.contains('is-running')) return;
      if (batch.classList.contains('is-pinned-open')) return;
      if (batch.querySelector('.tl-item.is-running')) return;
      batch.classList.remove('open');
      const sum = $('.batch-sum', batch);
      if (sum) sum.setAttribute('aria-expanded', 'false');
    });
  }

  let liveVerbTimer = 0;
  let liveVerbIdx = 0;

  function collectLiveVerbs() {
    const verbs = $$('.tl-item[data-status="running"]').map(el => KIND_VERB[el.dataset.kind] || 'thinking');
    const uniq = [];
    verbs.forEach(v => { if (uniq.indexOf(v) < 0) uniq.push(v); });
    if (uniq.length) return uniq;
    return document.body.dataset.running === '1' ? ['thinking'] : [];
  }

  function paintLiveVerb() {
    const el = $('#turnLiveVerb');
    if (!el) return;
    const verbs = collectLiveVerbs();
    if (!verbs.length) { el.textContent = ''; return; }
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const v = reduce ? verbs[0] : verbs[liveVerbIdx % verbs.length];
    el.textContent = v + '…';
  }

  function startLiveStatus() {
    const bar = $('#turnLive');
    if (!bar) return;
    bar.classList.remove('hidden');
    liveVerbIdx = 0;
    paintLiveVerb();
    clearInterval(liveVerbTimer);
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) {
      liveVerbTimer = setInterval(() => { liveVerbIdx += 1; paintLiveVerb(); }, 1600);
    }
  }

  function stopLiveStatus() {
    clearInterval(liveVerbTimer);
    liveVerbTimer = 0;
    const bar = $('#turnLive');
    if (bar) bar.classList.add('hidden');
  }

  function setRunning(on) {
    document.body.dataset.running = on ? '1' : '';
    // 运行态显示 run-strip、隐藏项目上下文条；空闲反之（Codex 式：初始对话
    // 看项目/分支上下文，真正跑起来才显示工具状态）。
    $('#ctxStrip').classList.toggle('hidden', on);
    $('#runStrip').classList.toggle('hidden', !on);
    $('#composer').classList.toggle('running', on);
    const send = $('#btnSend');
    send.className = 'send-btn' + (on ? ' abort' : '');
    send.innerHTML = OMP.icon(on ? 'stop' : 'send', 'sm');
    send.setAttribute('data-tip', on ? 'Abort 当前 Run' : '发送 (Enter)');
    // This single icon-only button flips between two very different actions —
    // send and abort. data-tip only feeds the CSS tooltip, so without an
    // aria-label that changes with it, a screen reader announced the same name
    // (or none) for both states. Same for the running border, which was the only
    // other signal that the composer was mid-run.
    send.setAttribute('aria-label', on ? 'Abort 当前 Run' : '发送消息');
    $('#ompStatusText').textContent = on ? 'OMP Running' : 'OMP Ready';
    if (on) startLiveStatus();
    else {
      stopLiveStatus();
      collapseFinishedBatches();
    }
  }
  function showBanner() {
    $('#globalBanner').classList.remove('hidden');
    document.body.dataset.ompDown = '1';
    $('#ompStatusText').textContent = 'OMP Reconnecting';
    $('#ompStatusDot').className = 'dot amber pulse';
    $('.sb-user .u-status').className = 'u-status warn';
  }
  function hideBanner() {
    $('#globalBanner').classList.add('hidden');
    document.body.dataset.ompDown = '';
    $('#ompStatusText').textContent = 'OMP Ready';
    $('#ompStatusDot').className = 'dot green pulse';
    $('.sb-user .u-status').className = 'u-status ok';
  }
  function scrollToEv(id) { const n = $('#ev-' + id); if (n) n.scrollIntoView({ behavior: 'smooth', block: 'center' }); }

  function expandGroup() {
    const g = $('#ev-e2');
    if (!g) return;
    g.classList.add('open');
    const sum = $('.batch-sum', g);
    if (sum) sum.setAttribute('aria-expanded', 'true');
    scrollToEv('e2');
  }

  function showRunningBatchDemo() {
    const old = $('#ev-live-batch');
    if (old) old.remove();
    appendStreamEvent(renderBatch({
      id: 'live-batch',
      items: [
        { kind: 'read', name: 'Read', target: 'components/MermaidBlock.tsx', status: 'done', dur: '0.2s', summary: '147 行' },
        { kind: 'grep', name: 'Grep', target: '"as const" in components/', status: 'done', dur: '0.3s', matches: [
          { file: 'components/MermaidBlock.tsx', line: '147', text: 'const codeTheme = getCodeTheme() as const;' }
        ] },
        { kind: 'think', status: 'running', dur: '7s',
          preview: '类型已经修好。接下来确认 Preview 缩放…',
          full: '类型已经修好。\n接下来确认 Preview 缩放和热更新是否跟上。\nMermaid 全屏拖拽在 125% DPI 下还要再看一眼惯性。\n如果惯性缺失，再问用户要不要做成设置项。\n先把 as const 断言覆盖字面量 widen。\n然后看 Preview 热更新是否带上缩放惯性。\n最后决定要不要把惯性做成设置项。' }
      ]
    }));
    const think = $('#ev-live-batch .think-scroll');
    if (think) think.scrollTop = think.scrollHeight;
    paintLiveVerb();
  }

  function showToolCardGallery() {
    const old = $('#ev-tool-gallery');
    if (old) old.remove();
    const items = D.nativeToolGallery || [];
    appendStreamEvent(renderBatch({
      id: 'tool-gallery',
      openAll: true,
      items: items
    }));
    toast('已展开 ' + items.length + ' 张 OMP 原生工具卡', 'layers');
  }

  function simulateStream() {
    const old = $('#ev-streamDemo');
    if (old) old.remove();
    const segs = [
      '<h3>4. 建议创建 Checkpoint</h3>',
      '<p>类型错误已修复，typecheck 与 lint 均通过；Preview 热更新后 Mermaid 缩放拖拽验证正常。</p>',
      '<p>本轮共修改 <strong>4 个文件</strong>（+221 / -5）。建议创建 <span class="chip-code">Checkpoint #13</span> 固化当前状态，再继续下一步。</p>'
    ];
    appendStreamEvent(`<div class="ev ev-assistant" id="ev-streamDemo">
      <div class="a-head"><span class="a-badge">${OMP.icon('bot')}</span><span class="a-name">OMP</span><span class="a-meta">gemini-3.6-flash · 刚刚</span></div>
      <div class="ev-body"></div>
    </div>`);
    const body = $('#ev-streamDemo .ev-body');
    if (!body) return;
    const caret = document.createElement('span');
    caret.className = 'stream-caret';
    body.appendChild(caret);
    let i = 0;
    const timer = setInterval(() => {
      if (i >= segs.length) {
        clearInterval(timer);
        caret.remove();
        collapseFinishedBatches();
        return;
      }
      caret.insertAdjacentHTML('beforebegin', segs[i++]);
      const sc = $('#convoScroll');
      if (sc) sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' });
    }, 420);
  }

  function initScenarios() {
    const fab = $('#scenarioFab');
    fab.addEventListener('click', e => {
      const m = menu('<div class="menu-label">关键界面状态（工作台部分）</div>' +
        scenarios.map(s => `<button class="menu-item" data-sc="${s[0]}"><span class="sc-no">${s[0]}</span><span>${s[1]}</span></button>`).join('') +
        '<div class="menu-sep"></div><div class="menu-label">其余状态见：主页 1 · 环境检查 2/3 · Time Travel 23 · 能力中心 25–27 · 设置 28/29 · 诊断 30 · 侧栏 31–36 直接拖拽体验</div>',
        'scenario-menu');
      m.addEventListener('click', ev => {
        const sc = scenarios.find(x => x[0] === ev.target.closest('[data-sc]')?.dataset.sc);
        if (sc) { sc[2](); OMP.ui.closeOverlay(); }
      });
      openOverlay(m, fab, 'up-left');
    });
    $('#bannerDismiss').addEventListener('click', hideBanner);
    $('#bannerDiagnose').addEventListener('click', () => OMP.router.goto('diagnostics'));
    $('#btnAbort').addEventListener('click', () => { setRunning(false); toast('已 Abort 当前 Run（可安全恢复）', 'stop'); });
    $('#btnSteer').addEventListener('click', () => { $('#composerInput').focus(); toast('Steering：你的输入会立即注入当前 Run', 'steering'); });
  }

  /* ================= 启动 ================= */
  document.addEventListener('DOMContentLoaded', () => {
    renderConvo();
    renderDeck();
    renderTodoDock();
    renderMinimap();
    initTelemetry();
    initComposer();
    initTopMenus();
    renderChanges();
    renderPreview('ok');
    renderAgents();
    renderBottom();
    initScenarios();

    // Arrow-key movement + roving tabindex for both tab sets. They looked like
    // tabs but behaved as six separate tab stops with no ARIA state.
    OMP.ui.initTablist('#spTabs');
    OMP.ui.initTablist('#bpTabs');

    // 默认空闲态：显示项目上下文条（Codex 风格），不预先进入运行场景。
    // 场景菜单里的「流式回答 / 连续工具调用」等会 setRunning(true) 切到运行态。
    setRunning(false);
    $$('#spTabs button').forEach(b => b.addEventListener('click', () => openSidePanel(b.dataset.sp)));
    $('#spClose').addEventListener('click', closeSidePanel);
    initSidePanelResize();

    // Names every icon-only control that the render passes above just created.
    OMP.ui.labelIconButtons();
  });
})();
