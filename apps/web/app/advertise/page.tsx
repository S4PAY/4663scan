import type { Metadata } from 'next';
import { SectionTitle } from '@/components/DataTable';

export const metadata: Metadata = {
  title: 'Advertise',
  description: 'Placements and audience for advertising on RHEX.',
};

const PLACEMENTS = [
  {
    name: 'Footer placement',
    description:
      'A small text/logo placement in the site footer, visible on every page.',
  },
  {
    name: 'Token page sponsor note',
    description:
      'A labeled, clearly-marked note on a specific token’s detail page — relevant to projects on that exact token.',
  },
  {
    name: '/tokens directory feature',
    description: 'A featured slot at the top of the tokens directory page.',
  },
];

export default function AdvertisePage() {
  return (
    <div className="max-w-2xl">
      <h1 className="text-lg font-semibold">Advertise on RHEX</h1>
      <p className="mt-2 text-[13px] text-muted">
        RHEX is the block explorer for Robinhood Chain — read by holders, builders and
        traders checking transactions, tokens and contracts on the chain day to day.
        We keep placements small, clearly labeled, and separate from data we show (no
        promoted or pay-for-rank listings — see our{' '}
        <a href="/docs" className="hashlink">
          API docs
        </a>{' '}
        for the same read-only data everyone gets).
      </p>

      <SectionTitle>Placements</SectionTitle>
      <div className="space-y-3">
        {PLACEMENTS.map((p) => (
          <div key={p.name} className="card px-4 py-3">
            <div className="text-sm font-medium">{p.name}</div>
            <p className="mt-1 text-[13px] text-muted">{p.description}</p>
          </div>
        ))}
      </div>

      <SectionTitle>Audience</SectionTitle>
      <p className="text-[13px] text-muted">
        We&apos;re early — this is a young explorer for a young chain, and we&apos;d rather
        tell you that plainly than paper over it with invented numbers. Current traffic
        and audience figures are available on request; ask when you get in touch below.
      </p>

      <SectionTitle>Get in touch</SectionTitle>
      <p className="text-[13px] text-muted">
        DM us on X —{' '}
        <a
          href="https://x.com/4663scan"
          target="_blank"
          rel="noopener noreferrer"
          className="hashlink"
        >
          x.com/4663scan
        </a>{' '}
        — with what you&apos;re looking for and we&apos;ll reply with pricing and
        availability.
      </p>
    </div>
  );
}
