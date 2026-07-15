import { describe, expect, it } from "@effect/vitest";
import * as Either from "effect/Either";
import * as Option from "effect/Option";
import {
  ActivityKinds,
  DefaultActivityKinds,
  buildSearchableText,
  parseActivityKinds,
  type XActivity,
} from "../../src/domain/activity";
import {
  parseActivityId,
  parseXHandle,
  parseXUserId,
} from "../../src/domain/identifiers";

/** 从测试输入的 Either 中提取成功值。 */
const expectRight = <A, E>(value: Either.Either<A, E>): A => {
  if (Either.isLeft(value)) throw new Error(String(value.left));
  return value.right;
};

/** 构造覆盖自身正文、嵌套正文与展开链接的规范化动态。 */
const makeActivity = (): XActivity => ({
  id: expectRight(parseActivityId("200")),
  authorId: expectRight(parseXUserId("100")),
  authorHandle: expectRight(parseXHandle("PrimaryUser")),
  authorName: "Primary User",
  kind: "quote",
  createdAtEpochMillis: 1_700_000_000_000,
  body: {
    text: "Own visible text",
    expandedUrls: ["https://example.com/own"],
    media: [],
  },
  replyToId: Option.none(),
  reference: Option.some({
    kind: "quote",
    activityId: expectRight(parseActivityId("199")),
    authorHandle: expectRight(parseXHandle("NestedUser")),
    authorName: "Nested User",
    body: {
      text: "Nested visible text",
      expandedUrls: ["https://example.com/nested"],
      media: [],
    },
    permalink: "https://x.com/nesteduser/status/199",
  }),
  permalink: "https://x.com/primaryuser/status/200",
});

describe("动态种类", () => {
  it("新订阅默认监控原创与回复", () => {
    expect(DefaultActivityKinds).toEqual(["post", "reply"]);
  });

  it("公开全部受支持种类并保持稳定顺序", () => {
    expect(ActivityKinds).toEqual(["post", "reply", "quote", "retweet"]);
  });

  it("解析、规范化并去重命令传入的种类", () => {
    expect(parseActivityKinds(" Reply,post,reply ")).toEqual(["reply", "post"]);
  });

  it("拒绝空集合与未知种类", () => {
    expect(parseActivityKinds(" , ")).toBe("至少选择一种动态类型");
    expect(parseActivityKinds("post,like")).toBe("不支持的动态类型：like");
  });
});

describe("动态可搜索文本", () => {
  it("包含自身、嵌套内容和双方展开后的 URL", () => {
    expect(buildSearchableText(makeActivity())).toBe([
      "Own visible text",
      "https://example.com/own",
      "Nested User",
      "@nesteduser",
      "Nested visible text",
      "https://example.com/nested",
    ].join("\n"));
  });

  it("没有嵌套内容时只包含自身正文与展开 URL", () => {
    const activity = makeActivity();
    const withoutReference: XActivity = { ...activity, reference: Option.none() };

    expect(buildSearchableText(withoutReference)).toBe([
      "Own visible text",
      "https://example.com/own",
    ].join("\n"));
  });
});
