/**
 * Text that arrives from a connected account ends up in a spoken sentence. It has to stay a
 * single clean line: control and formatting characters, line breaks, and unbounded length all
 * have to go before the text reaches the assistant.
 */
export function spokenText(value: unknown, max = 120) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\p{C}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}
