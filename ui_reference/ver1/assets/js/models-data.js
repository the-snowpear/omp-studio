/* ============================================================
   OMP Studio — 模型 / 供应商 & 角色 · Mock Data
   Provider 预设注册表 · 已保存供应商 · 模型角色 · YAML 生成器
   说明：预设列表在产品逻辑上来自 OMP Provider Registry，
   这里仅为原型 Mock，新增 Provider 后预设可同步扩充。
   ============================================================ */
(function () {
  const MR = {};

  /* ---------- 认证方式 ---------- */
  MR.AUTH_TYPES = [
    { id: 'oauth',   label: 'OMP Login / OAuth' },
    { id: 'api-key', label: 'API Key' },
    { id: 'env',     label: 'Environment Variable' },
    { id: 'command', label: 'External Command' },
    { id: 'none',    label: '无需认证' }
  ];

  /* ---------- API 类型（UI 名称 → OMP 真实 api 值） ---------- */
  MR.API_TYPES = [
    { id: 'openai-completions',   label: 'OpenAI Completions' },
    { id: 'openai-responses',     label: 'OpenAI Responses' },
    { id: 'openai-codex',         label: 'OpenAI Codex Responses' },
    { id: 'azure-responses',      label: 'Azure OpenAI Responses' },
    { id: 'anthropic-messages',   label: 'Anthropic Messages' },
    { id: 'bedrock-converse',     label: 'Bedrock Converse' },
    { id: 'google-generative',    label: 'Google Generative AI' },
    { id: 'gemini-cli',           label: 'Google Gemini CLI' },
    { id: 'google-vertex',        label: 'Google Vertex' }
  ];

  MR.DISCOVERY_TYPES = ['Ollama', 'llama.cpp', 'LM Studio', 'OpenAI Models List', 'Proxy', 'LiteLLM'];

  /* ---------- Provider 预设注册表（OMP Provider Registry → Studio Preset） ----------
     p(id, name, desc, api, auth[], opts)  opts: endpoint/local/discovery/oauth */
  function p(id, name, desc, api, auth, opts) {
    return Object.assign({ id, name, desc, api, auth: auth || ['oauth', 'api-key'] }, opts || {});
  }
  MR.PRESET_GROUPS = [
    { group: '官方 / 主流', items: [
      p('anthropic', 'Anthropic', 'Claude 系列模型官方 API', 'anthropic-messages', ['oauth', 'api-key'], { popular: true, endpoint: 'https://api.anthropic.com/v1' }),
      p('openai', 'OpenAI', 'GPT 系列模型官方 API', 'openai-responses', ['oauth', 'api-key'], { popular: true, endpoint: 'https://api.openai.com/v1' }),
      p('openai-codex', 'OpenAI Codex', 'Codex 订阅额度（ChatGPT 账号）', 'openai-codex', ['oauth'], { endpoint: 'https://api.openai.com/v1' }),
      p('google-gemini', 'Google Gemini', 'Gemini 系列模型官方 API', 'google-generative', ['oauth', 'api-key'], { popular: true, endpoint: 'https://generativelanguage.googleapis.com/v1beta' }),
      p('gemini-cli', 'Google Gemini CLI', 'Gemini Code Assist 订阅', 'gemini-cli', ['oauth'], { endpoint: 'https://generativelanguage.googleapis.com/v1beta' }),
      p('google-vertex', 'Google Vertex', 'Vertex AI 企业接入', 'google-vertex', ['oauth', 'api-key']),
      p('xai', 'xAI', 'Grok 系列模型', 'openai-completions', ['api-key'], { endpoint: 'https://api.x.ai/v1' }),
      p('groq', 'Groq', '高速推理（Llama / Mixtral）', 'openai-completions', ['api-key'], { endpoint: 'https://api.groq.com/openai/v1' }),
      p('mistral', 'Mistral', 'Mistral 系列模型', 'openai-completions', ['api-key'], { endpoint: 'https://api.mistral.ai/v1' }),
      p('deepseek', 'DeepSeek', 'DeepSeek V / R 系列', 'openai-completions', ['api-key'], { endpoint: 'https://api.deepseek.com/v1' }),
      p('moonshot', 'Moonshot / Kimi', 'Kimi K 系列模型', 'openai-completions', ['api-key'], { endpoint: 'https://api.moonshot.cn/v1' }),
      p('minimax', 'MiniMax', 'MiniMax M 系列模型', 'anthropic-messages', ['api-key'], { endpoint: 'https://api.minimaxi.com/v1' })
    ]},
    { group: 'Gateway / 聚合', items: [
      p('openrouter', 'OpenRouter', '一个 Key 访问多家模型', 'openai-completions', ['api-key'], { popular: true, endpoint: 'https://openrouter.ai/api/v1' }),
      p('vercel-ai', 'Vercel AI Gateway', 'Vercel 托管模型网关', 'openai-completions', ['api-key'], { endpoint: 'https://ai-gateway.vercel.sh/v1' }),
      p('cloudflare-ai', 'Cloudflare AI Gateway', 'Cloudflare 边缘网关', 'openai-completions', ['api-key']),
      p('litellm', 'LiteLLM', '自托管统一模型代理', 'openai-completions', ['api-key', 'env'], { endpoint: 'http://localhost:4000/v1', discovery: 'LiteLLM' }),
      p('github-copilot', 'GitHub Copilot', 'Copilot 订阅额度', 'openai-responses', ['oauth'])
    ]},
    { group: '云平台', items: [
      p('bedrock', 'Amazon Bedrock', 'AWS 托管多模型平台', 'bedrock-converse', ['env']),
      p('azure-openai', 'Azure OpenAI', 'Azure 托管 OpenAI 服务', 'azure-responses', ['api-key', 'oauth'])
    ]},
    { group: '本地', items: [
      p('ollama', 'Ollama', '本地模型服务，自动发现已拉取模型', 'openai-completions', ['none'], { endpoint: 'http://localhost:11434/v1', local: true, discovery: 'Ollama', popular: true }),
      p('lmstudio', 'LM Studio', '本地 OpenAI 兼容服务', 'openai-completions', ['none'], { endpoint: 'http://localhost:1234/v1', local: true, discovery: 'LM Studio' }),
      p('llamacpp', 'llama.cpp', 'llama-server OpenAI 兼容接口', 'openai-completions', ['none'], { endpoint: 'http://localhost:8080/v1', local: true, discovery: 'llama.cpp' })
    ]},
    { group: '更多 Provider', items: [
      p('bailian', 'Alibaba / 百炼', '阿里云百炼平台', 'openai-completions', ['api-key'], { endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }),
      p('qwen', 'Qwen', '通义千问官方 API', 'openai-completions', ['api-key'], { endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }),
      p('zhipu', 'Zhipu / 智谱', 'GLM 系列模型', 'openai-completions', ['api-key'], { endpoint: 'https://open.bigmodel.cn/api/paas/v4' }),
      p('cerebras', 'Cerebras', '超高速推理', 'openai-completions', ['api-key'], { endpoint: 'https://api.cerebras.ai/v1' }),
      p('fireworks', 'Fireworks', 'Fireworks AI 托管推理', 'openai-completions', ['api-key'], { endpoint: 'https://api.fireworks.ai/inference/v1' }),
      p('together', 'Together', 'Together AI 开源模型云', 'openai-completions', ['api-key'], { endpoint: 'https://api.together.xyz/v1' }),
      p('nvidia', 'NVIDIA', 'NVIDIA NIM 推理服务', 'openai-completions', ['api-key'], { endpoint: 'https://integrate.api.nvidia.com/v1' }),
      p('siliconflow', 'SiliconFlow', '硅基流动模型云', 'openai-completions', ['api-key'], { endpoint: 'https://api.siliconflow.cn/v1' }),
      p('huggingface', 'Hugging Face', 'HF Inference Endpoints', 'openai-completions', ['api-key'], { endpoint: 'https://router.huggingface.co/v1' })
    ]}
  ];
  MR.preset = function (id) {
    for (const g of MR.PRESET_GROUPS) {
      const hit = g.items.find(i => i.id === id);
      if (hit) return hit;
    }
    return null;
  };

  /* ---------- 供应商状态 / 来源元数据 ---------- */
  MR.STATUS = {
    'available':          { label: 'Available',              chip: 'green',  dot: 'green' },
    'not-authenticated':  { label: 'Not Authenticated',      chip: 'amber',  dot: 'amber' },
    'disabled':           { label: 'Disabled',               chip: 'gray',   dot: '' },
    'connecting':         { label: 'Connecting',             chip: 'blue',   dot: 'blue pulse' },
    'offline':            { label: 'Offline',                chip: 'red',    dot: 'red' },
    'auth-expired':       { label: 'Authentication Expired', chip: 'amber',  dot: 'amber' },
    'config-error':       { label: 'Configuration Error',    chip: 'red',    dot: 'red' },
    'connection-failed':  { label: 'Connection Failed',      chip: 'red',    dot: 'red' }
  };
  MR.SOURCE = {
    'builtin':  { label: 'OMP Built-in' },
    'custom':   { label: 'Custom' },
    'runtime':  { label: 'Runtime Discovery' },
    'extension':{ label: 'Extension' }
  };

  /* ---------- 模型工具函数 ----------
     m(id, name, ctx, maxOut, opts)  opts: img/reason/tools/cIn/cOut/status/src */
  function m(id, name, ctx, maxOut, o) {
    o = o || {};
    return {
      id, name, ctx, maxOut,
      img: !!o.img, reason: !!o.reason, tools: o.tools !== false,
      cIn: o.cIn != null ? o.cIn : 0, cOut: o.cOut != null ? o.cOut : 0,
      status: o.status || 'available',
      src: o.src || 'catalog'
    };
  }

  /* ---------- 已保存供应商（Saved Providers） ---------- */
  MR.providers = [
    {
      id: 'anthropic', name: 'Anthropic', source: 'builtin', status: 'available',
      statusDetail: '已登录 snowpear@anthropic.com · 延迟 142ms',
      auth: { type: 'oauth', account: 'snowpear@anthropic.com' },
      api: 'anthropic-messages', endpoint: { url: 'https://api.anthropic.com/v1' },
      local: false, enabled: true, website: 'https://www.anthropic.com',
      note: '', presetId: 'anthropic',
      models: [
        m('claude-opus-4.8', 'Claude Opus 4.8', 200000, 64000, { img: 1, reason: 1, cIn: 15, cOut: 75 }),
        m('claude-sonnet-4.5', 'Claude Sonnet 4.5', 200000, 64000, { img: 1, reason: 1, cIn: 3, cOut: 15 }),
        m('claude-haiku-4.5', 'Claude Haiku 4.5', 200000, 64000, { img: 1, cIn: 1, cOut: 5 })
      ]
    },
    {
      id: 'openai', name: 'OpenAI', source: 'builtin', status: 'available',
      statusDetail: 'API Key 已保存 · 延迟 168ms',
      auth: { type: 'api-key', saved: true, key: 'sk-proj-••••••••••••3fA2' },
      api: 'openai-responses', endpoint: { url: 'https://api.openai.com/v1' },
      local: false, enabled: true, website: 'https://platform.openai.com',
      note: '', presetId: 'openai',
      models: [
        m('gpt-5.2', 'GPT-5.2', 400000, 128000, { img: 1, reason: 1, cIn: 1.75, cOut: 14 }),
        m('gpt-5.2-codex', 'GPT-5.2 Codex', 400000, 128000, { img: 1, reason: 1, cIn: 1.75, cOut: 14 }),
        m('gpt-5-mini', 'GPT-5 mini', 400000, 128000, { img: 1, reason: 1, cIn: 0.25, cOut: 2 }),
        m('gpt-5.1-codex-mini', 'GPT-5.1 Codex mini', 400000, 128000, { reason: 1, cIn: 0.25, cOut: 2, status: 'disabled' })
      ]
    },
    {
      id: 'google', name: 'Google Gemini', source: 'builtin', status: 'available',
      statusDetail: '已登录 snowpear@gmail.com · 延迟 182ms',
      auth: { type: 'oauth', account: 'snowpear@gmail.com' },
      api: 'google-generative', endpoint: { url: 'https://generativelanguage.googleapis.com/v1beta' },
      local: false, enabled: true, website: 'https://aistudio.google.com',
      note: '', presetId: 'google-gemini',
      models: [
        m('gemini-3-pro', 'Gemini 3 Pro', 1000000, 64000, { img: 1, reason: 1, cIn: 2, cOut: 12 }),
        m('gemini-3-flash', 'Gemini 3 Flash', 1000000, 64000, { img: 1, reason: 1, cIn: 0.3, cOut: 2.5 })
      ]
    },
    {
      id: 'company-gateway', name: 'Company Gateway', source: 'custom', status: 'available',
      statusDetail: 'HTTP 200 · 延迟 96ms · 3 个自定义模型',
      auth: { type: 'env', envName: 'COMPANY_GATEWAY_KEY' },
      api: 'openai-responses',
      endpoint: { url: 'https://gateway.corp.example.com/v1' },
      local: false, enabled: true, website: 'https://wiki.corp.example.com/ai-gateway',
      note: '公司统一网关，走内网专线。', presetId: null,
      models: [
        m('claude-sonnet-4.5', 'Claude Sonnet 4.5（网关）', 200000, 64000, { img: 1, reason: 1, cIn: 0, cOut: 0, src: 'custom' }),
        m('gpt-5.2', 'GPT-5.2（网关）', 400000, 128000, { img: 1, reason: 1, src: 'custom' }),
        m('gemini-3-pro', 'Gemini 3 Pro（网关）', 1000000, 64000, { img: 1, reason: 1, src: 'custom' })
      ]
    },
    {
      id: 'ollama', name: 'Ollama', source: 'builtin', status: 'available',
      statusDetail: '本地服务运行中 · 发现 6 个模型 · 6 个可用',
      auth: { type: 'none' },
      api: 'openai-completions',
      endpoint: { url: 'http://localhost:11434/v1' },
      local: true, enabled: true, website: 'https://ollama.com',
      note: '', presetId: 'ollama',
      discovery: { enabled: true, type: 'Ollama', timeout: 10, found: 6, usable: 6 },
      models: [
        m('qwen3:32b', 'Qwen3 32B', 131072, 8192, { reason: 1, src: 'discovery' }),
        m('qwen3:4b', 'Qwen3 4B', 131072, 8192, { reason: 1, src: 'discovery' }),
        m('qwen2.5-coder:14b', 'Qwen2.5 Coder 14B', 131072, 8192, { src: 'discovery' }),
        m('deepseek-r1:14b', 'DeepSeek R1 14B', 131072, 8192, { reason: 1, src: 'discovery' }),
        m('llama3.3:70b', 'Llama 3.3 70B', 131072, 8192, { src: 'discovery' }),
        m('nomic-embed-text:latest', 'Nomic Embed Text', 8192, 2048, { tools: false, src: 'discovery' })
      ]
    },
    {
      id: 'openrouter', name: 'OpenRouter', source: 'custom', status: 'not-authenticated',
      statusDetail: '未配置 API Key — 创建后尚未完成认证',
      auth: { type: 'api-key', saved: false, key: '' },
      api: 'openai-completions', endpoint: { url: 'https://openrouter.ai/api/v1' },
      local: false, enabled: true, website: 'https://openrouter.ai',
      note: '', presetId: 'openrouter',
      models: [
        m('auto', 'OpenRouter Auto', 200000, 32000, { img: 1, reason: 1, status: 'unavailable' })
      ]
    },
    {
      id: 'deepseek', name: 'DeepSeek', source: 'builtin', status: 'auth-expired',
      statusDetail: '凭据已过期 · 上次成功认证 23 天前',
      auth: { type: 'api-key', saved: true, key: 'sk-••••••••9c1d' },
      api: 'openai-completions', endpoint: { url: 'https://api.deepseek.com/v1' },
      local: false, enabled: true, website: 'https://platform.deepseek.com',
      note: '', presetId: 'deepseek',
      models: [
        m('deepseek-v4', 'DeepSeek V4', 131072, 8192, { reason: 1, cIn: 0.27, cOut: 1.1, status: 'unavailable' }),
        m('deepseek-r1', 'DeepSeek R1', 131072, 8192, { reason: 1, cIn: 0.55, cOut: 2.19, status: 'unavailable' })
      ]
    },
    {
      id: 'azure-openai', name: 'Azure OpenAI', source: 'builtin', status: 'connection-failed',
      statusDetail: 'Endpoint 不可达 · connect ETIMEDOUT 20.190.160.4:443',
      auth: { type: 'api-key', saved: true, key: '••••••••••••77ab' },
      api: 'azure-responses',
      endpoint: { url: 'https://corp-eastus.openai.azure.com/openai/v1' },
      local: false, enabled: true, website: 'https://portal.azure.com',
      note: '走公司网络才能连通。', presetId: 'azure-openai',
      models: [
        m('gpt-5.2', 'GPT-5.2（Azure）', 400000, 128000, { img: 1, reason: 1, status: 'unavailable' })
      ]
    },
    {
      id: 'lmstudio', name: 'LM Studio', source: 'runtime', status: 'offline',
      statusDetail: '本地服务未运行 · 最后在线 2 天前',
      auth: { type: 'none' },
      api: 'openai-completions',
      endpoint: { url: 'http://localhost:1234/v1' },
      local: true, enabled: true, website: 'https://lmstudio.ai',
      note: '', presetId: 'lmstudio',
      discovery: { enabled: true, type: 'LM Studio', timeout: 5, found: 0, usable: 0 },
      models: []
    },
    {
      id: 'litellm-team', name: 'LiteLLM Team Proxy', source: 'custom', status: 'connecting',
      statusDetail: '正在连接 http://litellm.internal:4000 …',
      auth: { type: 'command', command: '!op read op://dev/litellm/api-key' },
      api: 'openai-completions',
      endpoint: { url: 'http://litellm.internal:4000/v1' },
      local: false, enabled: true, website: '',
      note: '', presetId: 'litellm',
      discovery: { enabled: true, type: 'LiteLLM', timeout: 15, found: 0, usable: 0 },
      models: []
    },
    {
      id: 'zhipu', name: 'Zhipu / 智谱', source: 'builtin', status: 'disabled',
      statusDetail: '已禁用 · 2 个模型不参与路由',
      auth: { type: 'api-key', saved: true, key: '••••••••a91f' },
      api: 'openai-completions', endpoint: { url: 'https://open.bigmodel.cn/api/paas/v4' },
      local: false, enabled: false, website: 'https://open.bigmodel.cn',
      note: '', presetId: 'zhipu',
      models: [
        m('glm-4.6', 'GLM 4.6', 200000, 8192, { reason: 1, cIn: 0.6, cOut: 2.2, status: 'disabled' }),
        m('glm-4.6-air', 'GLM 4.6 Air', 131072, 8192, { cIn: 0.2, cOut: 1, status: 'disabled' })
      ]
    },
    {
      id: 'copilot-ext', name: 'GitHub Copilot (Extension)', source: 'extension', status: 'config-error',
      statusDetail: 'Schema Invalid · models.yml:84 `contextWindow` 必须是正整数',
      auth: { type: 'oauth', account: null },
      api: 'openai-responses', endpoint: { url: 'https://api.githubcopilot.com/v1' },
      local: false, enabled: true, website: 'https://github.com/features/copilot',
      note: '由 omp-ext-copilot 扩展注入。', presetId: 'github-copilot',
      models: [
        m('copilot-gpt-5', 'Copilot GPT-5', 128000, 16384, { img: 1, status: 'unavailable', src: 'extension' })
      ]
    }
  ];
  MR.provider = id => MR.providers.find(x => x.id === id);

  /* ---------- Thinking Levels ---------- */
  MR.THINKING = [
    { id: 'off',    label: 'Off' },
    { id: 'low',    label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high',   label: 'High' }
  ];

  /* ---------- 模型角色（Model Roles） ----------
     primary: 'provider/model[:thinking]'；scope: global | project */
  MR.roles = [
    { id: 'default',  alias: '@default',  name: 'Default',  desc: '默认主模型', builtin: true,
      primary: 'anthropic/claude-sonnet-4.5', thinking: null, scope: 'global',
      fallbacks: ['openai/gpt-5.2', 'google/gemini-3-pro'], fallbackOn: true, recovery: 'cooldown' },
    { id: 'smol',     alias: '@smol',     name: 'Fast',     desc: '快速、低成本任务', builtin: true,
      primary: 'openai/gpt-5-mini', thinking: 'low', scope: 'global',
      fallbacks: ['anthropic/claude-haiku-4.5'], fallbackOn: true, recovery: 'cooldown' },
    { id: 'slow',     alias: '@slow',     name: 'Thinking', desc: '复杂推理任务', builtin: true,
      primary: 'openai/gpt-5.2', thinking: 'high', scope: 'project',
      globalPrimary: 'anthropic/claude-opus-4.8', globalThinking: 'high',
      fallbacks: ['google/gemini-3-pro'], fallbackOn: true, recovery: 'cooldown' },
    { id: 'vision',   alias: '@vision',   name: 'Vision',   desc: '视觉与图片任务', builtin: true,
      primary: 'google/gemini-3-pro', thinking: null, scope: 'global', fallbacks: [], fallbackOn: false, recovery: 'cooldown' },
    { id: 'plan',     alias: '@plan',     name: 'Architect', desc: '规划和架构任务', builtin: true,
      primary: 'anthropic/claude-opus-4.8', thinking: 'high', scope: 'global',
      fallbacks: ['openai/gpt-5.2'], fallbackOn: true, recovery: 'cooldown' },
    { id: 'designer', alias: '@designer', name: 'Designer', desc: '设计相关任务', builtin: true,
      primary: 'openrouter/auto', thinking: 'medium', scope: 'global', fallbacks: [], fallbackOn: false, recovery: 'cooldown' },
    { id: 'commit',   alias: '@commit',   name: 'Commit',   desc: 'Commit 相关任务', builtin: true,
      primary: 'anthropic/claude-haiku-4.5', thinking: 'low', scope: 'global', fallbacks: [], fallbackOn: false, recovery: 'cooldown' },
    { id: 'tiny',     alias: '@tiny',     name: 'Tiny',     desc: '标题、记忆等极轻量后台任务', builtin: true,
      primary: 'ollama/qwen3:4b', thinking: 'off', scope: 'global', fallbacks: [], fallbackOn: false, recovery: 'manual' },
    { id: 'task',     alias: '@task',     name: 'Subtask',  desc: '通用子任务', builtin: true,
      primary: 'openai/gpt-5.1-codex-mini', thinking: null, scope: 'global',
      fallbacks: ['openai/gpt-5-mini'], fallbackOn: true, recovery: 'cooldown' },
    { id: 'advisor',  alias: '@advisor',  name: 'Advisor',  desc: '第二模型审查', builtin: true,
      primary: 'openai/gpt-5.2', thinking: 'medium', scope: 'global',
      fallbacks: ['anthropic/claude-sonnet-4.5'], fallbackOn: true, recovery: 'cooldown' },
    { id: 'review',   alias: '@review',   name: 'Code Review', desc: '自定义 · 代码评审专用', builtin: false,
      primary: 'company-gateway/gpt-5.2', thinking: 'high', scope: 'project',
      globalPrimary: 'openai/gpt-5.2', globalThinking: 'high',
      fallbacks: ['anthropic/claude-sonnet-4.5'], fallbackOn: true, recovery: 'cooldown', quickCycle: true },
    { id: 'docs',     alias: '@docs',     name: 'Docs Writer', desc: '自定义 · 文档撰写', builtin: false,
      primary: 'company-gateway/gpt-4o-old', thinking: null, scope: 'global', fallbacks: [], fallbackOn: false, recovery: 'cooldown' }
  ];
  MR.role = id => MR.roles.find(r => r.id === id);
  MR.cycleOrder = ['smol', 'default', 'slow'];

  /* ---------- 模型解析与可用性 ---------- */
  MR.parseSelector = function (sel) {
    const i = sel.indexOf('/');
    return { providerId: sel.slice(0, i), modelId: sel.slice(i + 1) };
  };
  MR.findModel = function (sel) {
    const { providerId, modelId } = MR.parseSelector(sel);
    const prov = MR.provider(providerId);
    if (!prov) return { provider: null, model: null };
    return { provider: prov, model: prov.models.find(x => x.id === modelId) || null };
  };
  /* 返回 null 表示可用，否则返回 issue 对象 */
  MR.roleIssue = function (role) {
    const sel = role.primary;
    const { provider, model } = MR.findModel(sel);
    if (!provider || !model) return { kind: 'model-missing', selector: sel };
    if (!provider.enabled || provider.status === 'disabled') return { kind: 'provider-disabled', provider };
    if (provider.status === 'not-authenticated' || provider.status === 'auth-expired') return { kind: 'provider-unauth', provider };
    if (provider.status === 'offline' || provider.status === 'connection-failed' || provider.status === 'config-error')
      return { kind: 'provider-down', provider };
    if (model.status === 'disabled') return { kind: 'model-disabled', provider, model };
    if (model.status === 'unavailable') return { kind: 'model-unavailable', provider, model };
    return null;
  };
  /* 角色可选模型：仅「真正可用」的模型（Provider 启用 + 状态正常 + 模型可用） */
  MR.usableModels = function () {
    const out = [];
    MR.providers.forEach(pv => {
      if (!pv.enabled || pv.status !== 'available') return;
      pv.models.forEach(md => {
        if (md.status !== 'available') return;
        out.push({ provider: pv, model: md, selector: pv.id + '/' + md.id });
      });
    });
    return out;
  };

  /* ---------- 数字 / 成本格式化 ---------- */
  MR.fmtK = n => n >= 1000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + 'K' : String(n);

  /* ---------- YAML 生成：~/.omp/agent/models.yml ---------- */
  MR.modelsYml = function (d) {
    /* d = draft provider */
    const L = ['# ~/.omp/agent/models.yml — 由 OMP Studio 生成预览', 'providers:'];
    const key = d.id || '<provider-id>';
    L.push(`  ${key}:`);
    if (d.endpoint.url) L.push(`    baseUrl: ${d.endpoint.url}`);
    const a = d.auth;
    if (a.type === 'api-key' && a.key) L.push(`    apiKey: ${a.key}`);
    if (a.type === 'env' && a.envName) L.push(`    apiKey: ${a.envName}`);
    if (a.type === 'command' && a.command) L.push(`    apiKey: "${a.command}"`);
    if (a.type === 'oauth') L.push(`    auth: omp-login`);
    L.push(`    api: ${d.api}`);
    if (d.advanced && d.advanced.authHeader) L.push(`    authHeader: true`);
    if (d.advanced && d.advanced.disableStrictTools) L.push(`    disableStrictTools: true`);
    if (d.advanced && d.advanced.headers) {
      L.push(`    headers:`);
      d.advanced.headers.split('\n').filter(x => x.trim()).forEach(line => {
        const ci = line.indexOf(':');
        if (ci > 0) L.push(`      ${line.slice(0, ci).trim()}: "${line.slice(ci + 1).trim()}"`);
      });
    }
    if (d.discovery && d.discovery.enabled) {
      L.push(`    discovery:`);
      L.push(`      type: ${d.discovery.type.toLowerCase().replace(/[\s.]+/g, '-')}`);
      L.push(`      timeout: ${d.discovery.timeout || 10}`);
    }
    if (d.advanced && d.advanced.compatibility) L.push(`    compatibility: ${d.advanced.compatibility}`);
    if (d.models && d.models.length) {
      L.push(`    models:`);
      d.models.forEach(md => {
        L.push(`      - id: ${md.id}`);
        if (md.name && md.name !== md.id) L.push(`        name: "${md.name}"`);
        L.push(`        contextWindow: ${md.ctx}`);
        L.push(`        maxTokens: ${md.maxOut}`);
        if (md.reason) L.push(`        reasoning: true`);
        if (md.img) L.push(`        input: [text, image]`);
        if (md.tools === false) L.push(`        tools: false`);
        if (md.cIn || md.cOut) {
          L.push(`        cost:`);
          L.push(`          input: ${md.cIn}`);
          L.push(`          output: ${md.cOut}`);
        }
      });
    }
    return L.join('\n');
  };

  /* ---------- YAML 生成：config.yml 中的模型角色段 ---------- */
  MR.configYml = function (roles, cycleOrder) {
    const L = ['# ~/.omp/agent/config.yml — 模型角色配置预览', 'modelRoles:'];
    roles.forEach(r => {
      let v = r.primary + (r.thinking && r.thinking !== 'off' ? ':' + r.thinking : '');
      L.push(`  ${r.id}: ${v}`);
    });
    L.push('', 'cycleOrder:');
    cycleOrder.forEach(id => L.push(`  - ${id}`));
    const fbRoles = roles.filter(r => r.fallbackOn && r.fallbacks.length);
    if (fbRoles.length) {
      L.push('', 'retry:');
      L.push('  modelFallback: true');
      L.push('  fallbackChains:');
      fbRoles.forEach(r => {
        L.push(`    ${r.id}:`);
        r.fallbacks.forEach(f => L.push(`      - ${f}`));
      });
    }
    return L.join('\n');
  };

  window.OMP_MR = MR;
})();
