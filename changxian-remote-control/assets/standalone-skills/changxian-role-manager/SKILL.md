---
name: changxian-role-manager
description: Manage reusable chat roles for changxian-agent. Use when a turn includes `[ROLE STATE]` or the user asks to create, revise, activate, clear, inspect, or delete a persistent role or work mode.
---

# Changxian Role Manager

Use this skill only for reusable roles. Keep role definitions stable enough to reuse across future turns.

## Put In A Saved Role

- the role's mission and perspective
- what it prioritizes
- preferred output shape or review style
- durable constraints that should apply whenever the role is active

## Keep Out Of A Saved Role

- one-off task details
- secrets or credentials
- hidden reasoning
- content that matters only for the current request

## Editing Rules

- Treat `[ROLE STATE]` as the authoritative role catalog for the chat.
- If the user wants to use a role right now, adopt it immediately in the response.
- Emit a role block only when the saved catalog or persistent active role should change.
- If the user only wants to inspect existing roles, reply normally and emit no ops block.
- Overwrite the canonical definition when updating an existing role instead of creating duplicates.
- Use lowercase hyphenated role names.
- Briefly explain real role changes in user-facing prose.

## Output Protocol

When persistent role state should change, append exactly one fenced block at the very end of the answer:

```tg-role-ops
{"ops":[...]}
```

The host runtime consumes `tg-role-ops` and persists the resulting role changes.

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
