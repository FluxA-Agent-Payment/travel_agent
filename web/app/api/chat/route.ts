import type Anthropic from '@anthropic-ai/sdk';
import { NextRequest } from 'next/server';

import { runAgentTurn, type AgentEvent } from '@/lib/agent/loop';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Streams one agent turn as Server-Sent Events.
 *
 * The client owns the transcript: it posts the full message history and gets
 * the updated history back in the terminal `done` event. That keeps the server
 * stateless, so a restart never strands a conversation mid-booking.
 */
export async function POST(req: NextRequest) {
  let history: Anthropic.MessageParam[];
  try {
    const body = await req.json();
    history = body.messages;
    if (!Array.isArray(history) || history.length === 0) {
      return Response.json({ error: 'messages is required' }, { status: 400 });
    }
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: AgentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      try {
        await runAgentTurn(history, send, req.signal);
      } catch (err) {
        // Credentials resolve from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or
        // an `ant auth login` profile — so a missing env var alone is not
        // proof of no credentials. Report what actually failed.
        const raw = (err as Error).message ?? '';
        const isAuth =
          (err as { status?: number }).status === 401 ||
          /api[_ -]?key|authentication|credential/i.test(raw);
        send({
          type: 'error',
          message: isAuth
            ? 'No usable Anthropic credentials. Set ANTHROPIC_API_KEY in web/.env.local, or run `ant auth login`.'
            : raw || 'The agent failed unexpectedly.',
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed by client disconnect */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
