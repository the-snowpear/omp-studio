/* ============================================================
   OMP Studio — 二级页面逻辑
   统一页头 · 主页 / 环境检查 / 历史 / 能力中心 / 设置 / 诊断
   ============================================================ */
(function () {
  const D = window.OMP_DATA;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  /* ---------- 统一页头（单 HTML：构建一次，永不重建） ----------
     SPA 下 nav 结构常驻；路由只改 .ph-title 文本与激活入口（router 处理）。 */
  const NAV = [
    ['workbench', 'layout', '工作台'],
    ['home', 'home', '首页'],
    ['history', 'history', '会话历史'],
    ['capabilities', 'package', '能力中心'],
    ['model-config', 'server', '模型配置'],
    ['settings', 'settings', '设置'],
    ['diagnostics', 'pulse', '诊断中心']
  ];
  function buildNav() {
    const el = $('#pageHead');
    if (!el) return;
    el.innerHTML = `
      <a class="icon-btn" href="#!workbench" data-tip="返回工作台">${OMP.icon('arrow-l')}</a>
      <span class="ph-title"></span>
      <nav class="page-nav">
        ${NAV.map(n => `<a href="#!${n[0]}">${OMP.icon(n[1], 'sm')}${n[2]}</a>`).join('')}
      </nav>
      <span class="spacer"></span>
      <button class="icon-btn" data-action="toggle-theme" data-tip="切换 Light / Dark"><svg class="icon" data-theme-icon data-icon="light"></svg></button>`;
    OMP.injectIcons(el);
    el.querySelectorAll('[data-action="toggle-theme"]').forEach(b =>
      b.addEventListener('click', () => OMP.theme.toggle()));
    initNavSlide(el.querySelector('.page-nav'));
  }

  /* ---------- 滑动激活气泡（SPA：页头常驻，气泡在同一文档内滑动） ----------
     气泡 = 淡紫卡片（.nav-window），内含一份逐像素对齐的紫色镜像
     （.nav-mirror）。驱动用直接 left/width（px）—— 不要用 var() 引用的
     transform：Chromium 不对 `translateX(var(--x))` 做 transition，实测
     --x 变了 transform 纹丝不动。镜像 left 与气泡反向（-left），始终钉在
     基础层上；气泡 overflow 裁剪，盖住哪个入口就实时透出紫色。
     点击由 router 的委托处理（href 是 #!…）；这里只负责 place。 */
  function initNavSlide(nav) {
    if (!nav) return;
    const links = $$('a[href^="#!"]', nav);
    if (!links.length) return;

    const win = document.createElement('span');
    win.className = 'nav-window';
    win.setAttribute('aria-hidden', 'true');
    const mirror = document.createElement('span');
    mirror.className = 'nav-mirror';
    mirror.innerHTML = nav.innerHTML;   // 图标已注入，克隆即现成 SVG
    mirror.querySelectorAll('a').forEach(a => {
      a.tabIndex = -1;
      a.setAttribute('aria-hidden', 'true');
    });
    win.appendChild(mirror);
    nav.appendChild(win);

    const place = (a, animate) => {
      if (!a) return;
      const x = a.offsetLeft, w = a.offsetWidth;
      if (animate === false) {
        // 首帧落位：临时关闭 transition，避免进入二级页时气泡从 0 滑过来。
        win.style.transition = 'none';
        mirror.style.transition = 'none';
        win.style.left = x + 'px'; win.style.width = w + 'px';
        mirror.style.left = (-x) + 'px';
        void win.offsetWidth;
        win.style.transition = '';
        mirror.style.transition = '';
      } else {
        win.style.left = x + 'px'; win.style.width = w + 'px';
        mirror.style.left = (-x) + 'px';
      }
    };

    window.OMP = window.OMP || {};
    window.OMP.navSlide = window.OMP.navSlide || { place };
  }

  /* ---------- Token 使用统计（项目主页） ----------
     一年 365 天 × 7 行 GitHub 式日历热图 + 多视图平滑曲线（年/月/周/日）。
     日历排满一年：当前日期之前的格子是真实数据（色阶 = 当日用量），之前
     未使用的格子留淡紫底（提示"有工作但未触发"），未来日期用淡灰底突出
     区别；今天格子加描边。

     曲线：
     - 年视图：365 天，分桶为周聚合点（≈52 点），Catmull-Rom 平滑
     - 月视图：当前 30 天，按日点
     - 周视图：最近 7 天，按日点
     - 日视图：今日逐小时 24 个点（按工作日 / 周末建模）
     x/smoothing 切换不重建 SVG 结构，只重画数据路径与坐标。 */
  function initTokenUsage() {
    const card = $('#tkCard');
    if (!card || !D.tokenUsage || !D.tokenUsage.length) return;
    const days = D.tokenUsage;
    const DAY = 86400000;

    /* ---- 把数据按"日期 key"索引（本地午夜 = 0 点 ms），未到日期用 null 占位 ---- */
    const dayKey = ts => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
    const byDay = new Map(days.map(d => [dayKey(d.date), d]));
    /* 日历 = 完整 1 年：1 月 1 日 0 点 → 当年 12 月 31 日。today 之前的格子是真
       实数据，today 之后的格子是"未来"占位（按用户偏好显示淡灰底）。
       平年 365 / 闰年 366。 */
    const todayTs = dayKey(Date.now());
    const todayD = new Date(todayTs);
    const yearStartTs = dayKey(new Date(todayD.getFullYear(), 0, 1).getTime());
    const yearEndTs = dayKey(new Date(todayD.getFullYear(), 11, 31).getTime());
    const yearDays = [];
    const totalYearDays = Math.round((yearEndTs - yearStartTs) / DAY) + 1;
    for (let i = 0; i < totalYearDays; i++) {
      const ts = yearStartTs + i * DAY;
      yearDays.push({ ts, d: byDay.get(ts) || null });   // d = null 即无数据
    }
    const filledDays = yearDays.filter(x => x.d).map(x => x.d);
    const sum = k => filledDays.reduce((a, d) => a + d[k], 0);
    const fmtK = n => n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
    const dayLbl = d => (d.getMonth() + 1) + '月' + d.getDate() + '日';
    const dt = ts => new Date(ts);
    const last7 = filledDays.slice(-7);
    const avg7 = last7.length ? Math.round(last7.reduce((a, d) => a + d.total, 0) / last7.length) : 0;
    const peak = filledDays.reduce((a, d) => (d.total > a.total ? d : a), filledDays[0] || { total: 0, date: 0 });
    const CAP = 60000;
    const intensity = v => (v <= 0 ? 0 : Math.min(1, Math.pow(v / CAP, 0.5)));

    /* ---- 一年日历网格定位：列数 = 周数（GitHub 习惯），首格 = 1月1日所在周一开始。
       完整 1 年（1月1日 → 12月31日），今天之前真实数据，今天之后"未来"占位。
       末列补到 7 行占位与 grid 行数对齐。 */
    const yearFirstD = dt(yearStartTs);
    const firstDow = yearFirstD.getDay();              // 0=Sun ... 6=Sat
    const padFront = (firstDow + 6) % 7;                // 头补到周一
    const padded = [];
    for (let i = 0; i < padFront; i++) padded.push(null);
    yearDays.forEach(x => padded.push(x));
    const padTail = (7 - (padded.length % 7)) % 7;
    for (let i = 0; i < padTail; i++) padded.push(null);
    const WEEKS = padded.length / 7;
    padded.forEach((c, gi) => {
      if (c) { c.gi = gi; c.w = (gi / 7) | 0; c.dow = gi % 7; }
    });
    /* 月份标签：每个月第一次出现的 gi（不强制对齐周一，保证 1-12 月都有）。 */
    const monthLbls = [];
    let prevM = -1;
    padded.forEach((c, gi) => {
      if (!c) return;
      const m = dt(c.ts).getMonth();
      if (m !== prevM) { monthLbls.push({ gi, m }); prevM = m; }
    });

    /* ---- 视图状态 ---- */
    const views = ['year', 'month', 'week', 'day'];
    const viewLbl = { year: '年', month: '月', week: '周', day: '日' };
    let curView = 'month';

    /* ---- 折线图几何：viewBox 自适应容器宽度 ---- */
    const VB_H = 210, PT = 10, PB = 22;
    let VB_W = 0;
    const yOf = (v, max) => PT + (1 - Math.min(1, v / max)) * (VB_H - PT - PB);
    const xOf = (xi, n) => (xi + 0.5) * (VB_W / n);

    /* ---- 平滑曲线：Monotone Cubic Interpolation
       输入 = pts = [[x,y], ...]；
       每段切线斜率 = (y[i+1]-y[i])/(x[i+1]-x[i])，取邻段连中位数；
       端点斜率 = 单边差分。
       输出相邻控制点切线方向与临近段斜率一致而不是按张力外推，永远不会出
       "山尖"或者"远处反弹"。相比 Catmull-Rom 转换 Bezier：保留凸性，不
       会把局部极小值拉到相邻段远端；并且不需要 tension 参数。 */
    function smoothPath(pts) {
      if (pts.length < 2) return '';
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const n = pts.length;
      const ds = new Array(n - 1);
      for (let i = 0; i < n - 1; i++) ds[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
      const ms = new Array(n);
      ms[0] = ds[0];
      ms[n - 1] = ds[n - 2];
      for (let i = 1; i < n - 1; i++) {
        if (ds[i - 1] * ds[i] <= 0) ms[i] = 0;       // 极值点：水平切线
        else ms[i] = (ds[i - 1] + ds[i]) / 2;
      }
      let d = 'M' + xs[0].toFixed(1) + ' ' + ys[0].toFixed(1);
      for (let i = 0; i < n - 1; i++) {
        const dx = xs[i + 1] - xs[i];
        const c1x = xs[i] + dx / 3;
        const c1y = ys[i] + ms[i] * dx / 3;
        const c2x = xs[i + 1] - dx / 3;
        const c2y = ys[i + 1] - ms[i + 1] * dx / 3;
        d += 'C' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) + ' ' +
                  c2x.toFixed(1) + ' ' + c2y.toFixed(1) + ' ' +
                  xs[i + 1].toFixed(1) + ' ' + ys[i + 1].toFixed(1);
      }
      return d;
    }

    /* ---- 各视图的数据集生成 ---- */
    function seriesYear() {
      /* 按周聚合：取 week 内的 max 当日总量（不平均，避免稀薄时段被压平）。
         未来周（today 之后）跳过，避免折线被 0 拉到底。 */
      const buckets = [];
      for (let w = 0; w < WEEKS; w++) {
        let max = 0, sum0 = 0, n = 0, lastTs = -Infinity;
        for (let d = 0; d < 7; d++) {
          const c = padded[w * 7 + d];
          if (c && c.ts > lastTs) lastTs = c.ts;
          if (c && c.d) { max = Math.max(max, c.d.total); sum0 += c.d.total; n++; }
        }
        if (lastTs > todayTs) break;                            // 未来周停止
        buckets.push({ avg: n ? sum0 / n : 0, max, n });
      }
      return buckets.map((b, i) => ({ x: i, v: b.avg }));
    }
    function seriesMonth() {
      /* 本月 1 日 → 今天。dayKey 归一到本地午夜再比较，起点正是本月 1 号。 */
      const monthStart = dayKey(new Date(todayD.getFullYear(), todayD.getMonth(), 1).getTime());
      const days = filledDays.filter(d => dayKey(d.date) >= monthStart && dayKey(d.date) <= todayTs);
      return days.map((d, i) => ({ x: i, v: d.total, d }));
    }
    function seriesWeek() {
      /* 本周一 (dow=1) → 今天（含今天）。 */
      const dow = todayD.getDay();          // 0=Sun ... 6=Sat
      const daysSinceMon = (dow + 6) % 7;   // 距本周一的天数
      const weekStart = todayTs - daysSinceMon * DAY;
      const days = filledDays.filter(d => dayKey(d.date) >= weekStart && dayKey(d.date) <= todayTs);
      return days.map((d, i) => ({ x: i, v: d.total, d }));
    }
    function seriesDay() {
      /* 24 小时逐小时，伪随机 but 稳定 */
      const today = dt(todayTs);
      const isWeekend = today.getDay() === 0 || today.getDay() === 6;
      const hrs = [];
      for (let h = 0; h < 24; h++) {
        /* 工作时间（9–12 上午、14–18 下午）发信息，其余时段零星 */
        let v;
        if (h >= 9 && h <= 12) v = 1800 + ((h * 31) % 1100);
        else if (h >= 14 && h <= 18) v = 2200 + ((h * 41) % 1400);
        else if (h >= 1 && h <= 5) v = 0;
        else if (h === 13 || h === 19) v = 800;
        else v = 200 + ((h * 17) % 350);
        if (isWeekend) v = Math.round(v * 0.45);
        hrs.push({ x: h, v });
      }
      return hrs;
    }
    function getSeries() {
      const map = { year: seriesYear, month: seriesMonth, week: seriesWeek, day: seriesDay };
      return { pts: map[curView](), max: Math.max(60000, ...filledDays.map(d => d.total)) };
    }

    /* ---- 折线 SVG 渲染 ---- */
    function chartMarkup() {
      const { pts, max } = getSeries();
      const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => Math.round(max * t));
      let svg = '';
      ticks.forEach(t => {
        const y = yOf(t, max).toFixed(1);
        svg += `<line class="tk-grid${t === 0 ? ' base' : ''}" x1="0" y1="${y}" x2="${VB_W}" y2="${y}"/>` +
          `<text class="tk-yt" x="0" y="${(yOf(t, max) - 3.5).toFixed(1)}">${t === 0 ? '0' : fmtK(t)}</text>`;
      });
      /* X 轴标签：按视图类型不同 */
      const labels = xAxisLabels();
      labels.forEach(l => {
        svg += `<text class="tk-xt" x="${l.x.toFixed(1)}" y="${VB_H - 7}">${l.lbl}</text>`;
      });
      /* 曲线：单点（如周一）退化为圆点，避免整条线空白 */
      const sx = pts.map(p => [xOf(p.x, pts.length), yOf(p.v, max)]);
      let path = '', areaPath = '';
      if (sx.length >= 2) {
        path = smoothPath(sx);
        areaPath = path +
          `L${sx[sx.length - 1][0].toFixed(1)} ${(VB_H - PB).toFixed(1)}` +
          `L${sx[0][0].toFixed(1)} ${(VB_H - PB).toFixed(1)}Z`;
      }
      svg += `<path class="tk-area total" d="${areaPath}"/>`;
      svg += `<path class="tk-line total" d="${path}"/>`;
      if (sx.length === 1) {
        svg += `<circle class="tk-pt total" cx="${sx[0][0].toFixed(1)}" cy="${sx[0][1].toFixed(1)}" r="3"/>`;
      }
      svg += `<line class="tk-cursor" y1="${PT}" y2="${VB_H - PB}" style="display:none"/>`;
      svg += `<circle class="tk-hl" r="3.6" style="display:none"/>`;
      svg += `<rect class="tk-hit" x="0" y="0" width="${VB_W}" height="${VB_H}"/>`;
      return svg;
    }
    function xAxisLabels() {
      const { pts } = getSeries();
      if (curView === 'year') {
        return monthLbls.map(m => ({ x: xOf(m.gi / 7, pts.length), lbl: (m.m + 1) + '月' }));
      }
      if (curView === 'month') {
        return pts.filter((p, i) => i === 0 || i === pts.length - 1 || new Date(p.d.date).getDate() % 5 === 0)
          .map(p => ({ x: xOf(p.x, pts.length), lbl: (new Date(p.d.date).getDate()) + '日' }));
      }
      if (curView === 'week') {
        return pts.map(p => ({ x: xOf(p.x, pts.length), lbl: ['一','二','三','四','五','六','日'][new Date(p.d.date).getDay() === 0 ? 6 : new Date(p.d.date).getDay() - 1] }));
      }
      /* day: 每 2 小时，HH:00 格式 */
      return [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22].map(h => ({ x: xOf(h, pts.length), lbl: h + ':00' }));
    }

    /* ---- 卡片 HTML ---- */
    const cellsHtml = padded.map((c, gi) => {
      if (!c) return '<span class="tk-cell tk-empty"></span>';
      const d = c.d;
      const isFuture = c.ts > todayTs;
      const isToday = c.ts === todayTs;
      const cls = ['tk-cell'];
      if (!d) cls.push('tk-no-data');                      // 一年前未启用
      else if (d.total === 0) cls.push('tk-zero');         // 有但 0 token
      if (isFuture) cls.push('tk-future');                 // 未来预期
      if (isToday) cls.push('tk-today');
      const tip = d ? `${dayLbl(dt(c.ts))}，${fmtK(d.total)} tok` : (isFuture ? `${dayLbl(dt(c.ts))} (未来)` : `${dayLbl(dt(c.ts))}，无数据`);
      return `<span class="${cls.join(' ')}" data-ts="${c.ts}" data-date="${d ? d.date : ''}" tabindex="0"
        role="img" aria-label="${tip}"></span>`;
    }).join('');

    card.innerHTML = `
      <div class="tk-head">
        <span class="tk-title">${OMP.icon('pulse', 'sm')}Token 使用</span>
        <span class="spacer"></span>
        <div class="seg tk-views" role="group" aria-label="Token 视图切换">
          ${views.map(v => `<button data-view="${v}" class="${v === curView ? 'active' : ''}"
            aria-pressed="${v === curView}">${viewLbl[v]}</button>`).join('')}
        </div>
      </div>
      <div class="tk-kpis">
        <div class="tk-kpi"><span class="tk-kpi-v mono">${fmtK(sum('total'))}</span><span class="tk-kpi-l"><i class="tk-dot total"></i>年内总用量</span></div>
        <div class="tk-kpi"><span class="tk-kpi-v mono">${fmtK(avg7)}</span><span class="tk-kpi-l">近 7 天日均</span></div>
        <div class="tk-kpi"><span class="tk-kpi-v mono">${fmtK(peak.total)}</span><span class="tk-kpi-l">年内峰值</span></div>
      </div>
      <svg class="tk-chart" viewBox="0 0 0 0" role="img"
        aria-label="常用模型 ${viewLbl[curView]} 视图 token 用量折线图"></svg>
      <div class="tk-cal-wrap">
        <div class="tk-cal" data-on="total" style="--weeks:${WEEKS}">${cellsHtml}</div>
        <div class="tk-cal-months" style="--weeks:${WEEKS}">${monthLbls.map(m => `<span style="grid-column:${Math.floor(m.gi / 7) + 1}">${m.m + 1}月</span>`).join('')}</div>
        <div class="tk-cal-foot">
          <span class="tiny muted">颜色按每日总用量分级</span>
          <span class="spacer"></span>
          <span class="tk-scale" aria-hidden="true">少
            <i data-s="0"></i><i data-s="1"></i><i data-s="2"></i><i data-s="3"></i><i data-s="4"></i><i class="tk-scale-max">多</i></span>
        </div>
      </div>
      <div class="tk-tip" id="tkTip" role="status" aria-hidden="true"></div>`;

    /* ---- 日历色阶：总量 5 级紫主题 ---- */
    const TK_STEPS = {
      total: [
        'var(--accent-softer)',
        'color-mix(in srgb, var(--accent) 24%, var(--accent-softer))',
        'color-mix(in srgb, var(--accent) 45%, var(--surface-2))',
        'color-mix(in srgb, var(--accent) 68%, var(--surface-2))',
        'var(--accent)'
      ]
    };
    const calEl = card.querySelector('.tk-cal');
    const tip = card.querySelector('#tkTip');
    const svgEl = card.querySelector('.tk-chart');
    let hlTs = -1;

    let tooltipRange = '';     // tooltip 顶部小标签（视图表头）

    /* 热力格专用小浮层：该天在曲线上显示不出来（年视图周聚合 / 范围外）时
       弹在对应格上方，显示当天用量。曲线能显示的走 #tkTip，不用它。 */
    const cellTip = document.createElement('div');
    cellTip.className = 'tk-cell-tip';
    cellTip.setAttribute('role', 'status');
    cellTip.setAttribute('aria-hidden', 'true');
    card.appendChild(cellTip);

    function paintCal() {
      calEl.querySelectorAll('.tk-cell[data-ts]').forEach(cell => {
        const ts = +cell.dataset.ts;
        if (ts > todayTs) return;                            // 未来日固定 .tk-future
        const d = byDay.get(ts);
        if (!d) { cell.style.background = ''; return; }
        const v = d.total || 0;
        cell.style.background = !v ? 'var(--accent-softer)'
          : TK_STEPS.total[Math.min(4, Math.ceil(intensity(v) * 5) - 1)];
      });
      card.querySelectorAll('.tk-scale i[data-s]').forEach(el => {
        el.style.background = TK_STEPS.total[parseInt(el.dataset.s, 10)];
      });
    }

    function hiCell(ts, on) {
      const cell = calEl.querySelector(`.tk-cell[data-ts="${ts}"]`);
      if (cell) cell.classList.toggle('tk-hi', on);
    }
    function showCellTip(ts) {
      const d = byDay.get(ts);
      if (!d) return;
      const cell = calEl.querySelector(`.tk-cell[data-ts="${ts}"]`);
      if (!cell) return;
      cellTip.innerHTML = `<b>${dayLbl(new Date(ts))}</b><span class="mono">${fmtK(d.total)} tok</span>`;
      cellTip.style.display = 'block';
      const cr = cell.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const tw = cellTip.offsetWidth || 110;
      const th = cellTip.offsetHeight || 30;
      let left = cr.left - cardRect.left + cr.width / 2 - tw / 2;
      left = Math.max(2, Math.min(card.clientWidth - tw - 2, left));
      cellTip.style.left = left + 'px';
      /* 格子上方优先，贴近卡片顶部时翻到下方 */
      const relTop = cr.top - cardRect.top;
      cellTip.style.top = (relTop - th - 6 >= 0 ? relTop - th - 6 : relTop + cr.height + 6) + 'px';
      cellTip.classList.add('show');
      cellTip.setAttribute('aria-hidden', 'false');
    }
    function hideCellTip() {
      cellTip.classList.remove('show');
      cellTip.setAttribute('aria-hidden', 'true');
      cellTip.style.display = 'none';
    }
    function setCursor(gi, sx) {
      if (gi === hlTs) return;
      if (hlTs >= 0) hiCell(hlTs, false);
      hlTs = gi;
      const cursor = svgEl.querySelector('.tk-cursor');
      const hl = svgEl.querySelector('.tk-hl');
      if (!cursor || !hl) return;
      if (gi < 0 || !sx) {
        cursor.style.display = 'none';
        hl.style.display = 'none';
        tip.classList.remove('show');
        return;
      }
      cursor.setAttribute('x1', sx); cursor.setAttribute('x2', sx);
      cursor.style.display = '';
      hl.setAttribute('cx', sx);
      hl.style.display = '';
      /* gi 可能是 ts（来自日历 hover）也可能是 point index（来自折线 hover）；
         非数字类型时跳过日历高亮。 */
      if (typeof gi === 'number' && gi > 1e11) hiCell(gi, true);
      const { pts } = getSeries();
      const idx = typeof gi === 'number'
        ? (gi > 1e11 ? pts.findIndex(p => p.d && dayKey(p.d.date) === gi) : gi)
        : -1;
      const p = idx >= 0 ? pts[idx] : null;
      if (!p) {
        tip.classList.remove('show');
        return;
      }
      const label = chartPointLabel(p);
      tip.innerHTML =
        `<b>${label}</b>` +
        `<span class="tk-tip-row"><i class="tk-dot total"></i>${tooltipRange}<b class="mono">${fmtK(p.v)} tok</b></span>`;
      tip.classList.add('show');
      tip.setAttribute('aria-hidden', 'false');
      const cw = card.clientWidth;
      /* 浮层以卡片为定位参考，SVG 起点 = 卡片左 padding + 0；
         cw = 卡片内宽（不含 padding），但浮层 left 用卡片外宽。
         这里 cw 取 clientWidth（含 padding），与 js 中 px 同步用即可。 */
      const px = (parseFloat(sx) / VB_W) * (cw - 28) + 14;   // 14 = 左 padding
      const tw = tip.offsetWidth || 150;
      tip.style.left = Math.max(8, Math.min(cw - tw - 8, px - tw / 2)) + 'px';
      tip.style.top = '180px';  // 折线图下方一行
    }
    function chartPointLabel(p) {
      if (curView === 'day') return p.x + ':00';
      if (curView === 'year') return '第 ' + (p.x + 1) + ' 周';
      const dt2 = p.d ? new Date(p.d.date) : null;
      if (curView === 'week') {
        const dow = dt2 ? dt2.getDay() : 0;
        const day = ['周一','周二','周三','周四','周五','周六','周日'][dow === 0 ? 6 : dow - 1];
        return day + (dt2 ? ' ' + dayLbl(dt2) : '');
      }
      return dt2 ? dayLbl(dt2) : '';
    }

    /* ---- 鼠标在折线滑动：找最近点 ---- */
    function hitIndex(e) {
      const r = svgEl.getBoundingClientRect();
      const vx = (e.clientX - r.left) * (VB_W / r.width);
      const { pts } = getSeries();
      let best = -1, bd = Infinity;
      pts.forEach((p, i) => {
        const dd = Math.abs(xOf(p.x, pts.length) - vx);
        if (dd < bd) { bd = dd; best = i; }
      });
      return { i: best, x: xOf(pts[best].x, pts.length).toFixed(1), ts: pts[best].d ? dayKey(pts[best].d.date) : null };
    }
    svgEl.addEventListener('mousemove', e => {
      hideCellTip();
      const { i, x, ts } = hitIndex(e);
      const { pts, max } = getSeries();
      const cy = yOf(pts[i].v, max);
      svgEl.querySelector('.tk-hl').setAttribute('cy', cy.toFixed(1));
      setCursor(ts != null ? ts : i, x);
    });
    svgEl.addEventListener('mouseleave', () => { setCursor(-1); hideCellTip(); });
    svgEl.addEventListener('click', () => {
      if (hlTs >= 0) OMP.router.goto('history');
    });

    calEl.querySelectorAll('.tk-cell[data-ts]').forEach(cell => {
      const ts = +cell.dataset.ts;
      cell.addEventListener('mouseenter', () => {
        /* 该天是否正好是当前视图曲线上的一个点 */
        let i = -1;
        if (curView !== 'year') {
          const d = byDay.get(ts);
          if (d) {
            const { pts } = getSeries();
            i = pts.findIndex(p => p.d && p.d.date === d.date);
          }
        }
        if (i >= 0) {
          /* 是曲线上的点 → 显示在曲线图上 */
          hideCellTip();
          const { pts, max } = getSeries();
          const x = xOf(pts[i].x, pts.length).toFixed(1);
          const cy = yOf(pts[i].v, max).toFixed(1);
          svgEl.querySelector('.tk-hl').setAttribute('cy', cy);
          setCursor(ts, x);
        } else {
          /* 年视图周聚合无当天点 / 月周视图范围外的日期 →
             清掉图上 cursor，改在热力格上方弹当天用量 */
          setCursor(-1);
          showCellTip(ts);
        }
      });
      cell.addEventListener('focus', () => {
        const evt = new MouseEvent('mouseenter');
        cell.dispatchEvent(evt);
      });
    });
    calEl.addEventListener('mouseleave', () => { setCursor(-1); hideCellTip(); });
    calEl.addEventListener('focusout', e => {
      if (!calEl.contains(e.relatedTarget)) { setCursor(-1); hideCellTip(); }
    });

    /* ---- 视图切换 ---- */
    function setView(v) {
      if (!views.includes(v) || v === curView) return;
      curView = v;
      tooltipRange = ({ year: '周用量', month: '日用量', week: '日用量', day: '小时用量' })[v];
      card.querySelectorAll('.tk-views button').forEach(b => {
        const on = b.dataset.view === v;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      svgEl.setAttribute('aria-label', `常用模型 ${viewLbl[v]} 视图 token 用量折线图`);
      relayout(true);
    }
    card.querySelectorAll('.tk-views button').forEach(b => {
      b.addEventListener('click', () => setView(b.dataset.view));
    });
    tooltipRange = ({ year: '周用量', month: '日用量', week: '日用量', day: '小时用量' })[curView];

    /* ---- 折线 viewBox 跟随容器宽度；view 切换时也重建 ---- */
    function relayout(rebuild) {
      const w = card.clientWidth - 28;
      if (!w) return;
      const changed = Math.abs(w - VB_W) >= 1;
      if (!changed && !rebuild) return;
      VB_W = w;
      svgEl.setAttribute('viewBox', `0 0 ${VB_W} ${VB_H}`);
      svgEl.innerHTML = chartMarkup();
      hlTs = -1;
    }
    relayout();
    if (window.ResizeObserver) new ResizeObserver(() => relayout()).observe(card);

    paintCal();
  }

  /* ---------- 项目主页 ---------- */
  function initHome() {
    const grid = $('#projGrid');
    if (!grid) return;
    const flagChip = {
      running: '<span class="chip blue">任务运行中</span>',
      approval: '<span class="chip amber">需要处理</span>',
      preview: '<span class="chip green">Preview 运行中</span>',
      building: '<span class="chip blue">Preview 构建中</span>'
    };
    /* Project cards and activity rows were clickable <div>s whose whole job is
       to navigate to index.html. As divs they were mouse-only, announced as
       plain text, and could not be opened in a new tab or middle-clicked. They
       are links now — real navigation, so <a href> rather than a scripted
       button.

       The status chips also needed unit context: a bare "3" chip on a card does
       not say 3 of what once you cannot see the layout around it. */
    grid.innerHTML = D.projects.map(p => {
      const flags = [];
      if (p.running) flags.push(flagChip.running);
      if (p.attention) flags.push(flagChip.approval);
      if (p.preview === 'running') flags.push(flagChip.preview);
      if (p.preview === 'building') flags.push(flagChip.building);
      if (p.dirty) flags.push(`<span class="chip amber">${p.dirty} 个未提交修改</span>`);
      const last = p.threads[0];
      return `<a class="proj-card" href="#!workbench" data-p="${p.id}">
        <span class="pc-name">${OMP.icon('folder-open')}<span class="ellipsis">${p.name}</span>${p.pinned ? `<span role="img" aria-label="已置顶">${OMP.icon('pin', 'sm')}</span>` : ''}</span>
        <span class="pc-path ellipsis">${p.path}</span>
        <span class="pc-flags"><span class="chip gray">${OMP.icon('branch', 'sm')} ${p.branch}</span>${flags.join('')}</span>
        <span class="pc-foot"><span class="ellipsis">最近对话：${last.title}</span><span class="spacer"></span><span>${last.time}</span></span>
      </a>`;
    }).join('');

    const act = $('#activityList');
    act.innerHTML = D.activity.map(a => `
      <a class="activity-row" href="#!workbench">
        <span class="a-ic ${a.color}" aria-hidden="true">${OMP.icon(a.icon, 'sm')}</span>
        <span class="ellipsis">${a.text}</span>
        <span class="spacer"></span><span class="tiny muted">${a.time}</span>
      </a>`).join('');
    initTokenUsage();
  }

  /* ---------- 环境检查 ---------- */
  function initEnv() {
    if (!$('#envList')) return;
    let ok = true;
    const checks = [
      ['OMP CLI', 'C:\\Users\\snowpear\\AppData\\Local\\Programs\\omp\\omp.exe', true],
      ['OMP 版本', 'v0.82.1（要求 ≥ v0.80.0）', true],
      ['RPC 协议', 'omp-rpc/2.1 · 握手成功', true],
      ['Capability', '14 项已协商（agent.run / fs.write / preview.dom …）', true],
      ['模型认证', 'Google · 已登录（snowpear）', true],
      ['Provider 状态', 'gemini · 延迟 182ms', true],
      ['Git', 'git version 2.47.0.windows.1', true],
      ['Node', 'v22.22.2（Preview 依赖）', true],
      ['Bun', '未安装（可选，部分脚本不可用）', 'warn'],
      ['OMP 配置目录', 'C:\\Users\\snowpear\\.omp · 可写', true],
      ['文件权限', '工作区读写正常', true],
      ['Preview 运行依赖', 'vite · playwright chromium 已就绪', true]
    ];
    const checksFail = checks.map(c =>
      c[0] === '模型认证' ? ['模型认证', '未登录 · gemini provider 无可用凭据', false] :
      c[0] === 'RPC 协议' ? ['RPC 协议', '握手失败：EPIPE · Bridge 进程未响应', false] :
      c[0] === 'Provider 状态' ? ['Provider 状态', '不可达（未认证）', false] : c);

    function paint() {
      const list = ok ? checks : checksFail;
      const fails = list.filter(c => c[2] === false).length;
      const warns = list.filter(c => c[2] === 'warn').length;
      $('#envSummary').className = 'env-summary ' + (fails ? 'fail' : 'ok');
      $('#envSummary').innerHTML = fails ? `
        <span class="es-icon">${OMP.icon('x')}</span>
        <div style="flex:1"><b style="font-size:14px">OMP 环境存在 ${fails} 个问题</b>
          <div class="small" style="color:var(--text-2)">模型未认证且 RPC 握手失败，OMP 暂时无法启动。修复后将自动重新检测。</div></div>
        <button class="btn primary" id="envRetry">重新检测</button>` : `
        <span class="es-icon">${OMP.icon('check')}</span>
        <div style="flex:1"><b style="font-size:14px">OMP 环境正常</b>
          <div class="small" style="color:var(--text-2)">v0.82.1 · rpc/2.1 · 14 项 Capability 可用${warns ? ' · 1 项可选依赖缺失（Bun）' : ''}</div></div>
        <button class="btn primary" id="envEnter">进入 OMP Studio</button>`;
      $('#envList').innerHTML = list.map(c => `
        <div class="check-row">
          <span style="color:var(--${c[2] === true ? 'green' : c[2] === 'warn' ? 'amber' : 'red'})">
            ${OMP.icon(c[2] === true ? 'check' : c[2] === 'warn' ? 'alert' : 'x')}</span>
          <span class="ck-name">${c[0]}</span>
          <span class="ck-detail ellipsis">${c[1]}</span>
          <span class="ck-actions">
            ${c[2] === false ? (c[0] === '模型认证' ? '<button class="btn small primary">打开 OMP 登录</button>' : '<button class="btn small outline">查看诊断</button>') : ''}
            ${c[2] === 'warn' ? '<button class="btn small outline">打开安装说明</button>' : ''}
          </span>
        </div>`).join('');
      const enter = $('#envEnter'); if (enter) enter.addEventListener('click', () => OMP.router.goto('workbench'));
      const retry = $('#envRetry'); if (retry) retry.addEventListener('click', () => { ok = true; paint(); });
      $$('#envList .btn').forEach(b => { if (!b.id) b.addEventListener('click', () => { if (b.textContent.includes('诊断')) OMP.router.goto('diagnostics'); }); });
      $('#envToggle').textContent = ok ? '预览：检查失败状态' : '预览：检查成功状态';
    }
    $('#envToggle').addEventListener('click', () => { ok = !ok; paint(); });
    paint();
  }

  /* ---------- 会话历史 + Time Travel ---------- */
  function initHistory() {
    const list = $('#histList');
    if (!list) return;
    const live = $('#histCount');
    const stChip = {
      running: '<span class="chip blue">运行中</span>', completed: '<span class="chip green">已完成</span>',
      failed: '<span class="chip red">失败</span>', archived: '<span class="chip gray">已归档</span>'
    };
    /* The row was a clickable <div> that contained three icon buttons —
       interactive content nested inside interactive content, and the row itself
       was mouse-only. The title is now the <a> that opens the session, with the
       three actions as siblings beside it. The row-level buttons also needed
       per-row names: three rows of identical "恢复 / Fork / 更多" buttons are
       indistinguishable when read out of visual context. */
    function paint(rows) {
      if (!rows.length) {
        list.innerHTML = `<div class="empty">${OMP.icon('search')}没有匹配的对话</div>`;
        if (live) live.textContent = '没有匹配的对话';
        return;
      }
      list.innerHTML = rows.map(h => `
        <div class="hist-row">
          <span class="a-ic purple" aria-hidden="true">${OMP.icon('message', 'sm')}</span>
          <a class="h-main" href="#!workbench">
            <span class="h-title ellipsis">${h.pinned ? `<span class="t-pin" role="img" aria-label="已置顶">${OMP.icon('pin', 'sm')}</span>` : ''}${h.title}</span>
            <span class="h-sub">
              <span>${h.project} · ${h.branch}</span><span>${h.time}</span><span>${h.model}</span>
              <span>${h.files} 文件</span><span>${h.cost}</span><span>Checkpoint ×${h.checkpoints}</span>
              ${h.forkedFrom ? `<span class="h-fork">forked from「${h.forkedFrom}」</span>` : ''}
            </span>
          </a>
          ${stChip[h.status]}
          <div class="h-acts">
            <button class="icon-btn small" data-tip="恢复：${h.title}">${OMP.icon('refresh', 'sm')}</button>
            <button class="icon-btn small" data-tip="Fork：${h.title}">${OMP.icon('fork', 'sm')}</button>
            <button class="icon-btn small" data-tip="更多操作：${h.title}">${OMP.icon('more', 'sm')}</button>
          </div>
        </div>`).join('');
      if (OMP.ui && OMP.ui.labelIconButtons) OMP.ui.labelIconButtons(list);
    }
    paint(D.history);
    $('#histSearch').addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      const rows = D.history.filter(h => h.title.toLowerCase().includes(q) || h.project.toLowerCase().includes(q));
      paint(rows);
      // Filtering silently replaced the list before: a screen reader user typing
      // a query got no signal that the results had changed, or emptied.
      if (live && rows.length) live.textContent = `${rows.length} 个对话`;
    });

    // Time Travel 时间线
    const tt = [
      ['user', '用户请求', '整理上游同步过程为文档，并验证类型检查', '14:02'],
      ['tool', '工具执行', 'Read ×3 · Glob ×1 · Grep ×1 · Task ×2', '14:03'],
      ['file', '文件变化', '+2 文件（docs/UPSTREAM-SYNC.md +214 · README.md +3/-1）', '14:04'],
      ['test', '测试 / 检查', 'npm run typecheck → 1 个错误（TS2322）', '14:05'],
      ['checkpoint', 'Checkpoint #12', '3 文件 · +218/-4 · 构建通过 · Preview 已刷新', '14:06', true],
      ['user', '后续请求', '修复类型错误并验证 Mermaid 缩放', '14:07'],
      ['tool', '工具执行', 'Edit MermaidBlock.tsx · typecheck 通过 · Preview 刷新', '14:08'],
      ['checkpoint', 'Checkpoint #13', '4 文件 · +221/-5 · 0 错误', '14:09', true]
    ];
    $('#ttRail').innerHTML = tt.map(n => `
      <div class="tt-node ${n[0]}">
        <div class="tt-card">
          <div style="display:flex;align-items:center;gap:8px">
            <b>${n[1]}</b><span class="tiny muted mono">${n[3]}</span>
            ${n[4] ? '<span class="chip purple xs">可恢复</span>' : ''}
            ${n[4] ? `<span class="spacer"></span>
              <button class="btn small outline" data-tt="code">仅恢复代码</button>
              <button class="btn small outline" data-tt="convo">仅恢复对话</button>
              <button class="btn small primary" data-tt="both">恢复代码与对话</button>` : ''}
          </div>
          <div class="small muted" style="margin-top:2px">${n[2]}</div>
        </div>
      </div>`).join('');
    $$('#ttRail [data-tt]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const kind = { code: '仅恢复代码：工作区回滚，对话保留', convo: '仅恢复对话：对话回滚，工作区保留', both: '恢复代码与对话：两者同时回滚到该节点' }[b.dataset.tt];
      if (window.OMP.ui) OMP.ui.toast(kind, 'rewind');
    }));
  }

  /* Every switch in this app was a <span class="switch"> with a delegated click
     handler: not focusable, not operable by keyboard, and announced as nothing.
     That included the Permissions toggles — Bash execution, out-of-workspace
     access, network access — so the highest-consequence controls in the product
     were the ones a keyboard user could not reach. Rendered as a real button
     with role="switch" and an aria-checked that tracks state.

     Each also needs its own name: the visible label lives in a sibling element,
     which sighted users read by proximity but assistive tech does not. */
  function switchBtn(on, label) {
    return `<button type="button" class="switch${on ? ' on' : ''}" role="switch"
      aria-checked="${on ? 'true' : 'false'}" aria-label="${label}"></button>`;
  }

  /* ---------- 能力中心 ---------- */
  function initCapabilities() {
    const side = $('#capSide');
    if (!side) return;
    const tabs = [['skills', 'book', 'Skills', 5], ['plugins', 'package', 'Plugins', 3], ['mcp', 'plug', 'MCP', 4], ['host', 'monitor', 'Host Tools', 6], ['slash', 'slash', 'Slash Commands', 8]];
    /* This sidebar swaps what is rendered into #capMain, so it is a vertical
       tablist — as bare buttons every one was a tab stop, arrow keys did nothing,
       and .active was the only signal of which category you were viewing. The
       count badges also needed a unit: a bare "5" beside "Skills" does not say
       5 of what once the layout is not visible. */
    side.setAttribute('role', 'tablist');
    side.setAttribute('aria-label', '能力分类');
    side.setAttribute('aria-orientation', 'vertical');
    side.innerHTML = tabs.map((t, i) =>
      `<button data-cap="${t[0]}" class="${i === 0 ? 'active' : ''}" role="tab"
               aria-selected="${i === 0}" aria-controls="capMain" tabindex="${i === 0 ? '0' : '-1'}">
        ${OMP.icon(t[1], 'sm')}${t[2]}<span class="cnt">${t[3]}<span class="sr-only"> 项</span></span>
      </button>`).join('');

    /* Three-segment stepper. Reads left-to-right as a pipeline:
       配置 → 加载 → 可用. Each segment is on or off; the connector
       between segments is on only when both sides are on, so a failed
       state at "loaded" reads as "configured but not loaded", distinct
       from "loaded but not available". */
    const stepper = (a, b, c) => {
      const seg = (val, label) =>
        `<span class="cap-step ${val ? 'on' : 'off'}">
           ${val ? OMP.icon('check', 'xs') : OMP.icon('x', 'xs')}
           <span>${label}</span>
         </span>`;
      return `<span class="cap-stepper" role="group" aria-label="能力状态：已配置 / 已加载 / 当前会话可用">
        ${seg(a, '已配置')}${seg(b, '已加载')}${seg(c, '当前会话可用')}
      </span>`;
    };

    /* Tab-level summary. Reads as one line of telemetry so the user
       sees the health of the category before scrolling into cards.
       `ok` = available, `fail` = error or not loaded, `off` = remaining.
       Items with no session/loaded signal (plugins) pass both keys as null
       so the only counter that lights up is fail. */
    function capSum(items, sessionKey, failKey) {
      const total = items.length;
      let ok = 0, fail = 0, off = 0;
      for (const it of items) {
        const isOk = sessionKey ? !!it[sessionKey] : false;
        const isFail = failKey ? (!!it[failKey] || it.loaded === false) : false;
        if (isOk) ok++;
        else if (isFail) fail++;
        else off++;
      }
      const stat = (cls, n, label) => n
        ? `<span class="cap-sum-stat"><span class="dot ${cls}"></span><strong>${n}</strong><span class="muted">${label}</span></span>`
        : '';
      return `<div class="cap-summary">
        <span class="cap-sum-stat">
          ${OMP.icon('layers', 'xs')}
          <strong>${total}</strong><span class="muted">项</span>
        </span>
        ${stat('green', ok, '可用')}
        ${stat('red', fail, '失败')}
        ${stat('gray', off, '未配置')}
      </div>`;
    }

    /* Provide cell: icon + label + count + chips, or "—" if empty.
       Used in plugin / MCP cards to surface what each capability exposes
       without flattening all four types into one undifferentiated list. */
    function provide(iconName, label, n, items) {
      const head = `<div class="cap-provide-head">
          ${OMP.icon(iconName, 'xs')}<span>${label}</span>
          <span class="cap-provide-count">${n}</span>
        </div>`;
      const body = (items && items.length)
        ? `<div class="cap-provide-items">${items.map(i => `<span class="cap-provide-item">${i}</span>`).join('')}</div>`
        : `<div class="cap-provide-empty">无</div>`;
      return `<div class="cap-provide">${head}${body}</div>`;
    }

    const render = {
      skills: () => {
        const sum = capSum(D.skills, 'session', 'error');
        const list = D.skills.map(s => {
          const aIc = s.error ? 'amber' : s.session ? 'purple' : 'gray';
          // Scope mirrors ver2: two user-facing buckets (global / per-project)
          // plus "内置" for non-installable builtins. The render does the
          // mapping so mock data can keep raw strings like "workspace".
          const scopeCls =
            s.scope === 'global' ? 'global' :
            s.scope === 'builtin' ? 'builtin' :
            'project';
          const scopeLabel =
            s.scope === 'global' ? '全局' :
            s.scope === 'builtin' ? '内置' :
            '项目';
          // Plugin source: long path collapses to ellipsis on a single
          // mono line; the original used a single-letter chip which lost
          // the install provenance (where the skill came from).
          const source = s.path || s.src || '';
          return `<div class="cap-item cap-skills${s.error ? ' has-error' : ''}">
            <div class="cap-item-summary">
              <span class="a-ic ${aIc}">${OMP.icon('book', 'lg')}</span>
              <div class="cap-item-main">
                <div class="cap-item-name-row">
                  <span class="cap-item-name">${s.name}</span>
                  <span class="cap-scope ${scopeCls}">${scopeLabel}</span>
                </div>
                ${stepper(true, s.loaded, s.session)}
              </div>
              <div class="cap-item-actions">
                ${switchBtn(s.enabled, '启用 Skill ' + s.name)}
                <button class="btn small outline" data-tip="查看 ${s.name} 详情">查看</button>
                <button class="icon-btn small" data-tip="打开 ${s.name} 所在目录">${OMP.icon('folder-open', 'sm')}</button>
                <button class="icon-btn small danger" data-tip="删除 Skill ${s.name}">${OMP.icon('trash', 'sm')}</button>
              </div>
            </div>
            <div class="cap-item-body">
              <p class="cap-item-desc">${s.desc}</p>
              ${source ? `<span class="cap-source" title="${source}">${source}</span>` : ''}
            </div>
            ${s.error ? `<div class="cap-error">${OMP.icon('alert-c', 'xs')}<span>${s.error}</span></div>` : ''}
          </div>`;
        }).join('');
        return sum + list;
      },
      plugins: () => {
        const sum = capSum(D.plugins, null, 'err');
        const list = D.plugins.map(p => {
          const ok = !p.err;
          const aIc = p.err ? 'amber' : 'blue';
          return `<div class="cap-item${p.err ? ' has-error' : ''}">
            <div class="cap-item-summary">
              <span class="a-ic ${aIc}">${OMP.icon('package', 'sm')}</span>
              <div class="cap-item-main">
                <div class="cap-item-name-row">
                  <span class="cap-item-name">${p.name}</span>
                  <span class="chip ${ok ? 'green' : 'red'} xs">${ok ? '已加载' : '加载失败'}</span>
                  <span class="chip outline xs">${p.src}</span>
                </div>
              </div>
              <div class="cap-item-actions">
                ${p.err ? '<button class="btn small outline">查看错误</button>' : '<button class="btn small outline">详情</button>'}
                <button class="icon-btn small" data-tip="更多操作：${p.name}">${OMP.icon('more', 'sm')}</button>
              </div>
            </div>
            <div class="cap-item-provides">
              ${provide('terminal', '工具', p.tools, p.toolItems || [])}
              ${provide('slash', '指令', p.commands, p.commandItems || [])}
              ${provide('zap', 'Hook', p.hooks, p.hookItems || [])}
              ${provide('monitor', 'UI 能力', (p.uiItems && p.uiItems.length) || (p.ui ? 1 : 0), p.uiItems || (p.ui ? ['提供 UI'] : []))}
            </div>
            ${p.err ? `<div class="cap-error">${OMP.icon('alert-c', 'xs')}<span>${p.err}</span></div>` : ''}
          </div>`;
        }).join('');
        return sum + list;
      },
      mcp: () => {
        const items = D.mcp.map(m => ({
          session: m.status === 'connected',
          err: m.status === 'error',
        }));
        const totalOk = items.filter(x => x.session).length;
        const totalFail = items.filter(x => x.err).length;
        const totalOff = items.length - totalOk - totalFail;
        const sum = `<div class="cap-summary">
          <span class="cap-sum-stat">
            ${OMP.icon('layers', 'xs')}
            <strong>${D.mcp.length}</strong><span class="muted">项</span>
          </span>
          ${totalOk ? `<span class="cap-sum-stat"><span class="dot green"></span><strong>${totalOk}</strong><span class="muted">已连接</span></span>` : ''}
          ${totalFail ? `<span class="cap-sum-stat"><span class="dot red"></span><strong>${totalFail}</strong><span class="muted">失败</span></span>` : ''}
          ${totalOff ? `<span class="cap-sum-stat"><span class="dot gray"></span><strong>${totalOff}</strong><span class="muted">未连接</span></span>` : ''}
        </div>`;

        const list = D.mcp.map(m => {
          const tone = m.status === 'connected' ? 'green'
            : m.status === 'reconnecting' ? 'amber'
            : 'gray';
          const chip = m.status === 'connected' ? 'green'
            : m.status === 'reconnecting' ? 'amber'
            : 'gray';
          const isOn = m.status !== 'disabled';
          return `<div class="cap-item${m.status === 'error' ? ' has-error' : ''}" data-tone="${tone}">
            <div class="cap-item-summary">
              <span class="a-ic ${tone}">${OMP.icon('plug', 'sm')}</span>
              <div class="cap-item-main">
                <div class="cap-item-name-row">
                  <span class="cap-item-name">${m.name}</span>
                  <span class="chip ${chip} xs">${m.status}</span>
                  <span class="chip outline xs">${m.transport}</span>
                </div>
              </div>
              <div class="cap-item-actions">
                <button class="btn small outline">测试连接<span class="sr-only">：${m.name}</span></button>
                <button class="btn small outline">日志<span class="sr-only">：${m.name}</span></button>
                <button class="icon-btn small" data-tip="重新连接 ${m.name}">${OMP.icon('refresh', 'sm')}</button>
                ${switchBtn(isOn, '启用 MCP 服务器 ' + m.name)}
              </div>
            </div>
            <div class="cap-item-body">
              <div class="cap-item-meta">
                <span>Tools ${m.tools}</span>
                <span>Resources ${m.resources}</span>
                <span>Prompts ${m.prompts}</span>
                <span class="mono">最近调用 ${m.last}</span>
              </div>
            </div>
          </div>`;
        }).join('');
        return sum + list;
      },
      host: () => {
        const totalOk = D.hostTools.filter(h => h.registered).length;
        const totalOff = D.hostTools.length - totalOk;
        const sum = `<div class="cap-summary">
          <span class="cap-sum-stat">
            ${OMP.icon('layers', 'xs')}
            <strong>${D.hostTools.length}</strong><span class="muted">项</span>
          </span>
          <span class="cap-sum-stat"><span class="dot green"></span><strong>${totalOk}</strong><span class="muted">已注册</span></span>
          ${totalOff ? `<span class="cap-sum-stat"><span class="dot gray"></span><strong>${totalOff}</strong><span class="muted">未注册</span></span>` : ''}
        </div>`;
        const list = D.hostTools.map(h => {
          const tone = h.registered ? 'green' : 'amber';
          return `<div class="cap-item">
            <div class="cap-item-summary">
              <span class="a-ic ${tone}">${OMP.icon('monitor', 'sm')}</span>
              <div class="cap-item-main">
                <div class="cap-item-name-row">
                  <span class="cap-item-name mono">${h.name}</span>
                  <span class="chip ${tone} xs">${h.registered ? '已注册' : '未注册'}</span>
                </div>
              </div>
            </div>
            <div class="cap-item-body">
              <p class="cap-item-desc">${h.desc}</p>
              <div class="cap-item-meta">
                <span>累计调用 ${h.calls} 次</span>
              </div>
            </div>
          </div>`;
        }).join('');
        return sum + list;
      },
      slash: () => {
        const totalOk = D.slashCommands.filter(c => c.ok).length;
        const sum = `<div class="cap-summary">
          <span class="cap-sum-stat">
            ${OMP.icon('layers', 'xs')}
            <strong>${D.slashCommands.length}</strong><span class="muted">项</span>
          </span>
          <span class="cap-sum-stat"><span class="dot green"></span><strong>${totalOk}</strong><span class="muted">当前可用</span></span>
          ${D.slashCommands.length - totalOk ? `<span class="cap-sum-stat"><span class="dot gray"></span><strong>${D.slashCommands.length - totalOk}</strong><span class="muted">不可用</span></span>` : ''}
        </div>`;
        const list = `<div class="cap-slash-list">
          ${D.slashCommands.map(c => `
            <div class="cap-slash-row" data-ok="${c.ok}">
              <div class="cap-slash-name">
                <span class="a-ic purple">${OMP.icon('slash', 'sm')}</span>
                <span class="mono">${c.name}</span>
                <span class="muted">${c.args}</span>
              </div>
              <div class="cap-slash-desc">${c.desc}<span class="muted"> · ${c.src}</span></div>
              <span class="chip ${c.ok ? 'green' : 'gray'} sm">${c.ok ? '当前会话可用' : '不可用'}</span>
              <button class="btn small primary" ${c.ok ? '' : 'disabled'}>执行</button>
            </div>`).join('')}
        </div>`;
        return sum + list;
      }
    };
    const main = $('#capMain');
    function paint(tab) { main.innerHTML = render[tab](); }
    function selectCap(b) {
      $$('#capSide button').forEach(x => {
        const on = x === b;
        x.classList.toggle('active', on);
        // The class alone left aria-selected stuck on the first tab, so a screen
        // reader kept reporting "Skills" as current no matter what was shown.
        x.setAttribute('aria-selected', String(on));
        x.setAttribute('tabindex', on ? '0' : '-1');
      });
      paint(b.dataset.cap);
    }

    side.addEventListener('click', e => {
      const b = e.target.closest('[data-cap]');
      if (b) selectCap(b);
    });
    side.addEventListener('keydown', e => {
      const all = $$('#capSide [role="tab"]');
      const i = all.indexOf(document.activeElement);
      if (i < 0) return;
      let next = null;
      if (e.key === 'ArrowDown') next = all[(i + 1) % all.length];
      else if (e.key === 'ArrowUp') next = all[(i - 1 + all.length) % all.length];
      else if (e.key === 'Home') next = all[0];
      else if (e.key === 'End') next = all[all.length - 1];
      if (!next) return;
      e.preventDefault();
      selectCap(next);
      next.focus();
    });
    paint('skills');
  }

  /* Switch toggling, registered once for the whole page.

     This used to live inside initSettings(), which returns early when #setSide
     is absent — so on capabilities.html (which has #capSide, not #setSide) the
     handler was never attached and none of the Skills or MCP switches toggled at
     all. Hoisted out so it applies wherever a switch is rendered.

     It also only flipped the .on class. Now that switches are role="switch",
     aria-checked is the authoritative state and has to move with it, or the
     control announces the opposite of what it shows. */
  function initSwitches() {
    document.addEventListener('click', e => {
      const sw = e.target.closest?.('.switch');
      if (!sw) return;
      const on = !sw.classList.contains('on');
      sw.classList.toggle('on', on);
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  /* ---------- 设置 ----------
     SPA：sub 由 router 传入（原先是读 location.hash），仍从侧栏选中对应组。 */
  function initSettings(sub) {
    const side = $('#setSide');
    if (!side) return;
    const groups = [
      ['general', 'settings', 'General'], ['models', 'cpu', 'Models and Providers'],
      ['permissions', 'shield', 'Permissions'], ['sessions', 'history', 'Sessions'],
      ['preview', 'globe', 'Preview'], ['advanced', 'wrench', 'Advanced']
    ];
    // The settings sidebar switches which panel is shown, so it is a tablist —
    // as bare buttons nothing announced which section you were in, and .active
    // was the only signal.
    side.setAttribute('role', 'tablist');
    side.setAttribute('aria-label', '设置分组');
    side.setAttribute('aria-orientation', 'vertical');
    side.innerHTML = groups.map((g, i) =>
      `<button data-set="${g[0]}" class="${i === 0 ? 'active' : ''}" role="tab"
               id="setTab-${g[0]}" aria-controls="set-${g[0]}"
               aria-selected="${i === 0}" tabindex="${i === 0 ? '0' : '-1'}">
        ${OMP.icon(g[1], 'sm')}${g[2]}
      </button>`).join('');
    $$('#setMain .set-group').forEach(g => {
      const key = g.id.replace(/^set-/, '');
      g.setAttribute('role', 'tabpanel');
      g.setAttribute('aria-labelledby', 'setTab-' + key);
      g.setAttribute('tabindex', '0');
    });

    function selectGroup(b) {
      $$('#setSide button').forEach(x => {
        const on = x === b;
        x.classList.toggle('active', on);
        x.setAttribute('aria-selected', String(on));
        x.setAttribute('tabindex', on ? '0' : '-1');
      });
      $$('#setMain .set-group').forEach(g => g.classList.toggle('hidden', g.id !== 'set-' + b.dataset.set));
    }

    side.addEventListener('click', e => {
      const b = e.target.closest('[data-set]');
      if (b) selectGroup(b);
    });
    // Vertical tablist: Up/Down move, Home/End jump.
    side.addEventListener('keydown', e => {
      const all = $$('#setSide [role="tab"]');
      const i = all.indexOf(document.activeElement);
      if (i < 0) return;
      let next = null;
      if (e.key === 'ArrowDown') next = all[(i + 1) % all.length];
      else if (e.key === 'ArrowUp') next = all[(i - 1 + all.length) % all.length];
      else if (e.key === 'Home') next = all[0];
      else if (e.key === 'End') next = all[all.length - 1];
      if (!next) return;
      e.preventDefault();
      selectGroup(next);
      next.focus();
    });

    if (sub) {
      const btn = $(`#setSide [data-set="${sub}"]`);
      if (btn) selectGroup(btn);
    }
  }

  /* ---------- 诊断中心 ---------- */
  function initDiagnostics() {
    const kv = $('#diagKv');
    if (!kv) return;
    const d = D.diagnostics;
    kv.innerHTML = [
      ['OMP 可执行文件', d.ompPath], ['OMP 版本', d.version],
      ['RPC 协议', d.rpc], ['Bridge 状态', d.bridge],
      ['当前工作目录', d.cwd], ['配置目录', d.configDir]
    ].map(x => `<div class="dk"><div class="k">${x[0]}</div><div class="v">${x[1]}</div></div>`).join('');

    $('#diagProc').innerHTML = d.processes.map(p => `
      <tr><td>${p.name}</td><td>${p.pid}</td><td>${p.role}</td><td>${p.mem}</td></tr>`).join('');
    // The capability chips were spaced with an inline margin on every one; a
    // wrapping flex container does the same job once.
    $('#diagCap').innerHTML = `<div class="diag-caps">${d.capabilities.map(c => `<span class="chip gray">${c}</span>`).join('')}</div>`;
    // Error rows: the red tint was an inline style and the only marker that these
    // were errors rather than log lines. Class + a named icon instead.
    $('#diagErr').innerHTML = d.errors.map(e => `
      <div class="prob-row diag-err-row">
        <span class="prob-sev sev-red" role="img" aria-label="错误">${OMP.icon('alert-c', 'sm')}</span>
        <span class="mono tiny muted">${e.time}</span><span class="chip gray xs">${e.src}</span>
        <span class="ellipsis">${e.msg}</span>
      </div>`).join('');
    $$('#diagActions .btn').forEach(b => b.addEventListener('click', () => OMP.ui.toast('已执行：' + b.textContent.trim(), 'check')));
  }

  /* SPA 单 HTML：页头只构建一次；各视图 init 注册到 router，
     由 router 在进入对应视图时以 sub 调用。 */
  document.addEventListener('DOMContentLoaded', () => {
    buildNav();
    // Registered for every page, not just settings — see initSwitches().
    initSwitches();

    OMP.router.register('home', () => initHome());
    OMP.router.register('env', () => initEnv());
    OMP.router.register('history', () => initHistory());
    OMP.router.register('capabilities', () => initCapabilities());
    OMP.router.register('settings', sub => initSettings(sub));
    OMP.router.register('diagnostics', () => initDiagnostics());
  });
})();
