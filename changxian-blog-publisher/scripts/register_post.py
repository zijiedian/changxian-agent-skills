#!/usr/bin/env python3
"""Register a new blog post in changxian-web.

Updates:
- src/App.jsx: import + route
- src/data/articleIndex.js (preferred) or src/pages/Articles.jsx: prepend article metadata entry
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path


def escape_js(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


def normalize_tags(raw: str) -> list[str]:
    items = [item.strip() for item in raw.split(",")]
    return [item for item in items if item]


def insert_after_last_import(content: str, line: str) -> str:
    matches = list(re.finditer(r"^import .+;$", content, flags=re.MULTILINE))
    if not matches:
        raise ValueError("No import section found in App.jsx")
    last = matches[-1]
    insert_at = last.end()
    return content[:insert_at] + "\n" + line + content[insert_at:]


def update_app(app_path: Path, component: str, page_file: str, slug: str) -> tuple[bool, bool]:
    content = app_path.read_text(encoding="utf-8")
    updated_import = False
    updated_route = False

    import_line = f"import {component} from './pages/posts/{page_file}';"
    if import_line not in content:
        content = insert_after_last_import(content, import_line)
        updated_import = True

    route_line = f'      <Route path="/posts/{slug}" element={{{component_tag(component)}}} />'
    if route_line not in content:
        marker = "    </Routes>"
        idx = content.find(marker)
        if idx == -1:
            raise ValueError("Could not find </Routes> marker in App.jsx")
        content = content[:idx] + route_line + "\n" + content[idx:]
        updated_route = True

    if updated_import or updated_route:
        app_path.write_text(content, encoding="utf-8")

    return updated_import, updated_route


def component_tag(component: str) -> str:
    return f"<{component} />"


def build_article_entry(
    *,
    post_id: str,
    title: str,
    desc: str,
    date: str,
    category: str,
    channel: str,
    tags: list[str],
    read: str,
    preset: str,
    slug: str,
) -> str:
    tags_text = ", ".join(f"'{escape_js(tag)}'" for tag in tags)
    return (
        "  {\n"
        f"    id: '{escape_js(post_id)}',\n"
        f"    title: '{escape_js(title)}',\n"
        f"    desc: '{escape_js(desc)}',\n"
        f"    date: '{escape_js(date)}',\n"
        f"    category: '{escape_js(category)}',\n"
        f"    channel: '{escape_js(channel)}',\n"
        f"    tags: [{tags_text}],\n"
        f"    read: '{escape_js(read)}',\n"
        f"    preset: '{escape_js(preset)}',\n"
        f"    url: '/posts/{escape_js(slug)}',\n"
        "  },\n"
    )


def update_articles(metadata_path: Path, *, post_id: str, entry: str) -> bool:
    content = metadata_path.read_text(encoding="utf-8")

    if f"id: '{escape_js(post_id)}'" in content:
        return False

    marker_candidates = [
        "export const ARTICLE_INDEX = [",
        "const ARTICLES = [",
    ]
    marker = next((item for item in marker_candidates if item in content), "")
    idx = content.find(marker) if marker else -1
    if idx == -1:
        raise ValueError(f"Could not find article metadata array marker in {metadata_path}")

    insert_at = idx + len(marker)
    content = content[:insert_at] + "\n" + entry + content[insert_at:]
    metadata_path.write_text(content, encoding="utf-8")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="Register a new post in changxian-web route and article index.")
    parser.add_argument("--workspace", required=True, help="Path to changxian-web workspace root")
    parser.add_argument("--id", required=True, dest="post_id", help="Article id used in article metadata list")
    parser.add_argument("--slug", required=True, help="URL slug, e.g. llm-pricing-2026")
    parser.add_argument("--component", required=True, help="React component name, e.g. LlmPricing2026")
    parser.add_argument("--page-file", required=True, help="Page filename under src/pages/posts, e.g. LlmPricing2026.jsx")
    parser.add_argument("--title", required=True)
    parser.add_argument("--desc", required=True)
    parser.add_argument("--date", required=True, help="YYYY-MM-DD")
    parser.add_argument("--category", required=True)
    parser.add_argument("--channel", required=True)
    parser.add_argument("--tags", required=True, help="Comma separated tags")
    parser.add_argument("--read", required=True, help="Read duration label, e.g. 12 分钟")
    parser.add_argument("--preset", default="", help="Generator preset id; defaults to post id")

    args = parser.parse_args()
    workspace = Path(args.workspace).resolve()
    app_path = workspace / "src" / "App.jsx"
    article_index_path = workspace / "src" / "data" / "articleIndex.js"
    articles_path = workspace / "src" / "pages" / "Articles.jsx"

    metadata_path = article_index_path if article_index_path.exists() else articles_path

    if not app_path.exists() or not metadata_path.exists():
        raise SystemExit(
            "Expected changxian-web files not found: src/App.jsx and article metadata "
            "(src/data/articleIndex.js or src/pages/Articles.jsx)"
        )

    tags = normalize_tags(args.tags)
    if not tags:
        raise SystemExit("Tags cannot be empty.")

    preset = args.preset or args.post_id
    entry = build_article_entry(
        post_id=args.post_id,
        title=args.title,
        desc=args.desc,
        date=args.date,
        category=args.category,
        channel=args.channel,
        tags=tags,
        read=args.read,
        preset=preset,
        slug=args.slug,
    )

    import_changed, route_changed = update_app(app_path, args.component, args.page_file, args.slug)
    article_changed = update_articles(metadata_path, post_id=args.post_id, entry=entry)

    print("Registration summary:")
    print(f"- App import updated: {'yes' if import_changed else 'no (already present)'}")
    print(f"- App route updated: {'yes' if route_changed else 'no (already present)'}")
    print(f"- Article metadata entry added: {'yes' if article_changed else 'no (id exists)'} -> {metadata_path}")


if __name__ == "__main__":
    main()
