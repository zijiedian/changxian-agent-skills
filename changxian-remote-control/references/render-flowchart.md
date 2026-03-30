# Telegram 与 ACP 渲染流程图

## 1. 整体架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              用户消息                                        │
│                              @bot xxx                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Telegram Adapter (grammy Bot)                           │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                   │
│  │ handleError │    │ handleText  │    │ handleCmd   │                   │
│  └─────────────┘    └─────────────┘    └─────────────┘                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
                    ▼                ▼                ▼
             ┌───────────┐   ┌────────────┐  ┌───────────┐
             │ 命令处理  │   │  运行时    │  │ 权限请求  │
             │ /start   │   │  控制      │  │ 审批     │
             │ /cancel  │   │            │  │          │
             │ /setting │   │            │  │          │
             └───────────┘   └────────────┘  └───────────┘
                    │                │                │
                    └────────────────┼────────────────┘
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        RuntimeController                                    │
│  ┌─────────────────────────────────────────────────────────────────┐      │
│  │                    Agent Session Management                        │      │
│  │  • createSession()    • cancelSession()   • getSessionState() │      │
│  └─────────────────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     ACP Provider (AgentACPProvider)                        │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐          │
│  │  CodexAcpProvider │  │ClaudeAcpProvider│  │  PiAcpProvider   │          │
│  │                  │  │                  │  │                  │          │
│  │  @zed-industries │  │ @anthropic/claude│  │  pi-coding-agent │          │
│  │  /codex-acp     │  │ /claude-agent-acp│  │  /pi-acp        │          │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘          │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                          ┌──────────────────┐
                          │   Agent CLI      │
                          │  (codex-acp)    │
                          │                  │
                          │  --session-msg  │
                          │  --session-end   │
                          │  --permission    │
                          └──────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
                    ▼                ▼                ▼
              ┌───────────┐   ┌───────────┐   ┌───────────┐
              │ 文本消息  │   │ 工具调用  │   │ 权限请求  │
              │          │   │          │   │          │
              │ agent_   │   │ tool_call│   │permission│
              │ message  │   │ _update  │   │ _request │
              │ _chunk  │   │          │   │          │
              └───────────┘   └───────────┘   └───────────┘
                    │                │                │
                    └────────────────┼────────────────┘
                                     ▼
```

## 2. ACP SessionUpdate 事件流转

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    ACP Provider (base.mjs)                                 │
│                                                                             │
│  sessionUpdate() ←── ACP SDK 回调                                            │
│        │                                                                   │
│        ▼                                                                   │
│  eventFromSessionUpdate(update)                                             │
│        │                                                                   │
│        ├──→ 'agent_thought_chunk'  → type: 'thought'                       │
│        ├──→ 'agent_message_chunk'  → type: 'text'                          │
│        ├──→ 'tool_call'           → type: 'tool_call'                      │
│        ├──→ 'tool_call_update'     → type: 'tool_update'                    │
│        ├──→ 'plan'                → type: 'plan'                           │
│        ├──→ 'current_mode_update' → type: 'mode_change'                   │
│        ├──→ 'model_update'        → type: 'model_update'                   │
│        ├──→ 'usage'              → type: 'usage'                          │
│        ├──→ 'error'              → type: 'error'                          │
│        └──→ 'system_message'     → type: 'system_message'                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                          ┌──────────────────┐
                          │  RuntimeController│
                          │                  │
                          │ onAgentEvent()   │
                          │        │        │
                          │        ▼        │
                          │ emitAgentEvent() │
                          └──────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Telegram Adapter                                        │
│                                                                             │
│  telegramSink.onEvent(event)                                                │
│        │                                                                   │
│        ▼                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    MessageTransformer (render/)                       │    │
│  │                                                                      │    │
│  │  transformEvent(event)                                               │    │
│  │       │                                                              │    │
│  │       ├──→ OutgoingMessage { type, text, metadata }                 │    │
│  │       │                                                              │    │
│  │       └──→ RenderedMessage { body, format, attachments }              │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│        │                                                                   │
│        ▼                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    TelegramRenderer (render/)                          │    │
│  │                                                                      │    │
│  │  render(event)                                                        │    │
│  │       │                                                              │    │
│  │       ├──→ renderText()      → markdownToTelegramHtml()             │    │
│  │       ├──→ renderThought()   → markdownToTelegramHtml()             │    │
│  │       ├──→ renderToolCall()  → formatToolCall()                     │    │
│  │       ├──→ renderToolUpdate() → formatToolCall()                     │    │
│  │       ├──→ renderPlan()      → formatPlan()                         │    │
│  │       ├──→ renderUsage()     → formatUsage()                        │    │
│  │       ├──→ renderError()     → escapeHtml()                        │    │
│  │       └──→ renderNotification() → escapeHtml()                       │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│        │                                                                   │
│        ▼                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    renderTelegramPayload() (Legacy)                   │    │
│  │                                                                      │    │
│  │  输入: { status, text, preview, elapsedSeconds }                      │    │
│  │       │                                                              │    │
│  │       ▼                                                              │    │
│  │  ┌───────────────────────────────────────────────────────────────┐    │    │
│  │  │                   状态分支处理                                  │    │    │
│  │  │                                                              │    │    │
│  │  │  Running + thinking → Thinking 旋转动画                         │    │    │
│  │  │  Running + 其他    → 进度消息 (buildDetailedProgressMarkdown)   │    │    │
│  │  │  Done            → 完整消息 (buildTelegramStructuredPages)     │    │    │
│  │  │                                                              │    │    │
│  │  └───────────────────────────────────────────────────────────────┘    │    │
│  │       │                                                              │    │
│  │       ▼                                                              │    │
│  │  输出: { html, pages: string[], images: [] }                         │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Telegram Bot API                                          │
│                                                                             │
│  ctx.reply(html, { parse_mode: 'HTML' })                                   │
│        │                                                                   │
│        ▼                                                                   │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐        │
│  │ editMessage │  │ sendPhoto  │  │ replyWith  │  │ editMessage│        │
│  │ Text       │  │            │  │ InlineKbd  │  │ Text (停止)│        │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 3. 渲染器继承关系

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         BaseRenderer (base-renderer.mjs)                    │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  renderText(content, verbosity)                                       │    │
│  │  renderThought(content, verbosity)                                     │    │
│  │  renderToolCall(content, verbosity)                                    │    │
│  │  renderToolUpdate(content, verbosity)                                  │    │
│  │  renderPlan(content)                                                   │    │
│  │  renderUsage(content, verbosity)                                       │    │
│  │  renderError(content)                                                  │    │
│  │  renderNotification(notification)                                       │    │
│  │  renderPermission(request)                                              │    │
│  │  render(content, verbosity)  ← 路由分发                                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                        │
│                      ┌─────────────┴─────────────┐                          │
│                      │                         │                            │
│                      ▼                         ▼                            │
┌──────────────────────────────────┐  ┌──────────────────────────────────────┐  │
│  TelegramRenderer                │  │  WeComRenderer                      │  │
│  (telegram-renderer.mjs)        │  │  (wecom-renderer.mjs)               │  │
│                                  │  │                                      │  │
│  format: 'html'                 │  │  format: 'markdown'                 │  │
│  markdownToTelegramHtml()        │  │  简化处理                             │  │
│  coerceTelegramHtml()           │  │                                      │  │
│  renderTelegramPayload() ← Legacy│  │  renderWeComPayload() ← Legacy     │  │
└──────────────────────────────────┘  └──────────────────────────────────────┘  │
```

## 4. renderTelegramPayload 详细流程 (Legacy)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        输入: LegacyPayload                                    │
│                                                                             │
│  {                                                                          │
│    status: 'Running' | 'Done',                                              │
│    text: string,                                                            │
│    preview: {                                                               │
│      phase: 'thinking' | 'exec' | 'diff' | 'assistant',                   │
│      summary: string,                                                       │
│      content: string,                                                       │
│      highlights: string[],                                                   │
│      checks: string[],                                                       │
│      changedFiles: [],                                                       │
│      notes: string[],                                                       │
│      diffBlocks: []                                                         │
│    },                                                                       │
│    elapsedSeconds: number                                                   │
│  }                                                                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                         ┌────────────────────┐
                         │  resolvePreviewModel│
                         │        ()          │
                         └────────────────────┘
                                     │
                                     ▼
                         ┌────────────────────┐
                         │   sanitizePreview() │
                         │  (清理噪音内容)     │
                         └────────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
                    ▼                ▼                ▼
             ┌───────────┐   ┌───────────┐   ┌───────────┐
             │ Running   │   │ Running   │   │   Done    │
             │ thinking  │   │ 其他       │   │           │
             │           │   │           │   │           │
             └─────┬─────┘   └─────┬─────┘   └─────┬─────┘
                   │               │               │
                   ▼               ▼               ▼
           ┌───────────┐   ┌───────────┐   ┌───────────┐
           │ 旋转动画   │   │ 进度消息  │   │ 完整消息  │
           │ ⠋ Thinking │   │           │   │           │
           └───────────┘   └─────┬─────┘   └─────┬─────┘
                                 │               │
                                 ▼               ▼
                         ┌───────────────┐ ┌─────────────────┐
                         │ buildDetailed │ │buildTelegramStr- │
                         │ Progress     │ │ucturedPages     │
                         │ Markdown     │ │()               │
                         └───────┬─────┘ └────────┬────────┘
                                 │                │
                                 ▼                ▼
                         ┌───────────────┐ ┌─────────────────┐
                         │ splitMarkdown │ │ coerceTelegram  │
                         │ Pages()       │ │ Html()          │
                         │               │ │                 │
                         └───────┬─────┘ └────────┬────────┘
                                 │                │
                                 └────────┬───────┘
                                          │
                                          ▼
                              ┌─────────────────────┐
                              │   输出: Result       │
                              │                     │
                              │ { html, pages,      │
                              │   images }          │
                              │                     │
                              └─────────────────────┘
```

## 5. markdownToTelegramHtml 转换流程

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         markdownToTelegramHtml(text)                         │
│                                                                             │
│  输入: "Hello **world** and `code`"                                       │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 1: 提取代码块 → Placeholder                                    │    │
│  │                                                                      │    │
│  │  ```javascript                                                       │    │
│  │  const x = 1;                                                      │    │
│  │  ```                                                                 │    │
│  │            ↓                                                        │    │
│  │  @@CODE_BLOCK_0@@                                                    │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                     │                                        │
│                                     ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 2: 提取内联代码                                                 │    │
│  │                                                                      │    │
│  │  `code` → @@INLINE_CODE_0@@                                          │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                     │                                        │
│                                     ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 3: HTML 转义                                                    │    │
│  │                                                                      │    │
│  │  < → &lt;                                                            │    │
│  │  > → &gt;                                                            │    │
│  │  & → &amp;                                                          │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                     │                                        │
│                                     ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 4: Markdown → HTML 转换                                        │    │
│  │                                                                      │    │
│  │  **text**    → <b>text</b>                                          │    │
│  │  *text*      → <i>text</i>                                          │    │
│  │  __text__    → <u>text</u>                                          │    │
│  │  [text](url) → <a href="url">text</a>                               │    │
│  │  ~~text~~    → <s>text</s>                                          │    │
│  │  ||text||    → <tg-spoiler>text</tg-spoiler>                        │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                     │                                        │
│                                     ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 5: 恢复代码块                                                   │    │
│  │                                                                      │    │
│  │  @@CODE_BLOCK_0@@ → <pre><code>const x = 1;</code></pre>           │    │
│  │  @@INLINE_CODE_0@@ → <code>code</code>                               │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                     │                                        │
│                                     ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 6: 处理 Markdown 元素                                           │    │
│  │                                                                      │    │
│  │  # Header    → <b>Header</b>                                        │    │
│  │  - item      → • item                                               │    │
│  │  > quote     → <i>quote</i>                                        │    │
│  │  ---         → ———                                                   │    │
│  │  1. item    → 1. item                                               │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                     │                                        │
│                                     ▼                                        │
│  输出: "Hello <b>world</b> and <code>code</code>"                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 6. 事件类型映射

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      ACP SessionUpdate → OutgoingMessage                     │
└─────────────────────────────────────────────────────────────────────────────┘

  SessionUpdate                    OutgoingMessage                 Telegram
  ────────────                     ──────────────                ─────────
  
  agent_thought_chunk     →        type: 'thought'               renderThought()
                                                                     │
                                                                     ▼
                                                              markdownToTelegramHtml()
                                                              (纯文本/思考内容)

  agent_message_chunk     →        type: 'text'                  renderText()
                                                                     │
                                                                     ▼
                                                              markdownToTelegramHtml()
                                                              (Markdown → HTML)

  tool_call              →        type: 'tool_call'             renderToolCall()
  │                          { name, kind, rawInput,             │
  │                           displayTitle, displaySummary }      │
  │                                                                  │
  │                                                     ┌─────────────────────────┐
  │                                                     │ formatToolCall(meta)    │
  │                                                     │   │                     │
  │                                                     │   ├── resolveToolIcon() │
  │                                                     │   ├── formatToolTitle()│
  │                                                     │   ├── formatViewerLinks()│
  │                                                     │   └── formatHighDetails()│
  │                                                     └─────────────────────────┘

  tool_call_update       →        type: 'tool_update'           renderToolUpdate()
  (status: in_progress)                                              │
  (status: completed)                                                ▼
  (status: failed)                                              工具状态更新消息

  plan                   →        type: 'plan'                  renderPlan()
                                { entries: [...] }                    │
                                                                          ▼
                                                                  📋 <b>Plan</b>
                                                                  ✅ 1. step 1
                                                                  🔄 2. step 2
                                                                  ⬜ 3. step 3

  current_mode_update    →        type: 'mode_change'            renderModeChange()
                                { modeId }                            │
                                                                          ▼
                                                                  🔄 <b>Mode:</b> review

  model_update           →        type: 'model_update'           renderModelUpdate()
                                { modelId }                           │
                                                                          ▼
                                                                  🤖 <b>Model:</b> gpt-4o

  usage                 →        type: 'usage'                  renderUsage()
                                { tokensUsed,                          │
                                  contextSize,                         │
                                  cost }                              ▼
                                                                  📊 1,234 / 128,000 tokens
                                                                  ████████░░░░░░ 10%

  error                 →        type: 'error'                  renderError()
                                { text }                               │
                                                                          ▼
                                                                  ❌ <b>Error:</b> message

  permission_request    →        type: 'permission'              renderPermission()
                                { description, options }                 │
                                                                          ▼
                                                                  🔐 权限请求消息
                                                                  [允许一次] [始终允许] [拒绝]
```

## 7. 文件对应关系

```
src/
├── agent/
│   └── base.mjs                    # ACP Provider, eventFromSessionUpdate()
│
├── adapters/
│   └── telegram/
│       ├── index.mjs               # Telegram Adapter, telegramSink
│       ├── controls.mjs            # 运行时控制键盘
│       ├── command-panels.mjs      # 命令面板
│       └── channel-publisher.mjs   # 频道发布
│
└── render/
    ├── index.mjs                   # 统一导出
    ├── base-renderer.mjs            # 基础渲染器
    ├── telegram-renderer.mjs         # Telegram 渲染器 + renderTelegramPayload()
    ├── wecom-renderer.mjs           # 企业微信渲染器 + renderWeComPayload()
    ├── message-transformer.mjs      # 消息转换器
    └── format/
        ├── index.mjs               # 格式模块导出
        ├── types.mjs                # 类型定义 (STATUS_ICONS, KIND_ICONS)
        ├── message-formatter.mjs    # 消息格式化
        └── utils.mjs               # 格式化工具
```
