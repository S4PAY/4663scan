import type { ReactNode } from 'react';

/**
 * Table that renders as a real table on sm+ and collapses to
 * definition-list cards on mobile (see .dt rules in globals.css).
 * Cells must be <Td label="..."> so the mobile view can label them.
 */
export function DataTable({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="card overflow-hidden max-sm:border-0 max-sm:bg-transparent max-sm:bg-none">
      <table className="dt">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Td({
  label,
  className = '',
  children,
}: {
  label: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <td data-label={label} className={className}>
      {children}
    </td>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="card px-4 py-10 text-center text-sm text-muted">{children}</div>
  );
}

export function DetailList({ children }: { children: ReactNode }) {
  // Plain .card, not .glass: tx/block detail rows can carry a ticking <Age>
  // (components/Age.tsx, 1s interval), and a backdrop-filter ancestor redoes
  // its blur sample on every repaint inside it (see M3a review).
  return <dl className="detail card overflow-hidden">{children}</dl>;
}

export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-2 mt-6 text-[13px] font-semibold uppercase tracking-wider text-muted">
      {children}
    </h2>
  );
}
