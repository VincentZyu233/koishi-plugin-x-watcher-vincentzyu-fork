import { errorMessage } from "./errors";
import { h, type Logger } from "koishi";
import type { OutputMode } from "./config";
import type { WatcherRecord } from "./database";
import type { XActivity, XUser } from "./domain";
import { formatHelpMessage, helpCommands, type HelpDefaults } from "./help";
import { formatActivityMessage, formatRecentActivitiesMessage, formatWatcherListMessage } from "./formatter";
import type { TakumiRenderer } from "./render/takumi";
import type { ImageProcessor } from "./render/image";

export interface MessageOutput {
  readonly activity: (activity: XActivity, includeMedia: boolean) => Promise<string>;
  readonly watcherList: (watchers: ReadonlyArray<WatcherRecord>) => Promise<string>;
  readonly recentActivities: (user: XUser, activities: ReadonlyArray<XActivity>) => Promise<string>;
  readonly help: (defaults?: HelpDefaults) => Promise<string>;
}
export type AttachmentOutput = (activities: ReadonlyArray<XActivity>, numbered: boolean) => Promise<string>;

export function outputCapabilities(mode: OutputMode) {
  return {
    card: mode === "card" || mode === "card-text" || mode === "card-text-media",
    text: mode !== "card",
    attachments: mode === "text-media" || mode === "card-text-media",
  };
}

/** 命令与后台推送共用模式解析，文字只转义一次。 */
export function createMessageOutput(
  mode: OutputMode,
  renderer: TakumiRenderer | null,
  logger: Logger,
  processImage: ImageProcessor = async (image) => image,
  attachments: AttachmentOutput = async () => "",
): MessageOutput {
  const capabilities = outputCapabilities(mode);
  const compose = async (
    text: string,
    render: (renderer: TakumiRenderer) => Promise<ReadonlyArray<Buffer>>,
    activities: ReadonlyArray<XActivity> = [],
    numbered = false,
  ): Promise<string> => {
    const parts: string[] = [];
    let rendered = false;
    if (capabilities.card && renderer !== null) {
      try {
        const pages = await render(renderer);
        const images: string[] = [];
        for (const buffer of pages) {
          const image = await processImage({ buffer, mimeType: renderer.mimeType });
          logger.debug(`发送渲染图：${image.mimeType}，${image.buffer.length} 字节`);
          images.push(h.image(image.buffer, image.mimeType).toString());
        }
        parts.push(...images);
        rendered = images.length > 0;
      } catch (error) {
        logger.error(`Takumi 渲染或图片处理失败，回退文字：${errorMessage(error instanceof Error ? error : String(error))}`);
      }
    }
    if (capabilities.text || !rendered) parts.push(text);
    if (capabilities.attachments && activities.length > 0) parts.push(await attachments(activities, numbered));
    return parts.filter((part) => part.length > 0).join("\n");
  };
  return {
    activity: (activity, includeMedia) => compose(
      formatActivityMessage(activity),
      async (renderer) => [await renderer.renderActivity(activity, includeMedia)],
      includeMedia ? [activity] : [],
    ),
    recentActivities: (user, activities) => compose(
      formatRecentActivitiesMessage(user, activities),
      (renderer) => renderer.renderRecentActivities(user, activities), activities, true,
    ),
    watcherList: (watchers) => compose(
      formatWatcherListMessage(watchers),
      async (renderer) => watchers.length === 0 ? [] : [await renderer.renderWatcherList(watchers)],
    ),
    help: (defaults) => compose(h.text(formatHelpMessage(defaults)).toString(), async (renderer) => [await renderer.renderHelp(helpCommands(defaults))]),
  };
}

/** 未注入输出服务时只返回文字，不隐式发送远程图片。 */
export const legacyMessageOutput: MessageOutput = {
  activity: async (activity) => formatActivityMessage(activity),
  watcherList: async (watchers) => formatWatcherListMessage(watchers),
  recentActivities: async (user, activities) => formatRecentActivitiesMessage(user, activities),
  help: async (defaults) => h.text(formatHelpMessage(defaults)).toString(),
};
