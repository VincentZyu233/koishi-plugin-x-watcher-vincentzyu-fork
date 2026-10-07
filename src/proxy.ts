import type { Logger } from "koishi";
import { type Dispatcher, ProxyAgent, Socks5ProxyAgent } from "undici";

/** 代理配置，仅供 Rettiwt Axios 请求局部使用，不修改全局 dispatcher。 */
export interface ProxyLease {
  readonly rettiwtProxy: string | undefined;
  readonly dispose: () => void;
}

export interface ProxyOptions {
  readonly enabled: boolean;
  readonly url: string;
}

function normalizeProxyUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("代理地址不是有效 URL");
  }
  if (!["http:", "https:", "socks:", "socks5:"].includes(url.protocol)) {
    throw new Error("代理仅支持 HTTP(S) 或 SOCKS5 地址");
  }
  if (url.hostname.length === 0) {
    throw new Error("代理地址缺少主机名");
  }
  return url.href;
}

export function createDispatcher(value: string): Dispatcher {
  const url = normalizeProxyUrl(value);
  const protocol = new URL(url).protocol;
  return protocol === "socks:" || protocol === "socks5:"
    ? new Socks5ProxyAgent(url)
    : new ProxyAgent(url);
}

function proxyLabel(value: string): string {
  const url = new URL(value);
  const port = url.port.length === 0 ? "" : `:${url.port}`;
  return `${url.protocol}//${url.hostname}${port}`;
}

/**
 * 校验并返回代理配置，不修改全局 dispatcher。
 * Rettiwt-api 内部使用独立的 HttpProxyAgent/SocksProxyAgent，天然局部化；
 * media.ts 中的下载请求也通过 createDispatcher() 局部传入，不依赖全局。
 */
export function installProxy(
  config: ProxyOptions,
  logger: Logger,
): ProxyLease {
  if (!config.enabled) {
    return { rettiwtProxy: undefined, dispose: () => undefined };
  }

  const proxyUrl = normalizeProxyUrl(config.url);
  logger.info(`已启用代理（局部）：${proxyLabel(proxyUrl)}`);
  return {
    rettiwtProxy: proxyUrl,
    dispose: () => undefined,
  };
}
