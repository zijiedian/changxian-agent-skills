# Claude Backend

The bridge supports Claude SDK as a backend, using the `@anthropic-ai/claude-agent-sdk` to connect to Claude Code CLI.

## Switching to Claude Backend

Use the `/backend claude` command to switch to the Claude backend:

```
/backend claude
```

To restore the default backend:

```
/backend default
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `RC_CLAUDE_COMMAND_PREFIX` | `claude` | Command prefix for Claude CLI |
| `RC_CLAUDE_CODE_EXECUTABLE` | (auto-detect) | Path to Claude CLI executable |
| `RC_ENV_ISOLATION` | `inherit` | Environment isolation mode |

## Requirements

- Claude Code CLI installed (version >= 2.x recommended)
- CLI must be authenticated via `claude auth login`

## Diagnostics

Use `/setting` to check Claude SDK status:

```
/setting
```

Look for lines like:
- `claude_sdk: initialized` or `lazy`
- `claude_cli: /path/to/claude`
- `claude_version: claude 2.x.x`

## Permission Modes

The Claude backend supports `--permission-mode` flag in the command prefix:

- `default` - Ask before executing tools
- `plan` - Plan only mode
- `acceptEdits` - Accept edits without prompting

Example with permission mode:

```
/cmd claude --permission-mode acceptEdits
```
