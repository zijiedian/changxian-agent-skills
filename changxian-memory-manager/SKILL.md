---
name: changxian-memory-manager
description: Manage durable chat memory for changxian-agent. Use when a turn includes `[MEMORY STATE]` or the user asks to remember, forget, pin, unpin, revise, or inspect stable preferences, facts, or constraints that should matter in future turns.
---

# Changxian Memory Manager

Use this skill only for durable memory. Do not treat it as a scratchpad for one-off task details.

## Keep In Memory

- stable user preferences for language, tone, structure, and workflow
- durable facts that will matter again later
- recurring project constraints or repository conventions
- explicit corrections that replace older saved preferences

## Keep Out Of Memory

- secrets, tokens, passwords, or private keys
- chain-of-thought or hidden reasoning
- temporary logs, bulky outputs, or transient execution state
- one-off task details that will not matter after the current task

## Editing Rules

- Treat `[MEMORY STATE]` as the authoritative saved memory for the current scope.
- Prefer updating or merging an existing memory instead of creating duplicates.
- Delete or replace stale memories when the user clearly supersedes them.
- Emit no memory block when persistent memory should stay unchanged.
- If the user only wants to use or inspect saved memory, reply normally and emit no ops block.
- Briefly explain real memory changes in user-facing prose.

## Output Protocol

When persistent memory should change, append exactly one fenced block at the very end of the answer:

```tg-memory-ops
{"ops":[...]}
```

The host runtime consumes `tg-memory-ops` and persists the resulting memory changes.

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
