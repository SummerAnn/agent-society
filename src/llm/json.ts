/**
 * Models occasionally revise a JSON answer in the same response. Keep the
 * final complete object rather than treating two objects as malformed output.
 */
export function parseLastJsonObject(raw: string): Record<string, unknown> | null {
  const objects: Record<string, unknown>[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character !== "}" || depth === 0) continue;
    depth -= 1;
    if (depth !== 0 || start < 0) continue;
    try {
      const value: unknown = JSON.parse(raw.slice(start, index + 1));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        objects.push(value as Record<string, unknown>);
      }
    } catch {
      // Ignore prose or incomplete objects and keep looking for a final answer.
    }
    start = -1;
  }

  return objects.at(-1) ?? null;
}
