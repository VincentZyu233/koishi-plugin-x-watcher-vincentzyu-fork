# 🐦 koishi-plugin-x-watcher

[![npm](https://img.shields.io/npm/v/koishi-plugin-x-watcher?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-x-watcher)

在频道或私聊中订阅指定 X/Twitter 用户的原创、回复、引用和转推。插件支持 Rettiwt 轮询、TwitterAPI.io REST 轮询和 TwitterAPI.io Account Stream WebSocket；每个插件实例只运行一种数据源和模式，不会并行抓取或自动降级。

运行环境要求 Node.js 22.17 或更高版本。Node.js 22 和 24 已通过自动化测试；Node.js 26 由兼容性测试矩阵持续验证。固定依赖 `rettiwt-api@7.1.2` 仍将运行时声明限制在 22.x，因此在 Node.js 24 或 26 安装时可能出现 `EBADENGINE` 警告，但不会在未启用 `engine-strict` 时阻止安装。

## ⚙️ 配置

### 🔄 Rettiwt 轮询

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `apiKeys` | `string[]` | 无，必填 | Rettiwt Cookie API Key 池；按配置顺序故障转移 |
| `interval` | `number` | `5` | 检查间隔，单位为分钟，最小值为 `1` |
| `outputFormats` | `("image" \| "text")[]` | `["image", "text"]` | 消息输出格式；两项同时启用时在同一条消息中先图后文。图片由 Takumi WASM 渲染，不依赖 Puppeteer |
| `fontAssetPathRelativeToBaseDir` | `string[]` | `["data", "fonts", "LXGWWenKaiMono-Regular.ttf"]` | Takumi 字体路径片段；依次拼接到 Koishi 根目录 `ctx.baseDir`，当前为只读配置且不会自动下载字体 |
| `activityTypes` | `("post" \| "reply")[]` | `["post", "reply"]` | 自动推送的动态类型；引用和转推仍由 `watch` 命令选项控制 |
| `maxPostCount` | `number` | `10` | 单轮每条订阅最多推送的最新推文数；`0` 或负数表示不限量 |
| `maxReplyCount` | `number` | `10` | 单轮每条订阅最多推送的最新回复数；`0` 或负数表示不限量 |
| `latestDefaultUsername` | `string` | `amsrntk3` | `xlatest` 省略用户名时查询的账号，不需要填写 `@`；默认账号：[https://x.com/amsrntk3](https://x.com/amsrntk3) |
| `recentDefaultUsername` | `string` | `OpenAI` | `xrecent` 省略用户名时查询的账号，不需要填写 `@`；默认账号：[https://x.com/OpenAI](https://x.com/OpenAI) |
| `recentDefaultCount` | `number` | `10` | `xrecent` 默认每类获取数量；表示推文和回复各取此数量，只接受 `1`～`50` 的整数 |
| `enableQuote` | `boolean` | `true` | 指令触发的所有回复是否引用触发消息；主动订阅推送不引用 |
| `enableWaitingHint` | `boolean` | `true` | `xlatest` 和 `xrecent` 查询及渲染期间是否显示临时等待提示；最终回复后自动撤回 |
| `proxy.enabled` | `boolean` | `false` | 是否启用插件显式代理 |
| `proxy.url` | `string` | `http://127.0.0.1:7890` | HTTP/HTTPS 代理地址，同时用于 Rettiwt 与 Node 原生 `fetch` |

代理会同时传给 Rettiwt 的 Axios 请求，并接管其 `x-client-transaction-id`
依赖使用的 Node 原生 `fetch`。由于 Node 的 dispatcher 是进程级资源，启用期间其他
使用全局 `fetch` 的插件也会使用该代理；插件卸载时会在 dispatcher 未被其他组件替换的
前提下恢复原值。当前不支持 SOCKS 代理。

API Key 池始终按配置顺序故障转移，不做负载均衡；认证失败的 Key 会在当前进程隔离，触发 429 的 Key 冷却 60 秒。

Rettiwt Cookie API Key 获取方法：

1. 打开你的浏览器（Chrome/Chromium 内核/Firefox/Firefox 内核），访问 Twitter/X。
2. 按下键盘上的 F12 键，打开浏览器开发者工具。
3. 导航至 应用程序 -> Cookie（Chrome/Chromium 内核）或 存储 -> Cookie（Firefox/Firefox 内核）。
4. 复制以下 3 个字段的值：auth_token、ct0、twid。这些将作为你的身份验证凭据。
5. 进入浏览器开发者工具的控制台 ，执行命令：btoa("auth_token=<auth_token_value>;ct0=<ct0_value>;twid=<twid_value>;")。将token值替换为你复制的对应内容。
6. 输出的字符串即为你的 API_KEY。

## 🔁 从 0.1.x 迁移

旧 `auth_key` 配置不再兼容。：

插件在 `ready` 生命周期幂等迁移原有 `x_watcher` 表：

- 新增 `include_quote`、`include_retweet`，旧订阅都回填为 `false`。
- 新增 `enabled_at`，依次使用旧 `update_at`、`create_at` 或迁移时间。
- 原有频道、订阅状态、正则、媒体开关和 Snowflake 处理进度保持不变。

迁移失败时不会注册命令，也不会启动轮询。

## 🧰 命令

```text
xwatch [-m] [--quote] [--retweet] <username> [regexp]

xun <username>

xunwatch <username>

xlist

xlatest [username] [-t post|reply]

xrecent [username] [-c count]
```

简写别名：`xwa` → `xwatch`、`xun` → `xunwatch`、`xls` → `xlist`、`xla` → `xlatest`、`xre` → `xrecent`。

- 默认订阅原创和回复。
- `--quote` 开启引用推文。
- `--retweet` 开启转推。
- `-m` 附带图片和 GIF；视频继续只提供原文链接。
- 用户名可写成 `username` 或 `@username`。
- 正则只匹配当前动态正文。
- 订阅按频道或私聊隔离，频道中的任何成员都可以管理当前频道订阅。
- `xlatest` 只即时读取并发送指定用户最近的推文或回复，不创建订阅、也不推进订阅水位；用户名省略时查询 `latestDefaultUsername`，`-t` 省略时默认 `post`。
- `xrecent` 合并获取指定用户最近的原创推文和回复，不包含引用或转推，也不改变任何订阅。用户名省略时查询 `recentDefaultUsername`。
- `xrecent -c 10` 表示最多获取 `10` 条推文和 `10` 条回复，而不是总共 `10` 条；命令参数和配置均限制为 `1`～`50` 的整数。
- `xrecent` 图片输出使用 Takumi WASM，每页最多展示 `10` 条动态；多页图片和文字会按“引用、分页图片、文字”的顺序放在同一条消息中。图片附件直接展示，视频和 GIF 展示封面，媒体不可用时显示占位块。
- GIF 和视频在供应商封面不可用时，会尝试调用可选的 FFmpeg 服务提取首帧；未启用 FFmpeg 或抽帧失败时显示原因占位，不影响其他动态。

再次执行 `xwatch` 是完整覆盖，不是局部合并：省略正则会清空旧规则，省略 `-m`、`--quote` 或 `--retweet` 会关闭对应能力。非法正则会在命令阶段拒绝；数据库中意外存在的非法规则按 fail-closed 处理。

新订阅和重新启用的订阅都会先把处理进度设为当前最新动态，因此不会补发订阅前的历史动态。`xun` 和 `xunwatch` 只做软取消；重新启用时会重新设置起始位置。

示例：

```text
xwatch OpenAI
xwatch -m --quote OpenAI GPT|model
xwatch --quote --retweet @OpenAI release
xun OpenAI
xlist
xlatest thsottiaux
xlatest thsottiaux -t reply
xrecent
xrecent OpenAI
xrecent OpenAI -c 20
```

## 📬 投递与一致性

- 同一个 X 用户即使被多个频道订阅，每轮也只抓取一次，再按各频道的处理进度、类型开关和正则独立路由。
- 过滤不匹配或类型关闭的动态属于已消费，会推进该订阅的处理进度。
- 消息从旧到新发送；发送失败会停止该订阅本轮处理，不越过失败项。
- 发送成功但处理进度写入失败时，后续恢复可能产生至少一次重复投递；插件不使用持久化 outbox。
- WebSocket 投递失败会主动断线，至少等待 90 秒后重连并通过 REST 补漏。
- 时间固定显示为上海时区，消息包含分类标题、正文和原文链接。
