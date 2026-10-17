import Anthropic from '@anthropic-ai/sdk';

/** One client for the whole process. Credentials come from ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login`. */
export const anthropic = new Anthropic();

/** Main model for the assistant, intake extraction and anything a human will act on. */
export const MODEL = process.env.DELOREAN_MODEL ?? 'claude-opus-5-5';
/** Cheaper model for high-volume, low-stakes classification (every inbound email). */
export const TRIAGE_MODEL = process.env.DELOREAN_TRIAGE_MODEL ?? 'claude-haiku-5-5';

/** Server-side refusal fallback: if a safety classifier declines, the API retries on a suitable model in the same call. */
export const FALLBACK = { betas: ['server-side-fallback-2026-07-01'] as string[], fallbacks: 'default' as const };

export function aiConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}
