'use client';

import { useEffect, useRef, useState } from 'react';

import { useWallet } from '@/components/providers/WalletProvider';
import {
  browserWalletEnabled,
  createMandate,
  getMandate,
  isSigned,
  payerHeaders,
} from '@/lib/fluxa-browser';

/**
 * Paying a fare that accepts no card.
 *
 * Most Atlas fares settle by agency deposit and refuse virtual cards entirely.
 * The booking is still settled — from the desk's Atlas balance — but that is
 * the desk's money, not the traveller's, so the traveller's authorisation is
 * collected the same way it would be for a real charge: a FluxA mandate they
 * sign themselves, re-checked server-side before anything is settled.
 *
 * Whether the deduction against that mandate is actually executed depends on
 * `liveSettlement` — set when the desk has a receiving address configured. With
 * one, this really charges the traveller's wallet on-chain; without one the
 * signature is real and the deduction is skipped.
 *
 * Every surface below reads that flag rather than assuming either mode, because
 * the two things a payment screen must never do are imply money moved when it
 * did not, and imply it did not when it did. The flag defaults to false, so the
 * copy understates rather than overstates while the wallet is still loading.
 */

type Phase = 'idle' | 'requesting' | 'awaiting-signature' | 'settling' | 'done';

interface Step {
  key: Exclude<Phase, 'idle'>;
  title: string;
  note: string;
}

function steps(live: boolean): Step[] {
  return [
    {
      key: 'requesting',
      title: 'Request a mandate for the fare',
      note: 'An authorisation for the amount. Creating it moves no money.',
    },
    {
      key: 'awaiting-signature',
      title: 'You sign it in FluxA',
      note: 'The gate the agent cannot pass on its own, exactly as for a card.',
    },
    {
      key: 'settling',
      title: live ? 'Charged · airline settled' : 'Deduction simulated · airline settled',
      note: live
        ? 'USDC leaves your wallet for the desk against the mandate you signed — no second approval. The ticket is then settled with the airline.'
        : 'Sandbox: nothing is deducted from your wallet. The ticket is settled from the desk’s Atlas deposit.',
    },
    {
      key: 'done',
      title: 'Ticketing',
      note: 'The airline issues ticket numbers shortly afterwards.',
    },
  ];
}

const ORDER: Phase[] = ['requesting', 'awaiting-signature', 'settling', 'done'];

export function DepositPayFlow({
  orderId,
  reference,
  amount,
  currency,
  soleRail = true,
  onSettled,
}: {
  orderId: string;
  /** PNR, so the mandate the traveller signs names the booking it pays for. */
  reference?: string;
  amount: number;
  currency: string;
  /** False when the traveller chose this over an available card. */
  soleRail?: boolean;
  onSettled: (message: string) => void;
}) {
  const wallet = useWallet();
  const [phase, setPhase] = useState<Phase>('idle');
  const [mandateId, setMandateId] = useState<string | null>(null);
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  const [mandateStatus, setMandateStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const settling = useRef(false);
  const live = wallet.liveSettlement;
  const STEPS = steps(live);

  // Keep the wallet menu from closing under a signature in progress.
  const running = phase !== 'idle' && phase !== 'done';
  const { setIssuing } = wallet;
  useEffect(() => {
    setIssuing(running);
    return () => setIssuing(false);
  }, [running, setIssuing]);

  async function settle(mandate: string) {
    if (settling.current) return;
    settling.current = true;
    setPhase('settling');
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Identifies the wallet the charge comes out of. Empty unless the
          // browser wallet is on, in which case the server settles as this
          // visitor rather than as itself.
          ...(await payerHeaders()),
        },
        body: JSON.stringify({
          action: 'pay',
          orderId,
          method: 'deposit',
          mandateId: mandate,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not settle this booking');
      setPhase('done');
      // Report what the server says happened, not what the UI expected. If the
      // two ever disagree the server is right, and the agent must not be told
      // a charge was simulated when a txHash came back.
      const charged = body.simulatedDeduction === false;
      setTxHash(body.settlement?.txHash ?? null);
      onSettled(
        `I approved the ${amount.toFixed(2)} ${currency} mandate for order ${orderId}. ` +
          (soleRail
            ? "This fare takes no card, so it settled from the desk's Atlas deposit"
            : "I chose to settle from the desk's Atlas deposit rather than my card") +
          (charged
            ? `, and ${amount.toFixed(2)} USDC was charged from my FluxA wallet against that mandate. `
            : ` and the deduction from my wallet was simulated — no money moved. `) +
          `It is now ${body.order.status}.`,
      );
    } catch (err) {
      setError((err as Error).message);
      setPhase('idle');
    } finally {
      settling.current = false;
    }
  }

  useEffect(() => {
    if (phase !== 'awaiting-signature' || !mandateId) return;
    const timer = setInterval(async () => {
      try {
        // Asked of whichever wallet holds the mandate. Polling the server's
        // wallet for a mandate that lives on the traveller's would wait for a
        // signature that is never going to appear there.
        if (browserWalletEnabled()) {
          const mandate = await getMandate(mandateId);
          if (mandate.status) setMandateStatus(mandate.status);
          if (isSigned(mandate)) {
            clearInterval(timer);
            await settle(mandateId);
          }
          return;
        }
        const res = await fetch(`/api/cards?mandateId=${encodeURIComponent(mandateId)}`);
        const body = await res.json();
        if (body.mandate?.status) setMandateStatus(body.mandate.status);
        if (body.signed) {
          clearInterval(timer);
          await settle(mandateId);
        }
      } catch {
        /* transient — keep waiting */
      }
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, mandateId]);

  async function start() {
    setError(null);
    setPhase('requesting');
    try {
      // Raised on the traveller's own wallet, straight to FluxA. A mandate is
      // the sentence someone is agreeing to, so the fewer parties between them
      // and it, the less there is to trust. The wording is composed here from
      // the fare and the booking reference — never from text a response
      // supplied, because a consent string an attacker can write is not consent.
      if (browserWalletEnabled()) {
        const mandate = await createMandate({
          amountUsd: amount,
          description: `Pay ${amount.toFixed(2)} USDC for flight booking ${(
            reference ?? orderId
          ).replace(/[^A-Za-z0-9-]/g, '').slice(0, 24)}`,
        });
        setMandateId(mandate.id);
        if (isSigned(mandate)) await settle(mandate.id);
        else {
          setApprovalUrl(mandate.approvalUrl ?? null);
          setPhase('awaiting-signature');
        }
        return;
      }

      const res = await fetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `purpose` decides the text on FluxA's approval screen. This mandate
        // pays for a ticket; without it the traveller would be asked to
        // approve funding a virtual card, which is not what happens next.
        body: JSON.stringify({
          action: 'mandate-create',
          amountUsd: amount,
          purpose: 'ticket',
          reference: reference ?? orderId,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not create a mandate');
      setMandateId(body.mandate.id);
      if (body.signed) await settle(body.mandate.id);
      else {
        setApprovalUrl(body.mandate.approvalUrl ?? null);
        setPhase('awaiting-signature');
      }
    } catch (err) {
      setError((err as Error).message);
      setPhase('idle');
    }
  }

  const currentIndex = ORDER.indexOf(phase);

  return (
    <div className="pay deposit-pay">
      <p className="note warn">
        {soleRail
          ? 'This airline takes no card for this fare. It settles from the desk’s Atlas deposit — '
          : 'Settling from the desk’s Atlas deposit rather than your card. '}
        {live
          ? `You authorise the amount once, and ${amount.toFixed(2)} USDC is then charged from your FluxA wallet against that mandate. This is a real transfer.`
          : 'You authorise the amount, but in this sandbox the deduction from your wallet is simulated and no money moves.'}
      </p>

      <div className="actions">
        <button className="primary" onClick={start} disabled={running}>
          {phase === 'requesting'
            ? 'Requesting…'
            : phase === 'settling'
              ? 'Settling…'
              : phase === 'done'
                ? 'Settled ✓'
                : `Authorise ${amount.toFixed(2)} ${currency} and settle`}
        </button>
      </div>

      {phase !== 'idle' ? (
        <ol className="steps">
          {STEPS.map((step, i) => {
            const state =
              phase === 'done' || i < currentIndex
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
                          Approve {amount.toFixed(2)} {currency} in FluxA →
                        </a>
                      ) : (
                        <span className="note bad">
                          FluxA returned no approval URL — check the wallet app.
                        </span>
                      )}
                      <span className="note">
                        FluxA reports <code>{mandateStatus ?? 'pending_signature'}</code>.
                        This continues on its own once you sign.
                      </span>
                    </span>
                  ) : null}

                  {/* The receipt. A settled charge that shows no evidence is
                      indistinguishable from a simulated one, which is exactly
                      the ambiguity this rail exists to remove. */}
                  {step.key === 'settling' && txHash ? (
                    <span className="step-action">
                      <a
                        className="note"
                        href={`https://basescan.org/tx/${txHash}`}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        Charged on Base — <code>{txHash.slice(0, 10)}…{txHash.slice(-8)}</code> ↗
                      </a>
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}

      {error ? <p className="note bad">{error}</p> : null}
    </div>
  );
}
