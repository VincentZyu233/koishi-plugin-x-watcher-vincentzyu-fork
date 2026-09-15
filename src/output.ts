import Element from "@satorijs/element";
import type { Logger } from "koishi";
import type { OutputFormat } from "./config";
import type { WatcherRecord } from "./database";
import type { XActivity, XUser } from "./domain";
import {
  activityMessageElements,
  formatActivityMessage,
  formatRecentActivitiesMessage,
  formatWatcherListMessage,
  recentActivitiesMessageElements,
  watcherListMessageElements,
} from "./formatter";
import type { TakumiRenderer } from "./render/takumi";

export interface MessageOutput {
  readonly activity: (activity: XActivity, includeMedia: boolean) => Promise<string>;
  readonly watcherList: (watchers: ReadonlyArray<WatcherRecord>) => Promise<string>;
  readonly recentActivities: (
    user: XUser,
    activities: ReadonlyArray<XActivity>,
  ) => Promise<string>;
}

function imageElement(buffer: Buffer): Element {
  return Element("img", { src: `data:image/png;base64,${buffer.toString("base64")}` });
}

/** 序列化同一条消息内的并列元素，避免 message 节点触发适配器拆分发送。 */
function serializeElements(elements: ReadonlyArray<Element>): string {
  return elements.map((element) => element.toString()).join("");
}

export function createMessageOutput(
  formats: ReadonlyArray<OutputFormat>,
  renderer: TakumiRenderer,
  logger: Logger,
): MessageOutput {
  const imageEnabled = formats.includes("image");
  const textEnabled = formats.includes("text");

  const renderImage = async (operation: () => Promise<Buffer>): Promise<Element | null> => {
    if (!imageEnabled) return null;
    try {
      return imageElement(await operation());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Takumi 图片渲染失败，已回退到文字：${message}`);
      return null;
    }
  };

  return {
    activity: async (activity, includeMedia) => {
      const rendered = await renderImage(() => renderer.renderActivity(activity));
      if (rendered === null) return formatActivityMessage(activity, includeMedia);
      if (!textEnabled) return rendered.toString();
      const message = serializeElements(
        activityMessageElements(activity, includeMedia),
      );
      return `${rendered}${Element("br")}${message}`;
    },
    watcherList: async (watchers) => {
      if (watchers.length === 0) return formatWatcherListMessage(watchers);
      const rendered = await renderImage(() => renderer.renderWatcherList(watchers));
      if (rendered === null) return formatWatcherListMessage(watchers);
      if (!textEnabled) return rendered.toString();
      const message = serializeElements(watcherListMessageElements(watchers));
      return `${rendered}${Element("br")}${message}`;
    },
    recentActivities: async (user, activities) => {
      let pages: ReadonlyArray<Buffer> = [];
      if (imageEnabled) {
        try {
          pages = await renderer.renderRecentActivities(user, activities);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`Takumi 最近动态渲染失败，已回退到文字：${message}`);
        }
      }
      const images = pages.map(imageElement);
      if (images.length === 0) return formatRecentActivitiesMessage(user, activities);
      const rendered = serializeElements(images);
      if (!textEnabled) return rendered;
      const message = serializeElements(recentActivitiesMessageElements(user, activities));
      return `${rendered}${Element("br")}${message}`;
    },
  };
}

export const legacyMessageOutput: MessageOutput = {
  activity: async (activity, includeMedia) => formatActivityMessage(activity, includeMedia),
  watcherList: async (watchers) => formatWatcherListMessage(watchers),
  recentActivities: async (user, activities) => formatRecentActivitiesMessage(user, activities),
};
