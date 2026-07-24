/**
 * Renders a token's self-hosted logo, or — for any token without one — a
 * generated monogram tile (ticker initials, neon-on-charcoal) at the exact
 * same size/shape, so a grid of these never looks like a ragged mix of
 * real logos and blank space. Never hotlinks a third party: logoPath is
 * always either null or a same-origin /token-logos/*.webp path.
 */
export function TokenLogo({
  logoPath,
  ticker,
  size = 40,
  version,
}: {
  logoPath: string | null;
  ticker: string | null;
  size?: number;
  /** logoFetchedAt (unix seconds), appended as ?v= — logoPath is otherwise
   *  stable per address, so a re-fetched logo (e.g. after a bad upstream
   *  source got corrected) needs a way to invalidate any edge/browser
   *  cache still holding the old bytes at that same path, without
   *  depending on a CDN purge actually happening. */
  version?: number | null;
}) {
  if (logoPath) {
    const src = version != null ? `${logoPath}?v=${version}` : logoPath;
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className="shrink-0 border border-border bg-raised object-contain"
        style={{ width: size, height: size }}
      />
    );
  }
  const initials = (ticker ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || '?';
  return (
    <div
      aria-hidden="true"
      className="flex shrink-0 select-none items-center justify-center border border-accent/30 bg-raised font-mono font-bold text-accent"
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.32) }}
    >
      {initials}
    </div>
  );
}
