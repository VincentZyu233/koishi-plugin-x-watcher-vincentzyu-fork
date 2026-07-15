import * as Layer from "effect/Layer";
import type { Context } from "koishi";
import { RemoteMonitor, XDataSource } from "../../../ports/source";
import { makeTwitterApiDataSource, makeTwitterApiRemoteMonitor } from "./client";

/** 提供 TwitterAPI.io REST 数据源 Layer。 */
export const TwitterApiDataLayer = (ctx: Context, apiKey: string) =>
  Layer.succeed(XDataSource, makeTwitterApiDataSource(ctx, apiKey));

/** 提供 TwitterAPI.io Account Stream 远端控制 Layer。 */
export const TwitterApiRemoteMonitorLayer = (ctx: Context, apiKey: string) =>
  Layer.succeed(RemoteMonitor, makeTwitterApiRemoteMonitor(ctx, apiKey));
