# Claude ACP

The bridge supports Claude through `claude-agent-acp`, using ACP over stdio.

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
| `RC_CLAUDE_COMMAND_PREFIX` | `claude-agent-acp` | Command prefix for Claude ACP |
| `RC_ENV_ISOLATION` | `inherit` | Environment isolation mode |

## Requirements

- `npm install -g @zed-industries/claude-agent-acp`
- Claude must be authenticated via `claude auth login`

## Diagnostics

Use `/setting` to check Claude ACP status:

```
/setting
```

Look for lines like:
- `claude_acp: initialized` or `lazy`
- `claude_agent: <name/version>`
- `claude_cli: /path/to/claude-agent-acp`

## Permissions

Claude ACP permissions are controlled by the ACP adapter / Claude runtime itself, not by bridge-side preset flags.
