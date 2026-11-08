/** Caps text at `max` chars, preferring to cut at the last line break that keeps most of it. */
export function capText(text: string, max: number): string {
  const trimmed = text.replace(/\r/g, "").trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const lastBreak = cut.lastIndexOf("\n");
  return (lastBreak > max * 0.6 ? cut.slice(0, lastBreak) : cut).trim();
}
