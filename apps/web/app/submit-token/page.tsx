import type { Metadata } from 'next';
import type { PaymentPublicInfo } from '@4663scan/shared/api-types';
import { SubmitTokenForm } from '@/components/SubmitTokenForm';
import { apiGet } from '@/lib/api';

export const metadata: Metadata = {
  title: 'Submit a Token',
  description: 'Submit a token for listing on 4663scan.',
};

export default async function SubmitTokenPage() {
  let info: PaymentPublicInfo | null = null;
  try {
    info = await apiGet<PaymentPublicInfo>('/payment-info', { cache: 'no-store' });
  } catch {
    // API down or unconfigured: form itself still renders; the POST will
    // surface the real error (503 if payment truly isn't configured).
  }

  return (
    <div className="max-w-md">
      <h1 className="text-lg font-semibold">Submit a token</h1>
      <p className="mt-2 text-[13px] text-muted">
        Tell us about a token on Robinhood Chain. The contract address must already be
        deployed on-chain.
      </p>

      <div className="card mt-4 px-4 py-3 text-[13px] text-muted">
        <ul className="list-outside list-disc space-y-1.5 pl-4">
          <li>
            Listing costs{' '}
            <span className="text-text">
              {info ? `${info.priceUsd} USD (paid in ${info.asset})` : 'a small fee'}
            </span>{' '}
            — you&apos;ll pay after submitting this form.
          </li>
          <li>Every submission is reviewed by hand — nothing is published automatically.</li>
          <li>
            Reviews typically complete within a few business days, though it can take
            longer during busy periods.
          </li>
          <li>
            <span className="text-text">Paying does not guarantee approval</span> — it
            puts your submission in the review queue, nothing more.
          </li>
          <li>
            <span className="text-amber">Refund policy:</span>{' '}
            <span className="text-amber">
              [OPERATOR: insert refund policy wording here before launch]
            </span>
          </li>
        </ul>
      </div>

      <div className="mt-5">
        <SubmitTokenForm />
      </div>
    </div>
  );
}
