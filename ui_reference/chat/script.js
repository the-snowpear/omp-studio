// OMP Studio Chat Interface - Interactive Demo Script

// Configure marked for markdown rendering
marked.setOptions({
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
  breaks: true,
  gfm: true
});

// Demo messages data
const demoMessages = [
  {
    type: 'user',
    author: 'You',
    timestamp: '14:32',
    content: '请帮我设计一个聊天界面，包括工具调用、思考链、TodoList等功能的展示'
  },
  {
    type: 'assistant',
    author: 'Main Agent',
    timestamp: '14:32',
    content: '好的，我会为你设计一个综合性的聊天界面。让我先分析一下各大 coding agent 的界面特点。',
    thinking: `分析需求：
1. 用户对话区域 - 用户和AI的消息展示
2. 工具调用展示 - Shell、Read、Write等工具的使用过程
3. 思考链显示 - AI的推理过程可视化
4. TodoList进度 - 任务列表和完成状态
5. 子agent调用 - 显示subagent的工作状态
6. Markdown渲染 - 支持代码高亮、格式化
7. 多用户对话 - 支持团队协作场景

设计方向：
- 采用深色主题，专业开发者工具风格
- 使用slate色系作为基础色
- 天蓝色作为主要交互色
- 橙色作为强调色`,
    tools: [
      {
        name: 'WebSearch',
        status: 'success',
        input: 'cursor agent chat interface design',
        output: '找到相关设计模式...'
      },
      {
        name: 'Read',
        status: 'success',
        input: 'ui_reference/ver1/assets/css/models-roles.css',
        output: '已读取现有界面样式...'
      }
    ]
  },
  {
    type: 'assistant',
    author: 'Main Agent',
    timestamp: '14:33',
    content: '我会创建一个包含以下功能的界面：\n\n## 核心功能\n\n1. **三栏布局**\n   - 左侧：会话列表\n   - 中间：主对话区域\n   - 右侧：上下文面板\n\n2. **消息类型**\n   - 用户消息\n   - AI 回复\n   - 系统通知\n   - 工具调用结果\n\n3. **交互元素**\n   - 可折叠的思考链\n   - 可展开的工具调用详情\n   - 实时进度的 TodoList\n   - 子 Agent 状态卡片',
    todoList: {
      title: '界面开发任务',
      items: [
        { id: 1, text: '设计整体布局结构', status: 'completed' },
        { id: 2, text: '实现消息组件', status: 'completed' },
        { id: 3, text: '添加工具调用展示', status: 'in-progress' },
        { id: 4, text: '实现思考链折叠', status: 'pending' },
        { id: 5, text: '添加 TodoList 组件', status: 'pending' }
      ]
    }
  },
  {
    type: 'assistant',
    author: 'Main Agent',
    timestamp: '14:34',
    content: '让我调用一个子 agent 来帮助处理前端组件的开发：',
    subagent: {
      id: 'sub-001',
      name: 'Frontend Specialist',
      status: 'running',
      task: '创建可复用的消息组件，支持 Markdown 渲染和代码高亮',
      result: null
    }
  },
  {
    type: 'system',
    author: 'System',
    timestamp: '14:34',
    content: '✓ Subagent #001 已完成任务\n\n创建了以下组件：\n- MessageBubble.tsx\n- CodeBlock.tsx\n- ThinkingChain.tsx'
  },
  {
    type: 'assistant',
    author: 'Main Agent',
    timestamp: '14:35',
    content: '现在让我展示一些代码示例。这是消息组件的核心结构：\n\n```typescript\ninterface Message {\n  type: "user" | "assistant" | "system";\n  author: string;\n  timestamp: string;\n  content: string;\n  thinking?: string;\n  tools?: ToolCall[];\n  todoList?: TodoList;\n  subagent?: SubagentInfo;\n}\n\nfunction MessageComponent({ message }: { message: Message }) {\n  return (\n    <div className="message">\n      <MessageHeader author={message.author} timestamp={message.timestamp} />\n      <MessageContent content={message.content} />\n      {message.thinking && <ThinkingChain content={message.thinking} />}\n      {message.tools && <ToolCallsList tools={message.tools} />}\n      {message.todoList && <TodoListDisplay list={message.todoList} />}\n      {message.subagent && <SubagentCard info={message.subagent} />}\n    </div>\n  );\n}\n```\n\n这个设计允许每条消息灵活地包含不同类型的内容，同时保持整洁的视觉层次。'
  },
  {
    type: 'user',
    author: 'You',
    timestamp: '14:36',
    content: '看起来不错！能展示一下工具调用的实际效果吗？'
  },
  {
    type: 'assistant',
    author: 'Main Agent',
    timestamp: '14:36',
    content: '当然可以。让我演示几种常见的工具调用：',
    tools: [
      {
        name: 'Shell',
        status: 'success',
        input: 'npm install marked highlight.js',
        output: `added 2 packages, and audited 458 packages in 3s

68 packages are looking for funding
  run \`npm fund\` for details

found 0 vulnerabilities`
      },
      {
        name: 'Write',
        status: 'success',
        input: 'D:\\Project\\omp-studio\\ui_reference\\chat\\index.html',
        output: 'Successfully wrote 245 lines to index.html'
      },
      {
        name: 'Read',
        status: 'running',
        input: 'package.json',
        output: null
      }
    ]
  }
];

// Render messages
function renderMessages() {
  const container = document.getElementById('messagesContainer');
  
  demoMessages.forEach(msg => {
    const messageEl = document.createElement('div');
    messageEl.className = 'message';
    
    // Message header
    const headerEl = document.createElement('div');
    headerEl.className = 'message-header';
    
    const avatarEl = document.createElement('div');
    avatarEl.className = `message-avatar ${msg.type}`;
    avatarEl.textContent = msg.author.substring(0, 1).toUpperCase();
    
    const metaEl = document.createElement('div');
    metaEl.className = 'message-meta';
    metaEl.innerHTML = `
      <div class="message-author">${msg.author}</div>
      <div class="message-timestamp">${msg.timestamp}</div>
    `;
    
    headerEl.appendChild(avatarEl);
    headerEl.appendChild(metaEl);
    messageEl.appendChild(headerEl);
    
    // Message content
    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';
    contentEl.innerHTML = marked.parse(msg.content);
    messageEl.appendChild(contentEl);
    
    // Thinking chain
    if (msg.thinking) {
      const thinkingEl = createThinkingBlock(msg.thinking);
      contentEl.appendChild(thinkingEl);
    }
    
    // Tool calls
    if (msg.tools) {
      const toolsEl = createToolCallsList(msg.tools);
      contentEl.appendChild(toolsEl);
    }
    
    // TodoList
    if (msg.todoList) {
      const todoEl = createTodoList(msg.todoList);
      contentEl.appendChild(todoEl);
    }
    
    // Subagent
    if (msg.subagent) {
      const subagentEl = createSubagentCard(msg.subagent);
      contentEl.appendChild(subagentEl);
    }
    
    container.appendChild(messageEl);
  });
  
  // Apply syntax highlighting
  document.querySelectorAll('pre code').forEach(block => {
    hljs.highlightElement(block);
  });
}

// Create thinking block
function createThinkingBlock(content) {
  const block = document.createElement('div');
  block.className = 'thinking-block collapsed';
  block.innerHTML = `
    <div class="thinking-header">
      <div class="thinking-title">
        <svg class="thinking-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          <path d="M9 10h.01M15 10h.01M9.5 15a3.5 3.5 0 005 0"></path>
        </svg>
        <span>Thinking Process</span>
      </div>
      <svg class="thinking-toggle" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    </div>
    <div class="thinking-content">${content.replace(/\n/g, '<br>')}</div>
  `;
  
  block.querySelector('.thinking-header').addEventListener('click', () => {
    block.classList.toggle('collapsed');
  });
  
  return block;
}

// Create tool calls list
function createToolCallsList(tools) {
  const container = document.createElement('div');
  container.className = 'tool-calls';
  
  tools.forEach(tool => {
    const toolEl = document.createElement('div');
    toolEl.className = 'tool-call collapsed';
    
    const statusClass = tool.status;
    const statusText = tool.status === 'success' ? '✓' : 
                       tool.status === 'running' ? '⟳' : '✗';
    
    toolEl.innerHTML = `
      <div class="tool-call-header">
        <svg class="tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path>
        </svg>
        <span class="tool-name">${tool.name}</span>
        <span class="tool-status ${statusClass}">${statusText} ${statusClass}</span>
        <svg class="thinking-toggle" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </div>
      <div class="tool-call-body">
        <div><strong>Input:</strong> <code>${tool.input}</code></div>
        ${tool.output ? `<div class="tool-output">${tool.output}</div>` : '<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>'}
      </div>
    `;
    
    toolEl.querySelector('.tool-call-header').addEventListener('click', () => {
      toolEl.classList.toggle('collapsed');
    });
    
    container.appendChild(toolEl);
  });
  
  return container;
}

// Create TodoList
function createTodoList(todoData) {
  const container = document.createElement('div');
  container.className = 'todo-list';
  
  const completed = todoData.items.filter(item => item.status === 'completed').length;
  const total = todoData.items.length;
  
  container.innerHTML = `
    <div class="todo-header">
      <div class="todo-title">${todoData.title}</div>
      <div class="todo-progress">${completed}/${total}</div>
    </div>
    <div class="todo-items">
      ${todoData.items.map(item => `
        <div class="todo-item ${item.status}">
          <div class="todo-checkbox"></div>
          <div class="todo-text">${item.text}</div>
          <div class="todo-status ${item.status}">${item.status.replace('-', ' ')}</div>
        </div>
      `).join('')}
    </div>
  `;
  
  return container;
}

// Create subagent card
function createSubagentCard(subagent) {
  const card = document.createElement('div');
  card.className = 'subagent-card';
  
  const statusDot = subagent.status === 'running' ? 'thinking' : 'active';
  const statusText = subagent.status === 'running' ? 'Running...' : 'Completed';
  
  card.innerHTML = `
    <div class="subagent-header">
      <div class="subagent-info">
        <div class="subagent-avatar">S</div>
        <div>
          <div class="subagent-name">${subagent.name}</div>
          <div class="subagent-status">
            <div class="agent-status-dot ${statusDot}"></div>
            <span>${statusText}</span>
          </div>
        </div>
      </div>
    </div>
    <div class="subagent-body">
      <strong>Task:</strong> ${subagent.task}
      ${subagent.result ? `<div class="subagent-result">${subagent.result}</div>` : ''}
    </div>
  `;
  
  return card;
}

// Panel tabs switching
function setupPanelTabs() {
  const tabs = document.querySelectorAll('.panel-tab');
  const contents = document.querySelectorAll('.panel-content');
  
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const panelName = tab.dataset.panel;
      
      tabs.forEach(t => t.classList.remove('active'));
      contents.forEach(c => c.classList.remove('active'));
      
      tab.classList.add('active');
      document.getElementById(panelName + 'Panel').classList.add('active');
    });
  });
}

// Auto-resize textarea
function setupTextareaAutoResize() {
  const textarea = document.getElementById('messageInput');
  
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
  });
  
  // Handle Shift+Enter for new line, Enter for send
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
}

// Send message handler
function sendMessage() {
  const textarea = document.getElementById('messageInput');
  const content = textarea.value.trim();
  
  if (!content) return;
  
  const container = document.getElementById('messagesContainer');
  const now = new Date();
  const timestamp = now.getHours().toString().padStart(2, '0') + ':' + 
                    now.getMinutes().toString().padStart(2, '0');
  
  // Create user message
  const messageEl = document.createElement('div');
  messageEl.className = 'message';
  messageEl.innerHTML = `
    <div class="message-header">
      <div class="message-avatar user">Y</div>
      <div class="message-meta">
        <div class="message-author">You</div>
        <div class="message-timestamp">${timestamp}</div>
      </div>
    </div>
    <div class="message-content">${marked.parse(content)}</div>
  `;
  
  container.appendChild(messageEl);
  container.scrollTop = container.scrollHeight;
  
  // Clear input
  textarea.value = '';
  textarea.style.height = 'auto';
  
  // Simulate AI response
  setTimeout(() => {
    const responseEl = document.createElement('div');
    responseEl.className = 'message';
    responseEl.innerHTML = `
      <div class="message-header">
        <div class="message-avatar assistant">A</div>
        <div class="message-meta">
          <div class="message-author">Main Agent</div>
          <div class="message-timestamp">${timestamp}</div>
        </div>
      </div>
      <div class="message-content">
        <div class="typing-indicator">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
      </div>
    `;
    
    container.appendChild(responseEl);
    container.scrollTop = container.scrollHeight;
  }, 500);
}

// Send button handler
document.getElementById('sendBtn').addEventListener('click', sendMessage);

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  renderMessages();
  setupPanelTabs();
  setupTextareaAutoResize();
  
  // Scroll to bottom
  const container = document.getElementById('messagesContainer');
  container.scrollTop = container.scrollHeight;
});

// Export for potential external use
window.ChatInterface = {
  renderMessages,
  createThinkingBlock,
  createToolCallsList,
  createTodoList,
  createSubagentCard
};
