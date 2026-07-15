import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import type { Context } from "koishi";
import { DecodeError, UserUnavailableError, type SourceError } from "../../../domain/errors";
import {
  parseXHandle,
  parseXUserId,
  type XHandle,
} from "../../../domain/identifiers";
import type { ResolvedXUser } from "../../../ports/source";
import { decodeTwitterApi } from "./decoder";
import { requestTwitterApiJson } from "./http-client";
import { UserResponseSchema, type TwitterUser } from "./schema";

/** 解开用户资料响应的可选 data 包装。 */
const unwrapUserResponse = (
  response: typeof UserResponseSchema.Type,
): TwitterUser => "data" in response ? response.data : response;

/** 创建 TwitterAPI.io 的用户解析能力。 */
export const makeTwitterApiResolveUser = (ctx: Context, apiKey: string) => (
  handle: XHandle,
): Effect.Effect<ResolvedXUser, SourceError> =>
  requestTwitterApiJson(ctx, apiKey, "GET", "/twitter/user/info", {
    params: { userName: handle },
  }).pipe(
    Effect.flatMap((input) => decodeTwitterApi(UserResponseSchema, input)),
    Effect.flatMap((response) => {
      const user = unwrapUserResponse(response);
      if (!("id" in user) || !("userName" in user || "username" in user)) {
        return Effect.fail<SourceError>(
          new UserUnavailableError({ handle, message: "TwitterAPI.io 未返回该用户" }),
        );
      }
      const id = parseXUserId(user.id === undefined ? "" : user.id);
      const rawHandle = user.userName === undefined ? user.username : user.userName;
      const parsedHandle = parseXHandle(rawHandle === undefined ? "" : rawHandle);
      if (Either.isLeft(id) || Either.isLeft(parsedHandle)) {
        return Effect.fail<SourceError>(
          new DecodeError({ provider: "twitterapiio", message: "用户资料核心字段无效" }),
        );
      }
      const displayName = user.name === undefined
        ? user.displayName === undefined ? parsedHandle.right : user.displayName
        : user.name;
      return Effect.succeed<ResolvedXUser>({
        id: id.right,
        handle: parsedHandle.right,
        displayName,
      });
    }),
  );
