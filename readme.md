# koishi-plugin-x-watcher

[![npm](https://img.shields.io/npm/v/koishi-plugin-x-watcher?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-x-watcher)

在频道或私聊中订阅指定 X/Twitter 用户的原创、回复、引用和转推。插件支持 Rettiwt 轮询、TwitterAPI.io REST 轮询和 TwitterAPI.io Account Stream WebSocket；每个插件实例只运行一种数据源和模式，不会并行抓取或自动降级。

运行环境要求 Node.js 22.21 或更新的 22.x 版本；这是固定依赖 `rettiwt-api@7.1.2` 的运行时要求，所有模式都会加载该依赖。

## 配置

只填写 `apiKeys` 时默认使用 Rettiwt 轮询；`interval` 默认 5，最小 1 分钟：

```yaml
apiKeys:
  - RETTIWT_COOKIE_KEY_1
```

也可以显式写出完整配置：

- 轮询模式：动态检查间隔。
- WebSocket 模式：本地活跃订阅与远端 monitor 状态的同步间隔。

### Rettiwt 轮询

```yaml
provider: rettiwt
mode: polling
apiKeys:
  - RETTIWT_COOKIE_KEY_1
  - RETTIWT_COOKIE_KEY_2
interval: 5
```

Rettiwt 固定使用 `7.1.2`。凭据池始终按配置顺序故障转移，不做负载均衡；认证失败的 key 会在当前进程隔离，触发 429 的 key 冷却 60 秒。日志只显示凭据序号，不显示凭据内容。

Rettiwt Cookie API Key 可使用 [X Auth Helper](https://chromewebstore.google.com/detail/x-auth-helper/igpkhkjmpdecacocghpgkghdcmcmpfhp) 从已登录的 X 会话获取。不要退出生成 key 的 X 账号；凭据失效后需要重新生成并更新配置。

### TwitterAPI.io REST 轮询

```yaml
provider: twitterapiio
mode: polling
apiKey: TWITTERAPI_IO_KEY
interval: 5
```

API Key 获取与认证方式见 [TwitterAPI.io Authentication](https://docs.twitterapi.io/authentication)。插件使用用户信息、最新推文和 Advanced Search 接口，所有响应先以文本读取，再由 Zod 严格解码。

### TwitterAPI.io Account Stream WebSocket

```yaml
provider: twitterapiio
mode: websocket
apiKey: DEDICATED_TWITTERAPI_IO_STREAM_KEY
interval: 5
```

WebSocket 模式要求该 API Key 由一个 x-watcher 插件实例独占。插件会把远端 monitor 列表精确同步为本地活跃用户名集合，并使用一个连接访问 Account Stream。连接建立或异常重连后会先通过 REST 按持久化水位补漏，再排空恢复期间缓存的实时事件。

离开 WebSocket 模式前，请先取消全部订阅，或在 TwitterAPI.io 控制台清理远端 monitor。只关闭 WebSocket 不代表停止远端 Stream 套餐。相关接口与行为见 [Account Stream](https://twitterapi.io/twitter-stream)、[WebSocket 指南](https://twitterapi.io/blog/using-websocket-for-real-time-twitter-data)、[Add monitor](https://docs.twitterapi.io/api-reference/endpoint/add_user_to_monitor_tweet)、[List monitors](https://docs.twitterapi.io/api-reference/endpoint/get_user_to_monitor_tweet) 和 [Remove monitor](https://docs.twitterapi.io/api-reference/endpoint/remove_user_to_monitor_tweet)。

## 从 0.1.x 迁移

旧 `auth_key` 配置不再兼容。升级顺序如下：

1. 停止 Koishi。
2. 将旧配置改成上面三种配置之一。
3. 再启动 Koishi。

插件在 `ready` 生命周期幂等迁移原有 `x_watcher` 表：

- 新增 `include_quote`、`include_retweet`，旧订阅都回填为 `false`。
- 新增 `enabled_at`，依次使用旧 `update_at`、`create_at` 或迁移时间。
- 原有频道、订阅状态、正则、媒体开关和 Snowflake 水位保持不变。

迁移失败时不会注册命令，也不会启动轮询或 Stream worker。

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
- 正则只匹配当前动态正文，固定使用 JavaScript `RegExp` 的 `i` 标志。
- 订阅按频道或私聊隔离，频道中的任何成员都可以管理当前频道订阅。

再次执行 `watch` 是完整覆盖，不是局部合并：省略正则会清空旧规则，省略 `-m`、`--quote` 或 `--retweet` 会关闭对应能力。非法正则会在命令阶段拒绝；数据库中意外存在的非法规则按 fail-closed 处理。

新订阅和重新启用的订阅都会先建立最新水位，因此不会补发订阅前历史。`unwatch` 只做软取消；重新启用时会重新建立基线。

示例：

```text
watch OpenAI
watch -m --quote OpenAI GPT|model
watch --quote --retweet @OpenAI release
unwatch OpenAI
xlist
```

## 投递与一致性

- 同一个 X 用户即使被多个频道订阅，每轮也只抓取一次，再按各频道水位、类型开关和正则独立路由。
- 过滤不匹配或类型关闭的动态属于已消费，会推进该订阅水位。
- 消息从旧到新发送；发送失败会停止该订阅本轮处理，不越过失败项。
- 发送成功但水位写入失败时，后续恢复可能产生至少一次重复投递；插件不使用持久化 outbox。
- WebSocket 投递失败会主动断线，至少等待 90 秒后重连并通过 REST 补漏。
- 时间固定显示为上海时区，消息包含分类标题、正文和原文链接。

## 开发与验证

默认测试全部离线，不调用付费 API，也不会修改真实远端 monitor：

```bash
yarn workspace koishi-plugin-x-watcher typecheck
yarn workspace koishi-plugin-x-watcher test
yarn build x-watcher
```

发布 WebSocket 版本前，建议使用专用真实 Stream key 完成以下 smoke test：

1. 确认 key 未被其他实例使用，远端 monitor 列表中没有无关账号。
2. 启动插件并订阅测试账号，确认远端状态最终由 waiting/configuring 进入 active。
3. 分别发布原创、回复、引用和转推，确认默认开关及 `--quote`、`--retweet` 路由正确。
4. 在补漏进行时发布新动态，确认 REST 历史先于缓存的实时事件投递，且 Tweet ID 不重复。
5. 模拟异常断网，在断线期间发布动态，确认至少等待 90 秒重连并补回缺口。
6. 在两个频道订阅同一账号，先取消一个频道，确认远端 monitor 保留；取消最后一个频道后确认远端删除。
7. 将远端状态置于 failed 场景时确认插件报警，但不会反复删除重建。
8. 停用 WebSocket 模式前取消全部订阅，或在控制台完成远端清理。

Rettiwt 分页能力参考 [Rettiwt UserService](https://rishikant181.github.io/Rettiwt-API/classes/UserService.html)。TwitterAPI.io REST 接口参考 [User Info](https://docs.twitterapi.io/api-reference/endpoint/get_user_by_username)、[Last Tweets](https://docs.twitterapi.io/api-reference/endpoint/get_user_last_tweets) 和 [Advanced Search](https://docs.twitterapi.io/api-reference/endpoint/tweet_advanced_search)。
