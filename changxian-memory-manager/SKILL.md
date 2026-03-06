---
name: changxian-memory-manager
description: Manage long-term chat memory for changxian-agent. Use when a conversation includes saved memory state, when the user asks to remember or forget something, or when stable preferences and facts should update the chat memory.
---

# Changxian Memory Manager

## When To Use

Use this skill whenever changxian-agent provides a `[MEMORY STATE]` block or the user expresses any long-term preference, standing instruction, reusable fact, or correction to previously saved memory.

## Goals

- Use saved memory as active session context.
- Keep memory compact, accurate, and non-duplicative.
- Update memory conservatively when the user clearly wants to remember, forget, pin, unpin, or revise something.

## What Belongs In Memory

Keep only stable, reusable context such as:

- preferred language, tone, structure, and output defaults
- recurring project constraints and repository conventions
- durable user facts that matter for future turns
- corrections that replace older saved preferences

Do not store:

- secrets, tokens, passwords, or private keys
- chain-of-thought or hidden reasoning
- one-off task details that will not matter later
- large verbatim outputs or temporary logs

## Memory Editing Rules

- Treat `[MEMORY STATE]` as the authoritative saved memory for this chat.
- Prefer updating or merging an existing memory instead of creating duplicates.
- When the user explicitly replaces an old preference, update or delete the stale memory.
- If no memory change is needed, emit no memory-ops block.
- Keep normal user-facing prose separate from memory operations.

## Output Protocol

When memory should change, append exactly one fenced block at the very end of the answer:

```tg-memory-ops
{"ops":[...]}
```

Supported operations:

- `upsert`
- `delete`
- `pin`
- `unpin`

Supported fields:

- `op`: required operation name
- `scope`: optional; use `default`, `chat`, `chat:current`, `global`, `role`, or a concrete scope
- `memory_id`: preferred when editing a known memory from `[MEMORY STATE]`
- `title`: short summary for the memory
- `content`: canonical memory text for `upsert`
- `kind`: optional memory kind such as `preference`, `fact`, `constraint`, or `note`
- `tags`: optional string list
- `importance`: optional integer `0-10`
- `pinned`: optional boolean for `upsert`
- `query` or `contains`: optional matcher for `delete`, `pin`, or `unpin` when `memory_id` is unavailable

## Examples

User says: “记住：以后默认中文回答，先给结论再展开。”

```tg-memory-ops
{"ops":[{"op":"upsert","kind":"preference","title":"默认回复风格","content":"默认使用中文回答，并且先给结论再展开。","tags":["preference","language","format"],"importance":8,"pinned":true}]}
```

User says: “忘掉我之前说的英文优先。”

```tg-memory-ops
{"ops":[{"op":"delete","query":"英文优先"}]}
```

User says: “把‘默认中文回答’这条置顶。”

```tg-memory-ops
{"ops":[{"op":"pin","query":"默认中文回答"}]}
```
