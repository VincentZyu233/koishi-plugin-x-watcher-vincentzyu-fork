export interface HelpDefaults {
  readonly latestDefaultUsername?: string;
  readonly recentDefaultUsername?: string;
  readonly recentDefaultCount?: number;
}
export interface HelpOption {
  readonly key: string;
  readonly syntax: string;
  readonly description: string;
}
export interface HelpCommand {
  readonly name: string;
  readonly emoji: string;
  readonly syntax: string;
  readonly aliases: ReadonlyArray<string>;
  readonly description: string;
  readonly options: ReadonlyArray<HelpOption>;
  readonly notes: ReadonlyArray<string>;
  readonly examples: ReadonlyArray<string>;
}
export const HELP_COMMON = [
  "用户名可带 @，支持 1～15 个英文字母、数字或下划线；不接受用户主页 URL。",
  "订阅和即时查询均限定当前频道或私聊。查询不创建订阅，也不改变订阅水位。",
  "查询结果和总览帮助遵循当前输出模式；enableQuote 控制是否引用指令消息，与 --quote 包含引用推文不同。",
  "输入具体指令加 --help 查看详细用法，例如 xla --help。",
];

/** 无装饰内容与标识分离，文字和卡片共享内容但不共享 Emoji。 */
export function helpCommands(defaults: HelpDefaults = {}): ReadonlyArray<HelpCommand> {
  const latest = defaults.latestDefaultUsername ?? "amsrntk3";
  const recent = defaults.recentDefaultUsername ?? "OpenAI";
  const count = defaults.recentDefaultCount ?? 5;
  return [
    {
      name: "x-watcher.watch", emoji: "📡", syntax: "xwatch <twitter_username> [regexp]", aliases: ["xwa"],
      description: "订阅或完整更新当前会话的 X/Twitter 用户动态",
      options: [
        { key: "media", syntax: "-m", description: "包含推文媒体，默认关闭；卡片内展示媒体，仅附件模式另发图片，纯文本模式不发图片" },
        { key: "quote", syntax: "--quote", description: "包含引用推文，默认关闭；不是回复时引用指令消息" },
        { key: "retweet", syntax: "--retweet", description: "包含转推，默认关闭" },
      ],
      notes: [
        "twitter_username 必填；regexp 为可选的 JavaScript 正则表达式源码，匹配动态正文，省略时不过滤。",
        "再次执行完整覆盖：省略 regexp 清空过滤，省略 -m、--quote、--retweet 关闭对应功能。",
        "新建或重新启用从当前最新动态开始，不补发历史；更新活跃订阅保留水位。",
      ],
      examples: ["xwa -m --quote --retweet OpenAI", "xwatch OpenAI GPT|模型"],
    },
    {
      name: "x-watcher.unwatch", emoji: "🔕", syntax: "xun <twitter_username>", aliases: ["xunwatch"],
      description: "取消当前频道或私聊的用户订阅", options: [],
      notes: ["用户名必填；软取消并保留记录，不影响其他频道。重新订阅从当前最新动态开始。"],
      examples: ["xun OpenAI"],
    },
    {
      name: "x-watcher.list", emoji: "📋", syntax: "xlist", aliases: ["xls"],
      description: "查看当前频道或私聊的订阅列表", options: [],
      notes: ["包含已取消记录；展示账号、订阅状态、正文过滤正则、媒体开关、引用推文开关和转推开关。"],
      examples: ["xls"],
    },
    {
      name: "x-watcher.latest", emoji: "🆕", syntax: "xlatest [twitter_username]", aliases: ["xla"],
      description: "在当前会话查询最新推文或回复，不创建订阅",
      options: [{ key: "type", syntax: "-t, --type <type>", description: "可选 post＝原创推文、reply＝回复；默认 post，不支持 quote 或 retweet" }],
      notes: [`用户名可省略，当前默认：@${latest}。不改变订阅水位。`],
      examples: ["xla", "xla OpenAI -t reply"],
    },
    {
      name: "x-watcher.recent", emoji: "🕒", syntax: "xrecent [twitter_username]", aliases: ["xre"],
      description: "在当前会话查询最近推文和回复，不创建订阅",
      options: [{ key: "count", syntax: "-c, --count <count>", description: `1～50 的整数，当前默认 ${count}；分别限制推文和回复数量，-c 3 最多返回 3 条推文＋3 条回复` }],
      notes: [`用户名可省略，当前默认：@${recent}。不包含引用和转推，不改变订阅水位；没有 --type 选项。`],
      examples: ["xre", "xre OpenAI -c 3"],
    },
    {
      name: "x-watcher.help", emoji: "❓", syntax: "x-watcher.help", aliases: ["xhe"],
      description: "查看全部指令和用法说明", options: [],
      notes: ["总览帮助遵循当前输出模式；各指令 --help 使用 Koishi 原生文字帮助。"],
      examples: ["xhe", "xla --help"],
    },
  ];
}

export function helpDescription(name: string): string {
  const command = helpCommands().find((item) => item.name === name);
  if (command === undefined) throw new Error(`缺少帮助定义：${name}`);
  return `${command.emoji} ${command.description}`;
}

export function helpOption(name: string, key: string, defaults: HelpDefaults): string {
  const command = helpCommands(defaults).find((item) => item.name === name);
  if (command === undefined) throw new Error(`缺少帮助定义：${name}`);
  const option = command.options.find((item) => item.key === key);
  if (option === undefined) throw new Error(`缺少选项帮助：${name}.${key}`);
  return `⚙️ ${option.description}`;
}

export function formatHelpMessage(defaults: HelpDefaults = {}): string {
  const sections = helpCommands(defaults).map((command) => [
    `${command.emoji} ${command.syntax}`,
    command.description,
    `别名：${command.aliases.join("、")}`,
    ...command.options.map((option) => `  ⚙️ ${option.syntax}  ${option.description}`),
    ...command.notes.map((note) => `ℹ️ ${note}`),
    "示例：",
    ...command.examples,
  ].join("\n"));
  return ["❓ X Watcher 指令帮助", ...sections, `ℹ️ 通用说明\n${HELP_COMMON.join("\n")}`].join("\n\n");
}
