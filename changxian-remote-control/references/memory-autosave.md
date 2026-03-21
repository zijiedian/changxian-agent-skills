# Auto Memory Extraction

Use this reference when remote-control memory should be updated from dialogue context, not only from explicit `/memory add` style commands.

## Save These

Auto-save or auto-update memory when the dialogue reveals durable information such as:

- stable language or reply preferences
- recurring formatting or delivery preferences
- long-lived project paths, repositories, or working scopes
- owned resources the user repeatedly refers to as theirs
- durable constraints like “avoid X”, “default to Y”, “always use Z”
- reusable operating habits such as preferred backend, default role, or common output style

## Do Not Save These

Never auto-save:

- secrets, tokens, passphrases, cookies
- one-off task details
- temporary debugging text
- volatile facts tied only to the current task
- large pasted content that should live in files, not memory

## Update vs Create

Prefer updating an existing memory when:

- the new turn clearly refines the same fact
- the same preference is being clarified
- a path, alias, or default is being corrected

Prefer creating a new memory when:

- the fact is clearly new
- the previous memories are unrelated
- merging would make the memory vague or overloaded

## Good Auto Memory Examples

- “以后默认中文回答” -> reply preference
- “这个桥接默认在 /Users/me/project 下跑” -> default workdir
- “这个频道 daily 是我每天发日报的频道” -> owned resource / channel context
- “代码评审时默认用 reviewer 角色” -> stable role preference

## Bad Auto Memory Examples

- “今天先帮我看这个报错” -> one-off
- “这次临时用一下高权限” -> temporary
- “这是我的 token: ...” -> secret
- “把下面这 300 行日志记住” -> wrong storage layer

## Recommended Ops Pattern

- If the memory already exists, emit `upsert` with `memory_id`
- If the exact id is unknown but the target is obvious, emit `upsert` with `query` or `contains`
- If there is no match, emit a new `upsert`

## Review Questions

Before emitting auto memory ops, check:

1. Will this still matter in a future turn?
2. Is it specific enough to reuse?
3. Is it safe to persist?
4. Should this update an existing memory instead of creating a duplicate?
