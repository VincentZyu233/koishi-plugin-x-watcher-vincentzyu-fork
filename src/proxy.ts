import type { Logger } from "koishi";
import {
  type Dispatcher,
  getGlobalDispatcher,
  ProxyAgent,
  setGlobalDispatcher,
  Socks5ProxyAgent,
} from "undici";

/** 显式代理同时覆盖 Rettiwt Axios 请求与其依赖中的原生 fetch。 */
export interface ProxyLease {
  readonly rettiwtProxy: string | undefined;
  readonly dispose: () => void;
}

export interface ProxyOptions {
  readonly enabled: boolean;
  readonly url: string;
}

interface ActiveProxy {
  readonly url: string;
  readonly dispatcher: Dispatcher;
  readonly previous: Dispatcher;
  references: number;
}

let activeProxy: ActiveProxy | null = null;

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

function createLease(active: ActiveProxy, logger: Logger): ProxyLease {
  let disposed = false;
  return {
    rettiwtProxy: active.url,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      active.references -= 1;
      if (active.references > 0) return;
      if (activeProxy === active) activeProxy = null;
      if (getGlobalDispatcher() === active.dispatcher) {
        setGlobalDispatcher(active.previous);
      }
      void active.dispatcher.close().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`关闭代理 dispatcher 失败：${message}`);
      });
    },
  };
}

export function installProxy(
  config: ProxyOptions,
  logger: Logger,
): ProxyLease {
  if (!config.enabled) {
    return { rettiwtProxy: undefined, dispose: () => undefined };
  }

  const proxyUrl = normalizeProxyUrl(config.url);
  if (activeProxy !== null) {
    if (activeProxy.url !== proxyUrl) {
      throw new Error("已有其他 x-watcher 实例启用了不同的代理地址");
    }
    if (getGlobalDispatcher() !== activeProxy.dispatcher) {
      throw new Error("全局 fetch dispatcher 已被其他组件替换");
    }
    activeProxy.references += 1;
    logger.info(`复用代理：${proxyLabel(proxyUrl)}`);
    return createLease(activeProxy, logger);
  }

  const previous = getGlobalDispatcher();
  const dispatcher = createDispatcher(proxyUrl);
  setGlobalDispatcher(dispatcher);
  logger.info(`已启用代理：${proxyLabel(proxyUrl)}`);
  activeProxy = { url: proxyUrl, dispatcher, previous, references: 1 };
  return createLease(activeProxy, logger);
}
