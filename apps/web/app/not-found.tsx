import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <div className="font-mono text-5xl font-bold text-accent">404</div>
      <h1 className="mt-3 text-lg font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-muted">
        This block, transaction or address isn&apos;t in our index (yet). It may be
        outside the indexed range, or the identifier may be malformed.
      </p>
      <Link href="/" className="btn mt-6">
        ← Back to the live feed
      </Link>
    </div>
  );
}
