import { Context, Logger, Schema } from "koishi";
import { initializeDatabase } from "./database-schema";
import { registerCommands } from "./commands";
import { checkTweetUpdates } from "./tweet-checker";

export const name = "x-watcher";

export const usage = `
### 如何获取apiKey
1. 从 Chrome 应用商店安装 [X Auth Helper extension](https://chromewebstore.google.com/detail/x-auth-helper/igpkhkjmpdecacocghpgkghdcmcmpfhp) 扩展程序，并允许其在无痕模式下运行。
2. 切换至无痕模式后登录 Twitter/X 账号。
3. 成功登录后，在仍处于 Twitter/X 页面的状态下，点击浏览器扩展图标打开扩展弹窗。
4. 点击 \`Get Key\` 按钮, 扩展将生成 \`API_KEY\` 并显示在文本区域中。
5. 通过点击 \`API_KEY\` 按钮或手动从文本区域复制 \`API_KEY\` 。
6. 此时可以关闭浏览器，但不要主动退出登录。请注意，由于处于无痕模式，您并未执行“退出登录”操作，因此虽然浏览器会话会被清除，但 \`API_KEY\` 仍然保持有效。
7. 保存 \`API_KEY\` 以供使用。

### 如何使用
- watch twitter_username - 订阅推文，twitter_username 为推特用户名，即@后的部分
- unwatch twitter_username - 取消订阅推文
- xlist - 查看订阅列表

在哪里使用 watch 命令，推文的更新就会发送到哪里

如果已有科学上网环境，但使用watch命令时总是“获取推特用户名失败”，大概是 nodejs 版本过低，请使用 nodejs21 及以上版本

更多信息请前往存储库或npm阅读自述文件
`;

export const inject = { required: ["database"] };

export interface Config {
  interval: number;
  auth_key: string;
}

export const Config: Schema<Config> = Schema.object({
  interval: Schema.number()
    .default(5)
    .min(1)
    .description("检查推文更新间隔时间(分钟)"),
  auth_key: Schema.string()
    .role("secret")
    .description("推特API密钥")
    .required(),
});

export const logger = new Logger("x-watcher");

export function apply(ctx: Context, config: Config) {
  // 初始化数据库
  try {
    initializeDatabase(ctx);
  } catch (error) {
    logger.error("数据库初始化失败", error);
    return;
  }

  // 注册命令
  registerCommands(ctx, config);

  // 启动推文检查定时器
  ctx.setInterval(async () => {
    await checkTweetUpdates(ctx, config);
  }, config.interval * 60 * 1000); // 使用配置的间隔时间

  logger.info(`推文检查定时器已启动，间隔时间: ${config.interval} 分钟`);
}
