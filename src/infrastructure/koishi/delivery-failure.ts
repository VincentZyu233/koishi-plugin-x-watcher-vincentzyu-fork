import { DeliveryError } from "../../domain/errors";

const EXPLICIT_UNSUPPORTED_STATUS = /\b(413|415)\b/;
const EXPLICIT_UNSUPPORTED_REASON =
  /unsupported|not supported|invalid.*(?:element|media)|payload too large|content.?type|不支持|消息过长|内容过大/i;

/** 创建不支持当前投递参数的领域错误。 */
export const unsupportedDelivery = (message: string): DeliveryError =>
  new DeliveryError({ classification: "unsupported", message });

/** 创建需要在原阶段重试的暂时性投递错误。 */
export const transientDelivery = (message: string): DeliveryError =>
  new DeliveryError({ classification: "transient", message });

/** 仅把明确的内容不兼容信号分类为降级错误。 */
export const classifyDeliveryFailure = (message: string): DeliveryError =>
  EXPLICIT_UNSUPPORTED_STATUS.test(message) ||
  EXPLICIT_UNSUPPORTED_REASON.test(message)
    ? unsupportedDelivery(message)
    : transientDelivery(message);
