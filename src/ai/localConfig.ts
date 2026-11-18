import { readFileSync } from 'node:fs';

/**
 * Personal settings for the AI tools, kept in ai.local.json (git-ignored), e.g.
 *   { "model": "<lm studio model id>", "url": "http://localhost:1234" }
 * Command-line flags win over this file; without either, the loaded model is used.
 */
export interface LocalConfig {
  model?: string;
  url?: string;
}

export function loadLocalConfig(path = 'ai.local.json'): LocalConfig {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return {
      ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
      ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
    };
  } catch {
    return {};
  }
}
