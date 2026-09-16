/** 先移除二进制再截断，避免 OneBot 把 retcode 淹没在 Base64 中。 */
export function errorMessage(error: Error | string): string {
  const message = typeof error === "string" ? error : error.message;
  const cleaned = message
    .replace(/base64(?:,|:\/\/)[A-Za-z0-9+/=]+/g, "base64:[图片数据已省略]");
  const code = typeof error === "string" ? undefined : Reflect.get(error, "code");
  const suffix = typeof code === "number" || typeof code === "string" ? ` [code=${code}]` : "";
  return `${cleaned.length > 1500 ? cleaned.slice(0, 1500) + "…" : cleaned}${suffix}`;
}
