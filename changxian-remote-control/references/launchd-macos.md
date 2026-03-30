# macOS Launchd 管理

## Plist 位置

```
~/Library/LaunchAgents/com.changxian.remote-control.bridge.plist
```

## 快速命令

```bash
# 查看进程状态
launchctl list | grep changxian

# 重启（最常用）
launchctl unload ~/Library/LaunchAgents/com.changxian.remote-control.bridge.plist
launchctl load ~/Library/LaunchAgents/com.changxian.remote-control.bridge.plist

# 或者一行搞定
launchctl kickstart -k -p ~/Library/LaunchAgents/com.changxian.remote-control.bridge.plist && launchctl load ~/Library/LaunchAgents/com.changxian.remote-control.bridge.plist

# 查看日志
tail -f ~/.codex/changxian-agent/remote-control/remote-control-launchd.log

# 查看 healthz
curl http://localhost:18001/healthz

# 强制杀掉重载
launchctl kill 9 gui/$(id -u)
```

## 配置说明

| 配置项 | 值 |
|--------|-----|
| Label | `com.changxian.remote-control.bridge` |
| 入口 | `/usr/local/bin/node .../src/index.mjs` |
| 工作目录 | `.../reference-im-bridge` |
| RunAtLoad | `true` (开机自启) |
| KeepAlive | `true` (崩溃自动重启) |
| 日志 | `/Users/wanwenjie/.codex/changxian-agent/remote-control/remote-control-launchd.log` |
| 健康检查端口 | `18001` |

## 调试技巧

```bash
# 临时修改端口测试（不改 plist）
RC_PORT=18002 node src/index.mjs

# 启用调试日志
ACP_DEBUG=1 launchctl load ~/Library/LaunchAgents/com.changxian.remote-control.bridge.plist
```
