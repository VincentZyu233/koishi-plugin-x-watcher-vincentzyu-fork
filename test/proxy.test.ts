import { getGlobalDispatcher } from "undici";
import { describe, expect, it, vi } from "vitest";
import { installProxy } from "../src/proxy";

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  } as never;
}

describe("显式代理生命周期", () => {
  it("关闭代理时不修改全局 dispatcher", () => {
    const previous = getGlobalDispatcher();
    const lease = installProxy({
      enabled: false,
      url: "http://127.0.0.1:7890",
    }, logger());

    expect(lease.rettiwtProxy).toBeUndefined();
    expect(getGlobalDispatcher()).toBe(previous);
    lease.dispose();
    expect(getGlobalDispatcher()).toBe(previous);
  });

  it("启用代理后安装 dispatcher 并在卸载时恢复", () => {
    const previous = getGlobalDispatcher();
    const lease = installProxy({
      enabled: true,
      url: "http://127.0.0.1:7890",
    }, logger());

    expect(lease.rettiwtProxy).toBe("http://127.0.0.1:7890/");
    expect(getGlobalDispatcher()).not.toBe(previous);
    lease.dispose();
    expect(getGlobalDispatcher()).toBe(previous);
  });

  it("相同代理由多个实例共享直到最后一个实例卸载", () => {
    const previous = getGlobalDispatcher();
    const config = {
      enabled: true,
      url: "http://127.0.0.1:7890",
    };
    const first = installProxy(config, logger());
    const dispatcher = getGlobalDispatcher();
    const second = installProxy(config, logger());

    expect(getGlobalDispatcher()).toBe(dispatcher);
    first.dispose();
    expect(getGlobalDispatcher()).toBe(dispatcher);
    second.dispose();
    expect(getGlobalDispatcher()).toBe(previous);
  });

  it("拒绝同时启用不同代理地址", () => {
    const first = installProxy({
      enabled: true,
      url: "http://127.0.0.1:7890",
    }, logger());
    try {
      expect(() => installProxy({
        enabled: true,
        url: "http://127.0.0.1:7891",
      }, logger())).toThrow("启用了不同的代理地址");
    } finally {
      first.dispose();
    }
  });

  it("支持 SOCKS5 代理并在卸载时恢复 dispatcher", () => {
    const previous = getGlobalDispatcher();
    const lease = installProxy({
      enabled: true,
      url: "socks5://127.0.0.1:7890",
    }, logger());
    expect(lease.rettiwtProxy).toBe("socks5://127.0.0.1:7890");
    expect(getGlobalDispatcher()).not.toBe(previous);
    lease.dispose();
    expect(getGlobalDispatcher()).toBe(previous);
  });

  it("拒绝不受支持的代理协议", () => {
    expect(() => installProxy({
      enabled: true,
      url: "ftp://127.0.0.1:7890",
    }, logger())).toThrow("仅支持 HTTP(S) 或 SOCKS5");
  });
});
