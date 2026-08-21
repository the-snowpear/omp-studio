/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — mock telemetry
     Every number needs a label and a unit. A bare figure next to an icon
     is not information — it's decoration that looks like information.
     ========================================================================== */

  const MODELS = [
    { id: 'omp-opus-5', name: 'Opus 5', short: 'Opus 5', provider: 'Anthropic',
      contextWindow: 1_000_000, thinking: true, fast: true,
      priceIn: 15.0, priceOut: 75.0, priceCacheWrite: 18.75, priceCacheRead: 1.5 },
    { id: 'omp-sonnet-5', name: 'Sonnet 5', short: 'Sonnet 5', provider: 'Anthropic',
      contextWindow: 1_000_000, thinking: true, fast: true,
      priceIn: 3.0, priceOut: 15.0, priceCacheWrite: 3.75, priceCacheRead: 0.3 },
    { id: 'omp-haiku-4-5', name: 'Haiku 4.5', short: 'Haiku 4.5', provider: 'Anthropic',
      contextWindow: 200_000, thinking: false, fast: true,
      priceIn: 1.0, priceOut: 5.0, priceCacheWrite: 1.25, priceCacheRead: 0.1 },
    { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', short: 'G3.6 Flash', provider: 'Google',
      contextWindow: 1_000_000, thinking: true, fast: false,
      priceIn: 0.075, priceOut: 0.3, priceCacheWrite: 0.09, priceCacheRead: 0.019 },
    { id: 'gpt-5.2', name: 'GPT-5.2', short: 'GPT-5.2', provider: 'OpenRouter',
      contextWindow: 400_000, thinking: true, fast: false,
      priceIn: 2.5, priceOut: 10.0, priceCacheWrite: 3.13, priceCacheRead: 0.25 },
  ];

  const THINKING_LEVELS = [
    { id: 'off', label: 'Off', description: '不使用扩展思考' },
    { id: 'low', label: 'Low', description: '简短推理，适合明确的小任务' },
    { id: 'medium', label: 'Medium', description: '平衡推理深度与延迟' },
    { id: 'high', label: 'High', description: '深入推理，适合复杂重构与调试' },
    { id: 'max', label: 'Max', description: '最大推理预算，延迟明显增加' },
  ];

  const PERMISSION_MODES = [
    { id: 'review', label: 'Review', icon: 'eye',
      description: '每个写入与命令都需要审批',
      detail: '最安全。适合不熟悉的代码库或高风险变更。' },
    { id: 'workspace', label: 'Workspace', icon: 'shield',
      description: '工作区内自由读写，工作区外与网络需要审批',
      detail: '默认。日常开发的平衡点。' },
    { id: 'full', label: 'Full Access', icon: 'unlock',
      description: '不请求审批',
      detail: '仅在完全信任的环境中使用。OMP 可以运行任意命令并访问网络。' },
  ];

  const SERVICE_TIERS = [
    { id: 'standard', label: 'Standard', description: '标准优先级' },
    { id: 'priority', label: 'Priority', description: '更高优先级，延迟更低' },
    { id: 'batch', label: 'Batch', description: '批处理，成本更低但延迟不确定' },
  ];

  /* Current session telemetry — matches th-sync-upstream */
  const SESSION_TELEMETRY = {
    model: 'omp-opus-5',
    thinkingLevel: 'high',
    fastMode: false,
    serviceTier: 'standard',

    turn: {
      number: 3,
      tokensIn: 38_400,
      tokensOut: 3_700,
      tokensCacheRead: 1_240_000,
      tokensCacheWrite: 42_000,
      durationMs: 138_000,
      costUsd: 0.94,
    },

    session: {
      tokensIn: 3_540_000,
      tokensOut: 73_200,
      tokensCacheRead: 36_600_000,
      tokensCacheWrite: 1_820_000,
      durationMs: 1_912_000,
      costUsd: 4.82,
      turns: 3,
      requests: 47,
    },

    context: {
      used: 220_400,
      total: 1_000_000,
      breakdown: [
        { label: '系统提示词', tokens: 12_800, color: 'var(--muted)' },
        { label: '工具定义', tokens: 18_400, color: 'var(--text-tertiary)' },
        { label: 'Skills', tokens: 24_200, color: 'var(--accent)' },
        { label: '对话历史', tokens: 118_600, color: 'var(--run)' },
        { label: '文件内容', tokens: 42_100, color: 'var(--git-modified)' },
        { label: '子 Agent 汇总', tokens: 4_300, color: 'var(--ok)' },
      ],
    },

    cache: {
      hitRate: 0.94,
      reads: 36_600_000,
      writes: 1_820_000,
      savedUsd: 52.40,
    },

    compacts: [
      { at: 'Turn 1 后', turnsBefore: 1, tokensBefore: 0, tokensAfter: 0, note: '未触发' },
    ],

    retries: [
      { at: '13:58:41', reason: 'request timeout after 30s', method: 'tools/call', resolved: true, attempt: 2 },
    ],

    fallbacks: [],

    subagents: [
      { name: 'test-runner', tokensIn: 11_200, tokensOut: 1_200, costUsd: 0.21 },
      { name: 'preview-verifier', tokensIn: 2_900, tokensOut: 200, costUsd: 0.05 },
      { name: 'docs-writer', tokensIn: 8_100, tokensOut: 800, costUsd: 0.14 },
    ],
  };

  /* ---- Formatting helpers ------------------------------------------------
     Consistent number rendering across telemetry, cards and the minimap.
     ------------------------------------------------------------------------ */

  function fmtTokens(n) {
    if (n == null) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
    return String(n);
  }

  function fmtDuration(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const rs = Math.round(s % 60);
    if (m < 60) return `${m}m ${String(rs).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  }

  function fmtCost(usd) {
    if (usd == null) return '—';
    if (usd < 0.01) return '<$0.01';
    return `$${usd.toFixed(2)}`;
  }

  function fmtPercent(ratio, digits = 0) {
    return `${(ratio * 100).toFixed(digits)}%`;
  }

  function modelById(id) {
    return MODELS.find(m => m.id === id) || MODELS[0];
  }

  /* Context pressure → tone. 80% turns amber, 92% turns red and the
     composer surfaces the same warning. */
  function contextTone(ratio) {
    if (ratio >= 0.92) return 'danger';
    if (ratio >= 0.80) return 'warn';
    return 'muted';
  }


  OMP.mod['data/telemetry'] = { fmtTokens, fmtDuration, fmtCost, fmtPercent, modelById, contextTone, MODELS, THINKING_LEVELS, PERMISSION_MODES, SERVICE_TIERS, SESSION_TELEMETRY };
})(window.OMP = window.OMP || { mod: {} });
