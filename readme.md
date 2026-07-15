# koishi-plugin-x-watcher

[![npm](https://img.shields.io/npm/v/koishi-plugin-x-watcher?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-x-watcher)

基于 Effect 构建的 Koishi X/Twitter 用户动态订阅插件。在私聊、群聊或其他频道中使用 `watch` 订阅账号，后续的推文、回复、引用和转推会被可靠地排队并推送到发起订阅的频道。

插件提供两种数据源：

- **TwitterAPI.io**：推荐用于生产环境，支持 REST 轮询、Account Stream WebSocket，以及实验性的 Account Stream Webhook。
- **Rettiwt**：基于 X Web API 逆向的实验性轮询数据源，保留用于兼容和备用部署；它不是稳定的官方接口。

TwitterAPI.io 也是独立第三方服务，并非 X Corp. 官方 API。插件不会在两个 provider 或不同 mode 之间自动回退。

## 功能概览

- 订阅粒度为 `平台 + 频道 + X 用户稳定 ID`，同一 X 账号可向多个频道独立推送。
- 支持 `post`、`reply`、`quote`、`retweet` 四类动态；新订阅默认 `post,reply`。
- 使用 RE2 语义的不区分大小写正则过滤，避免灾难性回溯。
- 支持图片、GIF 和视频；不兼容图文混排的适配器会自动降级投递。
- 数据库持久化原始实时事件、投递任务和远端控制任务，可跨重启恢复。
- 以 Snowflake 字符串水位、数据库唯一键和消息 outbox 去重。
- 新建或重新启用订阅时建立最新基线；即使基线请求暂时失败，恢复路由也不会补发订阅前的历史动态。
- 一轮恢复超过 20 条时发送一条跳过摘要，避免离线后刷屏。

## 运行要求

- Koishi `^4.18.7`。
- 必须启用一个 Koishi `database` 服务。
- TwitterAPI.io 的 polling 和 websocket 模式还需要 `@koishijs/plugin-http ^0.6.3` 提供的 Koishi `http` 服务。
- TwitterAPI.io webhook 模式同时需要 `@koishijs/plugin-http ^0.6.3` 与 `@koishijs/plugin-server ^3.2.7`，并需要可公网访问的 HTTPS 入口。
- 本包固定依赖 `rettiwt-api@7.1.2`；该上游包声明 Node.js engine 为 `^22.21.0`。为获得可预期的安装与运行结果，建议使用 Node.js 22.21.x。即使只选择 TwitterAPI.io，包管理器仍可能检查 Rettiwt 的 engine 声明。

缺少模式所需的可选 Koishi 服务时，Koishi 会等待依赖注入；配置校验或运行时启动失败时，插件会记录错误，并且不会注册命令或启动 worker。

## Effect 架构

业务代码不直接依赖 Rettiwt 或 TwitterAPI.io 的返回类型。外部数据先在基础设施边界通过 Effect Schema 解码，再转换为统一的 `XActivity`：

```text
Koishi command / realtime ingress
                │
                ▼
      SubscriptionApplication
                │
        XDataSource port
                │
      ┌─────────┴──────────┐
      ▼                    ▼
TwitterAPI.io Layer    Rettiwt Layer
      │                    │
      └─────────┬──────────┘
                ▼
 XWatcherStore → durable queues → MessageSender
```

主要边界如下：

- `XDataSource`：解析用户、读取最新水位、恢复扫描、补全精简实时事件。
- `RemoteMonitor`：管理 TwitterAPI.io Account Stream 的远端账号 add/remove/list。
- `RealtimeIngress`：接收 WebSocket 实时消息；Webhook 则把 HTTP 请求写入同一持久化入口。
- `XWatcherStore`：订阅、账号水位、去重、原始事件、投递和控制 outbox。
- `ChannelAuthorization` 与 `MessageSender`：隔离 Koishi 平台权限查询和消息发送。
- `SubscriptionApplication`：组合上述能力，实现 `watch`、`unwatch`、`xlist`。

运行时根据显式的 `provider` 和 `mode` 组合对应 Layer，并由 `ManagedRuntime` 管理 scoped fibers 与资源释放。领域值保持不可变，预期错误使用带 `_tag` 的领域错误表达。源码维护约定是：每个函数、service 和 Layer 定义前都应有中文注释说明职责。

目录职责：

```text
src/domain          纯领域模型、ID、过滤和消息计划
src/ports           Effect Context.Tag 服务接口
src/application     订阅用例和后台 worker
src/infrastructure  数据库、Koishi 适配器和 provider Layer
src/runtime.ts      配置校验、Layer 组合和生命周期
```

## 选择数据源与模式

| 配置 | 获取方式 | 实时远端监控 | 额外 Koishi 服务 | 主要边界 |
| --- | --- | --- | --- | --- |
| `twitterapiio / polling` | TwitterAPI.io REST 定时扫描 | 否 | `http` | 最简单；延迟取决于轮询间隔和 API 可用性 |
| `twitterapiio / websocket` | Account Stream WebSocket + REST 恢复 | 是 | `http` | 一把 API key 只能有一个活动 WebSocket；会自动重连 |
| `twitterapiio / webhook` | Account Stream Webhook + REST 恢复 | 是 | `http`、`server` | 实验性；回调地址需手工配置，断流后没有周期性补拉 |
| `rettiwt / polling` | Rettiwt 时间线与回复轮询 | 否 | 无，除必需的 `database` | 实验性逆向接口；Cookie key 可能失效或触发账号风险 |

没有默认 provider，也没有默认 mode。必须同时显式填写二者；插件只启动所选路径，不会因为认证、限流、断线或解码错误切换到另一个数据源。

## 配置

下面是 Koishi YAML 中完整的插件配置片段。若你的实例给插件键添加了实例后缀，只需保留对象内字段不变。

### TwitterAPI.io REST 轮询

```yaml
plugins:
  x-watcher:
    provider: twitterapiio
    mode: polling
    apiKey: "<TWITTERAPI_IO_API_KEY>"
    intervalMinutes: 5
```

- `apiKey`：TwitterAPI.io API key，通过 `x-api-key` 请求头发送。
- `intervalMinutes`：每轮完成后到下一轮的间隔，至少 1 分钟；省略时 Koishi Schema 填入 5。
- REST 根地址为 `https://api.twitterapi.io`；用户解析使用 `/twitter/user/info`，恢复使用带 `includeReplies=true` 的 `/twitter/user/last_tweets`。
- 插件启动后会立即运行一轮恢复，然后等待配置的间隔。轮次不会重叠，账号按顺序恢复。
- 该模式不向 Account Stream 添加远端监控账号，但仍使用同一 `apiKey` 装配远端控制 worker。若从 WebSocket/Webhook 以相同 key 切换到此模式，worker 会自动删除此前由插件持有的远端监控。

### TwitterAPI.io Account Stream WebSocket

```yaml
plugins:
  x-watcher:
    provider: twitterapiio
    mode: websocket
    apiKey: "<TWITTERAPI_IO_API_KEY>"
```

此模式使用同一 key 完成 REST 用户查询、恢复扫描、精简事件补全、Account Stream 远端控制和 WebSocket 鉴权。

WebSocket 连接地址为 `wss://ws.twitterapi.io/twitter/tweet/websocket`，鉴权放在 `x-api-key` 请求头中。

TwitterAPI.io 当前规定一把 API key 只能维持一个活动 WebSocket。不要让多个 x-watcher 实例或其他程序共享同一 key 的 WebSocket；重复连接通常会收到关闭码 `1008`。插件在任何连接结束后等待 90 秒再重连，并在每次连接打开后先执行恢复扫描，再开放实时事件处理闸门。

### TwitterAPI.io Account Stream Webhook（实验性）

```yaml
plugins:
  x-watcher:
    provider: twitterapiio
    mode: webhook
    apiKey: "<TWITTERAPI_IO_API_KEY>"
    publicBaseUrl: "https://bot.example.com"
    callbackToken: "<至少43字符的Base64URL随机令牌>"
```

- `publicBaseUrl` 必须是带主机名且不含凭据、查询参数或片段的 HTTPS URL；允许反向代理使用的路径前缀。
- `callbackToken` 必须匹配 `[A-Za-z0-9_-]{43,}`，也就是至少 32 个随机字节的无填充 Base64URL。可用 Node.js 生成：

  ```bash
  node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
  ```

- 插件注册的固定内部路由为 `/x-watcher/twitterapiio/webhook`。
- 需要在 TwitterAPI.io Account Stream 控制台**手工**填写完整回调地址；插件不会调用供应商接口替你配置 Webhook URL：

  ```text
  https://bot.example.com/x-watcher/twitterapiio/webhook?token=<callbackToken>
  ```

- 如果前面有反向代理，必须把该路径转发给 Koishi `server`，并保留请求体和查询参数。

回调只使用查询参数 `token` 做恒定时间比较，没有实现供应商签名、HMAC 或来源 IP 校验。务必使用 HTTPS，将令牌视为密码，并避免在反向代理访问日志中记录完整查询串。`apiKey` 不应出现在回调 URL 中。

响应语义如下：

| HTTP 状态 | 含义 |
| --- | --- |
| `204` | 事件已成功解码并持久化，或该 envelope 没有需要处理的动态 |
| `400` | 请求体不是当前实现支持的实时事件格式 |
| `401` | 查询令牌缺失或不匹配 |
| `500` | 持久化失败，事件未被确认 |

Webhook 模式启动时执行一次恢复，远端 add 成功 20 分钟后再执行一次账号补拉；之后不会周期轮询，也无法主动感知 Webhook 中断。因此，持续断流、供应商未重投或代理丢请求可能造成缺口。这也是该模式仍标为实验性的主要原因。

### Rettiwt key 池轮询（实验性）

```yaml
plugins:
  x-watcher:
    provider: rettiwt
    mode: polling
    apiKeys:
      - "<RETTIWT_COOKIE_API_KEY_1>"
      - "<RETTIWT_COOKIE_API_KEY_2>"
    intervalMinutes: 5
```

`apiKeys` 至少包含一个非空 key。这里的 key 是 Rettiwt 所称的 Cookie `API_KEY`，本质是 X 登录 Cookie 的编码，权限接近对应账号的登录会话。请按照 [Rettiwt-API 的 Authentication 文档](https://github.com/Rishikant181/Rettiwt-API#authentication) 获取，并像账号密码一样保存；不要提交到 Git、粘贴到日志或发送给他人。

key 池是**按配置顺序故障转移**，不是轮询负载均衡：

- 每次请求从第一把当前可用的 key 开始尝试；第一把健康 key 通常承担全部流量。
- 每把 key 的客户端构造独立收纳同步异常；一把 key 的认证数据损坏时会记录带序号的告警并隔离，后续健康 key 仍可完成 Layer 初始化。只有全部 key 都无法构造时，Layer 才以类型化数据源错误启动失败。
- 识别为 `401`、`403` 或认证错误的 key 会在本进程剩余生命周期内隔离。
- 识别为 `429` 或限流的 key 会冷却 60 秒。
- 其他传输错误会继续尝试下一把 key，但不会给失败 key 设置冷却。
- SDK 内部重试被关闭，由插件统一控制失败和下一轮恢复。

Rettiwt 会并行读取普通时间线与回复时间线，再合并、按 ID 去重并排序。它没有本插件可用的原生实时入口。由于它逆向 X Web API，接口变化、Cookie 过期、限流和账号风控都可能导致不可用；生产部署优先选择 TwitterAPI.io。

## 命令

完整命令和短别名如下：

| 完整命令 | 别名 | 作用 |
| --- | --- | --- |
| `x-watcher.watch <username> [regexp]` | `watch` | 新建、重新启用或局部更新当前频道订阅 |
| `x-watcher.unwatch <username>` | `unwatch` | 软停用当前频道订阅 |
| `x-watcher.list` | `xlist` | 列出当前频道订阅 |

用户名可带或不带开头的 `@`，会被去除空白并转为小写；有效格式为 1～15 个 ASCII 字母、数字或下划线。

### `watch`

```text
watch <username> [regexp] [-m|--media|--no-media] [-t|--types <types>] [--clear-filter]
```

选项：

| 选项 | 作用 |
| --- | --- |
| `[regexp]` | 设置新的 RE2 过滤规则；包含空格时请加引号 |
| `-t, --types <types>` | 设置逗号分隔的动态类型，可选 `post,reply,quote,retweet` |
| `-m, --media` | 将媒体推送设为启用 |
| `--no-media` | 将媒体推送设为关闭 |
| `--clear-filter` | 清除已有过滤规则，不能与 `[regexp]` 同时使用 |

`watch` 是局部 patch，而不是每次覆盖全部设置：

| 场景 | 类型 | 过滤 | 媒体 |
| --- | --- | --- | --- |
| 首次 `watch @user` | 默认 `post,reply` | 无 | 关闭 |
| 已有订阅再次 `watch @user` | 保留 | 保留 | 保留 |
| 提供 `--types` | 替换为明确给出的去重类型集合 | 保留 | 保留 |
| 提供 `[regexp]` | 保留 | 替换并立即校验 | 保留 |
| 提供 `--clear-filter` | 保留 | 清除 | 保留 |
| 提供 `--media` | 保留 | 保留 | 设为开启 |
| 提供 `--no-media` | 保留 | 保留 | 设为关闭 |

`--no-media` 使用 Koishi 对布尔选项的否定语法；完全省略媒体选项才表示“保留”。`unwatch` 是软停用，之后重新 `watch` 也会保留原媒体设置；停用会同时作废当前 pending/processing 投递及其领取令牌，重新启用不会复活旧分片。

`--types` 会去除空白、转为小写并去重；空集合或任意未知类型都会拒绝整次命令。每次 `watch` 都会通过当前 provider 重新解析用户名，即使只是修改已有规则，provider 不可用时也无法完成 patch。

示例：

```text
# 默认订阅普通推文和回复
watch @OpenAI

# 只订阅普通推文、引用和转推
watch @OpenAI --types post,quote,retweet

# 设置过滤规则并启用媒体
watch @OpenAI "release|api|model" --media

# 只更新类型；原过滤规则和媒体设置保持不变
watch @OpenAI -t post,reply

# 清除过滤规则；其他设置保持不变
watch @OpenAI --clear-filter

# 关闭此前启用的媒体；其他设置保持不变
watch @OpenAI --no-media
```

同一平台和频道内，对同一稳定 X 用户 ID 只保留一条订阅。账号改名后，用新用户名执行 `watch` 可以通过稳定 ID 找回原订阅并更新显示名。若旧用户名已被另一个 X 账号占用，插件会拒绝把原订阅静默改指向新账号，并要求先用旧订阅名停用。

### `unwatch`

```text
unwatch @OpenAI
```

此命令软停用订阅，不删除账号、规则或历史记录。尚未开始的投递会被取消；正在发送的单个任务仍可能完成。若该 X 账号在所有频道都没有有效订阅，实时模式会排队删除对应的远端 Account Stream 监控。

`unwatch` 会优先使用本地保存的 handle 定位，因此当前 provider 暂时不可用时，旧 handle 通常仍可用于停用；只有本地找不到时才尝试向 provider 解析稳定用户 ID。

### `xlist`

```text
xlist
xlist --all
```

- 默认只列出当前频道的有效订阅。
- `-a, --all` 同时列出已软停用的订阅。
- 输出包含创建者 ID、动态类型、过滤规则及其错误状态、媒体开关、账号状态、远端同步状态和最近错误。
- 当前实现没有限制谁可以查看本频道的列表，因此频道成员可能看到创建者 ID、过滤规则和故障信息。

## 权限模型

- 任何能调用命令的频道成员都可以创建一条尚不存在的订阅。
- 修改、重新启用或停用已有订阅时，只有原创建者或已识别的频道管理员可以操作。
- 管理员执行更新不会改变持久化的原创建者 ID。
- 私聊中仅原创建者可以管理已有订阅。
- 管理员识别目前只实现：
  - Telegram：`getChatAdministrators` 返回的管理员；
  - Discord：服务器所有者或拥有 `ADMINISTRATOR` 权限位的成员；
  - QQ 频道：默认管理身份组 `2`、`4`、`5`。
- 未实现的平台、找不到当前会话机器人、缺少 guild 信息或管理员查询失败时一律按无管理员权限处理；创建者仍可管理。

管理员查询是失败关闭的。若某适配器升级后内部接口不兼容，不会因此把管理权限开放给普通成员。

## RE2 过滤语义

过滤由 `re2js` 编译，固定为不区分大小写。未使用 `^`/`$` 锚点时，只要可搜索文本中的某一段命中就会推送。

可搜索文本包括：

- 当前动态正文；
- 当前动态中的展开后链接；
- 引用或转推内容的作者显示名、`@用户名`、正文和展开后链接。

媒体 URL、发布时间、消息标题和最终原文链接不参与匹配。类型过滤先于正则过滤；不匹配的动态也会推进订阅水位，之后修改规则不会回头补发。

示例：

```text
watch @OpenAI "api|sdk"
watch @OpenAI "https?://"
watch @OpenAI "#(ai|ml)"
watch @OpenAI "^release"
```

RE2 支持常见的字符类、重复、分组、选择和锚点，但不支持依赖回溯的能力，例如：

- 正向或负向前后查找：`(?=...)`、`(?!...)`、`(?<=...)`、`(?<!...)`；
- 反向引用：`\1`、`\k<name>`。

新规则会在命令执行时编译，错误规则不会被保存。旧版迁移进来的不兼容规则会原样保留并标记 `[规则错误]`，在被替换或 `--clear-filter` 清除前不会产生普通动态投递。

超过 20 条时生成的恢复摘要用于告知数据缺口，不经过类型和正则过滤。

## 基线、水位与恢复

### 无历史基线

首次创建或重新启用订阅时，插件先查询该账号当前最新动态 ID：

- 查询成功：把最新 ID 写为本次订阅的基线；账号首次出现或仍在初始化时也同步账号水位，因此订阅之前的动态不会推送。
- 查询失败：订阅仍会保存，命令提示“等待数据源恢复后初始化（不会补历史）”。若该账号没有其他有效订阅提供现成水位，账号进入 `initializing`，后续 worker 只查询最新 ID 建立基线，不执行历史扫描。若账号因其他频道订阅已经处于 `ready`，新订阅暂用共享水位，但恢复路由仍按本次启用时间排除订阅前动态。
- 已有效的订阅只做规则 patch，不重置水位。

订阅还保存本次启用时间。普通恢复会排除创建时间早于本次启用的动态；实时事件还要求其接收时间不早于本次启用。因此，即使原始事件在数据库中延迟处理，也不会越过新基线被投递。

刚执行 `watch` 后看不到已有推文是预期行为，插件只监控本次订阅启用之后出现的动态。

### 20/21 恢复上限

每次轮询、WebSocket 建连恢复、Webhook 启动恢复或实时 add 后补拉，对外恢复批次最多包含最新的 20 条详情，并保留第 21 条的 ID 与创建时间作为最小路由边界。TwitterAPI.io 最多扫描到第 21 条唯一新动态；Rettiwt 分别扫描普通时间线和回复时间线后合并，只要合并结果超过 20 条就进入溢出路径：

- 新动态不超过 20 条：按 Snowflake ID 从旧到新路由，逐条应用类型和正则规则，再原子推进水位。
- 观察到超过 20 条时，每条订阅独立判断第 21 条边界：如果边界动态也同时位于该订阅的启用时间与水位之后，说明该订阅确实积压超过 20 条，于是只发送一条“离线期间超过 20 条”的摘要；否则不发摘要，而是从保留的最新 20 条详情中逐条路由该订阅启用后的动态。两条路径最终都把水位推进到本轮观察到的最新 ID。

该上限优先避免故障恢复时刷屏，同时防止共享账号的新频道因为其他频道的旧积压收到历史摘要。真正溢出的订阅会明确跳过详细动态；摘要使用去重键，同一订阅和同一恢复水位只会入队一次。数据库最多审计该批保留的 20 条规范化详情。

供应商批次按单条推文解码。一页中的单条脏数据会记录不包含正文的 `DecodeError` 告警并被跳过，同页其他有效动态继续进入恢复；只要脏项仍带合法 Tweet ID，该 ID 也会参与穿越旧水位与推进本轮最新水位，避免每轮永久卡在同一坏项。分页游标重复时会记录告警并终止该轮，等待下轮重新扫描。Rettiwt 普通时间线与回复时间线使用同一策略。

### 实时模式的补拉

- WebSocket 每次连接打开后先运行全账号恢复；恢复结束后才处理已经持久化的实时事件。
- Account Stream 标准 `tweet` 批次也逐项校验；单条无效推文会被审计并跳过，同批有效事件仍先持久化再处理。
- Webhook 启动时运行一次全账号恢复。
- TwitterAPI.io 表示新添加的 Account Stream 账号通常需要最多约 20 分钟完全生效。远端 add 成功后，插件为该账号持久化一次 20 分钟后的 REST 补拉，弥补激活窗口。启动恢复或 WebSocket 提前重连不会消费这个尚未到期的计划；只有到期补拉成功提交后才会清除。
- 上述 20 分钟补拉是一次性的，不是实时模式中的周期轮询。

## 去重、投递与重试

### 持久化去重

- 原始实时事件按 `activity:<tweetId>` 唯一。
- 规范化动态按 `账号 + tweetId` 唯一。
- 投递任务按 `订阅 + dedupeKey` 唯一。
- 远端 add/remove 使用持久化控制 outbox。

这些约束可以抵御重连、重复 Webhook、重复扫描和 worker 重启造成的重复入队，但不能提供端到端 exactly-once。若平台已经接收消息，而进程在记录成功前崩溃或网络响应丢失，同一消息或拆分后的某个分片仍可能重发；实际语义是持久化的 at-least-once 投递。

### 顺序与消息计划

- 每个订阅按最早未终结任务严格头阻塞，较早任务未完成时，后续动态不会越过它。
- 不同订阅之间可以交错处理。
- 消息计划在入队时冻结。之后修改过滤、类型或媒体开关，不会改变已经排队的消息。
- 引用/转推的作者与正文会进入消息；启用媒体时，当前动态和嵌套内容的媒体会按 URL 去重。消息中的发布时间固定使用 `Asia/Shanghai` 时区渲染。
- 投递和远端控制任务租约为 5 分钟，原始实时事件租约为 1 分钟；进程中断后，过期租约可被重新领取。每次领取都会写入新的随机 claim token，并在条件更新后按 token 回读确认；完成、重试和分片进度只接受当前 token，过期 worker 无法覆盖新 worker 的结果。

### 降级投递

启用媒体时，插件依次尝试：

1. 正文、媒体与链接的单条混排消息；
2. 正文、每个媒体、原文链接逐片发送，并持久化分片进度；
3. 仅发送标题和原文链接。

只有错误明确包含“不支持/无效媒体元素/内容过大/媒体类型不兼容”等信号时才进入下一阶段。超时、网络错误、限流、服务端错误，以及无法可靠归类的未知错误都保持当前阶段重试；普通 `400`、`405`、`422` 状态本身不会触发降级。GIF 的 MP4 变体使用视频元素，真实 GIF URL 使用图片元素；最终效果仍取决于 Koishi 适配器能力。

### 退避策略

原始事件补全、消息投递和远端控制失败后使用全抖动指数退避：上界从 5 秒开始翻倍，最大 1 小时，没有固定最大尝试次数。持续失败的订阅头任务会阻塞该订阅的后续消息，直到故障恢复或订阅被停用。

provider 读取错误不会触发 provider/mode 自动切换：轮询等待下一轮，实时补全和 outbox 进入持久化重试，WebSocket 连接则统一在 90 秒后重连。

## TwitterAPI.io Account Stream 远端监控

WebSocket 和 Webhook 模式都会维护远端账号：

- 某 X 账号出现第一条本地有效订阅时，创建 `add` 控制任务。
- add 前先读取远端列表；若同名条目已经存在但数据库无法证明其归属，插件会拒绝接管并且不会发送 add 请求。
- add 请求明确返回 `success` 后再次读取列表；只有操作前不存在同名条目、操作明确成功且操作后恰好出现一个对应 handle/`id_for_user` 时，才会记录为 `active`。
- add 响应丢失、成功后列表核验失败、出现多个候选，或进程在远端提交后、本地完成前崩溃时，插件不会猜测或接管候选 ID，也不会再次盲目 POST。任务进入 `ownership-uncertain` 人工协调终态，`xlist` 会显示候选 ID；这些 ID 的归属未经确认，插件不会自动删除。
- 同一 X 账号的多个本地频道订阅共享一个远端监控，并在本地扇出。
- 最后一条本地有效订阅停用后，使用已记录的远端 ID 创建 `remove` 任务。
- remove 无论返回成功还是错误都会再次读取列表；只有 ID 已不存在才清除本地所有权。操作和列表响应必须包含供应商文档要求的明确状态字段，HTTP 200 空对象不会被视为成功。
- 控制任务失败使用持久化指数退避，`xlist` 会显示 `pending-add`、`active`、`pending-remove`、`error` 等状态。

建议为 x-watcher 使用专用 TwitterAPI.io key，避免其他系统并发创建同名条目而使归属核验产生歧义。出现 `ownership-uncertain` 后，先使用对应 key 在控制台核对并清理候选条目，再对该账号执行一次 `unwatch` 和 `watch`，以显式解除人工协调状态并重新创建 add；普通规则更新不会静默重试。

### 切换 provider、key 或 mode 与 orphan

数据库只保存 API key 的 SHA-256 指纹，不保存原始 TwitterAPI.io key。TwitterAPI.io REST polling 也会保留当前 key 的指纹和远端删除能力，因此切换配置时按以下规则处理已有远端 ID：

- WebSocket/Webhook 切换到 `twitterapiio / polling` 且 `apiKey` 不变时，不产生 orphan。插件保留旧 ID，排队 `remove`，再由 polling 的远端控制 worker 使用同一 key 自动删除；即使切换时 add 正在执行，之后核验得到的 ID 也会先被持久化再进入删除队列。`xlist` 通常会从 `pending-remove` 变为 `inactive`。
- WebSocket 与 Webhook 使用相同 key 互相切换时，继续持有并复用已有远端监控。
- 更换 TwitterAPI.io `apiKey`，或切换到 Rettiwt 等不再提供旧 key 的 provider 时，运行时无法授权删除旧 ID，才会将其记录为 `orphaned-manual-cleanup`。若新配置仍是实时模式，插件会另外使用新 key 排队 add。

旧 key 已不在运行时中，插件不能安全地跨 key 自动删除这些条目。`xlist` 会显示必须使用旧 key 手工清理的远端 ID；请切回旧 key 登录 [Account Stream 管理页](https://twitterapi.io/twitter-stream/manage) 删除它们。当前没有确认并清除本地 orphan 标记的命令，因此即使手工删除成功，提示仍会作为本地审计保留。

若计划更换 key 或切换到不再提供旧 key 的 provider，较安全的操作顺序是：在每个频道停用相关订阅，等待 `xlist --all` 的远端状态变为 `inactive`，再修改配置。这样正常 remove 有机会使用旧 key 完成。仅以相同 key 从实时模式切换到 TwitterAPI.io REST polling 时无需先做这一步，polling worker 会继续完成清理。

## 实时事件边界

- 当前接受 `fast_tweet`、标准 `tweet`、`connected` 和 `ping` envelope。
- 编辑、删除、点赞、关注、置顶和未知事件会被忽略；插件只承诺推文类的 post/reply/quote/retweet。
- 标准 `tweet` 会直接规范化；`fast_tweet` 是精简数据，先持久化，再通过 `/twitter/tweets` 按 ID 补全。补全失败会持续重试。
- WebSocket 中无法解码的单条消息会记录警告并被忽略，不会进入持久化重试。
- WebSocket 消息若已解码但无法写入数据库，插件会主动关闭当前连接；90 秒后重连时先执行恢复扫描，以缩小未确认消息造成的缺口。
- Webhook 只有在整批支持的事件成功持久化后才返回 `204`。
- 水位始终单调递增，但实时路由不单纯以 Tweet ID 水位拒绝事件：只要动态创建时间和事件接收时间都不早于订阅本次启用时间，较小 ID 的乱序事件仍可按唯一事件投递，且不会让水位回退。恢复扫描同时使用 Snowflake 水位与订阅启用时间。

## 从旧版迁移

启动所选运行时前，插件会创建新表，并读取旧版 `x_watcher` 单表数据。迁移具有以下语义：

- 所有旧行在一个数据库事务中按旧 ID 顺序迁移；重复启动是幂等的。
- 旧 `x_watcher` 行不会被修改或删除，可继续用于备份和人工核对。
- 已存在的新表订阅不会被旧值覆盖。
- 稳定 X 用户 ID、handle、显示名、创建者、机器人、频道、active、媒体、过滤规则、时间戳和已有水位会被保留。
- 旧订阅迁移后保留旧版“全部动态”行为，即类型为 `post,reply,quote,retweet`；只有迁移后新建的订阅默认 `post,reply`。
- 多个旧频道订阅指向同一稳定 X 用户 ID 时共享账号记录，并采用保守的较早账号恢复水位；每条订阅仍保留自己的水位。已知与空水位混合时，最新基线只写入空水位订阅，不会覆盖已有订阅水位。
- 空 `last_tweet_id` 迁移为 `initializing`，恢复后只建立最新基线，不补历史。
- 空过滤规则迁移为无过滤；无法由 RE2 编译的旧规则会保留并标记为 invalid，不会静默放宽为“全部推送”。
- 旧表没有 guild/私聊上下文，因此迁移订阅的 `guildId` 为 `null`、`isDirect` 为 `false`；原创建者仍可管理。

任意旧行的核心标识符无效时，整批迁移回滚，旧表保持原样，运行时不会启动。日志会指出类似“旧订阅 `<id>` 无法迁移”的错误；修正或备份并移走无效旧行后再重启。

更换 provider 或 mode 不会清空订阅和 Snowflake 水位。以相同 key 从 TwitterAPI.io 实时模式切换到其 REST polling 时，远端监控会由 polling worker 自动删除；更换 key 或切换到无法使用旧 key 的 provider 时，才需要按照上一节手工处理 Account Stream orphan。

## 数据、隐私与保留

数据库可能保存：

- X 稳定用户 ID、handle、显示名和动态水位；
- Koishi 平台、频道、guild、机器人和订阅创建者 ID；
- 动态类型、过滤规则、媒体开关和 active 状态；
- 规范化动态正文、展开链接、媒体 URL、引用内容和原文链接；
- TwitterAPI.io 原始实时 payload；
- 已冻结的消息计划、投递进度、重试次数和最近错误；
- Account Stream 远端 ID、orphan ID 和 API key 的 SHA-256 指纹。

原始 TwitterAPI.io API key、Rettiwt Cookie key 和 Webhook callback token 来自插件配置，不写入上述业务表；但它们仍可能存在于 Koishi 配置文件、进程内存、备份或外部日志中。Rettiwt key 等价于敏感登录 Cookie，Webhook token 位于 URL 查询串，二者都需要按凭据管理。

清理 worker 每 24 小时执行一次：

- 已 `sent`/`cancelled` 的投递、已 `completed` 的原始事件、已 `completed`/`cancelled` 的远端控制审计，在终结超过 7 天后删除；
- 超过 7 天且已无投递引用的规范化动态随后删除；
- 仍在 pending/processing/retry 的任务不会因超过 7 天被删除；
- 账号、订阅、旧版 `x_watcher` 表和 orphan 提示没有自动过期；`unwatch` 也只是软停用。

插件没有“删除我的数据”命令，也不会因 X 原文删除而同步清除已经保存的内容。部署者应根据自己的隐私政策管理数据库、日志和备份，并确保向目标频道推送公开内容的行为符合平台规则和当地法规。

`xlist` 没有查看权限限制，当前频道成员可以看到创建者 ID、过滤规则和错误状态。不要在过滤规则或频道名称中写入不希望频道成员看到的秘密。

## 故障排查

### 命令没有注册

检查 `x-watcher` 日志：

- `provider` 与 `mode` 是否都已显式填写且组合受支持；
- key 是否非空，`intervalMinutes` 是否至少为 1；
- Webhook 的 `publicBaseUrl` 是否为 HTTPS，token 是否为至少 43 字符的 Base64URL；
- `database` 是否可用；TwitterAPI.io 是否还加载了所需 `http`/`server` 服务；
- 是否有旧表迁移失败。

配置无效或启动失败时，命令与 worker 都不会启用。

### `watch` 无法解析用户

- 确认用户名只包含 1～15 个字母、数字或下划线；开头 `@` 可以保留。
- 检查 TwitterAPI.io key 的认证、余额/套餐、网络和限流状态。
- Rettiwt 模式检查是否所有 key 都被认证隔离或处于 60 秒限流冷却。
- 账号不存在、被删除、受保护或当前 provider 无法访问时也可能失败。
- 使用 Rettiwt 时确认 Node.js 与 `rettiwt-api@7.1.2` 的 engine 要求匹配。

### 订阅成功但没有推送

1. 先运行 `xlist --all`，确认订阅为 `订阅中`，账号不是长期 `initializing`，过滤规则没有 `[规则错误]`。
2. 新订阅不会补历史，请等待本次启用之后的新动态；命令提示基线待初始化时，恢复路由仍会按启用时间隔离历史。
3. 检查 `types` 与 RE2 是否确实匹配；媒体 URL 不参与正则匹配。
4. polling 模式等待当前轮结束和下一次扫描，间隔从一轮完成后计算。
5. 实时模式检查远端状态是否从 `pending-add` 进入 `active`；新远端账号可能需要约 20 分钟生效。
6. WebSocket 若反复出现 `1008`，确认没有另一个进程共享同一 API key；插件会等待 90 秒再连。
7. Webhook 检查控制台回调 URL、反向代理路径、查询 token 和 `204/400/401/500` 响应。Webhook 断流后没有周期恢复。

### 实时远端状态出现 orphan

记录 `xlist` 中的远端 ID，使用产生该 ID 的旧 API key 在 TwitterAPI.io 控制台手工删除。新 key 无法授权删除旧 key 下的条目。清理后本地 orphan 提示仍会保留，因为当前没有清除审计标记的命令。

### 消息卡住或重复

- 单订阅严格头阻塞；一条持续失败的旧任务会挡住后续消息。先修复机器人、频道权限、适配器、网络或限流问题。
- 适配器不支持图文混排时，会看到拆分消息或最终的链接消息，这是自动降级。
- 网络响应丢失或进程在发送后、确认前退出时可能产生重复，这是 at-least-once 的已知边界。
- 停用订阅会取消等待中的任务，但正在发送的任务可能完成一次。

### Rettiwt key 全部不可用

认证失败的 key 会隔离到进程重启；限流 key 会冷却 60 秒。修正 `apiKeys` 后重载插件。不要依赖增加大量 Cookie key 掩盖长期接口变化；Rettiwt 逆向失效时应切换到 TwitterAPI.io。切换 provider 不会清空订阅和水位；数据库中已有的 orphan 仍需按提示使用对应旧 key 手工清理。

## 独立构建与发布

仓库不需要父级 Koishi monorepo 的构建缓存。全新克隆后可直接执行：

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack
```

`npm run build` 会先清理旧产物，再用 TypeScript 生成完整声明树，并用 esbuild 生成 Node.js CommonJS 入口 `lib/index.js`。`npm pack` 会通过 `prepack` 自动重新执行同一构建，因此发布包不依赖工作区中预先存在的 `lib`。

## 供应商文档

- [TwitterAPI.io Authentication](https://docs.twitterapi.io/authentication)
- [TwitterAPI.io Get Last Tweets](https://docs.twitterapi.io/api-reference/endpoint/get_user_last_tweets)
- [TwitterAPI.io Account Stream 介绍与管理](https://twitterapi.io/twitter-stream)
- [TwitterAPI.io Add User To Monitor](https://docs.twitterapi.io/api-reference/endpoint/add_user_to_monitor_tweet)
- [TwitterAPI.io Get Users To Monitor](https://docs.twitterapi.io/api-reference/endpoint/get_user_to_monitor_tweet)
- [TwitterAPI.io Remove User To Monitor](https://docs.twitterapi.io/api-reference/endpoint/remove_user_to_monitor_tweet)
- [TwitterAPI.io WebSocket Client Guide](https://twitterapi.io/blog/using-websocket-for-real-time-twitter-data)
- [Rettiwt-API 项目与认证说明](https://github.com/Rishikant181/Rettiwt-API)

供应商行为、价格、套餐、限额和 payload 可能变化；运维时应以其当前官方文档和控制台为准。
