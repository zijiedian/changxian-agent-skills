import json
import re
import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional, Sequence

WORD_RE = re.compile(r"[A-Za-z0-9_\-\u4e00-\u9fff]{2,}")
UNSET = object()


@dataclass
class MemoryRecord:
    id: str
    chat_id: int
    scope: str
    kind: str
    title: str
    content: str
    tags: list[str]
    importance: int
    pinned: bool
    source_type: str
    source_ref: str
    created_at: int
    updated_at: int
    last_hit_at: Optional[int]
    expires_at: Optional[int]


class MemoryStore:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)

    def initialize(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS memories (
                    id TEXT PRIMARY KEY,
                    chat_id INTEGER NOT NULL,
                    scope TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    content TEXT NOT NULL,
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    importance INTEGER NOT NULL DEFAULT 0,
                    pinned INTEGER NOT NULL DEFAULT 0,
                    source_type TEXT NOT NULL DEFAULT '',
                    source_ref TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    last_hit_at INTEGER,
                    expires_at INTEGER
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_memories_chat_scope_updated ON memories(chat_id, scope, updated_at DESC)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_memories_chat_pinned ON memories(chat_id, pinned DESC, updated_at DESC)"
            )
            conn.commit()
        try:
            self.db_path.chmod(0o600)
        except OSError:
            pass

    def add_memory(
        self,
        *,
        chat_id: int,
        scope: str,
        kind: str,
        content: str,
        title: str = "",
        tags: Optional[Sequence[str]] = None,
        importance: int = 0,
        pinned: bool = False,
        source_type: str = "",
        source_ref: str = "",
        expires_at: Optional[int] = None,
    ) -> MemoryRecord:
        now = int(time.time())
        record = MemoryRecord(
            id=f"mem_{uuid.uuid4().hex[:10]}",
            chat_id=chat_id,
            scope=(scope or f"chat:{chat_id}").strip(),
            kind=(kind or "note").strip() or "note",
            title=title.strip(),
            content=content.strip(),
            tags=list(tags or []),
            importance=int(importance),
            pinned=bool(pinned),
            source_type=source_type.strip(),
            source_ref=source_ref.strip(),
            created_at=now,
            updated_at=now,
            last_hit_at=None,
            expires_at=expires_at,
        )
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO memories (
                    id, chat_id, scope, kind, title, content, tags_json, importance, pinned,
                    source_type, source_ref, created_at, updated_at, last_hit_at, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.id,
                    record.chat_id,
                    record.scope,
                    record.kind,
                    record.title,
                    record.content,
                    json.dumps(record.tags, ensure_ascii=False),
                    record.importance,
                    1 if record.pinned else 0,
                    record.source_type,
                    record.source_ref,
                    record.created_at,
                    record.updated_at,
                    record.last_hit_at,
                    record.expires_at,
                ),
            )
            conn.commit()
        return record

    def get_memory(self, chat_id: int, memory_id: str) -> Optional[MemoryRecord]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM memories WHERE chat_id = ? AND id = ?",
                (chat_id, memory_id.strip()),
            ).fetchone()
        return self._row_to_memory(row) if row is not None else None

    def update_memory(
        self,
        chat_id: int,
        memory_id: str,
        *,
        scope: Optional[str] = None,
        kind: Optional[str] = None,
        title: Optional[str] = None,
        content: Optional[str] = None,
        tags: object = UNSET,
        importance: Optional[int] = None,
        pinned: Optional[bool] = None,
        source_type: Optional[str] = None,
        source_ref: Optional[str] = None,
        expires_at: object = UNSET,
    ) -> Optional[MemoryRecord]:
        existing = self.get_memory(chat_id, memory_id)
        if existing is None:
            return None

        next_scope = existing.scope if scope is None else (scope or f"chat:{chat_id}").strip()
        next_kind = existing.kind if kind is None else ((kind or "note").strip() or "note")
        next_title = existing.title if title is None else title.strip()
        next_content = existing.content if content is None else content.strip()
        next_tags = existing.tags if tags is UNSET else [str(item) for item in list(tags or [])]
        next_importance = existing.importance if importance is None else int(importance)
        next_pinned = existing.pinned if pinned is None else bool(pinned)
        next_source_type = existing.source_type if source_type is None else source_type.strip()
        next_source_ref = existing.source_ref if source_ref is None else source_ref.strip()
        next_expires_at = existing.expires_at if expires_at is UNSET else expires_at
        now = int(time.time())

        with self._connect() as conn:
            conn.execute(
                """
                UPDATE memories
                SET scope = ?, kind = ?, title = ?, content = ?, tags_json = ?, importance = ?, pinned = ?,
                    source_type = ?, source_ref = ?, updated_at = ?, expires_at = ?
                WHERE chat_id = ? AND id = ?
                """,
                (
                    next_scope,
                    next_kind,
                    next_title,
                    next_content,
                    json.dumps(next_tags, ensure_ascii=False),
                    next_importance,
                    1 if next_pinned else 0,
                    next_source_type,
                    next_source_ref,
                    now,
                    next_expires_at,
                    chat_id,
                    memory_id.strip(),
                ),
            )
            conn.commit()
        return self.get_memory(chat_id, memory_id)

    def list_memories(
        self,
        chat_id: int,
        *,
        scope: Optional[str] = None,
        query: str = "",
        limit: int = 12,
    ) -> list[MemoryRecord]:
        params: list[object] = [chat_id, int(time.time())]
        clauses = ["chat_id = ?", "(expires_at IS NULL OR expires_at > ?)"]
        if scope:
            clauses.append("scope = ?")
            params.append(scope.strip())
        sql = (
            "SELECT * FROM memories WHERE "
            + " AND ".join(clauses)
            + " ORDER BY pinned DESC, importance DESC, updated_at DESC"
        )
        with self._connect() as conn:
            rows = conn.execute(sql, tuple(params)).fetchall()
        records = [self._row_to_memory(row) for row in rows]
        if query.strip():
            records = self._filter_by_query(records, query)
        return records[: max(1, limit)]

    def search_memories(
        self,
        *,
        chat_id: int,
        scopes: Sequence[str],
        query: str,
        limit: int,
    ) -> list[MemoryRecord]:
        scope_values = [scope.strip() for scope in scopes if scope and scope.strip()]
        if not scope_values:
            return []
        placeholders = ",".join("?" for _ in scope_values)
        limit_value = max(1, limit)
        if not query.strip():
            sql = (
                "SELECT * FROM memories "
                f"WHERE chat_id = ? AND scope IN ({placeholders}) AND (expires_at IS NULL OR expires_at > ?) "
                "ORDER BY pinned DESC, importance DESC, updated_at DESC "
                "LIMIT ?"
            )
            params: list[object] = [chat_id, *scope_values, int(time.time()), limit_value]
            with self._connect() as conn:
                rows = conn.execute(sql, tuple(params)).fetchall()
            records = [self._row_to_memory(row) for row in rows]
            if records:
                self.touch_memories([record.id for record in records])
            return records

        sql = (
            "SELECT * FROM memories "
            f"WHERE chat_id = ? AND scope IN ({placeholders}) AND (expires_at IS NULL OR expires_at > ?)"
        )
        params: list[object] = [chat_id, *scope_values, int(time.time())]
        with self._connect() as conn:
            rows = conn.execute(sql, tuple(params)).fetchall()
        records = [self._row_to_memory(row) for row in rows]
        if not records:
            return []

        query_tokens = self._tokenize(query)
        primary_scope = scope_values[0]
        scored: list[tuple[int, MemoryRecord]] = []
        fallback_scored: list[tuple[int, MemoryRecord]] = []
        for record in records:
            haystack = f"{record.title}\n{record.content}\n{' '.join(record.tags)}".lower()
            token_hits = sum(1 for token in query_tokens if token in haystack)
            scope_score = 150 if record.scope == primary_scope else 0
            importance_score = min(100, record.importance * 10) if record.importance else 0
            recency_hours = max(1.0, (time.time() - record.updated_at) / 3600)
            recency_score = max(0, 24 - int(recency_hours))
            manual_score = 45 if any(str(tag).strip().lower() == "manual" for tag in record.tags) else 0
            score = scope_score + importance_score + recency_score
            if record.pinned:
                score += 1000
            if query_tokens:
                if token_hits > 0 or record.pinned:
                    score += token_hits * 40
                    scored.append((score, record))
                    continue

                fallback_score = importance_score + recency_score + manual_score
                if record.scope == primary_scope:
                    fallback_score += 80
                elif record.scope in scope_values[1:]:
                    fallback_score += 20
                fallback_scored.append((fallback_score, record))
                continue
            else:
                score += 10 + manual_score
            scored.append((score, record))

        scored.sort(key=lambda item: (-item[0], -item[1].updated_at))
        selected = [record for _, record in scored[:limit_value]]
        if len(selected) < limit_value and fallback_scored:
            fallback_scored.sort(key=lambda item: (-item[0], -item[1].updated_at))
            selected_ids = {record.id for record in selected}
            for _, record in fallback_scored:
                if record.id in selected_ids:
                    continue
                selected.append(record)
                selected_ids.add(record.id)
                if len(selected) >= limit_value:
                    break
        if selected:
            self.touch_memories([record.id for record in selected])
        return selected

    def touch_memories(self, memory_ids: Iterable[str]) -> None:
        ids = [item for item in memory_ids if item]
        if not ids:
            return
        now = int(time.time())
        placeholders = ",".join("?" for _ in ids)
        with self._connect() as conn:
            conn.execute(
                f"UPDATE memories SET last_hit_at = ?, updated_at = updated_at WHERE id IN ({placeholders})",
                (now, *ids),
            )
            conn.commit()

    def set_pinned(self, chat_id: int, memory_id: str, pinned: bool) -> bool:
        with self._connect() as conn:
            cursor = conn.execute(
                "UPDATE memories SET pinned = ?, updated_at = ? WHERE chat_id = ? AND id = ?",
                (1 if pinned else 0, int(time.time()), chat_id, memory_id.strip()),
            )
            conn.commit()
        return cursor.rowcount > 0

    def delete_memory(self, chat_id: int, memory_id: str) -> bool:
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM memories WHERE chat_id = ? AND id = ?",
                (chat_id, memory_id.strip()),
            )
            conn.commit()
        return cursor.rowcount > 0

    def clear_scope(self, chat_id: int, scope: str) -> int:
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM memories WHERE chat_id = ? AND scope = ?",
                (chat_id, scope.strip()),
            )
            conn.commit()
        return cursor.rowcount

    def count_memories(self, chat_id: int) -> int:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS count FROM memories WHERE chat_id = ? AND (expires_at IS NULL OR expires_at > ?)",
                (chat_id, int(time.time())),
            ).fetchone()
        return int(row["count"]) if row is not None else 0

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    @staticmethod
    def _row_to_memory(row: sqlite3.Row) -> MemoryRecord:
        tags_raw = row["tags_json"] or "[]"
        try:
            tags = json.loads(tags_raw)
        except json.JSONDecodeError:
            tags = []
        if not isinstance(tags, list):
            tags = []
        return MemoryRecord(
            id=row["id"],
            chat_id=int(row["chat_id"]),
            scope=row["scope"],
            kind=row["kind"],
            title=row["title"] or "",
            content=row["content"],
            tags=[str(item) for item in tags],
            importance=int(row["importance"] or 0),
            pinned=bool(row["pinned"]),
            source_type=row["source_type"] or "",
            source_ref=row["source_ref"] or "",
            created_at=int(row["created_at"]),
            updated_at=int(row["updated_at"]),
            last_hit_at=int(row["last_hit_at"]) if row["last_hit_at"] is not None else None,
            expires_at=int(row["expires_at"]) if row["expires_at"] is not None else None,
        )

    @classmethod
    def _filter_by_query(cls, records: Sequence[MemoryRecord], query: str) -> list[MemoryRecord]:
        tokens = cls._tokenize(query)
        if not tokens:
            return list(records)
        filtered: list[tuple[int, MemoryRecord]] = []
        for record in records:
            haystack = f"{record.title}\n{record.content}\n{' '.join(record.tags)}".lower()
            hits = sum(1 for token in tokens if token in haystack)
            if hits:
                filtered.append((hits, record))
        filtered.sort(key=lambda item: (-item[0], -item[1].updated_at))
        return [record for _, record in filtered]

    @staticmethod
    def _tokenize(value: str) -> list[str]:
        return [token.lower() for token in WORD_RE.findall(value or "")]
