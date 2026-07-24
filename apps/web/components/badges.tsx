export function MethodChip({
  name,
  id,
}: {
  name: string | null;
  id: string | null;
}) {
  return (
    <span className="chip" title={id ?? undefined}>
      {name ?? id ?? 'transfer'}
    </span>
  );
}

export function StatusBadge({ status }: { status: number | null }) {
  if (status === 1) return <span className="badge badge-green">success</span>;
  if (status === 0) return <span className="badge badge-red">reverted</span>;
  return <span className="badge badge-amber">pending</span>;
}

export function StockBadge({ ticker }: { ticker?: string | null }) {
  return (
    <span className="badge badge-green font-mono">
      STOCK
      {ticker ? <span className="font-semibold">{ticker}</span> : null}
    </span>
  );
}
