export interface HelpOption {
  readonly syntax: string;
  readonly description: string;
}

export interface HelpCommand {
  readonly syntax: string;
  readonly aliases: ReadonlyArray<string>;
  readonly description: string;
  readonly options: ReadonlyArray<HelpOption>;
}

export const HELP_COMMANDS: ReadonlyArray<HelpCommand> = [
  {
    syntax: "xwatch <twitter_username> [regexp]",
    aliases: ["xwa"],
    description: "订阅 X/Twitter 用户动态",
    options: [
      { syntax: "-m", description: "推送时包含媒体" },
      { syntax: "--quote", description: "包含引用推文" },
      { syntax: "--retweet", description: "包含转推" },
    ],
  },
  {
    syntax: "xun <twitter_username>",
    aliases: ["xunwatch"],
    description: "取消当前频道的用户订阅",
    options: [],
  },
  {
    syntax: "xlist",
    aliases: ["xls"],
    description: "查看当前频道订阅列表",
    options: [],
  },
  {
    syntax: "xlatest [twitter_username]",
    aliases: ["xla"],
    description: "在当前频道查询最新推文或回复，不创建订阅",
    options: [{ syntax: "-t, --type <post|reply>", description: "选择动态类型，默认 post" }],
  },
  {
    syntax: "xrecent [twitter_username]",
    aliases: ["xre"],
    description: "在当前频道查询最近推文和回复，不创建订阅",
    options: [{ syntax: "-c, --count <count>", description: "每类获取数量，范围 1～50" }],
  },
];

/** 文字与图片帮助共用同一份命令定义，避免文案和参数漂移。 */
export function formatHelpMessage(): string {
  const sections = HELP_COMMANDS.map((command) => {
    const lines = [
      command.syntax,
      command.description,
      `别名：${command.aliases.join("、")}`,
    ];
    for (const option of command.options) {
      lines.push(`  ${option.syntax}  ${option.description}`);
    }
    return lines.join("\n");
  });
  return ["X Watcher 指令帮助", ...sections].join("\n\n");
}
