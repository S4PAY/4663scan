'use client';

import { useState, type FormEvent } from 'react';
import type { PaymentView } from '@4663scan/shared/api-types';
import { NEXT_PUBLIC_API_URL } from '@/lib/config';
import { CopyButton } from './CopyButton';

type VerifyState = { kind: 'idle' } | { kind: 'verifying' } | { kind: 'failed'; reason: string };

export function PaymentPanel({
  id,
  token,
  initial,
}: {
  id: number;
  token: string;
  initial: PaymentView;
}) {
  const [view, setView] = useState(initial);
  const [txHash, setTxHash] = useState('');
  const [state, setState] = useState<VerifyState>({ kind: 'idle' });

  async function handleVerify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState({ kind: 'verifying' });
    try {
      const res = await fetch(`${NEXT_PUBLIC_API_URL}/v1/submissions/${id}/verify-payment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, txHash }),
      });
      const body = (await res.json().catch(() => null)) as
        | { status?: string; error?: string }
        | null;
      if (res.ok) {
        setView((v) => ({ ...v, status: body?.status ?? 'pending' }));
        setState({ kind: 'idle' });
        return;
      }
      setState({ kind: 'failed', reason: body?.error ?? `verification failed (${res.status})` });
    } catch {
      setState({
        kind: 'failed',
        reason: 'request failed — check your connection and try again',
      });
    }
  }

  if (view.status !== 'awaiting_payment') {
    return (
      <div className="card px-4 py-6 text-center text-sm">
        <p className="text-accent">Payment verified.</p>
        <p className="mt-1 text-muted">
          Your submission is now in the review queue. We&apos;ll reach out at the contact
          email you provided if we need anything else.
        </p>
        {view.paymentTxHash && (
          <p className="mt-3 break-all font-mono text-xs text-muted">tx: {view.paymentTxHash}</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="card px-4 py-3">
        <div className="text-xs text-muted">Send exactly</div>
        <div className="mt-1 font-mono text-lg text-accent">
          {view.amountDisplay} {view.asset}
        </div>

        <div className="mt-3 text-xs text-muted">To this address</div>
        <div className="mt-1 flex items-start gap-1 break-all font-mono text-[13px] text-text">
          <span>{view.treasuryAddress}</span>
          <CopyButton text={view.treasuryAddress} />
        </div>

        <div className="mt-3 text-xs text-muted">
          {view.quoteExpired ? (
            <span className="text-red">
              This quote expired — go back and submit the form again for a fresh one.
            </span>
          ) : (
            <>Quote valid until {new Date(view.quoteExpiresAt).toLocaleString()}</>
          )}
        </div>
      </div>

      <form onSubmit={(e) => void handleVerify(e)} className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Transaction hash
          <input
            required
            value={txHash}
            onChange={(e) => setTxHash(e.target.value)}
            placeholder="0x…"
            pattern="^0[xX][0-9a-fA-F]{64}$"
            title="0x followed by 64 hex characters"
            disabled={view.quoteExpired}
            className="input"
          />
        </label>

        {state.kind === 'failed' && <p className="text-xs text-red">{state.reason}</p>}

        <button
          type="submit"
          disabled={state.kind === 'verifying' || view.quoteExpired}
          className="btn self-start px-4 py-2"
        >
          {state.kind === 'verifying' ? 'Verifying…' : 'Verify payment'}
        </button>
      </form>
    </div>
  );
}
