# OMP Studio - Chat Interface Reference

## 概述

这是 OMP Studio 对话区域的 UI 参考实现，展示了现代 coding agent 界面的核心功能和交互模式。

## 功能特性

### 1. 三栏布局结构

- **左侧栏（Sessions Sidebar）**
  - 会话列表展示
  - 快速切换不同对话
  - 显示会话元信息（活跃 agent 数量、最后活动时间）

- **中间栏（Main Chat Area）**
  - 主要对话区域
  - 活跃 agent 状态栏
  - 消息流展示
  - 输入框和工具栏

- **右侧栏（Context Panel）**
  - 引用文件列表
  - 工具使用统计
  - Agent 性能指标
  - 用户设置

### 2. 消息类型

#### 用户消息（User Message）
- 天蓝色头像标识
- 清晰的时间戳
- Markdown 渲染支持

#### AI 回复（Assistant Message）
- 橙色头像标识
- 支持富文本内容
- 可包含多种附加元素：
  - 思考链（Thinking Process）
  - 工具调用（Tool Calls）
  - 任务列表（TodoList）
  - 子 Agent 调用（Subagent）

#### 系统通知（System Message）
- 灰色头像标识
- 用于状态更新和通知

### 3. 交互组件

#### 思考链展示（Thinking Chain）
- 可折叠/展开的设计
- 显示 AI 的推理过程
- 等宽字体显示，便于阅读代码逻辑

**特点：**
- 默认折叠状态，减少视觉干扰
- 点击标题栏展开/折叠
- 旋转动画图标表示可交互

#### 工具调用展示（Tool Calls）
- 每个工具调用独立卡片
- 状态指示器（成功/运行中/失败）
- 显示输入参数和输出结果
- 可折叠详情

**支持的工具类型：**
- Shell 命令执行
- 文件读写（Read/Write）
- 代码搜索（Grep/Glob）
- Web 搜索
- MCP 工具调用

#### TodoList 进度追踪
- 任务总览（已完成/总数）
- 三种状态：
  - `pending`（待处理）- 灰色
  - `in-progress`（进行中）- 蓝色
  - `completed`（已完成）- 绿色带勾选标记
- 视觉化复选框状态

#### 子 Agent 调用卡片
- 显示 Agent 名称和状态
- 任务描述
- 执行结果展示
- 蓝色左边框强调

### 4. 代码渲染

- 使用 `highlight.js` 进行语法高亮
- 使用 `marked.js` 进行 Markdown 解析
- 支持多种编程语言
- 深色主题配色（github-dark）
- 行内代码和代码块分别渲染

### 5. 输入区域

- 自适应高度的文本框（最高 200px）
- 附件上传按钮
- 发送按钮
- 快捷键提示：
  - `Shift + Enter` - 换行
  - `Enter` - 发送
  - `@` - 引用文件（功能占位）

### 6. 响应式设计

- **桌面（>1280px）**：完整三栏布局
- **平板（1024px-1280px）**：左侧栏收窄
- **移动（<1024px）**：左侧栏隐藏，可滑出
- **小屏（<768px）**：单栏布局，侧边栏浮动

## 设计系统

### 颜色方案

采用 **深色 Slate 基调 + 天蓝/橙色强调** 的专业开发者工具风格：

```css
/* 表面色阶 */
--surface-0: #0B0E14   /* 最深背景 */
--surface-1: #0F172A   /* 主要面板 */
--surface-2: #1E293B   /* 卡片/按钮 */
--surface-3: #334155   /* 悬停状态 */

/* 文本层级 */
--text-primary: #F8FAFC    /* 主要文本 */
--text-secondary: #CBD5E1  /* 次要文本 */
--text-tertiary: #94A3B8   /* 辅助文本 */
--text-muted: #64748B      /* 占位文本 */

/* 强调色 */
--accent-cool: #38BDF8     /* 交互/链接 */
--accent-warm: #F97316     /* AI/强调 */
--accent-success: #4FD1C5  /* 成功状态 */
--accent-error: #EF4444    /* 错误状态 */
```

### 间距系统

基于 **8pt 网格系统**：

```
--space-1: 4px
--space-2: 8px
--space-3: 12px
--space-4: 16px
--space-5: 24px
--space-6: 32px
--space-7: 48px
--space-8: 64px
```

### 圆角规范

```
--radius-sm: 6px   /* 小元素（标签、代码） */
--radius-md: 8px   /* 按钮、输入框 */
--radius-lg: 12px  /* 卡片、对话框 */
--radius-xl: 16px  /* 大容器 */
```

### 动画参数

```
--duration-fast: 150ms     /* 微交互 */
--duration-normal: 250ms   /* 标准过渡 */
--duration-slow: 350ms     /* 复杂动画 */

--ease-out: cubic-bezier(0.16, 1, 0.3, 1)    /* 进入 */
--ease-in: cubic-bezier(0.7, 0, 0.84, 0)     /* 退出 */
```

## 技术栈

- **HTML5** - 语义化结构
- **CSS3** - 现代布局（Grid/Flexbox）
- **JavaScript (ES6+)** - 交互逻辑
- **marked.js** - Markdown 解析
- **highlight.js** - 代码语法高亮

## 使用方式

### 本地预览

1. 直接在浏览器中打开 `index.html`
2. 或使用本地服务器：

```bash
# 使用 Python
cd D:\Project\omp-studio\ui_reference\chat
python -m http.server 8080

# 或使用 Node.js
npx http-server -p 8080

# 或使用 PHP
php -S localhost:8080
```

3. 访问 `http://localhost:8080`

### 集成到项目

1. **引入样式**：
```html
<link rel="stylesheet" href="path/to/chat/styles.css">
```

2. **引入依赖库**：
```html
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/11.1.1/marked.min.js"></script>
```

3. **引入脚本**：
```html
<script src="path/to/chat/script.js"></script>
```

4. **使用 API**：
```javascript
// 渲染消息
ChatInterface.renderMessages();

// 创建思考链
const thinkingBlock = ChatInterface.createThinkingBlock(content);

// 创建工具调用列表
const toolsList = ChatInterface.createToolCallsList(tools);

// 创建 TodoList
const todoList = ChatInterface.createTodoList(todoData);

// 创建子 Agent 卡片
const subagentCard = ChatInterface.createSubagentCard(subagentInfo);
```

## 核心交互流程

### 1. 发送消息
```
用户输入 → 按 Enter → 创建用户消息 → 滚动到底部 → 清空输入框 → 显示 AI 输入中指示器
```

### 2. AI 响应
```
收到响应 → 解析 Markdown → 渲染消息内容 → 展示附加元素（工具/思考/Todo） → 代码高亮
```

### 3. 工具调用
```
显示工具名称 → 状态指示器（运行中） → 展示输入参数 → 执行完成 → 更新状态 → 显示输出结果
```

### 4. 子 Agent 调用
```
创建子 Agent 卡片 → 显示任务描述 → 状态指示器（运行中） → 完成后更新状态 → 展示结果
```

## 可扩展性

### 添加新消息类型

在 `script.js` 中扩展 `demoMessages` 数组：

```javascript
{
  type: 'custom',
  author: 'Custom Agent',
  timestamp: '14:40',
  content: '自定义消息内容',
  customData: { /* 自定义数据 */ }
}
```

### 添加新工具类型

在 `createToolCallsList()` 函数中添加图标映射：

```javascript
const toolIcons = {
  'Shell': '<path d="..."></path>',
  'Read': '<path d="..."></path>',
  'YourTool': '<path d="..."></path>'
};
```

### 自定义主题

修改 CSS 变量：

```css
:root {
  --surface-0: #your-color;
  --accent-cool: #your-accent;
  /* ... */
}
```

## 参考来源

界面设计参考了以下主流 coding agent 的最佳实践：

- **Cursor** - 简洁的三栏布局，清晰的视觉层次
- **GitHub Copilot Chat** - 紧凑的消息气泡，流畅的交互
- **Codeium** - 优雅的工具调用展示
- **Tabnine** - 实用的上下文面板
- **ChatGPT** - 直观的输入区域设计

## 下一步

该参考实现为静态 Demo，实际集成时需要：

1. 连接到真实的 Agent Session API
2. 实现 WebSocket 实时通信
3. 添加消息持久化存储
4. 实现文件上传功能
5. 添加用户认证和权限管理
6. 优化性能（虚拟滚动、消息分页）
7. 添加搜索和过滤功能
8. 实现多人协作功能

## 许可

本参考实现供 OMP Studio 项目内部使用。

---

**创建日期**: 2026-08-12  
**版本**: 1.0.0  
**维护**: OMP Studio Team
