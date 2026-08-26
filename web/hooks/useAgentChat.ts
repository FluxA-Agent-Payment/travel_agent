'use client';

import { useCallback, useRef, useState } from 'react';

export type TimelineItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'text'; text: string }
  | {
      id: string;
      kind: 'tool';
      tool: string;
      status: 'running' | 'done' | 'error';
      data?: any;
      message?: string;
      /** BookingError code — lets the UI tell a fault from an unavailable service. */
      code?: string;
    }
  | { id: string; kind: 'error'; message: string };

/** Opaque message history, passed straight back to the API each turn. */
type ApiMessage = { role: 'user' | 'assistant'; content: unknown };

let seq = 0;
const nextId = () => `i${++seq}`;

/**
 * Drives one SSE agent turn at a time.
 *
 * The transcript the user sees and the message history the model sees are
 * deliberately separate: the first is a flat timeline of text and tool cards,
 * the second is the raw Anthropic history returned by the server. Mixing them
 * would mean re-deriving tool_use/tool_result pairing in the browser.
 */
export function useAgentChat() {
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [busy, setBusy] = useState(false);
  const historyRef = useRef<ApiMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const push = useCallback((item: TimelineItem) => {
    setTimeline((prev) => [...prev, item]);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;

      push({ id: nextId(), kind: 'user', text: trimmed });
      historyRef.current = [
        ...historyRef.current,
        { role: 'user', content: trimmed },
      ];

      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;

      // Tracks the text item currently accumulating deltas. Reset whenever a
      // tool card lands, so prose before and after a tool call stay separate.
      let openTextId: string | null = null;

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: historyRef.current }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const detail = await res.json().catch(() => ({}));
          throw new Error(detail.error ?? `Request failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            const line = frame.trim();
            if (!line.startsWith('data:')) continue;

            let event: any;
            try {
              event = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }

            switch (event.type) {
              case 'text': {
                if (openTextId === null) {
                  const id = nextId();
                  openTextId = id;
                  push({ id, kind: 'text', text: event.delta });
                } else {
                  const id = openTextId;
                  setTimeline((prev) =>
                    prev.map((item) =>
                      item.id === id && item.kind === 'text'
                        ? { ...item, text: item.text + event.delta }
                        : item,
                    ),
                  );
                }
                break;
              }

              case 'tool_start': {
                openTextId = null;
                push({
                  id: nextId(),
                  kind: 'tool',
                  tool: event.tool,
                  status: 'running',
                });
                break;
              }

              case 'tool_result':
              case 'tool_error': {
                const isError = event.type === 'tool_error';
                setTimeline((prev) => {
                  // Settle the most recent running card for this tool.
                  for (let i = prev.length - 1; i >= 0; i--) {
                    const item = prev[i];
                    if (
                      item.kind === 'tool' &&
                      item.tool === event.tool &&
                      item.status === 'running'
                    ) {
                      const next = [...prev];
                      next[i] = {
                        ...item,
                        status: isError ? 'error' : 'done',
                        data: event.data,
                        message: event.message,
                        code: event.code,
                      };
                      return next;
                    }
                  }
                  return prev;
                });
                break;
              }

              case 'done': {
                historyRef.current = event.messages;
                break;
              }

              case 'error': {
                push({ id: nextId(), kind: 'error', message: event.message });
                break;
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          push({
            id: nextId(),
            kind: 'error',
            message: (err as Error).message ?? 'The agent stopped unexpectedly.',
          });
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, push],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * Feed a system-generated fact back into the conversation as if the traveller
   * reported it — used after an order is placed or a refund submitted, so the
   * agent knows what the human just did on their behalf.
   */
  const reportEvent = useCallback(
    (text: string) => {
      void send(text);
    },
    [send],
  );

  return { timeline, busy, send, stop, reportEvent };
}
