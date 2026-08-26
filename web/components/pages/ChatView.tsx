'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { useAgentChat } from '@/hooks/useAgentChat';
import { useSplitWidth } from '@/hooks/useSplitWidth';
import { FlightResults, ToolResult, toolLabel } from '@/components/shared/ToolCards';
import { TripsPanel } from '@/components/shared/TripsPanel';
import { StatusStrip } from '@/components/shared/StatusStrip';
import { useOrders } from '@/hooks/useOrders';
import { WalletPanel } from '@/components/shared/WalletPanel';
import { WalletProvider, balanceOf, useWallet } from '@/components/providers/WalletProvider';
import { Markdown } from '@/components/shared/Markdown';

import type { RefundQuote, VerifyResult } from '@/lib/types';

/**
 * Openers that already name a route and a date.
 *
 * The ordinary case, and first because it is what most people actually arrive
 * wanting. Atlas's sandbox carries Asia-Pacific and Middle East inventory;
 * European and North American origins come back empty, so these point where
 * the data is.
 */
const DIRECT = [
  'Find me a flight from Hong Kong to Singapore on 15 October 2026',
  'Cheapest flight from Kuala Lumpur to Singapore next month',
  'Dubai to Mumbai on 20 September 2026 for one adult',
];

/**
 * Openers that state a constraint and a mood rather than a route.
 *
 * Naming the destination is the easy half of trip planning, and it is the half
 * the traveller often cannot do. These hand the agent a budget, a duration and
 * an intent and let it pick — which is the part worth watching, and the part a
 * search box cannot do at all.
 *
 * Every destination the agent might reasonably choose from Hong Kong — SIN,
 * BKK, KUL, TPE, NRT, ICN, MNL, HAN, SGN, DPS, CNX, PEN, KIX, BKI — has been
 * confirmed to return live fares.
 */
const MYSTERY: { label: string; prompt: string }[] = [
  {
    label: 'Sunrise · 2 days · $200',
    prompt:
      "I've only got $200 and two days free. Find me a flight out of Hong Kong " +
      'to somewhere worth waking up early for — I want to watch the sunrise.',
  },
  {
    label: 'Cheapest escape, next weekend',
    prompt:
      'Get me out of Hong Kong next weekend, as cheaply as possible. Anywhere ' +
      'warm. Surprise me.',
  },
  {
    label: 'Three days of good food · under $250',
    prompt:
      'Three days somewhere with great food, leaving Hong Kong, under $250 all ' +
      'in. Where should I go and what does it cost?',
  },
];

/**
 * Tools whose output belongs in the Results tab — the shopping surface.
 *
 * Deliberately narrow. Everything about an existing booking lives in Trips,
 * and verification is folded into the flight card it verified, so neither
 * appears here.
 */
const RESULTS_TOOLS = new Set([
  'search_flights',
  'get_seats',
  'get_luggage',
  'prepare_order',
]);

/**
 * Tools with no card of their own.
 *
 * check_order and list_orders used to draw order cards into the stream; Trips
 * now owns order display, and a second renderer would eventually disagree with
 * it. verify_flight folds into its flight card. The rest are already visible
 * elsewhere — the wallet menu, the agent's own prose.
 */
/** Outcomes that mean "the provider does not offer this", not "we broke". */
const UNAVAILABLE_CODES = new Set(['refund_unsupported']);

const SILENT_TOOLS = new Set([
  'check_coupon',
  'check_wallet',
  'verify_flight',
  'check_order',
  'list_orders',
  'quote_refund',
]);

export default function ChatView({ backend }: { backend: string }) {
  return (
    <WalletProvider>
      <ChatShell backend={backend} />
    </WalletProvider>
  );
}

function ChatShell({ backend }: { backend: string }) {
  const { timeline, busy, send, stop, reportEvent } = useAgentChat();
  const split = useSplitWidth();
  const wallet = useWallet();
  const [draft, setDraft] = useState('');
  const [walletOpen, setWalletOpen] = useState(false);
  const [tab, setTab] = useState<'results' | 'trips'>('results');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const threadEndRef = useRef<HTMLDivElement>(null);
  const panelEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const walletRef = useRef<HTMLDivElement>(null);

  // The conversation and the artifacts it produces are two views of one
  // timeline: prose and progress stay in the thread, anything with a shape
  // worth looking at moves to the pane where it has room to breathe.
  const panelItems = useMemo(
    () =>
      timeline.filter(
        (item) =>
          item.kind === 'tool' &&
          item.status === 'done' &&
          RESULTS_TOOLS.has(item.tool) &&
          item.data != null,
      ),
    [timeline],
  );

  /** flightId → its live-fare check, so a card can show its own verification. */
  const verifications = useMemo(() => {
    const map = new Map<string, VerifyResult>();
    for (const item of timeline) {
      if (item.kind !== 'tool' || item.tool !== 'verify_flight') continue;
      if (item.status !== 'done' || !item.data?.flightId) continue;
      map.set(item.data.flightId, item.data);
    }
    return map;
  }, [timeline]);

  const refundQuotes = useMemo(
    () =>
      timeline
        .filter(
          (i) => i.kind === 'tool' && i.tool === 'quote_refund' && i.status === 'done',
        )
        .map((i) => (i as { data: RefundQuote }).data)
        .filter(Boolean),
    [timeline],
  );

  // Index of the newest search, which is the one left expanded. Earlier ones
  // collapse to a header rather than disappearing, so two routes can still be
  // compared without them stacking up the pane.
  const lastSearchIndex = useMemo(() => {
    for (let i = panelItems.length - 1; i >= 0; i--) {
      const item = panelItems[i];
      if (item.kind === 'tool' && item.tool === 'search_flights') return i;
    }
    return -1;
  }, [panelItems]);

  // Anything that changes bookings bumps this, so Trips and the status strip
  // reload without either of them having to watch the conversation.
  const orderEpoch = useMemo(
    () => timeline.filter((i) => i.kind === 'user').length,
    [timeline],
  );

  const {
    orders,
    loading: ordersLoading,
    error: ordersError,
    reload: reloadOrders,
  } = useOrders(orderEpoch);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [timeline]);

  useEffect(() => {
    panelEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [panelItems.length]);

  // Dismiss the wallet on an outside click or Escape, the way a menu should.
  // It stays open while issuance is mid-flight, because that flow lives inside
  // it and a stray click must not drop a mandate the user is signing.
  useEffect(() => {
    if (!walletOpen || wallet.issuing) return;
    function onPointer(e: MouseEvent) {
      if (!walletRef.current?.contains(e.target as Node)) setWalletOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setWalletOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [walletOpen, wallet.issuing]);

  function submit() {
    const text = draft;
    setDraft('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    void send(text);
  }

  return (
    <div className="shell">
      <header className="masthead">
        <h1>FluxA Flight Desk</h1>
        <span className="sub">search · price · book · manage</span>
        <div className="wallet-anchor" ref={walletRef}>
          <button
            className={`wallet-toggle ${walletOpen ? 'open' : ''}`}
            onClick={() => setWalletOpen((v) => !v)}
            aria-expanded={walletOpen}
            aria-haspopup="dialog"
            title="FluxA cards used to pay for bookings"
          >
            {wallet.selected ? (
              <>
                <span className="wt-dot" aria-hidden="true" />
                •••• {wallet.selected.last4 ?? '????'}
                <span className="wt-bal">
                  ${balanceOf(wallet.selected).toFixed(2)}
                </span>
              </>
            ) : (
              'wallet'
            )}
            <span className={`chev ${walletOpen ? 'up' : ''}`} aria-hidden="true" />
          </button>

          {walletOpen ? (
            <div className="wallet-pop" role="dialog" aria-label="FluxA wallet">
              <WalletPanel />
            </div>
          ) : null}
        </div>
        <span className="badge" title="Which booking backend is wired up">
          {backend === 'mock'
            ? 'fixture data'
            : backend === 'atlas'
              ? 'atlas sandbox'
              : 'flight402'}
        </span>
      </header>

      <div
        className={`split ${split.dragging ? 'dragging' : ''}`}
        ref={split.containerRef}
        style={{ gridTemplateColumns: `${split.width}px 11px 1fr` }}
      >
        {/* ---------- Conversation ---------- */}
        <section className="chat-pane">
          <div className="thread">
            {timeline.length === 0 ? (
              <div className="empty">
                <h2>Where are you going?</h2>
                <p>
                  Ask in plain language. Nothing is booked and no money moves
                  until you approve it yourself.
                </p>
                <div className="sg-direct">
                  {DIRECT.map((s) => (
                    <button key={s} onClick={() => void send(s)}>
                      {s}
                    </button>
                  ))}
                </div>

                {/* The second group asks for a destination rather than naming
                    one, so it is labelled — otherwise it reads as three oddly
                    verbose versions of the row above. */}
                <div className="sg-rule">
                  <span>or let it choose</span>
                </div>

                <div className="suggestions">
                  {MYSTERY.map((s) => (
                    <button
                      key={s.label}
                      onClick={() => void send(s.prompt)}
                      title={s.prompt}
                    >
                      <span className="sg-label">{s.label}</span>
                      <span className="sg-prompt">{s.prompt}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {timeline.map((item) => {
              switch (item.kind) {
                case 'user':
                  return (
                    <div className="turn user" key={item.id}>
                      <div className="bubble">{item.text}</div>
                    </div>
                  );

                case 'text':
                  return (
                    <div className="turn" key={item.id}>
                      <Markdown text={item.text} />
                    </div>
                  );

                case 'tool': {
                  // Finished panel artifacts render on the right; the thread
                  // keeps a one-line trace so the conversation stays readable.
                  if (item.status === 'running') {
                    return (
                      <div className="turn" key={item.id}>
                        <div className="activity">
                          <span className="dot" />
                          {toolLabel(item.tool)}…
                        </div>
                      </div>
                    );
                  }
                  if (item.status === 'error') {
                    // A service the provider does not offer is not a fault of
                    // ours, and dressing it in red reads as one. Say what is
                    // true: this is unavailable, not broken.
                    const unavailable = UNAVAILABLE_CODES.has(item.code ?? '');
                    return (
                      <div className="turn" key={item.id}>
                        <div className={`activity ${unavailable ? 'muted' : 'error'}`}>
                          {unavailable
                            ? item.message
                            : `${toolLabel(item.tool)} failed — ${item.message}`}
                        </div>
                      </div>
                    );
                  }
                  // Everything renders in the pane or nowhere. The thread keeps
                  // a one-line trace so the conversation stays readable.
                  if (RESULTS_TOOLS.has(item.tool) || SILENT_TOOLS.has(item.tool)) {
                    return (
                      <div className="turn" key={item.id}>
                        <div className="activity done">{toolLabel(item.tool)} ✓</div>
                      </div>
                    );
                  }
                  return (
                    <div className="turn" key={item.id}>
                      <ToolResult
                        tool={item.tool}
                        data={item.data}
                        onEvent={reportEvent}
                      />
                    </div>
                  );
                }

                case 'error':
                  return (
                    <div className="turn" key={item.id}>
                      <p className="note bad">{item.message}</p>
                    </div>
                  );

                default:
                  return null;
              }
            })}

            <div ref={threadEndRef} />
          </div>

          <div className="composer">
            <textarea
              ref={textareaRef}
              value={draft}
              placeholder="Ask about flights, or an existing booking…"
              rows={1}
              onChange={(e) => {
                setDraft(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (!busy) submit();
                }
              }}
            />
            {busy ? (
              <button onClick={stop}>Stop</button>
            ) : (
              <button className="primary" onClick={submit} disabled={!draft.trim()}>
                Send
              </button>
            )}
          </div>
        </section>

        {/* ---------- Divider ---------- */}
        <div
          className="divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize conversation pane"
          aria-valuenow={split.width}
          aria-valuemin={split.min}
          aria-valuemax={split.max}
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          {...split.handleProps}
        >
          <span className="divider-grip" aria-hidden="true" />
        </div>

        {/* ---------- Results / Trips ---------- */}
        <aside className="results-pane">
          <div className="tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === 'results'}
              className={tab === 'results' ? 'on' : ''}
              onClick={() => setTab('results')}
            >
              Results
            </button>
            <button
              role="tab"
              aria-selected={tab === 'trips'}
              className={tab === 'trips' ? 'on' : ''}
              onClick={() => setTab('trips')}
            >
              Trips
              {orders.length > 0 ? (
                <span className="tabcount">{orders.length}</span>
              ) : null}
            </button>
          </div>

          {tab === 'results' ? (
            panelItems.length === 0 ? (
              <div className="pane-empty">
                <div className="pane-empty-mark">✈</div>
                <p>Flights and fares appear here as you search.</p>
              </div>
            ) : (
              <div className="pane-scroll">
                {panelItems.map((item, i) => {
                  if (item.kind !== 'tool') return null;

                  // Older searches fold to a header. They stay reachable so two
                  // routes can be compared, without every past search competing
                  // for the column with the current one.
                  if (item.tool === 'search_flights') {
                    const isLatest = i === lastSearchIndex;
                    const open = collapsed[item.id] ?? isLatest;
                    const flights = item.data?.flights ?? [];
                    const first = flights[0]?.outbound?.[0];
                    const last =
                      flights[0]?.outbound?.[flights[0].outbound.length - 1];
                    return (
                      <div className="pane-item" key={item.id}>
                        {!isLatest ? (
                          <button
                            className="searchfold"
                            onClick={() =>
                              setCollapsed((p) => ({ ...p, [item.id]: !open }))
                            }
                            aria-expanded={open}
                          >
                            <span className="searchfold-route">
                              {first ? `${first.departure.airport} → ${last?.arrival.airport}` : 'earlier search'}
                            </span>
                            <span className="searchfold-meta">
                              {flights.length} options
                            </span>
                            <span
                              className={`chev ${open ? 'up' : ''}`}
                              aria-hidden="true"
                            />
                          </button>
                        ) : null}
                        {open ? (
                          <FlightResults
                            data={item.data}
                            onEvent={reportEvent}
                            verifications={verifications}
                          />
                        ) : null}
                      </div>
                    );
                  }

                  return (
                    <div className="pane-item" key={item.id}>
                      <ToolResult
                        tool={item.tool}
                        data={item.data}
                        onEvent={reportEvent}
                      />
                    </div>
                  );
                })}
                <div ref={panelEndRef} />
              </div>
            )
          ) : (
            <div className="pane-scroll">
              <TripsPanel
                orders={orders}
                loading={ordersLoading}
                error={ordersError}
                onReload={() => void reloadOrders()}
                refundQuotes={refundQuotes}
                onEvent={reportEvent}
              />
            </div>
          )}

          <StatusStrip orders={orders} onOpen={() => setTab('trips')} />
        </aside>
      </div>
    </div>
  );
}
