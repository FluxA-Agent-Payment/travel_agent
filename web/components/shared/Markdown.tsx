'use client';

import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders assistant prose.
 *
 * GFM is on because the model reaches for tables when comparing fares, and a
 * comparison table is genuinely the right shape for that — it just has to
 * render as a table rather than as pipes. Links open in a new tab and carry
 * noreferrer: link text arrives from the model, so it is never fully trusted.
 *
 * Memoised on `text` because this re-renders on every streamed delta.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ children }) => (
            <div className="scroll-x">
              <table>{children}</table>
            </div>
          ),
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
