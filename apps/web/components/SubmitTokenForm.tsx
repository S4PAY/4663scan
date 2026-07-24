'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { NEXT_PUBLIC_API_URL } from '@/lib/config';

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'submitted-no-payment' }
  | { kind: 'error'; message: string };

interface SubmitResponse {
  ok: boolean;
  id?: number | null;
  paymentToken?: string;
}

export function SubmitTokenForm() {
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });
  const router = useRouter();

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);

    setState({ kind: 'submitting' });
    try {
      const res = await fetch(`${NEXT_PUBLIC_API_URL}/v1/submissions`, {
        method: 'POST',
        body: data,
      });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as SubmitResponse | null;
        if (body?.id != null && body.paymentToken) {
          form.reset();
          router.push(`/submit-token/pay/${body.id}?t=${encodeURIComponent(body.paymentToken)}`);
          return;
        }
        // Honeypot-triggered responses omit id/paymentToken on purpose —
        // there's nowhere real to send this "submitter" to pay.
        setState({ kind: 'submitted-no-payment' });
        form.reset();
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setState({
        kind: 'error',
        message: body?.error ?? `submission failed (${res.status})`,
      });
    } catch {
      setState({ kind: 'error', message: 'request failed — check your connection and try again' });
    }
  }

  if (state.kind === 'submitted-no-payment') {
    return (
      <div className="card px-4 py-6 text-center text-sm">
        <p className="text-accent">Submitted.</p>
      </div>
    );
  }

  const submitting = state.kind === 'submitting';

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
      {/* Honeypot: real visitors never see or focus this field (off-screen,
          not display:none — some bots skip fields that are display:none but
          still fill absolutely-positioned ones, so this alone isn't
          bulletproof, but it's a real, effective, zero-cost first filter). A
          filled value silently no-ops server-side (see submissions.ts). */}
      <div className="absolute -left-[9999px] top-auto h-0 w-0 overflow-hidden" aria-hidden="true">
        <label>
          Phone
          <input type="text" name="phone" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-xs text-muted">
        Token contract address *
        <input
          required
          name="tokenAddress"
          placeholder="0x…"
          pattern="^0[xX][0-9a-fA-F]{40}$"
          title="0x followed by 40 hex characters"
          className="input"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted">
        Project name *
        <input required name="projectName" maxLength={200} className="input" />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted">
        Logo URL
        <input
          name="logoUrl"
          type="url"
          placeholder="https://…/logo.png"
          className="input"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted">
        …or upload a logo directly
        <input
          name="logo"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"
          className="input file:mr-3 file:cursor-pointer file:border-0 file:bg-raised file:px-2 file:py-1 file:text-text"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted">
        Website
        <input name="website" type="url" placeholder="https://…" className="input" />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted">
        Socials
        <input
          name="socials"
          placeholder="Twitter/X, Discord, Telegram…"
          maxLength={2000}
          className="input"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted">
        Short description
        <textarea name="description" rows={4} maxLength={2000} className="input" />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted">
        Contact email *
        <input required name="contactEmail" type="email" className="input" />
      </label>

      {state.kind === 'error' && (
        <p className="text-xs text-red">{state.message}</p>
      )}

      <button type="submit" disabled={submitting} className="btn mt-1 self-start px-4 py-2">
        {submitting ? 'Submitting…' : 'Continue to payment'}
      </button>
    </form>
  );
}
