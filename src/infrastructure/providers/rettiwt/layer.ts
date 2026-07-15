import * as Layer from "effect/Layer";
import type { RettiwtPollingConfig } from "../../../config";
import { XDataSource } from "../../../ports/source";
import { makeRettiwtService } from "./service";

/** 提供带 key 池的 Rettiwt 轮询数据源 Layer。 */
export const RettiwtPollingLayer = (config: RettiwtPollingConfig) =>
  Layer.effect(XDataSource, makeRettiwtService(config.apiKeys));
