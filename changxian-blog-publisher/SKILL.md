---
name: changxian-blog-publisher
description: "Draft, publish, and package changxian-web posts using the unified article architecture: write Markdown articles with changxian writer-style rules, generate declarative poster.cards in a concise MiniMax-like card language, and publish JSON article records under src/content/articles/*.json for the generic /posts/:slug route."
---

# changxian-blog-publisher

用于 `changxian-web` 的**写文 + 发文 + 图文卡片发布**一体化流程。

推荐模式：**先写 Markdown 正文，再生成 declarative poster，再用脚本发布 JSON 文章记录**。

## 先读哪些参考

- 需要起草、改写、润色正文时，先读 `references/article-writing-rules.md`
- 需要做图文卡片、封面页、卡片顺序与文案压缩时，先读 `references/poster-style-minimax.md`
- 需要做最终发布自检时，读 `references/publish-checklist.md`

## Quick Start

```bash
python3 $CODEX_HOME/skills/changxian-blog-publisher/scripts/publish_post.py \
  --workspace /path/to/changxian-web \
  --slug <post-slug> \
  --id <post-id> \
  --title "<文章标题>" \
  --desc "<文章摘要>" \
  --date YYYY-MM-DD \
  --category "<分类>" \
  --channel "<频道>" \
  --tags "标签1,标签2,标签3" \
  --read "10 分钟" \
  --content-file /path/to/article.md \
  --sources-file /path/to/sources.md \
  --cards-source /path/to/cards \
  --card-layout auto
```

如果卡片要强自定义，优先提供：

```bash
--poster-json /path/to/poster.json
```

如果只需要起草文章，不要急着运行发布脚本；先产出：

- `article.md`
- `sources.md`
- 可选 `poster.json`

## Current Architecture

当前 `changxian-web` 使用统一文章架构：

- 数据：`src/content/articles/*.json`
- 内容：正文写在 JSON 的 `content` 字段中，使用 Markdown
- 路由：统一 `'/posts/:slug'`
- 页面：`src/pages/posts/ArticlePostPage.jsx`
- 卡片：统一使用 declarative `poster.cards`

不要再生成单篇 JSX 页面，不要新增独立路由，也不要使用 legacy renderer bridge。

## Workflow

### 1) 写文章

写文时遵守两条总原则：

- 先立判断，再展开信息，不要先铺背景
- 每个抽象判断后面都要跟具体例子、场景、产品、后果或动作

正文默认应满足：

- 开头要快：一句判断 / 一个反常识事实 / 一个具体场景
- 中段可用 `3 个判断`、`5 个变化`、`路线图`、`对比拆解` 这类结构，但不要为了凑数字硬切
- 语言要自然、直接、有判断，避免报告腔、演讲腔、模板化金句
- 段落适合手机阅读，长段落拆开
- 写完后必须做一次“AI 味审查”：删重复、删机械排比、删空话、补具体例子

### 2) 做图文卡片

卡片不要机械切正文，要先做**传播版重组**：

- 先抽结论卡 / 封面卡
- 再放矩阵、对比、指标、时间线、建议、结论
- 一张卡只讲一个主题
- 标题与副标题都要短，能单独截图传播

默认优先采用 `MiniMax` 那类信息型卡片语言：

- 封面卡：`cover-home`
- 信息矩阵：`layers`
- 关键指标：`metrics`
- 节奏变化：`timeline` / `hot-timeline`
- 判断与建议：`checklist` 或 `points`
- 结尾收束：`cta`

### 3) 发布文章

`scripts/publish_post.py` 会完成：

- 生成/更新 `src/content/articles/<slug>.json`
- 写入 `id/slug/title/desc/date/category/channel/tags/read/preset`
- 写入 `summary/content/sources`
- 可选写入 `poster` / `actions`
- 可选复制卡片资源到 `public/assets/posts/<slug>/`
- 可选导出 `poster` 模板与 `actions` 模板
- 可选写入 `src/pages/Generator.jsx` preset

### 4) 发布后验证

发布后必须执行：

```bash
npm run build
```

并检查：

- `/articles` 能看到新文章
- `/posts/<slug>` 能正常访问
- `poster.cards` 能正常渲染
- 来源显示在正文末尾
- 卡片资源路径有效

## 内容硬规则

### 正文

- 正文使用 Markdown
- 不要在正文里手写站内卡片容器
- 不要使用自动编号标题
- 不要使用 `<hr />`
- “参考来源”不要手写到正文尾部，应通过 `sources` 字段提供

### 卡片

- 不要把正文按段落平均切卡
- 不要把章节标题原样搬成卡片标题
- 不要让副标题过长、过虚、像 PPT 标题
- 不要一张卡同时塞背景、观点、数据、结论四件事
- 不要为了“有设计感”堆装饰性词语；信息清晰优先

### 数据结构

文章 JSON 至少包含：

- `id`
- `slug`
- `title`
- `desc`
- `date`
- `category`
- `channel`
- `tags`
- `read`
- `preset`
- `summary`
- `content`

## 推荐参数

### 内容

- `--content-file /path/to/article.md`
- `--sources-file /path/to/sources.md`
- `--summary-items "结论1|结论2|结论3"`

### 卡片

- `--cards-source /path/to/cards`
- `--poster-json /path/to/poster.json`
- `--poster-template-out /path/to/generated-poster.json`
- `--actions-template-out /path/to/actions-template.json`
- `--card-layout auto|image|compare|timeline|concept|metrics|layers|checklist`
- `--focus-terms "术语1,术语2,术语3"`
- `--keep-existing-poster`
- `--keep-existing-actions`

### 品牌

- `--brand-name "尝鲜AI"`
- `--brand-subtitle "科技日报"`
- `--follow-term "关注公众号：尝鲜AI"`
- `--poster-badge "专题特辑"`
- `--card-footer "尝鲜AI · 科技日报"`
- `--logo-url "/logo.png"`
- `--cover-decoration-text "CARD"`
- `--show-card-no`
- `--no-show-card-no`

## Resources

- 写作规则：`references/article-writing-rules.md`
- 卡片风格：`references/poster-style-minimax.md`
- 发布清单：`references/publish-checklist.md`
- Article template：`references/article-json-template.json`
- Poster template：`references/poster-template.json`
- Actions template：`references/actions-template.json`
- 发布脚本：`scripts/publish_post.py`
- 注册脚本（legacy only）：`scripts/register_post.py`
