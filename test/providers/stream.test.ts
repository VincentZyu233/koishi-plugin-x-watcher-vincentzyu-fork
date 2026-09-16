import { describe, expect, it } from "vitest";

import type {
  ActivityKind,
  Result,
  SourceError,
  XActivity,
} from "../../src/domain";
import type { StreamHandlers } from "../../src/services";
import {
  createTwitterAccountStreamServiceWithTransport,
  decodeTwitterStreamFrame,
} from "../../src/providers/stream";
import type {
  TwitterStreamHttpResponse,
  TwitterStreamSocketHandlers,
  TwitterStreamTransport,
  TwitterStreamTransportSocket,
} from "../../src/providers/stream";

interface RecordedRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, string>> | null;
}

interface CloseCall {
  readonly code: number;
  readonly reason: string;
}

class FakeSocket implements TwitterStreamTransportSocket {
  private handlers: TwitterStreamSocketHandlers | null = null;
  readonly closeCalls: CloseCall[] = [];

  attach(handlers: TwitterStreamSocketHandlers): void {
    this.handlers = handlers;
  }

  private attachedHandlers(): TwitterStreamSocketHandlers {
    if (this.handlers === null) throw new Error("socket 尚未建立");
    return this.handlers;
  }

  emitText(value: object): void {
    this.attachedHandlers().onText(JSON.stringify(value));
  }

  emitRawText(value: string): void {
    this.attachedHandlers().onText(value);
  }

  emitError(): void {
    this.attachedHandlers().onError();
  }

  emitClosed(code: number, reason: string): void {
    this.attachedHandlers().onClosed(code, reason);
  }

  close(code: number, reason: string): void {
    this.closeCalls.push({ code, reason });
  }
}

interface FakeTransportFixture {
  readonly transport: TwitterStreamTransport;
  readonly requests: RecordedRequest[];
  readonly socket: FakeSocket;
}

function createFakeTransport(
  responses: ReadonlyArray<TwitterStreamHttpResponse | Error>,
): FakeTransportFixture {
  const requests: RecordedRequest[] = [];
  const socket = new FakeSocket();
  let responseIndex = 0;

  const nextResponse = (): TwitterStreamHttpResponse => {
    const response = responses[responseIndex];
    if (response === undefined) throw new Error("缺少测试 HTTP 响应");
    responseIndex += 1;
    if (response instanceof Error) throw response;
    return response;
  };

  const transport: TwitterStreamTransport = {
    getText: async (url, headers) => {
      requests.push({ method: "GET", url, headers, body: null });
      return nextResponse();
    },
    postText: async (url, headers, body) => {
      requests.push({ method: "POST", url, headers, body });
      return nextResponse();
    },
    openSocket: (url, headers, handlers) => {
      requests.push({ method: "GET", url, headers, body: null });
      socket.attach(handlers);
      return socket;
    },
  };

  return { transport, requests, socket };
}

function okResponse(body: object): TwitterStreamHttpResponse {
  return { status: 200, body: JSON.stringify(body), retryAfter: null };
}

function unwrap<Value, ErrorValue>(
  result: Result<Value, ErrorValue>,
): Value {
  if (!result.ok) throw new Error("测试期望成功结果");
  return result.value;
}

function first<Value>(values: ReadonlyArray<Value>): Value {
  const value = values[0];
  if (value === undefined) throw new Error("测试期望非空数组");
  return value;
}

function fastEvent(
  type: string,
  id = "1900000000000000001",
  media: ReadonlyArray<string> = ["https://pbs.twimg.com/media/example.jpg"],
): object {
  return {
    event_type: "fast_tweet",
    timestamp: 1_770_000_000_100,
    tweet: {
      id,
      screen_name: "OpenAI",
      display_name: "OpenAI",
      user_id: "4398626122",
      text: `fast ${type}`,
      type,
      created_ms: 1_770_000_000_000,
      media,
    },
  };
}

function standardTweet(
  id: string,
  additions: Readonly<Record<string, object | string | boolean | null>> = {},
): object {
  return {
    id,
    text: `standard ${id}`,
    author: {
      id: "4398626122",
      username: "OpenAI",
      name: "OpenAI",
    },
    createdAt: "Sat Mar 15 05:31:28 +0000 2025",
    ...additions,
  };
}

describe("TwitterAPI.io monitor REST service", () => {
  it("严格解码列表并映射 0～3 状态", async () => {
    const fixture = createFakeTransport([
      okResponse({
        status: "success",
        msg: "ok",
        data: [
          {
            id_for_user: "monitor-0",
            x_user_screen_name: "WaitingUser",
            monitor_tweet_config_status: 0,
            x_user_id: 1,
          },
          {
            id_for_user: "monitor-1",
            x_user_screen_name: "ConfigUser",
            monitor_tweet_config_status: 1,
            x_user_id: 2,
          },
          {
            id_for_user: "monitor-2",
            x_user_screen_name: "ActiveUser",
            monitor_tweet_config_status: 2,
            x_user_id: 3,
          },
          {
            id_for_user: "monitor-3",
            x_user_screen_name: "FailedUser",
            monitor_tweet_config_status: 3,
            x_user_id: 4,
          },
        ],
      }),
    ]);
    const service = createTwitterAccountStreamServiceWithTransport(
      fixture.transport,
      "secret-key",
    );

    const monitors = unwrap(await service.listMonitors());

    expect(monitors).toEqual([
      { idForUser: "monitor-0", handle: "waitinguser", status: "waiting" },
      {
        idForUser: "monitor-1",
        handle: "configuser",
        status: "configuring",
      },
      { idForUser: "monitor-2", handle: "activeuser", status: "active" },
      { idForUser: "monitor-3", handle: "faileduser", status: "failed" },
    ]);
    expect(first(fixture.requests)).toEqual({
      method: "GET",
      url:
        "https://api.twitterapi.io/oapi/x_user_stream/get_user_to_monitor_tweet",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "secret-key",
      },
      body: null,
    });
  });

  it("使用官方字段添加和删除 monitor", async () => {
    const fixture = createFakeTransport([
      okResponse({ status: "success", msg: "added" }),
      okResponse({ status: "success", msg: "removed" }),
    ]);
    const service = createTwitterAccountStreamServiceWithTransport(
      fixture.transport,
      "secret-key",
    );

    expect(await service.addMonitor("@OpenAI")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await service.removeMonitor("monitor-id")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(fixture.requests).toEqual([
      {
        method: "POST",
        url:
          "https://api.twitterapi.io/oapi/x_user_stream/add_user_to_monitor_tweet",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": "secret-key",
        },
        body: { x_user_name: "OpenAI" },
      },
      {
        method: "POST",
        url:
          "https://api.twitterapi.io/oapi/x_user_stream/remove_user_to_monitor_tweet",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": "secret-key",
        },
        body: { id_for_user: "monitor-id" },
      },
    ]);
  });

  it("拒绝无效状态、API error 与非法输入", async () => {
    const invalidFixture = createFakeTransport([
      okResponse({
        status: "success",
        msg: "ok",
        data: [
          {
            id_for_user: "monitor",
            x_user_screen_name: "OpenAI",
            monitor_tweet_config_status: 4,
          },
        ],
      }),
    ]);
    const invalidService = createTwitterAccountStreamServiceWithTransport(
      invalidFixture.transport,
      "secret-key",
    );
    const invalidStatus = await invalidService.listMonitors();
    if (invalidStatus.ok) throw new Error("无效状态不应解码成功");
    expect(invalidStatus.error.kind).toBe("decode");

    const errorFixture = createFakeTransport([
      okResponse({ status: "error", msg: "remote failure" }),
    ]);
    const errorService = createTwitterAccountStreamServiceWithTransport(
      errorFixture.transport,
      "secret-key",
    );
    const remoteError = await errorService.listMonitors();
    if (remoteError.ok) throw new Error("API error 不应成功");
    expect(remoteError.error.kind).toBe("unavailable");

    const noRequestFixture = createFakeTransport([]);
    const noRequestService = createTwitterAccountStreamServiceWithTransport(
      noRequestFixture.transport,
      "secret-key",
    );
    const badHandle = await noRequestService.addMonitor("not valid!");
    const badId = await noRequestService.removeMonitor("   ");
    if (badHandle.ok || badId.ok) throw new Error("非法输入不应成功");
    expect(badHandle.error.kind).toBe("decode");
    expect(badId.error.kind).toBe("decode");
    expect(noRequestFixture.requests).toEqual([]);
  });

  it("映射认证和限流 HTTP 状态", async () => {
    const fixture = createFakeTransport([
      { status: 401, body: "unauthorized", retryAfter: null },
      { status: 429, body: "limited", retryAfter: "0" },
      { status: 429, body: "limited", retryAfter: "0" },
      { status: 429, body: "limited", retryAfter: "0" },
    ]);
    const service = createTwitterAccountStreamServiceWithTransport(
      fixture.transport,
      "secret-key",
    );

    const authentication = await service.listMonitors();
    const rateLimit = await service.listMonitors();
    if (authentication.ok || rateLimit.ok) {
      throw new Error("错误 HTTP 状态不应成功");
    }
    expect(authentication.error.kind).toBe("authentication");
    expect(rateLimit.error.kind).toBe("rate-limit");
    expect(rateLimit.error.retryAfterMilliseconds).toBe(0);
  });

  it("monitor REST 对网络错误、429 和 5xx 最多额外重试两次", async () => {
    const networkFixture = createFakeTransport([
      new Error("offline"),
      new Error("offline"),
      okResponse({ status: "success", msg: "ok", data: [] }),
    ]);
    const networkService = createTwitterAccountStreamServiceWithTransport(
      networkFixture.transport,
      "secret-key",
    );
    expect((await networkService.listMonitors()).ok).toBe(true);
    expect(networkFixture.requests).toHaveLength(3);

    const statusFixture = createFakeTransport([
      { status: 503, body: "unavailable", retryAfter: "0" },
      { status: 429, body: "limited", retryAfter: "0" },
      okResponse({ status: "success", msg: "ok", data: [] }),
    ]);
    const statusService = createTwitterAccountStreamServiceWithTransport(
      statusFixture.transport,
      "secret-key",
    );
    expect((await statusService.listMonitors()).ok).toBe(true);
    expect(statusFixture.requests).toHaveLength(3);
  });
});

describe("TwitterAPI.io Account Stream frame decoder", () => {
  it("映射 fast lane 的五种受支持类型", () => {
    const cases: ReadonlyArray<{
      readonly source: string;
      readonly expected: ActivityKind;
    }> = [
      { source: "post", expected: "post" },
      { source: "reply", expected: "reply" },
      { source: "thread", expected: "reply" },
      { source: "quote", expected: "quote" },
      { source: "repost", expected: "retweet" },
    ];

    for (const item of cases) {
      const frame = unwrap(
        decodeTwitterStreamFrame(JSON.stringify(fastEvent(item.source))),
      );
      if (frame.type !== "activities") {
        throw new Error("受支持 fast_tweet 应产生动态");
      }
      expect(first(frame.activities).kind).toBe(item.expected);
      expect(first(frame.activities)).toMatchObject({
        username: "OpenAI",
        fullname: "OpenAI",
        authorId: "4398626122",
        media: [
          { kind: "image", url: "https://pbs.twimg.com/media/example.jpg" },
        ],
      });
    }
  });

  it("忽略 fast lane 不支持的动作", () => {
    expect(
      unwrap(decodeTwitterStreamFrame(JSON.stringify(fastEvent("like")))),
    ).toEqual({
      type: "ignored",
      warning: "TwitterAPI.io fast_tweet 类型不受支持，已忽略",
    });
    expect(
      unwrap(decodeTwitterStreamFrame(JSON.stringify(fastEvent("follow")))),
    ).toEqual({
      type: "ignored",
      warning: "TwitterAPI.io fast_tweet 类型不受支持，已忽略",
    });
  });

  it("按 Twitter 媒体路径区分 fast lane 动图与普通视频", () => {
    const gifFrame = decodeTwitterStreamFrame(JSON.stringify(fastEvent(
      "post",
      "1900000000000000001",
      ["https://video.twimg.com/tweet_video/example.mp4"],
    )));
    const videoFrame = decodeTwitterStreamFrame(JSON.stringify(fastEvent(
      "post",
      "1900000000000000002",
      ["https://video.twimg.com/ext_tw_video/example.mp4"],
    )));
    const decodedGif = unwrap(gifFrame);
    const decodedVideo = unwrap(videoFrame);
    if (decodedGif.type !== "activities" || decodedVideo.type !== "activities") {
      throw new Error("媒体 fixture 应产生动态");
    }
    expect(first(decodedGif.activities).media).toEqual([
      { kind: "gif", url: "https://video.twimg.com/tweet_video/example.mp4" },
    ]);
    expect(first(decodedVideo.activities).media).toEqual([
      { kind: "video", url: "https://video.twimg.com/ext_tw_video/example.mp4" },
    ]);
  });

  it("解码 standard tweet、分类并在批内按 Snowflake 去重排序", () => {
    const post = standardTweet("1900000000000000004", {
      extendedEntities: {
        media: [
          {
            type: "animated_gif",
            media_url_https: "https://pbs.twimg.com/gif-preview.jpg",
            video_info: {
              variants: [
                {
                  url: "https://video.twimg.com/gif.mp4",
                  content_type: "video/mp4",
                  bitrate: 256000,
                },
              ],
            },
          },
        ],
      },
    });
    const reply = standardTweet("1900000000000000001", { isReply: true });
    const quote = standardTweet("1900000000000000002", {
      quoted_tweet: { id: "1800000000000000000" },
    });
    const retweet = standardTweet("1900000000000000003", {
      retweeted_tweet: {
        id: "1800000000000000001",
        extendedEntities: {
          media: [{
            type: "photo",
            media_url_https: "https://pbs.twimg.com/retweet.jpg",
          }],
        },
      },
    });
    const frame = unwrap(
      decodeTwitterStreamFrame(
        JSON.stringify({
          event_type: "tweet",
          timestamp: 1_770_000_000_100,
          tweets: [post, retweet, quote, reply, quote],
        }),
      ),
    );
    if (frame.type !== "activities") {
      throw new Error("standard tweet 应产生动态");
    }

    expect(frame.activities.map((activity) => activity.id)).toEqual([
      "1900000000000000001",
      "1900000000000000002",
      "1900000000000000003",
      "1900000000000000004",
    ]);
    expect(frame.activities.map((activity) => activity.kind)).toEqual([
      "reply",
      "quote",
      "retweet",
      "post",
    ]);
    expect(first(frame.activities).url).toBe(
      "https://x.com/OpenAI/status/1900000000000000001",
    );
    expect(frame.activities[3]).toMatchObject({
      media: [{ kind: "gif", url: "https://video.twimg.com/gif.mp4" }],
    });
    expect(frame.activities[2]).toMatchObject({
      media: [{ kind: "image", url: "https://pbs.twimg.com/retweet.jpg" }],
    });
  });

  it("忽略带 rule_id 的规则事件，不尝试解码其 tweets", () => {
    const frame = unwrap(
      decodeTwitterStreamFrame(
        JSON.stringify({
          event_type: "tweet",
          rule_id: "rule-1",
          rule_tag: "external-rule",
          tweets: ["different payload is irrelevant"],
          timestamp: 1_770_000_000_100,
        }),
      ),
    );
    expect(frame).toEqual({ type: "ignored", warning: null });
  });

  it("解码 connected/ping，并拒绝坏 JSON 和坏 tweet", () => {
    expect(
      unwrap(
        decodeTwitterStreamFrame(
          JSON.stringify({ event_type: "connected", timestamp: 1 }),
        ),
      ),
    ).toEqual({ type: "connected" });
    expect(
      unwrap(
        decodeTwitterStreamFrame(
          JSON.stringify({ event_type: "ping", timestamp: 2 }),
        ),
      ),
    ).toEqual({ type: "ping" });

    const badJson = decodeTwitterStreamFrame("{");
    const badTweet = decodeTwitterStreamFrame(
      JSON.stringify({ event_type: "tweet", tweets: [], timestamp: "bad" }),
    );
    if (badJson.ok || badTweet.ok) throw new Error("坏帧不应成功");
    expect(badJson.error.kind).toBe("decode");
    expect(badTweet.error.kind).toBe("decode");
  });
});

describe("TwitterAPI.io Account Stream connection", () => {
  it("用 x-api-key 建立连接、分派文本事件并透传 close 信息", async () => {
    const fixture = createFakeTransport([]);
    const service = createTwitterAccountStreamServiceWithTransport(
      fixture.transport,
      "stream-key",
    );
    const received: XActivity[][] = [];
    const errors: SourceError[] = [];
    const closes: CloseCall[] = [];
    let connectedCount = 0;
    const handlers: StreamHandlers = {
      onConnected: async () => {
        connectedCount += 1;
      },
      onActivities: async (activities) => {
        received.push([...activities]);
      },
      onError: (error) => {
        errors.push(error);
      },
      onClosed: (code, reason) => {
        closes.push({ code, reason });
      },
    };

    const connection = unwrap(service.connect(handlers));
    expect(first(fixture.requests)).toEqual({
      method: "GET",
      url: "wss://ws.twitterapi.io/twitter/tweet/websocket",
      headers: { "x-api-key": "stream-key" },
      body: null,
    });

    fixture.socket.emitText({ event_type: "connected", timestamp: 1 });
    fixture.socket.emitText({ event_type: "ping", timestamp: 2 });
    fixture.socket.emitText(fastEvent("post"));
    fixture.socket.emitRawText("not-json");
    fixture.socket.emitError();
    fixture.socket.emitClosed(1008, "duplicate connection");
    connection.close(1000, "dispose");
    await Promise.resolve();

    expect(connectedCount).toBe(1);
    expect(received).toHaveLength(1);
    expect(first(first(received)).kind).toBe("post");
    expect(errors.map((error) => error.kind)).toEqual(["decode", "transport"]);
    expect(closes).toEqual([
      { code: 1008, reason: "duplicate connection" },
    ]);
    expect(fixture.socket.closeCalls).toEqual([
      { code: 1000, reason: "dispose" },
    ]);
  });
});
