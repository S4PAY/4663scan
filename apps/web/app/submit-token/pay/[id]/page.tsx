import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { PaymentView } from '@4663scan/shared/api-types';
import { PaymentPanel } from '@/components/PaymentPanel';
import { apiGet, isClientError } from '@/lib/api';
import { firstParam } from '@/lib/params';

export const metadata: Metadata = { title: 'Complete Payment' };

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string | string[] }>;
}

export default async function PayForSubmissionPage({ params, searchParams }: Props) {
  const { id } = await params;
  const token = firstParam((await searchParams).t);
  if (!/^\d+$/.test(id) || !token) notFound();

  let view: PaymentView;
  try {
    view = await apiGet<PaymentView>(
      `/submissions/${id}/payment?token=${encodeURIComponent(token)}`,
      { cache: 'no-store' },
    );
  } catch (err) {
    // A wrong/mangled token or id is client input, not an API outage.
    if (isClientError(err)) notFound();
    throw err;
  }

  return (
    <div className="max-w-md">
      <h1 className="text-lg font-semibold">Complete payment</h1>
      <p className="mt-2 text-[13px] text-muted">
        Send the exact amount below from any wallet, then paste the resulting transaction
        hash here to confirm it. Bookmark this page — you can come back to it any time
        before the quote expires.
      </p>
      <div className="mt-5">
        <PaymentPanel id={Number(id)} token={token} initial={view} />
      </div>
    </div>
  );
}
