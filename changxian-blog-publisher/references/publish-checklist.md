# changxian-web 发布清单（JSON-first 版本）

## 0) 写作与卡片参考

- 正文起草或改写前，先对齐 `references/article-writing-rules.md`
- 图文卡片文案与结构压缩前，先对齐 `references/poster-style-minimax.md`

## 1) 输入检查

- 必填：标题、摘要、日期、分类、频道、标签、阅读时长
- 推荐：`--content-file` 提供正文 Markdown
- 推荐：`--sources-file` 提供来源
- 推荐：图文卡片 5-10 张（`1080x1920`）
- 强自定义卡片：优先 `--poster-json`
- 如需人工微调：可同时导出 `--poster-template-out` 和 `--actions-template-out`
- 覆盖已有文章且不想丢失手工调整：使用 `--keep-existing-poster` / `--keep-existing-actions`

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

## 2) 数据结构检查（严格）

- 必须生成：`src/content/articles/<slug>.json`
- 至少包含：`id/slug/title/desc/date/category/channel/tags/read/preset/summary/content`
- `content` 必须是 Markdown
- `sources` 应为结构化数组，不要把来源单独写在站点外层 JSX

## 3) poster 检查（严格）

- 必须使用 `poster.cards`
- 自动脚手架应先抽结论、再做标题重写与布局匹配，不能只把正文切成平铺卡片
- 至少检查：
  - 是否有“先看结论”卡
  - 表格类内容是否转成 `layers` / `metrics`
  - 时间事件是否转成 `hot-timeline`
  - 清单/建议/判断是否转成 `checklist`
  - 标题和副标题是否可直接用于转发，不要保留生硬章节名

## 4) 正文规则检查

- 正文不要自动编号标题
- 正文不要使用 `<hr />`
- 正文不要出现玻璃卡、图标装饰卡、阴影卡
- 段落优先短句与列表，移动端优先

## 5) 发布后验证

- `npm run build` 必须通过
- `/articles` 可见新文章
- `/posts/<slug>` 可访问
- 卡片资源路径可打开
- 来源在正文末尾自动显示
- 卡片区与正文区都能正常渲染
- 卡片标题/副标题适合截图转发，不像目录
- 至少有封面卡、结论卡、收束卡，卡片顺序不是机械切段
