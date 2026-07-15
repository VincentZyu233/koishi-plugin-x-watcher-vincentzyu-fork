import { createHash } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { XWatcherStore } from "../ports/storage";

/** 生成不会泄露原始 API key 的稳定远端配置指纹。 */
export const fingerprintApiKey = (apiKey: string): string =>
  createHash("sha256").update(apiKey).digest("hex");

/** 迁移数据库后把当前全局实时设置应用到既有账号。 */
export const prepareStore = (
  remoteMonitoring: boolean,
  remoteKeyFingerprint: string | null,
) =>
  Effect.gen(function* () {
    const store = yield* XWatcherStore;
    yield* store.migrate();
    const now = new Date(yield* Clock.currentTimeMillis);
    yield* store.configureRemoteMonitoring(
      remoteMonitoring,
      remoteKeyFingerprint,
      now,
    );
  });
