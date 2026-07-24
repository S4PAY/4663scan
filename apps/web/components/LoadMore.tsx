import Link from 'next/link';

/**
 * Server-component-friendly pagination: a link to the same route with
 * ?cursor=<nextCursor>. Lists append via full navigation — simple and
 * cache-friendly.
 */
export function LoadMore({
  basePath,
  cursor,
  params,
}: {
  basePath: string;
  cursor: string | null;
  params?: Record<string, string | undefined>;
}) {
  if (!cursor) return null;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v) sp.set(k, v);
  }
  sp.set('cursor', cursor);
  return (
    <div className="mt-3">
      <Link href={`${basePath}?${sp.toString()}`} className="btn w-full">
        Load more ↓
      </Link>
    </div>
  );
}
