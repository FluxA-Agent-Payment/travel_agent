'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const MIN = 300;
const MAX = 760;
const DEFAULT = 380;
// Bumped when the default changes, so an existing saved width does not pin
// the layout to a stale preference — the old key is simply never read again.
const STORAGE_KEY = 'flightdesk:chatWidth:v2';

function clamp(n: number): number {
  return Math.min(MAX, Math.max(MIN, n));
}

/**
 * Drag state for the divider between the conversation and the results pane.
 *
 * Pointer capture rather than window listeners, so a fast drag that outruns
 * the cursor still delivers its moves to the handle. The chosen width is
 * persisted, since it is a lasting preference about how someone reads the
 * screen rather than a per-session accident.
 */
export function useSplitWidth() {
  const [width, setWidth] = useState(DEFAULT);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = Number(window.localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(saved) && saved > 0) setWidth(clamp(saved));
  }, []);

  const persist = useCallback((next: number) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      /* private browsing — the width just won't survive a reload */
    }
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging || !containerRef.current) return;
      const left = containerRef.current.getBoundingClientRect().left;
      setWidth(clamp(e.clientX - left));
    },
    [dragging],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      setDragging(false);
      persist(width);
    },
    [dragging, persist, width],
  );

  /** Arrow keys nudge, Home resets — the divider is a real control. */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 48 : 16;
      let next: number | null = null;
      if (e.key === 'ArrowLeft') next = clamp(width - step);
      else if (e.key === 'ArrowRight') next = clamp(width + step);
      else if (e.key === 'Home') next = DEFAULT;
      if (next === null) return;
      e.preventDefault();
      setWidth(next);
      persist(next);
    },
    [persist, width],
  );

  const reset = useCallback(() => {
    setWidth(DEFAULT);
    persist(DEFAULT);
  }, [persist]);

  return {
    width,
    dragging,
    containerRef,
    min: MIN,
    max: MAX,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onKeyDown,
      onDoubleClick: reset,
    },
  };
}
