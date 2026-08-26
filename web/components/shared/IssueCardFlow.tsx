'use client';

import { useEffect, useRef, useState } from 'react';

import { useWallet } from '@/components/providers/WalletProvider';

/**
 * Opening a FluxA virtual card, shown as the handshake it actually is.
 *
 * The interesting property of FluxA is not that an agent can hold a card — it
 * is that the card cannot exist until a human signs a mandate authorising the
 * spend. Collapsing that into one spinner hides the only part worth seeing, so
 * every step is on screen and the signature is a visible gate rather than a
 * transient state:
 *
 *   1. request a mandate      — an authorisation, no money moves
 *   2. the user signs it      — in FluxA, out of this app's hands, by design
 *   3. FluxA issues the card  — USDC leaves the wallet, funds the card
 *   4. the card can pay
 *
 * Step 1 is free. Nothing is spent until step 3, which is unreachable without
 * a signature the server re-checks independently of this component.
 */

type Phase = 'idle' | 'requesting' | 'awaiting-signature' | 'issuing' | 'issued';

interface Step {
  key: Exclude<Phase, 'idle'>;
  title: string;
  note: string;
}

const STEPS: Step[] = [
  {
    key: 'requesting',
    title: 'Request a mandate',
    note: 'An authorisation to spend up to the amount. Creating it moves no money.',
  },
  {
    key: 'awaiting-signature',
    title: 'You sign it in FluxA',
    note: 'The gate the agent cannot pass on its own. Without your signature there is no card.',
  },
  {
    key: 'issuing',
    title: 'FluxA issues the card',
    note: 'USDC leaves your wallet and funds a real prepaid card number.',
  },
  {
    key: 'issued',
    title: 'Card ready to pay',
    note: 'Usable at the airline. Its PAN stays server-side and never reaches this page.',
  },
];

const ORDER: Phase[] = ['requesting', 'awaiting-signature', 'issuing', 'issued'];

export function IssueCardFlow({
  defaultAmount,
  reason,
  onIssued,
}: {
  /** Pre-fills the amount — the fare, when opened from an unpayable order. */
  defaultAmount?: number;
  /** Why this is being offered, shown above the amount. */
  reason?: string;
  onIssued?: (cardId: string) => void;
}) {
  const wallet = useWallet();
  // Seeded from the wallet so a mandate survives this component unmounting —
  // which happens every time the wallet menu closes, while the user is off
  // signing in another tab.
  const [amount, setAmount] = useState(() =>
    (wallet.pendingMandate?.amountUsd ?? defaultAmount ?? 25).toFixed(2),
  );
  const [phase, setPhase] = useState<Phase>('idle');
  const mandateId = wallet.pendingMandate?.id ?? null;
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waited, setWaited] = useState(0);
  // FluxA's own word for where the mandate is. Shown because "waiting" with no
  // reported state is indistinguishable from a stuck poll.
  const [mandateStatus, setMandateStatus] = useState<string | null>(null);

  // Guards a double issuance: the poll and a late signature can both decide
  // it is time to create the card.
  const issuingRef = useRef(false);

  // Mirror "a flow is in progress" up to the wallet, so the menu containing
  // this does not close under the user mid-signature.
  const running = phase !== 'idle' && phase !== 'issued';
  const { setIssuing } = wallet;
  useEffect(() => {
    setIssuing(running);
    return () => setIssuing(false);
  }, [running, setIssuing]);

  async function post(payload: Record<string, unknown>) {
    const res = await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'Request failed');
    return body;
  }

  async function issue(mandate: string) {
    if (issuingRef.current) return;
    issuingRef.current = true;
    setPhase('issuing');
    try {
      const body = await post({
        action: 'card-create',
        amountUsd: Number(amount),
        mandateId: mandate,
      });
      setPhase('issued');
      setApprovalUrl(null);
      wallet.setPendingMandate(null);
      await wallet.refresh();
      if (body.card?.id) {
        wallet.selectCard(body.card.id);
        onIssued?.(body.card.id);
      }
    } catch (err) {
      setError((err as Error).message);
      setPhase('idle');
    } finally {
      issuingRef.current = false;
    }
  }

  // The user is signing in another tab, so there is nothing here to react to
  // except the passage of time.
  useEffect(() => {
    if (phase !== 'awaiting-signature' || !mandateId) return;
    const started = Date.now();
    const timer = setInterval(async () => {
      setWaited(Math.round((Date.now() - started) / 1000));
      try {
        const res = await fetch(`/api/cards?mandateId=${encodeURIComponent(mandateId)}`);
        const body = await res.json();
        if (body.mandate?.status) setMandateStatus(body.mandate.status);
        if (body.signed) {
          clearInterval(timer);
          await issue(mandateId);
        }
      } catch {
        /* a transient failure is not a signal — keep waiting */
      }
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, mandateId]);

  /** Re-attach to a mandate whose watch was stopped — including one already signed. */
  async function resume() {
    if (!mandateId) return;
    setError(null);
    setWaited(0);
    try {
      const res = await fetch(`/api/cards?mandateId=${encodeURIComponent(mandateId)}`);
      const body = await res.json();
      if (body.signed) {
        await issue(mandateId);
      } else {
        setApprovalUrl(body.mandate?.approvalUrl ?? approvalUrl);
        setPhase('awaiting-signature');
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function start() {
    setError(null);
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError('Enter an amount greater than zero');
      return;
    }
    setWaited(0);
    setPhase('requesting');
    try {
      const body = await post({ action: 'mandate-create', amountUsd: value });
      wallet.setPendingMandate({ id: body.mandate.id, amountUsd: value });
      if (body.signed) {
        await issue(body.mandate.id);
      } else {
        setApprovalUrl(body.mandate.approvalUrl ?? null);
        setPhase('awaiting-signature');
      }
    } catch (err) {
      setError((err as Error).message);
      setPhase('idle');
    }
  }

  /**
   * Stop watching, but keep the mandate.
   *
   * The user may already have signed in the other tab; throwing the id away
   * would strand a real signature with nothing polling for it and no way back
   * to it. So this stops the poll and offers to resume.
   */
  function stopWatching() {
    setPhase('idle');
    setApprovalUrl(null);
    setWaited(0);
  }

  const currentIndex = ORDER.indexOf(phase);

  return (
    <div className="issue">
      <span className="issue-label">Open a virtual card</span>
      {reason ? <p className="note">{reason}</p> : null}

      <div className="issue-row">
        <span className="issue-prefix">$</span>
        <input
          type="number"
          min="1"
          step="1"
          value={amount}
          disabled={running}
          onChange={(e) => setAmount(e.target.value)}
          aria-label="Amount to load onto the card, in USD"
        />
        <button className="primary" onClick={start} disabled={running}>
          {phase === 'requesting'
            ? 'Requesting…'
            : phase === 'issuing'
              ? 'Issuing…'
              : phase === 'issued'
                ? 'Issued ✓'
                : 'Open card'}
        </button>
        {running ? <button onClick={stopWatching}>Stop watching</button> : null}
      </div>

      {/* A mandate outlives the poll. If the user signed after we stopped
          watching, that signature is still good — offer the way back to it
          rather than making them start over and sign twice. */}
      {phase === 'idle' && mandateId ? (
        <div className="resume">
          <p className="note warn">
            A mandate is still open for ${Number(amount).toFixed(2)}. If you
            have signed it, pick it up here — no need to request another.
          </p>
          <div className="actions">
            <button className="primary" onClick={resume}>
              Resume this mandate
            </button>
            <button onClick={() => wallet.setPendingMandate(null)}>Discard it</button>
          </div>
        </div>
      ) : null}

      {phase !== 'idle' ? (
        <ol className="steps">
          {STEPS.map((step, i) => {
            const state =
              phase === 'issued' || i < currentIndex
                ? 'done'
                : i === currentIndex
                  ? 'active'
                  : 'pending';
            return (
              <li className={`step ${state}`} key={step.key}>
                <span className="step-mark" aria-hidden="true">
                  {state === 'done' ? '✓' : i + 1}
                </span>
                <span className="step-body">
                  <span className="step-title">{step.title}</span>
                  <span className="step-note">{step.note}</span>

                  {step.key === 'awaiting-signature' && state === 'active' ? (
                    <span className="step-action">
                      {approvalUrl ? (
                        <a
                          className="btn primary"
                          href={approvalUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          Approve ${Number(amount).toFixed(2)} in FluxA →
                        </a>
                      ) : (
                        <span className="note bad">
                          FluxA returned no approval URL — check the wallet app.
                        </span>
                      )}
                      <span className="note">
                        FluxA reports{' '}
                        <code>{mandateStatus ?? 'pending_signature'}</code>
                        {waited ? ` · ${waited}s` : ''}. This page continues on
                        its own once you sign.
                      </span>
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}

      {error ? <p className="note bad">{error}</p> : null}

      {phase === 'idle' ? (
        <p className="note">
          Issuing a card spends from your wallet. The card is prepaid, so load at
          least the fare you intend to pay.
        </p>
      ) : null}
    </div>
  );
}
