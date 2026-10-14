// Best-effort per-model context window table, used when --context-window is not given. Static and will drift as
// providers change limits; rea's own default (DEFAULT_CONTEXT_WINDOW) is used for anything unmatched.
import { DEFAULT_CONTEXT_WINDOW } from './context.js';

export const MODEL_WINDOWS = [
  { match: /claude-.*(?:\[1m\]|-1m\b|context-1m)/i, window: 1_000_000 },
  { match: /claude-(?:opus|sonnet|haiku)-[3-9](?:\.\d+)?/i, window: 200_000 },
  { match: /claude-[23](?:\.\d+)?-(?:opus|sonnet|haiku)/i, window: 200_000 },
  { match: /gemini-(?:1\.5|2)/i, window: 1_000_000 },
  { match: /gpt-5|gpt-4\.1|\bo3\b|\bo4\b/i, window: 200_000 },
  { match: /gpt-4o|gpt-4-turbo/i, window: 128_000 },
  { match: /gpt-3\.5/i, window: 16_000 },
  { match: /llama-3\.[123]/i, window: 128_000 },
  { match: /mixtral|mistral/i, window: 32_000 },
  { match: /deepseek/i, window: 64_000 },
  { match: /qwen2\.5|qwen-2\.5/i, window: 128_000 },
];

export function windowForModel(name, fallback = DEFAULT_CONTEXT_WINDOW) {
  if (!name) return fallback;
  return MODEL_WINDOWS.find((m) => m.match.test(name))?.window ?? fallback;
}
