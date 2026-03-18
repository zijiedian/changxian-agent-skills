#!/usr/bin/env python3
"""JSON-first publisher for changxian-web.

Current changxian-web article architecture:
1) Article detail page is unified via src/pages/posts/ArticlePostPage.jsx
2) Article data is discovered from src/content/articles/*.json
3) Markdown content is converted at runtime
4) Poster cards are configured declaratively via article.poster.cards

Workflow:
1) (Optional) copy card images into public/assets/posts/<slug>/
2) generate/update src/content/articles/<slug>.json
3) (Optional) append Generator preset entry
4) optionally export poster/actions templates for manual refinement
5) no route registration required for current changxian-web
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path
from typing import Any

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}
DEFAULT_BRAND_NAME = "尝鲜AI"
DEFAULT_BRAND_SUBTITLE = "科技日报"
DEFAULT_FOLLOW_TERM = "关注公众号：尝鲜AI"
DEFAULT_CARD_FOOTER = "尝鲜AI · 科技日报"
DEFAULT_LOGO_URL = "/logo.png"
SECURITY_BRAND_NAME = "甜甜圈攻防"
SECURITY_BRAND_SUBTITLE = "安全研究"
SECURITY_FOLLOW_TERM = "关注公众号：甜甜圈攻防"
SECURITY_CARD_FOOTER = "甜甜圈攻防 · 安全研究"
SECURITY_LOGO_URL = "/甜甜圈-logo.png"
SECURITY_BRAND_KEYWORDS = ("安全", "攻防", "cyber", "security", "att&ck", "mitre", "soc", "threat", "c2", "zero trust")
CARD_LAYOUT_CHOICES = {"auto", "image", "compare", "timeline", "concept", "metrics", "layers", "checklist"}
COMPARE_KEYWORDS = ("对比", "比较", "vs", "差异", "选型")
TIMELINE_KEYWORDS = ("时间线", "历程", "演进", "发布", "版本", "路线图", "阶段", "里程碑")
CONCEPT_KEYWORDS = ("术语", "概念", "入门", "小白", "科普", "指南", "定义")
METRICS_KEYWORDS = ("行业", "市场", "报告", "趋势", "数据", "指标", "统计", "规模", "份额")
LAYERS_KEYWORDS = ("公司", "厂商", "平台", "版图", "格局", "地图", "分类", "赛道", "方向", "清单")
CHECKLIST_KEYWORDS = ("结论", "判断", "建议", "怎么做", "步骤", "方法", "清单", "跟踪", "收束")
DATE_PREFIX_RE = re.compile(r"^(?P<date>(?:19|20)\d{2}(?:[-/.年]\d{1,2})?(?:[-/.月]\d{1,2})?(?:日)?)\s*[：:·\-–—~～]?")
VALUE_PAIR_RE = re.compile(r"^(?P<label>[^:：]{1,24})[：:](?P<value>.+)$")
TABLE_SEPARATOR_RE = re.compile(r"^\s*:?-{3,}:?\s*$")

HOOK_RULES = [
    {
        "patterns": ("市场地图", "市值", "最值得盯", "榜单"),
        "meta": "市场格局",
        "title": "谁最值钱，谁最像平台",
        "subtitle": "资本市场最买单的，不是单点工具，而是安全总平台",
        "layout": "layers",
    },
    {
        "patterns": ("卖什么", "业务", "产品版图", "分类"),
        "meta": "业务版图",
        "title": "这些公司到底在卖什么",
        "subtitle": "看懂预算往哪流，先看它们到底在卖什么能力",
        "layout": "layers",
    },
    {
        "patterns": ("平台型", "巨头", "第一梯队"),
        "meta": "平台逻辑",
        "title": "为什么平台型巨头估值最高",
        "subtitle": "企业现在买的不是单一产品，而是未来三年的安全总平台",
        "layout": "layers",
    },
    {
        "patterns": ("zero trust", "sase", "sse"),
        "meta": "访问边界",
        "title": "边界没有消失，只是被重写了",
        "subtitle": "访问控制、边缘安全和流量治理，仍是企业预算核心入口",
        "layout": "layers",
    },
    {
        "patterns": ("身份安全", "iam", "pam", "身份"),
        "meta": "身份赛道",
        "title": "身份安全已经从配角变主角",
        "subtitle": "人类、机器与 AI 身份正在汇合，身份能力正在变成平台核心",
        "layout": "layers",
    },
    {
        "patterns": ("ai 驱动 soc", "xdr", "siem", "soc"),
        "meta": "AI SOC",
        "title": "SOC 正从规则中心走向 AI 中心",
        "subtitle": "下一代安全运营卖点已经变成告警归并、AI 调查和自动化响应",
        "layout": "layers",
    },
    {
        "patterns": ("云安全", "cnapp", "cdr", "runtime", "appsec"),
        "meta": "云安全",
        "title": "云安全已经不再是工具拼盘",
        "subtitle": "最热的方向，是把代码、运行时和云调查响应收进同一平台",
        "layout": "layers",
    },
    {
        "patterns": ("最火爆的方向", "最热方向", "热点方向", "热点赛道"),
        "meta": "热点赛道",
        "title": "未来两三年，预算会往哪流",
        "subtitle": "最热的不只是 AI 安全，而是平台化安全能力重组",
        "layout": "layers",
    },
    {
        "patterns": ("最新成果", "值得关注的最新成果", "最新动作"),
        "meta": "最新动作",
        "title": "2025-2026 最值得盯的动作",
        "subtitle": "真正重要的不是新闻本身，而是这些动作背后的产业方向",
        "layout": "timeline",
    },
    {
        "patterns": ("资本市场",),
        "meta": "跟踪名单",
        "title": "看股票，先盯这几家",
        "subtitle": "平台化能力最强的公司，最容易吃到估值溢价",
        "layout": "layers",
    },
    {
        "patterns": ("企业采购", "采购"),
        "meta": "采购视角",
        "title": "按预算主题来挑厂商",
        "subtitle": "不同预算口径，对应的是完全不同的公司名单",
        "layout": "layers",
    },
    {
        "patterns": ("增量预算", "未来两三年"),
        "meta": "增量预算",
        "title": "未来三年最值得盯的 5 条线",
        "subtitle": "AI、身份、云原生平台化会持续成为增量预算主线",
        "layout": "checklist",
    },
    {
        "patterns": ("结论", "收束", "最后"),
        "meta": "一句话结论",
        "title": "最后一句话收住全篇",
        "subtitle": "最值钱的不是单点功能，而是能成为安全底座的平台",
        "layout": "checklist",
    },
]


def normalize_tags(raw: str) -> list[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


def normalize_summary_items(raw: str, *, desc: str, tags: list[str]) -> list[str]:
    if raw.strip():
        items = [item.strip() for item in raw.split("|") if item.strip()]
        if len(items) == 1 and "," in raw:
            items = [item.strip() for item in raw.split(",") if item.strip()]
    else:
        items = [desc.strip()] if desc.strip() else []
        if len(tags) >= 2:
            items.append(f"关键词：{' / '.join(tags[:4])}")

    deduped: list[str] = []
    seen: set[str] = set()
    for item in items:
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped[:6]


def normalize_focus_terms(raw: str, tags: list[str]) -> list[str]:
    if raw.strip():
        items = [item.strip() for item in raw.split(",") if item.strip()]
    else:
        items = [item.strip() for item in tags if item.strip()]

    deduped: list[str] = []
    seen: set[str] = set()
    for item in items:
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)

    if not deduped:
        deduped = ["核心问题", "关键路径", "落地建议"]

    return deduped[:8]


def is_security_topic(*, title: str, desc: str, category: str, channel: str, tags: list[str]) -> bool:
    text = " ".join([title, desc, category, channel, *tags]).lower()
    return any(keyword in text for keyword in SECURITY_BRAND_KEYWORDS)


def resolve_branding_defaults(
    *,
    title: str,
    desc: str,
    category: str,
    channel: str,
    tags: list[str],
    brand_name: str,
    brand_subtitle: str,
    follow_term: str,
    card_footer: str,
    logo_url: str,
) -> dict[str, str]:
    security_mode = is_security_topic(title=title, desc=desc, category=category, channel=channel, tags=tags)

    resolved_brand_name = brand_name.strip() or DEFAULT_BRAND_NAME
    resolved_brand_subtitle = brand_subtitle.strip() or DEFAULT_BRAND_SUBTITLE
    resolved_follow_term = follow_term.strip() or DEFAULT_FOLLOW_TERM
    resolved_card_footer = card_footer.strip() or DEFAULT_CARD_FOOTER
    resolved_logo_url = logo_url.strip() or DEFAULT_LOGO_URL

    if security_mode:
        if resolved_brand_name == DEFAULT_BRAND_NAME:
            resolved_brand_name = SECURITY_BRAND_NAME
        if resolved_brand_subtitle == DEFAULT_BRAND_SUBTITLE:
            resolved_brand_subtitle = SECURITY_BRAND_SUBTITLE
        if resolved_follow_term == DEFAULT_FOLLOW_TERM:
            resolved_follow_term = SECURITY_FOLLOW_TERM
        if resolved_card_footer == DEFAULT_CARD_FOOTER:
            resolved_card_footer = SECURITY_CARD_FOOTER
        if resolved_logo_url == DEFAULT_LOGO_URL:
            resolved_logo_url = SECURITY_LOGO_URL

    return {
        "brand_name": resolved_brand_name,
        "brand_subtitle": resolved_brand_subtitle,
        "follow_term": resolved_follow_term,
        "card_footer": resolved_card_footer,
        "logo_url": resolved_logo_url,
    }


def trim_text(text: str, max_len: int) -> str:
    value = strip_inline_markdown(text)
    if len(value) <= max_len:
        return value
    return value[: max_len - 1].rstrip("，。、；：: ") + "…"


def cleanup_heading_title(title: str) -> str:
    value = strip_inline_markdown(title)
    value = re.sub(r"^第[一二三四五六七八九十百千万0-9]+[，、.:： ]*", "", value)
    value = re.sub(r"^\d+[.)、]\s*", "", value)
    value = re.sub(r"^如果你", "", value)
    return value.strip("：: ")


def infer_card_layout(title: str, desc: str, tags: list[str]) -> str:
    text = f"{title} {desc} {' '.join(tags)}".lower()
    if any(keyword in text for keyword in COMPARE_KEYWORDS):
        return "compare"
    if any(keyword in text for keyword in TIMELINE_KEYWORDS):
        return "timeline"
    if any(keyword in text for keyword in CHECKLIST_KEYWORDS):
        return "checklist"
    if any(keyword in text for keyword in LAYERS_KEYWORDS):
        return "layers"
    if any(keyword in text for keyword in CONCEPT_KEYWORDS):
        return "concept"
    if any(keyword in text for keyword in METRICS_KEYWORDS):
        return "metrics"
    return "image"


def resolve_card_layout(raw_layout: str, *, title: str, desc: str, tags: list[str]) -> str:
    layout = (raw_layout or "auto").strip().lower()
    if layout not in CARD_LAYOUT_CHOICES:
        allowed = ", ".join(sorted(CARD_LAYOUT_CHOICES))
        raise SystemExit(f"unsupported --card-layout: {raw_layout}. allowed: {allowed}")
    return infer_card_layout(title, desc, tags) if layout == "auto" else layout


def list_card_files(source: Path) -> list[Path]:
    return sorted(
        [path for path in source.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_EXTS],
        key=lambda p: p.name,
    )


def ensure_cards(*, workspace: Path, slug: str, cards_source: Path | None, dry_run: bool) -> list[str]:
    target = workspace / "public" / "assets" / "posts" / slug
    if cards_source:
        if not cards_source.exists() or not cards_source.is_dir():
            raise SystemExit(f"cards source does not exist or is not a directory: {cards_source}")
        source_files = list_card_files(cards_source)
        if not source_files:
            raise SystemExit(f"no image files found in cards source: {cards_source}")
        if not dry_run:
            target.mkdir(parents=True, exist_ok=True)
            for item in source_files:
                shutil.copy2(item, target / item.name)
        return [f"/assets/posts/{slug}/{item.name}" for item in source_files]

    if target.exists() and target.is_dir():
        existing = list_card_files(target)
        if existing:
            return [f"/assets/posts/{slug}/{item.name}" for item in existing]

    return []


def parse_sources_file(path: Path) -> list[dict[str, str]]:
    if not path.exists() or not path.is_file():
        raise SystemExit(f"sources file does not exist: {path}")

    items: list[dict[str, str]] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("- "):
            line = line[2:].strip()

        markdown_match = re.match(r"\[([^\]]+)\]\((https?://[^)]+)\)", line)
        if markdown_match:
            items.append({"title": markdown_match.group(1).strip(), "url": markdown_match.group(2).strip()})
            continue

        angle_match = re.match(r"(.+?):\s*<((?:https?://)[^>]+)>$", line)
        if angle_match:
            items.append({"title": angle_match.group(1).strip(), "url": angle_match.group(2).strip()})
            continue

        pipe_match = re.match(r"(.+?)\s*\|\s*(https?://\S+)$", line)
        if pipe_match:
            items.append({"title": pipe_match.group(1).strip(), "url": pipe_match.group(2).strip()})
            continue

        comma_match = re.match(r"(.+?)\s*,\s*(https?://\S+)$", line)
        if comma_match:
            items.append({"title": comma_match.group(1).strip(), "url": comma_match.group(2).strip()})
            continue

        if re.match(r"^https?://\S+$", line):
            items.append({"title": line, "url": line})
            continue

        items.append({"title": line})

    return items


def parse_actions_json(path: Path | None) -> list[dict[str, Any]]:
    if path is None:
        return []
    if not path.exists() or not path.is_file():
        raise SystemExit(f"actions json does not exist: {path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise SystemExit(f"invalid actions json: {path}: {error}") from error
    if not isinstance(payload, list):
        raise SystemExit("actions json must be a list of action objects")
    return payload


def load_content(path: Path | None, *, title: str, desc: str, tags: list[str]) -> str:
    if path:
        if not path.exists() or not path.is_file():
            raise SystemExit(f"content file does not exist: {path}")
        content = path.read_text(encoding="utf-8").strip()
        if not content:
            raise SystemExit(f"content file is empty: {path}")
        return content

    tag_line = " / ".join(tags[:4]) if tags else "请补充文章关键词"
    return (
        f"## 导读\n\n{desc}\n\n"
        "## 核心观点\n\n"
        "- 请补充观点 1\n"
        "- 请补充观点 2\n"
        "- 请补充观点 3\n\n"
        "## 关键展开\n\n"
        f"- 关键词：{tag_line}\n"
        "- 请补充背景\n"
        "- 请补充结论\n"
    )


def strip_inline_markdown(text: str) -> str:
    value = text.strip()
    if not value:
        return ""
    value = re.sub(r"^#{1,6}\s+", "", value)
    value = re.sub(r"^[-*+]\s+", "", value)
    value = re.sub(r"^\d+[.)、]\s+", "", value)
    value = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", value)
    value = re.sub(r"`([^`]+)`", r"\1", value)
    value = re.sub(r"\*\*([^*]+)\*\*", r"\1", value)
    value = re.sub(r"\*([^*]+)\*", r"\1", value)
    value = re.sub(r"<[^>]+>", "", value)
    return re.sub(r"\s+", " ", value).strip()


def split_markdown_blocks(lines: list[str]) -> list[str]:
    blocks: list[str] = []
    current: list[str] = []
    for line in lines:
        if not line.strip():
            if current:
                blocks.append(" ".join(current).strip())
                current = []
            continue
        current.append(strip_inline_markdown(line))
    if current:
        blocks.append(" ".join(current).strip())
    return [block for block in blocks if block]


def extract_markdown_sections(content: str) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    for raw_line in content.splitlines():
        heading_match = re.match(r"^(#{2,3})\s+(.+)$", raw_line.strip())
        if heading_match:
            if current and (current["title"] or current["lines"]):
                sections.append(current)
            current = {"title": strip_inline_markdown(heading_match.group(2)), "lines": []}
            continue

        if current is None:
            current = {"title": "导读", "lines": []}
        current["lines"].append(raw_line.rstrip())

    if current and (current["title"] or current["lines"]):
        sections.append(current)

    normalized: list[dict[str, Any]] = []
    for section in sections:
        blocks = split_markdown_blocks(section["lines"])
        bullets = []
        for line in section["lines"]:
            stripped = line.strip()
            if re.match(r"^[-*+]\s+", stripped) or re.match(r"^\d+[.)、]\s+", stripped):
                bullets.append(strip_inline_markdown(stripped))
        normalized.append(
            {
                "title": section["title"] or "未命名章节",
                "blocks": blocks,
                "bullets": bullets,
                "raw_lines": [line for line in section["lines"] if line.strip()],
            }
        )
    return normalized


def parse_value_pairs(lines: list[str]) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for raw_line in lines:
        line = strip_inline_markdown(raw_line)
        match = VALUE_PAIR_RE.match(line)
        if match:
            pairs.append((match.group("label").strip(), match.group("value").strip()))
    return pairs


def parse_markdown_tables(lines: list[str]) -> list[dict[str, Any]]:
    grouped: list[list[str]] = []
    current: list[str] = []

    for raw_line in lines:
        line = raw_line.strip()
        if line.startswith("|") and line.endswith("|"):
            current.append(line)
            continue

        if len(current) >= 2:
            grouped.append(current)
        current = []

    if len(current) >= 2:
        grouped.append(current)

    tables: list[dict[str, Any]] = []
    for raw_table in grouped:
        rows = [[strip_inline_markdown(cell).strip() for cell in row.strip().strip("|").split("|")] for row in raw_table]
        if len(rows) < 3:
            continue

        header = rows[0]
        separator = rows[1]
        if len(separator) != len(header):
            continue
        if not all(TABLE_SEPARATOR_RE.match(cell.replace(" ", "")) for cell in separator):
            continue

        data_rows = []
        for row in rows[2:]:
            normalized = row + [""] * max(0, len(header) - len(row))
            normalized = normalized[: len(header)]
            data_rows.append({header[index]: normalized[index].strip() for index in range(len(header))})

        if data_rows:
            tables.append({"headers": header, "rows": data_rows})

    return tables


def build_stats_from_pairs(pairs: list[tuple[str, str]]) -> list[dict[str, str]]:
    stats: list[dict[str, str]] = []
    for label, value in pairs[:4]:
        stats.append({"label": label[:20], "value": value[:28], "hint": ""})
    return stats


def build_stats_from_table(table: dict[str, Any]) -> list[dict[str, str]]:
    headers = table.get("headers", [])
    rows = table.get("rows", [])
    if len(headers) < 2 or not rows:
        return []

    primary = headers[0]
    secondary = headers[1]
    extras = headers[2:4]
    stats: list[dict[str, str]] = []

    for row in rows[:4]:
        hint = " · ".join(trim_text(row.get(key, ""), 18) for key in extras if row.get(key, ""))
        stats.append(
            {
                "label": trim_text(row.get(primary, primary), 20),
                "value": trim_text(row.get(secondary, ""), 24),
                "hint": trim_text(hint, 28),
            }
        )
    return stats


def build_layers_from_table(table: dict[str, Any]) -> list[dict[str, str]]:
    headers = table.get("headers", [])
    rows = table.get("rows", [])
    if not headers or not rows:
        return []

    primary = headers[0]
    value_key = headers[1] if len(headers) > 1 else ""
    desc_keys = headers[2:] if len(headers) > 2 else []
    layers: list[dict[str, str]] = []

    for row in rows[:5]:
        desc_parts = [trim_text(row.get(key, ""), 30) for key in desc_keys if row.get(key, "")]
        if not desc_parts and value_key:
            desc_parts.append(trim_text(row.get(value_key, ""), 42))
        layers.append(
            {
                "title": trim_text(row.get(primary, primary), 22),
                "value": trim_text(row.get(value_key, ""), 16) if value_key else "",
                "desc": trim_text(" · ".join(part for part in desc_parts if part), 80),
            }
        )

    return layers


def build_layers_from_pairs(pairs: list[tuple[str, str]]) -> list[dict[str, str]]:
    return [
        {
            "title": trim_text(label, 24),
            "value": "",
            "desc": trim_text(value, 80),
        }
        for label, value in pairs[:5]
    ]


def build_layers_from_points(points: list[str]) -> list[dict[str, str]]:
    layers: list[dict[str, str]] = []
    for index, item in enumerate(points[:5], start=1):
        if "：" in item:
            title, desc = [part.strip() for part in item.split("：", 1)]
        elif ":" in item:
            title, desc = [part.strip() for part in item.split(":", 1)]
        else:
            title, desc = f"要点 {index}", item
        layers.append(
            {
                "title": trim_text(title, 24),
                "value": "",
                "desc": trim_text(desc, 80),
            }
        )
    return layers


def build_hot_items_from_pairs(pairs: list[tuple[str, str]]) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for label, value in pairs[:5]:
        date_match = DATE_PREFIX_RE.match(label)
        if not date_match:
            continue
        date_text = date_match.group("date")
        event = label[date_match.end():].strip(" ：:-–—~～") or value
        impact = "" if event == value else value
        items.append({"date": date_text, "event": event, "impact": impact})
    return items


def build_hot_items_from_bullets(bullets: list[str]) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for bullet in bullets[:5]:
        line = strip_inline_markdown(bullet)
        match = DATE_PREFIX_RE.match(line)
        if not match:
            continue
        date_text = match.group("date")
        rest = line[match.end():].strip(" ：:-–—~～")
        if not rest:
            continue
        if "：" in rest:
            event, impact = [part.strip() for part in rest.split("：", 1)]
        elif ":" in rest:
            event, impact = [part.strip() for part in rest.split(":", 1)]
        else:
            event, impact = rest, ""
        items.append({"date": date_text, "event": event, "impact": impact})
    return items


def build_hot_items_from_section_titles(sections: list[dict[str, Any]]) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for section in sections:
        title = strip_inline_markdown(section["title"])
        match = DATE_PREFIX_RE.match(title)
        if not match:
            continue
        date_text = match.group("date")
        event = title[match.end():].strip(" ：:-–—~～")
        points = build_section_points(section)
        impact = points[0] if points else (section["blocks"][0] if section["blocks"] else "")
        items.append(
            {
                "date": date_text,
                "event": trim_text(event or title, 32),
                "impact": trim_text(impact, 64),
            }
        )
    return items


def build_section_points(section: dict[str, Any]) -> list[str]:
    return section["bullets"][:5] or section["blocks"][:5]


def match_hook_rule(section: dict[str, Any]) -> dict[str, str] | None:
    text = " ".join([section["title"], *section["blocks"], *section["bullets"]]).lower()
    for rule in HOOK_RULES:
        if any(pattern.lower() in text for pattern in rule["patterns"]):
            return rule
    return None


def section_score(section: dict[str, Any], *, index: int) -> int:
    points = build_section_points(section)
    tables = parse_markdown_tables(section["raw_lines"])
    hot_items = build_hot_items_from_pairs(parse_value_pairs(section["raw_lines"])) or build_hot_items_from_bullets(points)
    text = " ".join([section["title"], *section["blocks"], *section["bullets"]]).lower()
    rule = match_hook_rule(section)

    score = len(points) * 3 + len(section["blocks"]) * 2
    if tables:
        score += 8
    if hot_items:
        score += 6
    if rule:
        score += 4
    if any(keyword in text for keyword in LAYERS_KEYWORDS):
        score += 3
    if any(keyword in text for keyword in CHECKLIST_KEYWORDS):
        score += 3
    if any(keyword in text for keyword in TIMELINE_KEYWORDS):
        score += 3
    if "导读" in section["title"]:
        score -= 4
    if index > 0:
        score += min(index, 2)
    return score


def select_sections_for_cards(sections: list[dict[str, Any]], *, max_sections: int) -> list[dict[str, Any]]:
    materialized = [section for section in sections if section["blocks"] or section["bullets"]]
    if len(materialized) <= max_sections:
        return materialized

    ranked = sorted(
        enumerate(materialized),
        key=lambda item: (-section_score(item[1], index=item[0]), item[0]),
    )[:max_sections]
    selected_indexes = sorted(index for index, _ in ranked)
    return [materialized[index] for index in selected_indexes]


def section_layout_hint(section: dict[str, Any], default_layout: str, *, explicit_default: bool) -> str:
    text = " ".join([section["title"], *section["blocks"], *section["bullets"]]).lower()
    tables = parse_markdown_tables(section["raw_lines"])

    if tables:
        if any(keyword in text for keyword in LAYERS_KEYWORDS) or len(tables[0]["rows"]) > 4:
            return "layers"
        return "metrics"
    if any(keyword in text for keyword in COMPARE_KEYWORDS):
        return "compare"
    if any(keyword in text for keyword in TIMELINE_KEYWORDS) or any(DATE_PREFIX_RE.match(strip_inline_markdown(line)) for line in section["raw_lines"]):
        return "timeline"
    if any(keyword in text for keyword in CHECKLIST_KEYWORDS):
        return "checklist"
    if any(keyword in text for keyword in LAYERS_KEYWORDS):
        return "layers"
    if any(keyword in text for keyword in METRICS_KEYWORDS):
        return "metrics"
    if any(keyword in text for keyword in CONCEPT_KEYWORDS):
        return "concept"
    return default_layout if explicit_default else "default"


def build_card_from_section(
    *,
    section: dict[str, Any],
    index: int,
    default_layout: str,
    focus_terms: list[str],
    explicit_default: bool,
) -> dict[str, Any]:
    rule = match_hook_rule(section)
    layout = rule["layout"] if rule else section_layout_hint(section, default_layout, explicit_default=explicit_default)
    points = build_section_points(section)
    summary_text = section["blocks"][0] if section["blocks"] else (points[0] if points else "请补充该卡片内容")
    fallback_index = index - 3
    raw_title = cleanup_heading_title(section["title"]) or (focus_terms[fallback_index] if 0 <= fallback_index < len(focus_terms) else f"核心卡片 {index:02d}")
    title = rule["title"] if rule else trim_text(raw_title, 24)
    subtitle = rule["subtitle"] if rule else trim_text(summary_text, 42)
    meta = rule["meta"] if rule else trim_text(section["title"] or f"CARD {index:02d}", 12)
    tables = parse_markdown_tables(section["raw_lines"])
    pairs = parse_value_pairs(section["raw_lines"])
    card: dict[str, Any] = {
        "id": f"{index:02d}",
        "meta": meta,
        "title": title,
        "subtitle": subtitle,
    }

    if layout == "compare":
        left = pairs[0] if len(pairs) > 0 else (points[0], "") if len(points) > 0 else ("方案 A", "请补充方案 A")
        right = pairs[1] if len(pairs) > 1 else (points[1], "") if len(points) > 1 else ("方案 B", "请补充方案 B")
        card.update(
            {
                "layout": "compare",
                "leftTitle": left[0],
                "leftDesc": left[1] or "请补充方案 A 的特点",
                "rightTitle": right[0],
                "rightDesc": right[1] or "请补充方案 B 的特点",
            }
        )
        return card

    if layout == "timeline":
        hot_items = build_hot_items_from_pairs(pairs) or build_hot_items_from_bullets(points)
        if hot_items:
            card.update({"layout": "hot-timeline", "hotItems": hot_items[:5]})
        else:
            card.update({"layout": "timeline", "points": points[:5]})
        return card

    if layout == "checklist":
        card.update({"layout": "checklist", "steps": (points[:5] if points else [summary_text])[:5]})
        return card

    if layout == "layers":
        layers = build_layers_from_table(tables[0]) if tables else []
        if not layers and pairs:
            layers = build_layers_from_pairs(pairs)
        if not layers:
            layers = build_layers_from_points(points or [summary_text])
        card.update({"layout": "layers", "layers": layers[:5]})
        return card

    if layout == "metrics":
        stats = build_stats_from_table(tables[0]) if tables else build_stats_from_pairs(pairs)
        if stats:
            card.update({"layout": "metrics", "stats": stats[:4]})
            return card

    if layout == "concept":
        concepts = []
        seed_items = points[:6] if points else focus_terms[:6]
        for item in seed_items[:6]:
            if "：" in item:
                term, desc = [part.strip() for part in item.split("：", 1)]
            elif ":" in item:
                term, desc = [part.strip() for part in item.split(":", 1)]
            else:
                term, desc = item, "请补充说明"
            concepts.append({"term": term, "desc": desc})
        card.update({"layout": "concept-grid", "concepts": concepts[:6]})
        if len(section["blocks"]) > 1:
            card["note"] = section["blocks"][1][:120]
        return card

    card.update({"points": points[:5]})
    return card


def build_cover_stats(sections: list[dict[str, Any]]) -> list[dict[str, str]]:
    for section in sections:
        tables = parse_markdown_tables(section["raw_lines"])
        if tables:
            stats = build_stats_from_table(tables[0])
            if stats:
                return stats[:4]
        pairs = parse_value_pairs(section["raw_lines"])
        if pairs:
            stats = build_stats_from_pairs(pairs)
            if stats:
                return stats[:4]
    return []


def build_default_poster(
    *,
    slug: str,
    title: str,
    desc: str,
    summary_items: list[str],
    content: str,
    focus_terms: list[str],
    card_paths: list[str],
    card_layout: str,
    card_layout_explicit: bool,
    brand_name: str,
    brand_subtitle: str,
    follow_term: str,
    logo_url: str,
    poster_badge: str,
    card_footer: str,
    cover_decoration_text: str,
    show_card_no: bool,
) -> dict[str, Any]:
    cards: list[dict[str, Any]] = []
    summary_points = summary_items[:3] if summary_items else [desc]
    sections = extract_markdown_sections(content)
    timeline_items = build_hot_items_from_section_titles(sections)
    selected_pool = [section for section in sections if not DATE_PREFIX_RE.match(strip_inline_markdown(section["title"]))]
    selected_sections = select_sections_for_cards(selected_pool, max_sections=5 if len(timeline_items) >= 3 else 6)
    cover_stats = build_cover_stats(selected_sections or sections)

    cover_card: dict[str, Any] = {
        "id": "01",
        "type": "cover",
        "meta": "图文速览",
        "title": title,
        "subtitle": trim_text(desc, 48),
    }
    if cover_stats:
        cover_card.update({"layout": "cover-home", "stats": cover_stats[:4], "bullets": summary_points})
    else:
        cover_card["points"] = summary_points
    cards.append(cover_card)

    cards.append(
        {
            "id": "02",
            "meta": "先看结论",
            "title": "这篇文章最值得记住的几件事",
            "subtitle": "先把结论看懂，再决定要不要深读全文",
            "layout": "checklist",
            "steps": (summary_items[:5] if summary_items else [desc])[:5],
        }
    )

    if len(timeline_items) >= 3:
        cards.append(
            {
                "id": "03",
                "meta": "最新动作",
                "title": "近期最值得盯的 5 个动作",
                "subtitle": "真正重要的不是新闻本身，而是这些动作背后的方向",
                "layout": "hot-timeline",
                "hotItems": timeline_items[:5],
            }
        )

    if selected_sections:
        start_index = len(cards) + 1
        for index, section in enumerate(selected_sections[:6], start=start_index):
            cards.append(
                build_card_from_section(
                    section=section,
                    index=index,
                    default_layout=card_layout,
                    focus_terms=focus_terms,
                    explicit_default=card_layout_explicit,
                )
            )
    elif card_paths:
        start_index = len(cards) + 1
        for index, path in enumerate(card_paths[:5], start=start_index):
            cards.append(
                {
                    "id": f"{index:02d}",
                    "meta": "重点图片",
                    "title": focus_terms[index - 3] if index - 3 < len(focus_terms) else f"核心卡片 {index:02d}",
                    "subtitle": "请按这张卡片的重点补充说明",
                    "image": path,
                }
            )
    else:
        start_index = len(cards) + 1
        for index, item in enumerate(summary_items[:4], start=start_index):
            cards.append(
                {
                    "id": f"{index:02d}",
                    "meta": "关键结论",
                    "title": focus_terms[index - 3] if index - 3 < len(focus_terms) else f"核心结论 {index - 2}",
                    "subtitle": trim_text(item, 42),
                    "points": summary_items[:4],
                }
            )

    if card_paths and selected_sections:
        used_ids = {card["id"] for card in cards}
        next_index = len(cards) + 1
        for path in card_paths[: min(len(card_paths), 3)]:
            card_id = f"{next_index:02d}"
            if card_id in used_ids:
                next_index += 1
                card_id = f"{next_index:02d}"
            cards.append(
                {
                    "id": card_id,
                    "meta": "图片重点",
                    "title": focus_terms[(next_index - 2) % len(focus_terms)] if focus_terms else f"图片卡 {next_index:02d}",
                    "subtitle": "可替换为对应图片说明",
                    "image": path,
                }
            )
            next_index += 1
            if len(cards) >= 8:
                break

    cards = cards[:10]
    cards.append({"id": "99", "meta": "关注我们", "title": brand_name, "subtitle": "", "kind": "cta"})

    return {
        "title": title,
        "description": desc,
        "coverBadgeText": poster_badge,
        "filePrefix": slug,
        "footerText": card_footer,
        "coverDecorationText": cover_decoration_text,
        "brandName": brand_name,
        "brandSubtitle": brand_subtitle,
        "followTerm": follow_term,
        "logoUrl": logo_url,
        "showCardNo": show_card_no,
        "cards": cards,
    }


def load_poster_json(path: Path) -> dict[str, Any]:
    if not path.exists() or not path.is_file():
        raise SystemExit(f"poster json does not exist: {path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise SystemExit(f"invalid poster json: {path}: {error}") from error
    if not isinstance(payload, dict):
        raise SystemExit("poster json must be a single JSON object")
    return payload


def detect_json_article_mode(workspace: Path) -> bool:
    return (
        (workspace / "src" / "content" / "articles").exists()
        and (workspace / "src" / "pages" / "posts" / "ArticlePostPage.jsx").exists()
        and (workspace / "src" / "data" / "articles" / "index.js").exists()
    )


def build_preset_text(*, title: str, desc: str, content: str, tags: list[str]) -> str:
    lines = [title, "", desc]
    trimmed_content = content.strip()
    if trimmed_content:
        content_lines = [line.strip() for line in trimmed_content.splitlines() if line.strip()]
        snippet = []
        total = 0
        for line in content_lines:
            cleaned = strip_inline_markdown(line)
            total += len(cleaned)
            if total > 900:
                break
            snippet.append(cleaned)
        if snippet:
            lines.extend(["", *snippet])
    if tags:
        lines.extend(["", "核心要点：", *[f"- {tag}" for tag in tags[:6]]])
    return "\n".join(lines).strip()


def upsert_generator_preset(*, workspace: Path, preset: str, preset_text: str, dry_run: bool) -> bool:
    generator_path = workspace / "src" / "pages" / "Generator.jsx"
    if not generator_path.exists():
        return False

    content = generator_path.read_text(encoding="utf-8")
    marker = "const PRESET_ARTICLES = {"
    if marker not in content:
        return False

    key_literal = f"  '{preset}':"
    if key_literal in content:
        return False

    escaped = preset_text.replace("\\", "\\\\").replace("`", "\\`")
    block = f"  '{preset}': `{escaped}`,\n"
    insert_at = content.find(marker) + len(marker)
    content = content[:insert_at] + "\n" + block + content[insert_at:]
    if not dry_run:
        generator_path.write_text(content, encoding="utf-8")
    return True


def build_article_record(
    *,
    slug: str,
    post_id: str,
    title: str,
    desc: str,
    date: str,
    category: str,
    channel: str,
    tags: list[str],
    read: str,
    preset: str,
    summary_items: list[str],
    content: str,
    sources: list[dict[str, Any]],
    actions: list[dict[str, Any]],
    poster: dict[str, Any] | None,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "id": post_id,
        "slug": slug,
        "title": title,
        "desc": desc,
        "date": date,
        "category": category,
        "channel": channel,
        "tags": tags,
        "read": read,
        "preset": preset,
        "summary": summary_items,
        "content": content,
        "sources": sources,
    }
    if actions:
        record["actions"] = actions
    if poster:
        record["poster"] = poster
    return record


def load_existing_article(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise SystemExit(f"existing article json is invalid: {path}: {error}") from error
    if not isinstance(payload, dict):
        raise SystemExit(f"existing article json must be an object: {path}")
    return payload


def build_actions_template(*, slug: str) -> list[dict[str, Any]]:
    return [
        {
            "label": "查看原始来源",
            "href": "https://example.com",
            "variant": "primary",
            "external": True,
        },
        {
            "label": "下载附件",
            "href": f"/assets/posts/{slug}/appendix.pdf",
            "variant": "secondary",
            "download": True,
        },
    ]


def maybe_write_json(path: Path | None, payload: Any, *, dry_run: bool) -> bool:
    if path is None:
        return False
    if not dry_run:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="Publish a changxian-web article into JSON-first data structure")
    parser.add_argument("--workspace", required=True, help="Path to changxian-web workspace root")
    parser.add_argument("--slug", required=True, help="URL slug, e.g. llm-pricing-2026")
    parser.add_argument("--id", dest="post_id", default="", help="Article id; defaults to slug")
    parser.add_argument("--component", default="", help="Deprecated in JSON mode; kept for backward compatibility")
    parser.add_argument("--title", required=True)
    parser.add_argument("--desc", required=True)
    parser.add_argument("--date", required=True, help="YYYY-MM-DD")
    parser.add_argument("--category", required=True)
    parser.add_argument("--channel", required=True)
    parser.add_argument("--tags", required=True, help="Comma separated tags")
    parser.add_argument("--read", required=True, help="Read duration label, e.g. 12 分钟")
    parser.add_argument("--preset", default="", help="Generator preset id; defaults to article id")
    parser.add_argument("--content-file", default="", help="Markdown article file path")
    parser.add_argument("--summary-items", default="", help="Optional summary items, split by | or comma")
    parser.add_argument("--cards-source", default="", help="Optional directory containing poster card images")
    parser.add_argument("--sources-file", default="", help="Optional markdown/text file with source links")
    parser.add_argument("--actions-json", default="", help="Optional JSON file for ArticleHeader actions")
    parser.add_argument("--actions-template-out", default="", help="Optional path to write an actions JSON template")
    parser.add_argument("--poster-json", default="", help="Optional full poster JSON config file")
    parser.add_argument("--poster-renderer-id", default="", help="Deprecated: current changxian-web only supports poster.cards")
    parser.add_argument("--poster-template-out", default="", help="Optional path to write generated poster JSON scaffold")
    parser.add_argument("--keep-existing-poster", action="store_true", help="When overwriting, preserve existing article.poster if present")
    parser.add_argument("--keep-existing-actions", action="store_true", help="When overwriting, preserve existing article.actions if present")
    parser.add_argument(
        "--card-layout",
        default="auto",
        choices=sorted(CARD_LAYOUT_CHOICES),
        help="Default generated card layout: auto/image/compare/timeline/concept/metrics/layers/checklist",
    )
    parser.add_argument("--focus-terms", default="", help="Optional comma-separated focus terms")
    parser.add_argument("--brand-name", default="", help="Poster brand name; auto-inferred if omitted")
    parser.add_argument("--brand-subtitle", default="", help="Poster brand subtitle; auto-inferred if omitted")
    parser.add_argument("--follow-term", default="", help="Poster CTA follow phrase; auto-inferred if omitted")
    parser.add_argument("--poster-badge", default="文章摘要", help="Poster cover badge text")
    parser.add_argument("--card-footer", default="", help="Poster footer text; auto-inferred if omitted")
    parser.add_argument("--logo-url", default="", help="Poster logo url; auto-inferred if omitted")
    parser.add_argument("--cover-decoration-text", default="CARD", help="Poster cover decoration text")
    parser.add_argument("--show-card-no", dest="show_card_no", action="store_true", help="Show card numbers on poster cards (default)")
    parser.add_argument("--no-show-card-no", dest="show_card_no", action="store_false", help="Hide card numbers on poster cards")
    parser.set_defaults(show_card_no=True)
    parser.add_argument("--skip-generator", action="store_true", help="Skip appending preset to Generator.jsx")
    parser.add_argument("--force", action="store_true", help="Overwrite existing article JSON")
    parser.add_argument("--dry-run", action="store_true", help="Show planned actions without writing files")
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()
    if not workspace.exists():
        raise SystemExit(f"workspace does not exist: {workspace}")
    if not detect_json_article_mode(workspace):
        raise SystemExit(
            "This skill now targets JSON-first changxian-web. Expected: "
            "src/content/articles/, src/data/articles/index.js, src/pages/posts/ArticlePostPage.jsx"
        )

    slug = args.slug.strip()
    post_id = (args.post_id or slug).strip()
    preset = (args.preset or post_id).strip()
    tags = normalize_tags(args.tags)
    if not tags:
        raise SystemExit("tags cannot be empty")

    focus_terms = normalize_focus_terms(args.focus_terms, tags)
    summary_items = normalize_summary_items(args.summary_items, desc=args.desc, tags=tags)
    branding = resolve_branding_defaults(
        title=args.title,
        desc=args.desc,
        category=args.category,
        channel=args.channel,
        tags=tags,
        brand_name=args.brand_name,
        brand_subtitle=args.brand_subtitle,
        follow_term=args.follow_term,
        card_footer=args.card_footer,
        logo_url=args.logo_url,
    )
    card_layout_raw = (args.card_layout or "auto").strip().lower()
    card_layout = resolve_card_layout(card_layout_raw, title=args.title, desc=args.desc, tags=tags)
    card_layout_explicit = card_layout_raw != "auto"

    content_file = Path(args.content_file).resolve() if args.content_file else None
    content = load_content(content_file, title=args.title, desc=args.desc, tags=tags)

    cards_source = Path(args.cards_source).resolve() if args.cards_source else None
    card_paths = ensure_cards(workspace=workspace, slug=slug, cards_source=cards_source, dry_run=args.dry_run)

    sources_file = Path(args.sources_file).resolve() if args.sources_file else None
    sources = parse_sources_file(sources_file) if sources_file else []

    actions_json = Path(args.actions_json).resolve() if args.actions_json else None
    actions = parse_actions_json(actions_json)

    article_path = workspace / "src" / "content" / "articles" / f"{slug}.json"
    existing_article = load_existing_article(article_path)
    if existing_article and not args.force:
        raise SystemExit(f"article already exists: {article_path} (use --force to overwrite)")

    actions_template_out = Path(args.actions_template_out).resolve() if args.actions_template_out else None
    poster_template_out = Path(args.poster_template_out).resolve() if args.poster_template_out else None

    poster: dict[str, Any] | None = None
    if args.poster_renderer_id.strip():
        raise SystemExit("--poster-renderer-id is no longer supported; use declarative poster.cards or --poster-json")

    if args.poster_json:
        poster = load_poster_json(Path(args.poster_json).resolve())
    elif args.keep_existing_poster and existing_article and isinstance(existing_article.get("poster"), dict):
        poster = existing_article["poster"]
    else:
        poster = build_default_poster(
            slug=slug,
            title=args.title,
            desc=args.desc,
            summary_items=summary_items,
            content=content,
            focus_terms=focus_terms,
            card_paths=card_paths,
            card_layout=card_layout,
            card_layout_explicit=card_layout_explicit,
            brand_name=branding["brand_name"],
            brand_subtitle=branding["brand_subtitle"],
            follow_term=branding["follow_term"],
            logo_url=branding["logo_url"],
            poster_badge=args.poster_badge.strip() or "文章摘要",
            card_footer=branding["card_footer"],
            cover_decoration_text=args.cover_decoration_text.strip() or "CARD",
            show_card_no=args.show_card_no,
        )

    if args.keep_existing_actions and existing_article and isinstance(existing_article.get("actions"), list) and not actions:
        actions = existing_article["actions"]

    article_record = build_article_record(
        slug=slug,
        post_id=post_id,
        title=args.title,
        desc=args.desc,
        date=args.date,
        category=args.category,
        channel=args.channel,
        tags=tags,
        read=args.read,
        preset=preset,
        summary_items=summary_items,
        content=content,
        sources=sources,
        actions=actions,
        poster=poster,
    )

    generator_changed = False
    preset_text = build_preset_text(title=args.title, desc=args.desc, content=content, tags=tags)

    if not args.dry_run:
        article_path.parent.mkdir(parents=True, exist_ok=True)
        article_path.write_text(json.dumps(article_record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        maybe_write_json(poster_template_out, poster, dry_run=False)
        maybe_write_json(actions_template_out, build_actions_template(slug=slug), dry_run=False)
        if not args.skip_generator:
            generator_changed = upsert_generator_preset(
                workspace=workspace,
                preset=preset,
                preset_text=preset_text,
                dry_run=False,
            )
    else:
        maybe_write_json(poster_template_out, poster, dry_run=True)
        maybe_write_json(actions_template_out, build_actions_template(slug=slug), dry_run=True)
        if not args.skip_generator:
            generator_changed = upsert_generator_preset(
                workspace=workspace,
                preset=preset,
                preset_text=preset_text,
                dry_run=True,
            )

    print("Publish summary:")
    print(f"- Article JSON: {'would write' if args.dry_run else 'written'} -> {article_path}")
    print(f"- Content source: {content_file if content_file else 'generated scaffold'}")
    print(f"- Summary items: {len(summary_items)}")
    print(f"- Sections detected: {len(extract_markdown_sections(content))}")
    print(f"- Card assets linked: {len(card_paths)}")
    print(f"- Sources linked: {len(sources)}")
    print(f"- Poster mode: {'custom-json' if args.poster_json else ('preserved-existing' if args.keep_existing_poster and existing_article and isinstance(existing_article.get('poster'), dict) else f'declarative/optimized/{card_layout}')}")
    print(f"- Poster template exported: {'yes' if poster_template_out else 'no'}")
    print(f"- Actions template exported: {'yes' if actions_template_out else 'no'}")
    print(f"- Generator preset added: {'yes' if generator_changed else 'no/skip'}")
    print("- Route registration: skipped (current changxian-web auto-discovers /posts/:slug)")
    print("- Next step: run `npm run build` in workspace")


if __name__ == "__main__":
    main()
