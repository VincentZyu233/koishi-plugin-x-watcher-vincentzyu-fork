import { Logger } from "@koishijs/core";
import Element from "@satorijs/element";
import { describe, expect, it, vi } from "vitest";
import type { OutputMode } from "../src/config";
import { createMessageOutput } from "../src/output";
import type { TakumiRenderer } from "../src/render/takumi";

let activityMediaEnabled = false;
let helpRendered = false;

const renderer: TakumiRenderer = {
  mimeType: "image/jpeg",
  renderActivity: async (_activity, includeMedia) => {
    activityMediaEnabled = includeMedia;
    return Buffer.from("png-activity");
  },
  renderWatcherList: async () => Buffer.from("png-list"),
  renderRecentActivities: async () => [Buffer.from("png-recent-1"), Buffer.from("png-recent-2")],
  renderHelp: async () => {
    helpRendered = true;
    return Buffer.from("png-help");
  },
};

const activity = {
  id: "2099756963429245110",
  authorId: "42",
  username: "thsottiaux",
  fullname: "Tibo",
  kind: "reply" as const,
  text: "@jxnlco bet",
  createdAt: new Date("2026-09-15T07:07:26.000Z"),
  url: "https://x.com/thsottiaux/status/2099756963429245110",
  media: [],
};

describe("消息输出组合", () => {
  it.each<OutputMode>(["text", "text-media", "card", "card-text", "card-text-media"])("模式 %s 精确控制卡片、文字和附件", async (mode) => {
    const attachments = vi.fn(async () => '<img src="data:image/png;base64,YXR0YWNobWVudA=="/>');
    const renderActivity = vi.fn(renderer.renderActivity);
    const output = createMessageOutput(mode, { ...renderer, renderActivity }, new Logger("test"), async image => image, attachments);
    const message = await output.activity(activity, true);
    expect(message.includes("@jxnlco bet")).toBe(mode !== "card");
    expect(renderActivity).toHaveBeenCalledTimes(mode.startsWith("card") ? 1 : 0);
    expect(attachments).toHaveBeenCalledTimes(mode.endsWith("media") ? 1 : 0);
    expect(message.includes("YXR0YWNobWVudA==")).toBe(mode.endsWith("media"));
    expect(message).not.toMatch(/<(p|br|a)(\s|>)/);
  });

  it("只转义一次外部文字，纯文本不下载媒体", async () => {
    const attachments = vi.fn(async () => "");
    const output = createMessageOutput("text", null, new Logger("test"), async image => image, attachments);
    const message = await output.activity({ ...activity, text: '<img src="evil"/> & <hello>' }, true);
    const parsed = Element.parse(message);
    expect(parsed.every(item => item.type === "text")).toBe(true);
    expect(parsed.map(item => item.attrs.content).join("")).toContain('<img src="evil"/> & <hello>');
    expect(attachments).not.toHaveBeenCalled();
  });

  it("关闭订阅媒体时卡片不含媒体且不下载附件", async () => {
    const attachments = vi.fn(async () => "");
    const output = createMessageOutput("card-text-media", renderer, new Logger("test"), async image => image, attachments);
    await output.activity(activity, false);
    expect(activityMediaEnabled).toBe(false);
    expect(attachments).not.toHaveBeenCalled();
  });

  it("卡片失败只回退文字，不擅自增加附件", async () => {
    const attachments = vi.fn(async () => "");
    const output = createMessageOutput("card", { ...renderer, renderActivity: async () => { throw new Error("render failed"); } }, new Logger("test"), async image => image, attachments);
    expect(await output.activity(activity, true)).toContain("@jxnlco bet");
    expect(attachments).not.toHaveBeenCalled();
  });

  it("recent 第二页处理失败不发送已完成的部分卡片", async () => {
    let calls = 0;
    const output = createMessageOutput("card", renderer, new Logger("test"), async image => {
      if (++calls === 2) throw new Error("too large");
      return image;
    });
    const message = await output.recentActivities({ id: "42", username: "test", fullname: "test" }, [activity]);
    expect(message).toContain("@jxnlco bet");
    expect(message).not.toContain("<img");
  });
  it("所有图片出口都使用压缩后的数据与 MIME，包括 recent 的每页", async () => {
    let calls = 0;
    const output = createMessageOutput("card", renderer, new Logger("test"), async () => {
      calls += 1;
      return { buffer: Buffer.from("compressed"), mimeType: "image/webp" };
    });
    const single = await output.activity(activity, true);
    const help = await output.help();
    const recent = await output.recentActivities({ id: "42", username: "test", fullname: "test" }, [activity]);
    for (const message of [single, help, recent]) {
      expect(message).toContain("data:image/webp;base64,Y29tcHJlc3NlZA==");
      expect(message).not.toContain("data:image/jpeg");
    }
    expect(calls).toBe(4);
  });

  it("图片与文字同选时在同一消息中先图后文", async () => {
    const output = createMessageOutput(
      "card-text",
      renderer,
      new Logger("output-test"),
    );
    const message = await output.activity(activity, false);
    expect(message.startsWith("<img")).toBe(true);
    expect(message).toContain("data:image/jpeg;base64,");
    expect(message.indexOf("<img")).toBeLessThan(message.indexOf("Tibo"));
    expect(message).toContain("@jxnlco bet");
    expect(message).not.toContain("<message>");
  });

  it("只选择图片时不附加文字消息", async () => {
    const output = createMessageOutput(
      "card",
      renderer,
      new Logger("output-test"),
    );
    const message = await output.activity(activity, false);
    expect(message).toContain("<img");
    expect(message).not.toContain("@jxnlco bet");
    expect(message).not.toContain("<message>");
  });

  it("将订阅的媒体开关传给 Takumi 单条卡片", async () => {
    const output = createMessageOutput(
      "card",
      renderer,
      new Logger("output-test"),
    );
    await output.activity(activity, true);
    expect(activityMediaEnabled).toBe(true);
  });

  it("引用、图片和文字保持在同一层且顺序固定", async () => {
    const output = createMessageOutput(
      "card-text",
      renderer,
      new Logger("output-test"),
    );
    const content = await output.activity(activity, false);
    const message = `${Element("quote", { id: "trigger-message" })}${content}`;

    expect(message.startsWith('<quote id="trigger-message"/><img')).toBe(true);
    expect(message.indexOf("<quote")).toBeLessThan(message.indexOf("<img"));
    expect(message.indexOf("<img")).toBeLessThan(message.indexOf("Tibo"));
    expect(message).not.toContain("<message>");
  });

  it("最近动态多页图片和文字保持在同一消息中", async () => {
    const output = createMessageOutput(
      "card-text",
      renderer,
      new Logger("output-test"),
    );
    const content = await output.recentActivities({
      id: "42",
      username: "OpenAI",
      fullname: "OpenAI",
    }, [activity]);
    const message = `${Element("quote", { id: "trigger-message" })}${content}`;
    const firstImage = message.indexOf("<img");
    const secondImage = message.indexOf("<img", firstImage + 1);
    expect(message.startsWith('<quote id="trigger-message"/><img')).toBe(true);
    expect(firstImage).toBeLessThan(secondImage);
    expect(secondImage).toBeLessThan(message.indexOf("OpenAI"));
    expect(message).not.toContain("<message>");
  });

  it("帮助在图文同选时同消息内先图后文", async () => {
    const output = createMessageOutput(
      "card-text",
      renderer,
      new Logger("output-test"),
    );
    const message = await output.help();
    expect(helpRendered).toBe(true);
    expect(message.startsWith("<img")).toBe(true);
    expect(message.indexOf("<img")).toBeLessThan(message.indexOf("X Watcher 指令帮助"));
    expect(Element.parse(message).map((item) => item.toString()).join("")).toContain("xwatch &lt;twitter_username&gt; [regexp]");
  });

});
