"use client";

import { useEffect, useRef, useState } from "react";

import { balanceOf, useWallet } from "@/components/providers/WalletProvider";
import { IssueCardFlow } from "./IssueCardFlow";

/**
 * Pay, and choose what to pay with, in one control.
 *
 * The card was previously chosen in a menu at the other end of the screen,
 * which meant the button that spends money did not say what it would spend
 * from until you went and looked. Here the card is named on the button, and
 * changing it — or opening a funded one — happens at the moment of payment
 * rather than as a prerequisite you have to know about in advance.
 */
export function PayControl({
  amount,
  currency,
  working,
  onPay,
}: {
  amount: number;
  currency: string;
  working: boolean;
  onPay: (cardId: string) => void;
}) {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const card = wallet.selected;
  const shortfall = card ? amount - balanceOf(card) : amount;

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    // The ref spans the whole control, not just the bar: mousedown fires before
    // click, so a menu row outside it would be treated as an outside click and
    // unmount itself before its own handler ever ran.
    <div className="pay" ref={ref}>
      <div className="paybar">
        <button
          className="primary paybar-main"
          disabled={working || !card}
          onClick={() => card && onPay(card.id)}
        >
          {working
            ? "Charging card…"
            : card
              ? `Pay ${amount.toFixed(2)} ${currency} with •••• ${card.last4 ?? "????"}`
              : `Pay ${amount.toFixed(2)} ${currency} — choose a card`}
        </button>
        <button
          className="paybar-caret"
          aria-label="Choose a different card"
          aria-expanded={open}
          disabled={working}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={`chev ${open ? "up" : ""}`} aria-hidden="true" />
        </button>
      </div>

      {/* Expands in place rather than floating over the card. The order card
          sets overflow:hidden to clip its header corners, which silently cut
          an absolutely-positioned menu in half; and inside a scrolling pane a
          floating menu would need its position tracked on every scroll. */}
      {open ? (
        <div className="paymenu" role="menu">
          {wallet.cards.length ? (
            wallet.cards.map((c) => {
              const covers = balanceOf(c) >= amount;
              return (
                <button
                  key={c.id}
                  role="menuitem"
                  className={`paymenu-row ${c.id === card?.id ? "on" : ""}`}
                  onClick={() => {
                    wallet.selectCard(c.id);
                    setOpen(false);
                  }}
                >
                  <span className="paymenu-pan">•••• {c.last4 ?? "????"}</span>
                  <span className={`paymenu-bal ${covers ? "" : "short"}`}>
                    ${balanceOf(c).toFixed(2)}
                  </span>
                  {/* Say which cards can actually cover this fare, rather
                        than letting the balance be worked out by the reader. */}
                  <span className="paymenu-note">
                    {covers ? "covers this fare" : "not enough"}
                  </span>
                </button>
              );
            })
          ) : (
            <p className="note">No cards yet.</p>
          )}
          <button
            role="menuitem"
            className="paymenu-row new"
            onClick={() => {
              setIssuing(true);
              setOpen(false);
            }}
          >
            Open a new card…
          </button>
        </div>
      ) : null}

      {/* No shortfall banner here. Each row of the picker already says whether
          it covers the fare, and repeating it under the button was noise —
          doubly so because the sandbox authorises regardless of balance, which
          makes a confident "short of this fare" warning misleading. */}

      {issuing ? (
        <IssueCardFlow
          defaultAmount={Math.ceil(amount)}
          reason="FluxA cards are prepaid and issued against a mandate you sign yourself — the agent cannot create one on its own."
          onIssued={() => setIssuing(false)}
        />
      ) : null}
    </div>
  );
}
