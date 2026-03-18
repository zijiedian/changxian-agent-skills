# MiniMax 风格图文卡片提炼

## 参考样本

优先参考这些现成文章：

- `changxian-web/src/content/articles/minimax-2026.json`
- `changxian-web/src/content/articles/gemini-3-1-pro.json`
- `changxian-web/src/content/articles/claw-ecosystem-report-2026.json`

这三篇的共性足够稳定，适合作为信息型图文卡片模板。

## 稳定共性

- 都是信息压缩型卡片，不是情绪海报型卡片
- 底层是同一套 declarative poster shell：横向滑动卡组、竖版信息卡、编号 badge、底部品牌 footer
- 都有明确封面卡、信息矩阵卡、数据卡、节奏卡、结论卡、CTA 卡
- 标题短、meta 清楚、副标题短，不拖泥带水
- 重点用 `layers`、`metrics`、`timeline`、`points` 这几种结构反复出现
- 变化主要发生在 `layout` 选择，不在整体卡片语言

## 推荐卡片顺序

1. 封面卡：主题 + 副标题 + 3 条核心 bullets + 3-4 个 stats
2. 身份卡：公司/模型/对象是谁
3. 矩阵卡：产品、模型、版图、能力分层
4. 指标卡：关键 benchmark、规模、效率、时间点
5. 解读卡：为什么重要、为什么值得关注
6. 补充卡：生态、场景、对比、节奏
7. 结论卡：一句话看懂 / 3 条判断
8. CTA 卡：品牌收束

## 文案规则

- `meta`：4-8 个字，说明卡片视角，如“模型谱系”“关键结论”
- `title`：尽量短，优先名词化、判断化，不要整句口号
- `subtitle`：只补一个维度，不再复述标题
- `stats`：适合放 3-4 个数字或规格
- `layers`：适合放矩阵、分层、版图、产品线
- `points`：适合放结论、建议、判断，不超过 3-5 条

## 布局映射

- 公司介绍 / 模型矩阵 / 能力版图：`layers`
- 评测 / 关键数字 / 规模参数：`metrics`
- 发布时间 / 版本演进 / 节奏：`timeline` 或 `hot-timeline`
- 判断 / 结论 / 建议：默认 `points` 或 `checklist`
- 第一张卡：`cover-home`
- 最后一张卡：`cta`

## 视觉与信息密度

- 每张卡只讲一个主题
- 标题、副标题、数据、要点不要同时过满
- 关键数据卡可用 `dark: true`，但只用于最重要的 benchmark/指标卡
- 不要照搬样本中的品牌词或装饰词；提炼结构，不复制内容

## 交付标准

- 读者只看卡片，不看正文，也能抓到全文主线
- 任意一张卡单独截图，也能讲清一个信息点
- 全套卡片应像“压缩后的文章”，不是“截图版目录”
