/**
 * Parse a model reply as JSON. Structured output normally guarantees clean JSON,
 * but this also copes with code fences or stray text around the object.
 */
export function parseJsonLoose(raw: string): unknown {
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  throw new Error(`Reply is not JSON: ${text.slice(0, 120)}`);
}
