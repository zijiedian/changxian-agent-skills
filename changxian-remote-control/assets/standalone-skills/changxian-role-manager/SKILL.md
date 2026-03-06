---
name: changxian-role-manager
description: Manage reusable chat roles for changxian-agent. Use when a conversation includes role state, when the user asks to create or revise a role, or when the user wants to activate, clear, or delete a saved role.
---

# Changxian Role Manager

## When To Use

Use this skill whenever changxian-agent provides a `[ROLE STATE]` block or the user asks to define, refine, select, stop using, or remove a reusable role.

## Goals

- Keep reusable roles in a compact, durable form.
- Let the assistant immediately act in a requested role for the current turn.
- Persist role definitions only when they are reusable beyond the current task.

## What A Saved Role Should Contain

Saved roles should describe stable working behavior, such as:

- the role's mission and perspective
- what it prioritizes
- preferred output structure
- recurring constraints or review style

Do not save:

- one-off task details
- secrets or credentials
- hidden reasoning or chain-of-thought
- content that only matters for the current turn

## Role Editing Rules

- Treat `[ROLE STATE]` as the authoritative list of saved roles and the current active role.
- If the user asks to use a role for this turn, do so immediately in the response.
- Emit a role-ops block only when the role catalog or active role should persist after this turn.
- If the user request is not about role management, never emit a role-ops block.
- When updating an existing role, overwrite the canonical definition instead of creating duplicates.
- Avoid no-op role operations that only repeat the current role content or active-role state.
- Do not add routine "role reminder" prose in normal replies.
- When role state really changes, explain the concrete change points briefly (added/updated/activated/cleared/deleted role).
- Use lowercase hyphenated role names.

## Output Protocol

When persistent role state should change, append exactly one fenced block at the very end of the answer:

```tg-role-ops
{"ops":[...]}
```

Storage note: this skill emits role operations only. The host bridge consumes `tg-role-ops` and persists role definitions and active-role mapping to its state store (for changxian remote control, `roles/*.md` and `chat_roles.json`).

Supported operations:

- `upsert_role`
- `use_role`
- `clear_role`
- `delete_role`

Supported fields:

- `op`: required operation name
- `name`: role name, such as `security-reviewer`
- `content`: canonical role definition for `upsert_role`
- `activate`: optional boolean; when true, make the role the new default active role for the chat

## Examples

User says: “创建一个叫 api-reviewer 的角色：专门检查接口兼容性和错误处理，以后默认用它。”

```tg-role-ops
{"ops":[{"op":"upsert_role","name":"api-reviewer","content":"You are an API reviewer. Prioritize compatibility risks, contract drift, error handling, and missing tests. Keep findings concise and actionable.","activate":true}]}
```

User says: “以后用 researcher 这个角色。”

```tg-role-ops
{"ops":[{"op":"use_role","name":"researcher"}]}
```

User says: “不要再默认用任何角色了。”

```tg-role-ops
{"ops":[{"op":"clear_role"}]}
```

User says: “把 old-reviewer 这个角色删掉。”

```tg-role-ops
{"ops":[{"op":"delete_role","name":"old-reviewer"}]}
```
