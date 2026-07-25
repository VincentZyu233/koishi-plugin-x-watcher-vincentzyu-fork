# koishi-plugin-x-watcher

[![npm](https://img.shields.io/npm/v/koishi-plugin-x-watcher?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-x-watcher)

在频道或私聊中订阅指定 X/Twitter 用户的原创、回复、引用和转推。插件支持 Rettiwt 轮询、TwitterAPI.io REST 轮询和 TwitterAPI.io Account Stream WebSocket；每个插件实例只运行一种数据源和模式，不会并行抓取或自动降级。

运行环境要求 Node.js 22.21 或更新的 22.x 版本；这是固定依赖 `rettiwt-api@7.1.2` 的运行时要求，所有模式都会加载该依赖。

## 配置

### Rettiwt 轮询

`apiKeys`: Rettiwt Cookie API Key 池

`apiKey`: Twitter/X webapi 身份验证凭据

`interval`: 检查间隔（分钟）

apiKey 池始终按配置顺序故障转移，不做负载均衡；认证失败的 key 会在当前进程隔离，触发 429 的 key 冷却 60 秒。

Rettiwt Cookie API Key 获取方法：

1. 打开你的浏览器（Chrome/Chromium 内核/Firefox/Firefox 内核），访问 Twitter/X。
2. 按下键盘上的 F12 键，打开浏览器开发者工具。
3. 导航至 应用程序 -> Cookie（Chrome/Chromium 内核）或 存储 -> Cookie（Firefox/Firefox 内核）。
4. 复制以下 3 个字段的值：auth_token、ct0、twid。这些将作为你的身份验证凭据。
5. 进入浏览器开发者工具的控制台 ，执行命令：btoa("auth_token=<auth_token_value>;ct0=<ct0_value>;twid=<twid_value>;")。将token值替换为你复制的对应内容。
6. 输出的字符串即为你的 API_KEY。

## 从 0.1.x 迁移

旧 `auth_key` 配置不再兼容。：

插件在 `ready` 生命周期幂等迁移原有 `x_watcher` 表：

- 新增 `include_quote`、`include_retweet`，旧订阅都回填为 `false`。
- 新增 `enabled_at`，依次使用旧 `update_at`、`create_at` 或迁移时间。
- 原有频道、订阅状态、正则、媒体开关和 Snowflake 处理进度保持不变。

迁移失败时不会注册命令，也不会启动轮询。

## 命令

```text
watch [-m] [--quote] [--retweet] <username> [regexp]

unwatch <username>

xlist
```

- 默认订阅原创和回复。
- `--quote` 开启引用推文。
- `--retweet` 开启转推。
- `-m` 附带图片和 GIF；视频继续只提供原文链接。
- 用户名可写成 `username` 或 `@username`。
- 正则只匹配当前动态正文。
- 订阅按频道或私聊隔离，频道中的任何成员都可以管理当前频道订阅。

再次执行 `watch` 是完整覆盖，不是局部合并：省略正则会清空旧规则，省略 `-m`、`--quote` 或 `--retweet` 会关闭对应能力。非法正则会在命令阶段拒绝；数据库中意外存在的非法规则按 fail-closed 处理。

新订阅和重新启用的订阅都会先把处理进度设为当前最新动态，因此不会补发订阅前的历史动态。`unwatch` 只做软取消；重新启用时会重新设置起始位置。

示例：

```text
watch OpenAI
watch -m --quote OpenAI GPT|model
watch --quote --retweet @OpenAI release
unwatch OpenAI
xlist
```

## 投递与一致性

- 同一个 X 用户即使被多个频道订阅，每轮也只抓取一次，再按各频道的处理进度、类型开关和正则独立路由。
- 过滤不匹配或类型关闭的动态属于已消费，会推进该订阅的处理进度。
- 消息从旧到新发送；发送失败会停止该订阅本轮处理，不越过失败项。
- 发送成功但处理进度写入失败时，后续恢复可能产生至少一次重复投递；插件不使用持久化 outbox。
- WebSocket 投递失败会主动断线，至少等待 90 秒后重连并通过 REST 补漏。
- 时间固定显示为上海时区，消息包含分类标题、正文和原文链接。
