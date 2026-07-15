import {
  AuthenticationError,
  RateLimitError,
  TransportError,
  type SourceError,
} from "../../../domain/errors";

/** 从 Error 或 SDK 普通错误对象中提取稳定文案。 */
const extractRettiwtErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" && error !== null && "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
};

/** 将未知 Rettiwt 异常归类为领域错误。 */
export const classifyRettiwtError = (error: unknown): SourceError => {
  const message = extractRettiwtErrorMessage(error);
  if (
    /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid authentication data|failed to authenticate|not authorized|authentication failed/i.test(
      message,
    )
  ) {
    return new AuthenticationError({ provider: "rettiwt", message });
  }
  if (/\b429\b|rate.?limit/i.test(message)) {
    return new RateLimitError({
      provider: "rettiwt",
      retryAfterMillis: 60_000,
      message,
    });
  }
  return new TransportError({ provider: "rettiwt", message });
};
