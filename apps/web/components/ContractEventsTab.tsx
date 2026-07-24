import type { ContractEventLog, Paginated } from '@4663scan/shared/api-types';
import { Age } from './Age';
import { EmptyState } from './DataTable';
import { LoadMore } from './LoadMore';
import { RawToggle } from './RawToggle';
import { TxLink } from './links';

export function ContractEventsTab({
  address,
  page,
}: {
  address: string;
  page: Paginated<ContractEventLog>;
}) {
  if (page.items.length === 0) {
    return <EmptyState>No logs for this address in the indexed range.</EmptyState>;
  }
  return (
    <>
      <div className="card divide-y divide-border/60">
        {page.items.map((log) => (
          <div key={`${log.blockNumber}-${log.logIndex}`} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="chip">#{log.logIndex}</span>
              {log.decoded ? (
                <span className="chip">{log.decoded.name}</span>
              ) : (
                <span className="text-xs text-muted">undecoded</span>
              )}
              <TxLink hash={log.txHash} />
              <Age timestamp={log.timestamp} />
            </div>
            {log.decoded && log.decoded.params.length > 0 && (
              <div className="mt-1.5 flex flex-col gap-0.5 text-[13px]">
                {log.decoded.params.map((p, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="shrink-0 font-mono text-muted">{p.name}</span>
                    <span className="mono break-all">{p.value}</span>
                  </div>
                ))}
              </div>
            )}
            {!log.decoded && (
              <ol className="mt-2 space-y-1">
                {log.topics.map((topic, i) => (
                  <li key={i} className="flex gap-2 font-mono text-xs">
                    <span className="shrink-0 text-muted">t{i}</span>
                    <span className={`break-all ${i === 0 ? 'font-semibold text-text' : 'text-muted'}`}>
                      {topic}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {!log.decoded && log.data && log.data !== '0x' && (
              <div className="mt-2">
                <RawToggle label="Data" data={log.data} />
              </div>
            )}
          </div>
        ))}
      </div>
      <LoadMore
        basePath={`/address/${address}`}
        cursor={page.nextCursor}
        params={{ tab: 'events' }}
      />
    </>
  );
}
