import { Logger } from "@koishijs/core";
import Element from "@satorijs/element";
import { describe, expect, it } from "vitest";
import { createMessageOutput } from "../src/output";
import type { TakumiRenderer } from "../src/render/takumi";

const renderer: TakumiRenderer = {
  renderActivity: async () => Buffer.from("png-activity"),
  renderWatcherList: async () => Buffer.from("png-list"),
  renderRecentActivities: async () => [Buffer.from("png-recent-1"), Buffer.from("png-recent-2")],
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
  it("图片与文字同选时在同一消息中先图后文", async () => {
    const output = createMessageOutput(
      ["image", "text"],
      renderer,
      new Logger("output-test"),
    );
    const message = await output.activity(activity, false);
    expect(message.startsWith("<img")).toBe(true);
    expect(message.indexOf("<img")).toBeLessThan(message.indexOf("Tibo"));
    expect(message).toContain("@jxnlco bet");
    expect(message).not.toContain("<message>");
  });

  it("只选择图片时不附加文字消息", async () => {
    const output = createMessageOutput(
      ["image"],
      renderer,
      new Logger("output-test"),
    );
    const message = await output.activity(activity, false);
    expect(message).toContain("<img");
    expect(message).not.toContain("@jxnlco bet");
    expect(message).not.toContain("<message>");
  });

  it("引用、图片和文字保持在同一层且顺序固定", async () => {
    const output = createMessageOutput(
      ["image", "text"],
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
      ["image", "text"],
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
});
