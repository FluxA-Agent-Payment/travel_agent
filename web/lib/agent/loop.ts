import Anthropic from '@anthropic-ai/sdk';

import { buildTools, type UiEvent } from './tools';
import { systemPrompt } from './prompt';

/** Guardrail against a pathological tool loop. Normal bookings use 4-8. */
const MAX_TURNS = 16;

export type AgentEvent =
  | { type: 'text'; delta: string }
  | UiEvent
  | { type: 'done'; messages: Anthropic.MessageParam[] }
  | { type: 'error'; message: string };

/**
 * Run one conversational turn to completion, streaming as it goes.
 *
 * A manual loop rather than the SDK tool runner: this needs to emit a distinct
 * UI event per tool call (so the browser can render flight cards and drafts as
 * they arrive) and to hand the caller the full updated message history for the
 * next turn. Both sit outside what the runner exposes.
 */
export async function runAgentTurn(
  history: Anthropic.MessageParam[],
  emit: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<Anthropic.MessageParam[]> {
  const client = new Anthropic();
  const tools = buildTools((event) => emit(event));
  const messages: Anthropic.MessageParam[] = [...history];
  const system = systemPrompt(new Date().toISOString().slice(0, 10));

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (signal?.aborted) break;

    const stream = client.messages.stream(
      {
        model: 'claude-opus-5',
        max_tokens: 64000,
        // Adaptive thinking is on by default on Opus 5; asking for the summary
        // keeps a visible signal during the pause before the first token.
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'high' },
        system,
        tools: tools.definitions,
        messages,
      },
      { signal },
    );

    stream.on('text', (delta) => emit({ type: 'text', delta }));

    const message = await stream.finalMessage();
    messages.push({ role: 'assistant', content: message.content });

    if (message.stop_reason === 'refusal') {
      emit({
        type: 'error',
        message:
          'That request was declined. Try rephrasing, or ask about something else.',
      });
      break;
    }

    if (message.stop_reason !== 'tool_use') break;

    const toolUses = message.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    if (toolUses.length === 0) break;

    // Run the batch concurrently — the read-only tools are independent — and
    // return every result in one user message, which is what keeps parallel
    // tool use working on subsequent turns.
    const results = await Promise.all(
      toolUses.map(async (use): Promise<Anthropic.ToolResultBlockParam> => {
        const content = await tools.dispatch(use.name, use.input);
        return {
          type: 'tool_result',
          tool_use_id: use.id,
          content,
          is_error: content.startsWith('ERROR:'),
        };
      }),
    );

    messages.push({ role: 'user', content: results });
  }

  emit({ type: 'done', messages });
  return messages;
}
