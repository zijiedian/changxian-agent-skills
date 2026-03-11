# WeCom Adapter Example

Use this profile when changxian-agent runs behind a WeCom intelligent robot long connection.

## Capabilities

- task submission from text messages
- progress streaming through `aibot_respond_msg`
- proactive pushes through `aibot_send_msg`
- event callbacks such as `enter_chat`
- scheduled execution when the runtime enables a scheduler loop

## Host-specific notes

- Connect to `wss://openws.work.weixin.qq.com`.
- Subscribe with `aibot_subscribe` using `BotID` and long-connection `Secret`.
- Keep the socket alive with `ping` every 30 seconds.
- Use `aibot_msg_callback` for user text prompts.
- Use `aibot_event_callback` for events such as `enter_chat` and `disconnected_event`.
- Use `aibot_respond_welcome_msg` only for `enter_chat`.
- Use `aibot_respond_msg` for streaming replies to message callbacks.
- Use `aibot_send_msg` for proactive scheduled pushes.
