/**
 * The DeLorean assistant: a tool-using Claude conversation persisted in SQLite,
 * streamed to the UI as server-sent events.
 */
import Anthropic from '@anthropic-ai/sdk';
import { anthropic, MODEL, FALLBACK } from './client.ts';
import { businessContext, ASSISTANT_RULES } from './context.ts';
import { allTools } from './tools.ts';
import { all, get, run, setting } from '../db.ts';

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;

export interface AssistantEvent {
  type: 'text' | 'tool_start' | 'tool_result' | 'done' | 'error';
  text?: string; name?: string; input?: unknown; result?: string; conversation_id?: number; message_id?: number;
}

export function ensureConversation(id?: number | null, title?: string): number {
  if (id && get('SELECT 1 FROM conversations WHERE id = ?', id)) return id;
  return Number(run('INSERT INTO conversations(title) VALUES (?)', title ?? null).lastInsertRowid);
}

function history(conversationId: number): BetaMessageParam[] {
  return all<{ role: 'user' | 'assistant'; content: string }>('SELECT role, content FROM conversation_messages WHERE conversation_id = ? ORDER BY id', conversationId)
    .map(m => ({ role: m.role, content: JSON.parse(m.content) }));
}

function persist(conversationId: number, msg: BetaMessageParam) {
  const content = typeof msg.content === 'string' ? msg.content : msg.content;
  const text = typeof content === 'string' ? content
    : content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  const r = run('INSERT INTO conversation_messages(conversation_id, role, content, display_text) VALUES (?, ?, ?, ?)',
    conversationId, msg.role, JSON.stringify(content), text);
  run("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?", conversationId);
  return Number(r.lastInsertRowid);
}

function todayLine() {
  const tz = setting('timezone') ?? 'Africa/Johannesburg';
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return `Today is ${fmt.format(now)} (${iso}).`;
}

/**
 * Run one user turn. Yields streaming events; persists the turn when done.
 * `userContent` may include document/image blocks for attachments.
 */
export async function* runAssistant(conversationId: number, userContent: string | Anthropic.Beta.BetaContentBlockParam[], opts: { signal?: AbortSignal } = {}): AsyncGenerator<AssistantEvent> {
  const prior = history(conversationId);
  const userMsg: BetaMessageParam = { role: 'user', content: userContent as any };
  const userMessageId = persist(conversationId, userMsg);
  if (prior.length === 0) {
    const title = (typeof userContent === 'string' ? userContent : (userContent.find((b: any) => b.type === 'text') as any)?.text ?? 'Conversation').slice(0, 80);
    run('UPDATE conversations SET title = ? WHERE id = ? AND title IS NULL', title, conversationId);
  }

  const runner = anthropic.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    stream: true,
    max_iterations: 25,
    ...FALLBACK,
    output_config: { effort: 'high' },
    thinking: { type: 'adaptive', display: 'omitted' },
    system: [
      { type: 'text', text: businessContext() + ASSISTANT_RULES, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: todayLine() },
    ],
    tools: allTools,
    messages: [...prior, userMsg],
  }, { signal: opts.signal });

  const startLen = prior.length + 1;
  try {
    for await (const stream of runner) {
      for await (const event of stream) {
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          yield { type: 'tool_start', name: event.content_block.name };
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text', text: event.delta.text };
        }
      }
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') {
        yield { type: 'text', text: '\n\nI can’t help with that one.' };
      }
      // Surface tool inputs/results as they are produced (the runner appends them to params.messages).
      for (const block of msg.content) {
        if (block.type === 'tool_use') yield { type: 'tool_start', name: block.name, input: block.input };
      }
    }
    // Persist every new message (assistant turns + tool_result user turns) verbatim so thinking/tool blocks replay correctly.
    const msgs = runner.params.messages.slice(startLen);
    let lastId = userMessageId;
    for (const m of msgs) {
      lastId = persist(conversationId, m as BetaMessageParam);
      if (m.role === 'user' && Array.isArray(m.content)) {
        for (const b of m.content as any[]) if (b.type === 'tool_result') yield { type: 'tool_result', result: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) };
      }
    }
    yield { type: 'done', conversation_id: conversationId, message_id: lastId };
  } catch (e) {
    const msg = e instanceof Anthropic.AuthenticationError ? 'Claude API key is missing or invalid (set ANTHROPIC_API_KEY).'
      : e instanceof Anthropic.RateLimitError ? 'Claude is rate-limited right now, try again in a moment.'
      : e instanceof Anthropic.APIError ? `Claude API error ${e.status}: ${e.message}`
      : (e as Error).message;
    yield { type: 'error', text: msg };
  }
}

/** Non-streaming convenience for bots: returns the assistant's final text. */
export async function askAssistant(conversationId: number, text: string): Promise<string> {
  let out = '';
  for await (const ev of runAssistant(conversationId, text)) {
    if (ev.type === 'text') out += ev.text;
    if (ev.type === 'error') throw new Error(ev.text);
  }
  return out.trim();
}

export function listConversations() {
  return all('SELECT c.*, (SELECT display_text FROM conversation_messages m WHERE m.conversation_id = c.id AND role = \'assistant\' ORDER BY id DESC LIMIT 1) AS last_reply FROM conversations c ORDER BY updated_at DESC LIMIT 50');
}
export function conversationMessages(id: number) {
  return all<{ id: number; role: string; content: string; display_text: string | null; created_at: string }>('SELECT id, role, content, display_text, created_at FROM conversation_messages WHERE conversation_id = ? ORDER BY id', id)
    .map(m => {
      const content = JSON.parse(m.content);
      const tools = Array.isArray(content) ? content.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ name: b.name, input: b.input })) : [];
      const isToolResult = Array.isArray(content) && content.every((b: any) => b.type === 'tool_result');
      return { id: m.id, role: m.role, text: m.display_text ?? '', tools, is_tool_result: isToolResult, created_at: m.created_at };
    })
    .filter(m => !m.is_tool_result);
}
