# Changxian Agent Skills

本项目包含用于 `changxian-agent` / `remote-control` 的 Pi Skills，支持博客发布和远程控制两大功能。

## 项目结构

```
changxian-agent-skills/
├── changxian-blog-publisher/   # 博客发布技能
│   ├── SKILL.md               # 技能主文件
│   ├── scripts/               # 发布脚本
│   └── references/            # 参考文档
├── changxian-remote-control/  # 远程控制技能
│   ├── SKILL.md              # 技能主文件
│   ├── scripts/              # 运行时脚本
│   ├── assets/               # 桥接资源
│   └── references/           # 参考文档
└── docs/                     # 设计文档和计划
```

---

## Skills 快速索引

| Skill | 触发描述 | 用途 |
|-------|---------|------|
| `changxian-blog-publisher` | 写博客、发布文章、生成图文卡片、生成封面图 | `changxian-web` 文章发布 |
| `changxian-remote-control` | 远控、Telegram、WeCom、后台切换、定时任务、记忆持久化 | 跨平台远程控制 |

---

## changxian-blog-publisher

### 何时使用

- 用户要求写博客文章、发公众号、发布文章
- 需要生成图文卡片、做封面图
- 涉及 `changxian-web` 的文章发布
- 需要创建 `poster.cards` 或 JSON 文章记录

### 核心流程

1. **写正文** → 按 `references/article-writing-rules.md` 的写作风格
2. **做图文卡片** → 按 `references/poster-style-minimax.md` 的卡片语言
3. **发布验证** → 执行 `npm run build` 检查

### 关键参考

| 文件 | 用途 |
|------|------|
| `references/article-writing-rules.md` | 写作风格、开头规则、AI味审查 |
| `references/poster-style-minimax.md` | 卡片布局、文案压缩、传播策略 |
| `references/publish-checklist.md` | 发布前自检清单 |
| `scripts/publish_post.py` | 文章发布脚本 |

### 发布命令

```bash
python3 $CODEX_HOME/skills/changxian-blog-publisher/scripts/publish_post.py \
  --workspace /path/to/changxian-web \
  --slug <post-slug> \
  --title "<文章标题>" \
  --desc "<摘要>" \
  --date YYYY-MM-DD \
  --content-file /path/to/article.md
```

---

## changxian-remote-control

### 何时使用

- 用户要求开启远控、重启桥接、检查状态
- 通过 Telegram 或 WeCom 远程控制 changxian-agent
- 管理记忆、角色、定时任务
- 后端切换（Claude / Codex / OpenCode ACP / Pi）
- 涉及 `[MEMORY STATE]`、`[ROLE STATE]`、`[SCHEDULE STATE]` 的指令

### 核心能力

| 能力 | 说明 |
|------|------|
| 运行时管理 | 启动、停止、重启桥接进程 |
| 记忆持久化 | 保存稳定偏好、项目事实、默认设置 |
| 角色管理 | 创建、使用、切换角色配置 |
| 定时任务 | 创建一次性/循环任务，立即执行 |
| 后端切换 | Claude ↔ Codex ↔ OpenCode ACP ↔ Pi |
| Telegram 频道发布 | 预览和发布到 TG 频道 |
| 媒体输入 | 支持图片和文件作为任务输入 |

### macOS 快速重启

```bash
launchctl unload ~/Library/LaunchAgents/com.changxian.remote-control.bridge.plist
launchctl load ~/Library/LaunchAgents/com.changxian.remote-control.bridge.plist

# 或直接检查健康状态
curl http://localhost:18001/healthz
```

### 健康检查

```bash
node --no-warnings --experimental-strip-types scripts/remote-control.ts help
```

### 关键参考

| 文件 | 用途 |
|------|------|
| `references/host-bridge-contract.md` | 通用主机桥接能力模型 |
| `references/telegram-operations.md` | Telegram 操作和频道发布 |
| `references/memory-autosave.md` | 自动记忆提取规则 |
| `references/pi-backend.md` | 切换到 Pi 后端 |
| `references/opencode-acp.md` | 切换到 OpenCode ACP |
| `references/claude-backend.md` | 切换到 Claude 后端 |
| `references/launchd-macos.md` | macOS launchd plist 管理 |

### 常用示例

```
"开启远控，帮我把 Telegram 桥接跑起来"
"重启远控桥接，顺手检查 healthz"
"把这个项目接到企微里远程处理"
"把这段内容发到 Telegram 频道 daily"
"记住以后默认中文回答"
"创建一个 reviewer 角色"
"每天早上 9 点自动检查远控服务状态"
"现在直接执行 daily-health-check 这个定时任务"
"切换到 Pi 后端"
"切回 Codex 后端"
```

---

## 写作风格规范（changxian-web）

### 目标气质

- 像长期写《尝鲜AI》的人，而不是像报告生成器
- 语气自然、温暖、直接，有判断，不端着

### 开头规则

- 第一段就要立住：判断、冲突、反常识事实、或一个能把人拉进来的具体场景
- 不要先铺一大段背景

### 语言规则

- 少说空话、大词、正确的废话
- 不要滥用排比句、三连句
- 句子要短，段落要在手机上能快速扫读

### AI 味审查

交稿前至少检查四遍：
1. 结构：开头够不够快
2. 语言：有没有重复、排比、套话
3. 内容：每个重要观点后面是否有具体例子
4. 人味：读起来像不像一个真的试过产品的人

---

## 远程控制输出协议

当需要变更桥接状态时，在回答末尾追加对应的 fenced ops 块：

```rc-memory-ops
{"ops":[{"op":"upsert","memory_id":"xxx","data":{"content":"..."}}]}
```

```rc-role-ops
{"ops":[{"op":"upsert_role","name":"reviewer","instructions":"..."}]}
```

```rc-schedule-ops
{"ops":[{"op":"create_job","schedule":"0 9 * * *","prompt":"检查服务状态"}]}
```

---

## 环境要求

- Node.js 18+
- Python 3.8+ (用于发布脚本)
- Telegram Bot Token (远控)
- WeCom Webhook (可选)

## 相关项目

- [changxian-web](https://github.com/example/changxian-web) - 尝鲜AI科技日报前端
- [changxian-agent](https://github.com/example/changxian-agent) - changxian-agent 核心运行时
