# 📜 更新日志

本文件根据 `git log`、各提交的文件差异及当时的 `package.json` 整理，覆盖当前 fork 与上游主分支的全部 24 个历史提交。按来源分组、组内倒序记录；既包含功能更新，也包含修复、文档、构建、合并与回滚。

## 🧭 阅读说明与仓库关系

- 本仓库：[GitHub fork](https://github.com/VincentZyu233/koishi-plugin-x-watcher-vincentzyu-fork) · [Gitee 镜像](https://gitee.com/vincent-zyu/koishi-plugin-x-watcher-vincentzyu-fork)。
- 上游仓库：[Tsuikyuu/koishi-plugin-x-watcher](https://github.com/Tsuikyuu/koishi-plugin-x-watcher)。
- 整理截至 **2026-09-16**：fork 主分支为 `1db5a54`，上游主分支为 `66076a8`，共同祖先为 `2ab9d3f`。
- 日期采用 Git 作者日期；版本采用对应提交中的包版本，不代表已在 npm 发布。部分版本的构建日期后缀与提交日期不同，保留原值。
- 当前 Git 历史没有版本标签。没有独立版本提交的中间开发状态不单独编造版本条目，例如 `0.3.1-beta.4+20260916` 未出现在这两条分支的包版本快照中。
- 上游分叉后的 3 个提交单独列出，**没有直接合并或 cherry-pick**；硬取消功能已在本地未发布修改中手工适配，详见下节。
- 历史版本的默认值、依赖和配置可能已被后续版本替换；当前使用方式以 [README](./readme.md) 为准。

## 🚀 本仓库独立更新

### 🛠️ 未发布 — 独立订阅管理页面与带二次确认的硬取消

- 修复同一 X 账号跨频道订阅的头像不一致：页面按稳定用户 ID 共享非空缓存；头像地址变化或手动刷新时重新加载失败图片，不增加轮询 API 请求。

- 新增 X 风格独立控制台页面：列表与详情双栏、状态标签、搜索与筛选、分页、机器人状态、明暗主题和窄屏抽屉。
- 新增订阅创建、规则编辑、取消、恢复及二次确认永久删除；与指令共享数据和写入队列，管理快照冲突检测不受 worker 水位更新干扰。
- console 成为必需服务，页面与管理接口权限为 3；补齐就绪状态检查和卸载清理，不在页面暴露密钥，不向真实频道发送管理反馈。
- 显式声明不可重用并在 README 强调仅支持单实例；没有增加多实例隔离或协调。

- 参考上游 [f7d8b38](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/f7d8b38) 手工实现 `xun --hard` / `xunwatch --hard`；普通取消仍为软取消。
- 硬取消支持清理当前会话的活跃或已取消记录，增加 `session.prompt(30000)` 二次确认，仅发起人回复 `y` 才删除；`n`、其他输入或超时取消。
- 提示及最终反馈遵守 `enableQuote`，文字使用 Emoji；帮助同时更新 `xhe`、原生 `--help` 和无 Emoji 装饰的 Takumi 卡片。
- 同一会话发起人的并行硬取消被拒绝；确认期间记录发生变化、被删除或插件卸载时，不再执行旧确认的删除。
- 删除后同步远端 Stream，失败提示待重试；其他频道继续订阅同一账号时，沿用现有对账机制保留监控。
- 同步软硬取消说明，并建立本文件的完整历史记录；此条目不宣称已经发布新版本。

### ✨ 0.3.3-beta.6+20260916 — 2026-09-16

提交：[1db5a54](https://github.com/VincentZyu233/koishi-plugin-x-watcher-vincentzyu-fork/commit/1db5a54) — 完善指令帮助与轻微裁剪。

#### ❓ 指令帮助与文字反馈

- 统一 `xhe`、原生 `--help` 与 Takumi 帮助卡片的帮助定义，补齐命令描述、别名、参数含义、选项、用法说明和示例。
- `xlatest` 明确 `--type` 仅支持 `post`、`reply`，默认 `post`；`xrecent` 明确没有 `--type`，`--count` 接受 1～50 的整数，分别限制推文和回复数量。
- 帮助读取插件实例实际配置，展示当前默认用户名和数量，不再仅展示固定默认值。
- 补充用户名规则、正则匹配范围、重复订阅的完整覆盖规则、新建与重新启用不补发历史、软取消保留记录等说明。
- 明确即时查询只在当前会话回复，不创建订阅、不改变订阅处理进度；区分 `--quote` 包含引用推文和 `enableQuote` 引用指令消息。
- 文字帮助增加命令分类 Emoji；成功、失败、参数校验和空结果等文字反馈增加对应标识。
- 最近动态的每条序号前分别使用 📝、💬 区分推文和回复；引用、转推文字分别使用 💭、🔁。
- Takumi 卡片共享完整说明但不添加这些 Emoji 装饰；帮助卡片中的命令示例和通用说明独立分行。

#### ✂️ 裁剪配置与控制台选项

- `takumiMediaCrop` 从布尔开关改成三档单选：`none` 完全不裁剪、`mild` 轻微裁剪、`aggressive` 激进裁剪。
- 默认使用 `mild`：向图片框比例靠拢，居中裁剪，至少保留原图面积的 85%；必要时不铺满，小图不放大。
- `none` 保留完整画面、等比缩小、不放大小图；`aggressive` 居中填满图片框，允许放大，不限制裁剪量。
- 裁剪作用于卡片内配图及媒体封面，不改变独立图片附件；尺寸上限仍为默认 666×333 px。
- 输出模式选项按文本、卡片、附件组合 📝、🖼️、📎；多图布局和裁剪选项增加 Emoji。
- **不兼容变更：旧 `takumiMediaCrop: true/false` 不再接受。** 需要改为新字符串值，或删除字段使用默认 `mild`。

#### 🧪 文档与验证

- README 增加可点击的 GitHub、Gitee 仓库徽章，补充裁剪迁移、命令帮助和 Emoji 说明。
- 增加真实 Koishi help 插件集成测试，覆盖完整命令名及别名、实际默认值、帮助不请求数据源，以及文字与卡片装饰隔离。
- 增加三档裁剪、面积保留比例、小图处理与旧布尔值拒绝测试。
- 该提交交付时完整测试 **159 项通过**，类型检查及 Koishi 工作区构建通过；包含 Codex 协作者署名。

### 🖼️ 0.3.2-beta.5+20260916 — 2026-09-16

提交：[9376edf](https://github.com/VincentZyu233/koishi-plugin-x-watcher-vincentzyu-fork/commit/9376edf) — 重构输出模式、媒体发送及配图布局。

#### 📨 输出模式与命令行为

- 用 `outputMode` 五选一替代旧 `outputFormats` 多选：纯文本、文本＋图片附件、Takumi 卡片、卡片＋文本、卡片＋文本＋图片附件；默认 `card-text`。
- 纯文本模式不再夹带原始图片；附件模式单独处理媒体；卡片渲染或压缩失败时回退文字。
- 重构消息格式化，使用换行文本和图片消息元素，正文进行转义，避免推文中的标签被识别成 Koishi 元素。
- 新增 `x-watcher.help` 和别名 `xhe`，帮助及订阅列表按输出模式选择文字、卡片，不额外附带推文媒体。
- 完善 `xla`、`xre` 当前频道回复与 `enableQuote` 测试，区分即时查询和独立的后台订阅推送。
- 三个数量配置 `recentDefaultCount`、`maxPostCount`、`maxReplyCount` 默认统一为 5。

#### 📎 媒体下载、压缩与错误诊断

- 图片附件由插件下载为二进制再发送，可使用插件代理，不再依赖 OneBot/NapCat 直接访问 X 图片地址。
- 附件下载最多并发三个，保持原顺序；部分附件失败时保留成功结果，并提示失败附件。
- 新增 JPG、PNG、WebP 渲染格式配置；默认 JPG、质量 50。质量配置为普通数字输入，PNG、WebP 的质量参数受当时 Takumi WASM 能力限制。
- FFmpeg 改为必需的 Koishi 服务，可由 `koishi-plugin-ffmpeg` 或 `koishi-plugin-ffmpeg-path` 提供；服务缺失时等待就绪。
- 新增 `takumiImageMaxSizeMiB`，默认每张 5 MiB，同时约束渲染卡片和独立图片附件，不是整条消息总大小限制。
- 未超限保留原格式；超限后用 FFmpeg 转 JPEG，先降质量再缩尺寸，最多尝试 8 次，不发送仍超限的图片。
- 完善 GIF、视频封面处理：缺少可用封面时通过 FFmpeg 提取首帧，缓存结果；失败时显示原因占位。
- 新增错误摘要，先移除 Base64 图片数据再截断长日志，并在可用时保留错误码，方便定位发送失败。

#### 🧩 卡片布局与配置整理

- `xlist` 展示用户头像并调整标题、表头和用户名的字重；支持缓存、占位、每次刷新三种头像策略。
- 新增配图最大宽高、裁剪开关和多图排列配置：默认 666×333 px、不裁剪、两列网格；另有单列纵排和三列网格。
- 不裁剪时按原图比例缩小，不放大小图；多图从左到右、从上到下排列，最后一行不足时靠左，不突然放大。
- 卡片高度随实际内容计算，媒体不可用时保留占位；单图和多图遵守列宽限制。
- 代理配置从嵌套对象改为 `enableProxy`、`proxyUrl`，移除重复层级与说明，支持 HTTP(S) 和 SOCKS5。
- 调整即时查询、图片渲染、代理配置分组和字段顺序；整理图片处理模块为 `render/image.ts`，Stream 测试文件与源码统一为 `stream` 命名。
- 补充媒体、图片限制、布局、错误摘要、代理和输出模式测试；该轮完成时完整测试 **152 项通过**。

### 🔧 0.3.0-beta.3+20260916 — 2026-09-16

提交：[7574e21](https://github.com/VincentZyu233/koishi-plugin-x-watcher-vincentzyu-fork/commit/7574e21) — 修复未安装 FFmpeg 服务包时的构建兼容性。

- 移除对 `koishi-plugin-ffmpeg-path` 的编译期类型依赖和可选 peer 声明。
- 改为插件内部定义 FFmpeg 服务接口，运行时按需读取 `ctx.ffmpeg`，避免构建环境必须安装某一个具体服务提供插件。
- 该版本中 FFmpeg 仍为可选：没有服务时，缺失封面的媒体使用占位降级；后续 `9376edf` 将 FFmpeg 服务改为必需。
- `message-formatter.tsx` 改名为 `formatter.tsx`，`twitter-stream.ts` 改名为 `stream.ts`，同步相关导入。
- 提交记录注明完整测试 **108 项通过**，类型检查、差异检查与工作区构建通过；包含 Codex 协作者署名。

### 🆕 0.3.0-beta.2+20260915 — 2026-09-16

提交：[f7fccab](https://github.com/VincentZyu233/koishi-plugin-x-watcher-vincentzyu-fork/commit/f7fccab) — 新增即时查询及 Takumi 图文推送。版本后缀为 `20260915`，Git 提交日期为次日。

- 新增 `xlatest`、`xrecent`，分别查询最新推文或回复、最近一组推文和回复；支持默认账号、数量配置及命令参数。
- 补充统一的 x 前缀别名：`xwa`、`xun`、`xls`、`xla`、`xre`。
- 增加文字与图片输出选择、引用触发消息开关，以及查询和渲染期间的等待提示；将引用、图片、文字组织在同一条消息中。
- 引入 Takumi WASM，绘制动态卡片、订阅列表和最近动态分页，提供中文字体配置及渲染预览。
- 字体路径通过只读片段配置拼接到 `ctx.baseDir`，默认使用 `data/fonts/LXGWWenKaiMono-Regular.ttf`，不自动下载字体。
- 支持推文图片、视频和 GIF 封面；当时通过可选 FFmpeg 服务提取缺失封面的首帧。
- 新增推文、回复类型开关及单轮推送数量限制，控制长期停用后积累动态的推送量。
- 扩充 Rettiwt、TwitterAPI.io 的动态字段解析和即时查询接口，完善轮询、Stream、消息格式化链路。
- 修复热重载后的重复选项和卸载后异步注册“幽灵命令”等生命周期问题。
- 新增命令、配置、输出、Provider、Worker 和渲染测试；提交记录注明 **108 项测试通过**，类型检查和构建通过；包含 Codex 协作者署名。

### 🌐 0.2.1-beta.1+20260809 — 2026-08-10

提交：[a870685](https://github.com/VincentZyu233/koishi-plugin-x-watcher-vincentzyu-fork/commit/a870685) — fork 包名、显式代理与 Node 兼容验证。版本后缀为 `20260809`，Git 提交日期为次日。

- 包名改为 `koishi-plugin-x-watcher-vincentzyu-fork`，插件描述增加 X、订阅和通知相关 Emoji。
- Node.js 运行要求由 `^22.21.0` 调整为 `>=22.17.0`。
- 新增 Rettiwt HTTP/HTTPS 显式代理，同时覆盖 Axios 请求和依赖使用的 Node 原生 `fetch`。
- 使用 undici `ProxyAgent` 管理进程级 dispatcher，支持多个同代理实例共享引用及卸载恢复。
- 拒绝冲突代理设置，代理日志隐藏认证信息，并说明全局 `fetch` 受影响的范围。
- 新增 Node.js 22、24、26 的 GitHub Actions 测试矩阵，补充配置、代理生命周期和 Rettiwt 参数传递测试。
- 包含 Codex 协作者署名。该提交是本 fork 相对共同祖先的第一项独立改动。

## 🌿 上游分叉后更新（提交未直接合入）

### 🏷️ 上游 0.3.0 — 2026-08-18

涉及三个提交，均不在当前 fork 的祖先链上：

- [66076a8](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/66076a8)：将上游包版本由 `0.2.0` 升为 `0.3.0`。
- [f7d8b38](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/f7d8b38)：为 `unwatch` 新增 `--hard`。默认仍软取消；指定后永久删除当前频道本地订阅记录，再尝试同步远端监控。补充已取消记录也可硬删除等命令测试与用法说明。
- [9d401da](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/9d401da)：从包描述和 README 移除 TwitterAPI.io 及 Stream 相关介绍，使对外说明聚焦 Rettiwt 轮询。该提交改动文档和包描述，不等于删除全部相关源码。

上游提交未直接合入；当前本地未发布修改已参考硬取消实现，并额外增加 y/n 二次确认。上游删除文档和版本升级提交未吸纳；已提交的 `1db5a54` 版本仍只有软取消。

## 🧱 上游共同历史（本仓库已继承）

### ⚙️ 上游 0.2.0 后续整理 — 2026-07-25

- [2ab9d3f](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/2ab9d3f)：公开配置 Schema 限定为 Rettiwt 轮询，默认补齐 `provider: rettiwt`、`mode: polling`，要求非空 `apiKeys`；原多数据源联合表单被注释，相关内部类型和实现保留。同步配置及生命周期测试。此提交为两条分支的共同祖先。
- [c74648e](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/c74648e)：格式化插件入口，整理导入和启动调用等排版，没有新增用户功能。
- [6113720](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/6113720)：更新 README 和控制台使用说明，补充从浏览器 Cookie 获取 Rettiwt 凭据的方法、升级时手动改配置的提示、命令用法及发送目标说明。
- [e8b5cff](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/e8b5cff)：修复源码约束测试的跨平台路径解析，避免平台路径差异影响测试。

### 🏗️ 上游 0.2.0 双数据源重构 — 2026-07-16

提交：[348718e](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/348718e) — 重建数据源、领域模型、存储和运行时。

- 在该版本实现 Rettiwt 轮询、TwitterAPI.io REST 轮询、Account Stream WebSocket；每个实例只运行一种模式，不并行抓取或自动切换数据源。
- 固定使用 `rettiwt-api@7.1.2`，配置从旧 `auth_key` 改为凭据池 `apiKeys`；认证失败凭据在当前进程隔离，429 冷却 60 秒，日志使用凭据序号。
- 用领域模型统一原创、回复、引用、转推、用户名、Snowflake ID、过滤及错误结果；用 Zod 解码外部数据。
- 拆分 Provider、服务接口、worker、runtime、数据库及配置模块，替代早期 API client 和 tweet checker 组织方式。
- 订阅按频道或私聊隔离；同一账号只抓取一次，再按各订阅类型、正则和处理进度独立投递。
- 重复订阅完整覆盖规则；非法正则在命令阶段拒绝，数据库中的异常过滤规则按不放行处理。
- 新订阅和重新启用先建立最新处理进度，不补发订阅之前的历史；取消订阅采用软取消。
- 消息按旧到新发送，失败时停止该订阅当轮处理，不越过失败动态；发送成功但进度保存失败时仍可能重复投递，不使用持久化 outbox。
- Account Stream 同步本地活跃订阅到远端 monitor；连接恢复先 REST 补漏，再排空实时缓存；投递失败后断线并等待至少 90 秒重连。
- 为旧 `x_watcher` 表幂等增加 `include_quote`、`include_retweet`、`enabled_at`，保留原订阅与处理进度；迁移失败时不启动命令及 worker。
- 加入离线 Vitest 测试、测试类型检查和源码语法约束，覆盖命令、数据库、领域、Provider、Stream、运行时、worker 与生命周期。
- **历史兼容提示：** 从 0.1.x 升级时，旧 `auth_key` 配置不能直接沿用；本节的多数据源配置入口后来在 `2ab9d3f` 被收窄。

### ↩️ Effect 重构尝试及完整回滚 — 2026-07-15

- [ebe88d4](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/ebe88d4)：尝试基于 Effect 重建插件，当时包版本改为 `0.2.0`。引入应用层、领域层、端口和基础设施分层，涉及订阅授权、投递队列、重试、恢复、远端监控协调、数据库迁移，以及 Rettiwt、TwitterAPI.io 和 WebSocket 适配；同步大量测试与文档。
- [4411a74](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/4411a74)：完整撤销上述 Effect 重构，恢复先前结构和 `0.1.4` 包版本。
- 这是一组已回滚的历史变更，不能视为当前插件依赖 Effect 或具备该尝试中的队列、授权等能力。次日的 `348718e` 是另一套重构实现。

### 📖 上游 0.1.4 — 2025-07-22

- [e5d9b46](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/e5d9b46)：更新媒体订阅用法示例，并将包版本升至 `0.1.4`。
- [d748e5b](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/d748e5b)：调整示例为 `watch -m <twitter_username> [regexp]`，增加包含图片的订阅例子，说明当时媒体推送对图文混排平台的要求。
- [9a965b6](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/9a965b6)：合并远端 `master` 分支，归并同期用法示例更新；不另外计为一项用户功能。

### 📷 上游 0.1.3 — 2025-07-21

- [de6e842](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/de6e842)：新增媒体推送能力，为订阅增加 `-m` 开关与数据库媒体字段，将消息格式化模块改为 TSX，并将开关传入动态发送链路。
- [5905a8d](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/5905a8d)：修复构建错误，显式增加 `@satorijs/element` 依赖，将 `Element` 导入从 JSX runtime 调整为包主入口。

### 🐛 上游 0.1.2 — 2025-07-21

提交：[2fc80fd](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/2fc80fd) — 修复置顶推文误判。

- 获取最新推文时不再直接认定时间线第一条最新，改为比较 Snowflake ID，必要时使用发布时间比较，避免置顶旧推文干扰起始进度。
- 调整 Rettiwt 时间线请求参数，规避当时对数量参数的疑似异常。
- 删除部分冗余错误处理，包括错误文本触发的固定五分钟等待；整理日志入口。
- 使用 `Tweet` 类型替代部分宽泛类型，简化发布时间读取，移除旧的 Snowflake 时间解析回退函数。

### 🌱 上游 0.0.1 — 2025-07-17～2025-07-18

- [0b05b53](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/0b05b53)（07-17）：初始化插件骨架、TypeScript 配置、包元数据、README、Git 忽略规则和编辑器约定，包版本为 `0.0.1`。
- [c4777b3](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/c4777b3)（07-18）：完成基本订阅功能。加入 Rettiwt 客户端、数据库记录、`watch` / `unwatch` / `xlist`、定期检查、正则过滤、消息格式化及工具函数；README 补充凭据获取、频道隔离和使用示例。
- [8267ad4](https://github.com/Tsuikyuu/koishi-plugin-x-watcher/commit/8267ad4)（07-18）：补充上游 Git 仓库地址、贡献者信息及 Koishi `database` 必需服务声明。

## 🔎 历史核对方式

后续维护可使用以下命令继续核对；查看上游新提交不代表已将其合入本仓库：

```bash
git fetch origin
git log --graph --oneline --decorate HEAD origin/master
git log --reverse --format=fuller HEAD origin/master
git log HEAD..origin/master --oneline
git show <commit> --stat
git show <commit>:package.json
```

新增记录时保留来源、版本、日期及提交链接；遇到回滚或未合入的上游功能应明确标注，不将开发讨论、未提交中间版本或测试计划写成已发布事实。
