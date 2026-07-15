import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Layer from "effect/Layer";
import {
  Universal,
  type Bot,
  type Context as KoishiContext,
  type Fragment,
} from "koishi";
import { DeliveryError } from "../../domain/errors";
import type { MessagePlan } from "../../domain/message";
import {
  MessageSender,
  type DeliveryTarget,
  type MessageSenderService,
} from "../../ports/platform";
import {
  renderLinkFragment,
  renderMixedFragment,
  renderSplitFragments,
} from "./message-fragments";
import {
  classifyDeliveryFailure,
  transientDelivery,
  unsupportedDelivery,
} from "./delivery-failure";

type DeliveryStage = "mixed" | "split" | "link";

/** 当前调用需要发送的一个原子分片。 */
interface SelectedPart {
  readonly fragment: Fragment;
  readonly nextIndex: number;
}

/** 从 Koishi 上下文查找目标机器人。 */
const findBot = (
  ctx: KoishiContext,
  target: DeliveryTarget,
): Bot | undefined =>
  ctx.bots.find(
    (bot) => bot.platform === target.platform && bot.selfId === target.botId,
  );

/** 为持久化目标重建发送上下文，保留 Telegram 话题群组信息。 */
const makeSyntheticSession = (
  bot: Bot,
  target: DeliveryTarget,
): ReturnType<Bot["session"]> => {
  const channel = {
    id: target.channelId,
    type: target.isDirect
      ? Universal.Channel.Type.DIRECT
      : Universal.Channel.Type.TEXT,
  };
  if (target.isDirect || target.guildId === null) {
    return bot.session({ channel });
  }
  return bot.session({ channel, guild: { id: target.guildId } });
};

/** 按阶段与进度选择本次唯一需要发送的分片。 */
const selectPart = (
  plan: MessagePlan,
  stage: DeliveryStage,
  partIndex: number,
): Either.Either<SelectedPart, DeliveryError> => {
  if (!Number.isInteger(partIndex) || partIndex < 0) {
    return Either.left(unsupportedDelivery(`无效的消息分片位置：${partIndex}`));
  }
  if (stage === "mixed") {
    return partIndex === 0
      ? Either.right({ fragment: renderMixedFragment(plan), nextIndex: -1 })
      : Either.left(unsupportedDelivery(`混排阶段不存在分片 ${partIndex}`));
  }
  if (stage === "link") {
    return partIndex === 0
      ? Either.right({ fragment: renderLinkFragment(plan), nextIndex: -1 })
      : Either.left(unsupportedDelivery(`链接阶段不存在分片 ${partIndex}`));
  }
  const fragments = renderSplitFragments(plan);
  const fragment = fragments[partIndex];
  if (fragment === undefined) {
    return Either.left(unsupportedDelivery(`拆分阶段不存在分片 ${partIndex}`));
  }
  const nextIndex = partIndex + 1 === fragments.length ? -1 : partIndex + 1;
  return Either.right({ fragment, nextIndex });
};

/** 发送一个原子 Fragment，并把空消息 ID 结果视为失败。 */
const sendPart = (
  bot: Bot,
  target: DeliveryTarget,
  part: SelectedPart,
): Effect.Effect<number, DeliveryError> => {
  const session = makeSyntheticSession(bot, target);
  return Effect.tryPromise({
    /** 通过目标机器人发送当前唯一原子分片。 */
    try: () =>
      bot.sendMessage(target.channelId, part.fragment, undefined, { session }),
    /** 将适配器拒绝原因分类为暂时性或内容不兼容。 */
    catch: (cause) =>
      classifyDeliveryFailure(
        cause instanceof Error ? cause.message : String(cause),
      ),
  }).pipe(
    Effect.flatMap((messageIds) =>
      messageIds.length === 0
        ? Effect.fail(
            classifyDeliveryFailure("适配器未返回任何已发送消息 ID"),
          )
        : Effect.succeed(part.nextIndex),
    ),
  );
};

/** 创建绑定 Koishi 上下文的消息发送服务。 */
const makeMessageSender = (ctx: KoishiContext): MessageSenderService => ({
  /** 每次仅发送当前进度指向的一个原子分片。 */
  send: (target, plan, stage, partIndex) =>
    Effect.gen(function* () {
      const bot = findBot(ctx, target);
      if (bot === undefined) {
        return yield* Effect.fail(
          transientDelivery("找不到订阅绑定的 Koishi 机器人"),
        );
      }
      const selection = selectPart(plan, stage, partIndex);
      const part = Either.isLeft(selection)
        ? yield* Effect.fail(selection.left)
        : selection.right;
      return yield* sendPart(bot, target, part);
    }),
});

/** 提供绑定 Koishi 上下文的消息发送 Layer。 */
export const MessageSenderLive = (ctx: KoishiContext) =>
  Layer.succeed(MessageSender, makeMessageSender(ctx));
