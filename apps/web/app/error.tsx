'use client';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const unreachable = error.name === 'ApiUnreachableError';
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <div className="font-mono text-5xl font-bold text-red">✕</div>
      <h1 className="mt-3 text-lg font-semibold">
        {unreachable ? 'API unreachable' : 'Something went wrong'}
      </h1>
      <p className="mt-2 text-sm text-muted">
        {unreachable
          ? 'The explorer API is not responding — is `pnpm dev` running?'
          : error.message ||
            'An unexpected error occurred. If the API is down (`pnpm dev` not running), start it and retry.'}
      </p>
      {error.digest && (
        <p className="mt-1 font-mono text-xs text-muted/70">digest {error.digest}</p>
      )}
      <button type="button" onClick={reset} className="btn mt-6">
        ↻ Retry
      </button>
    </div>
  );
}
