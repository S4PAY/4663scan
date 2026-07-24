import type { ContractInfo } from '@4663scan/shared/api-types';
import { CopyButton } from './CopyButton';
import { EmptyState } from './DataTable';
import { RawToggle } from './RawToggle';

export function ContractCodeTab({ info }: { info: ContractInfo }) {
  const { source } = info;

  if (source.verified) {
    return (
      <div>
        {source.files && source.files.length > 0 ? (
          <div className="flex flex-col gap-3">
            {source.files.map((f) => (
              <details key={f.path} className="card overflow-hidden" open={source.files!.length === 1}>
                <summary className="cursor-pointer select-none border-b border-border px-3 py-2 font-mono text-[13px] text-muted hover:text-accent">
                  {f.path}
                </summary>
                <pre className="raw m-0 max-h-[32rem] overflow-auto rounded-none border-0">
                  {f.content}
                </pre>
              </details>
            ))}
          </div>
        ) : (
          <EmptyState>Source verified but no file contents were returned.</EmptyState>
        )}

        {source.abi && (
          <div className="mt-4 card overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-[13px] font-semibold uppercase tracking-wider text-muted">
                ABI
              </span>
              <CopyButton text={JSON.stringify(source.abi, null, 2)} />
            </div>
            <pre className="raw m-0 max-h-96 overflow-auto rounded-none border-0">
              {JSON.stringify(source.abi, null, 2)}
            </pre>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="badge badge-amber mb-3 w-full justify-center py-2">
        Not verified — no source or ABI on Sourcify or Blockscout for this address.
      </div>
      {info.decodedSelectors && info.decodedSelectors.length > 0 && (
        <div className="card mb-4 overflow-hidden">
          <div className="border-b border-border px-3 py-2 text-[13px] font-semibold uppercase tracking-wider text-muted">
            Selectors found in bytecode
          </div>
          <div className="divide-y divide-border/60">
            {info.decodedSelectors.map((s) => (
              <div key={s.selector} className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
                <span className="chip">{s.selector}</span>
                <span className={s.name ? '' : 'text-muted'}>{s.name ?? 'unknown selector'}</span>
              </div>
            ))}
          </div>
          <p className="border-t border-border/60 px-3 py-1.5 text-[11px] text-muted/80">
            Heuristically scanned from raw bytecode (PUSH4 patterns), not a decompiler — may
            include false positives.
          </p>
        </div>
      )}
      {info.bytecode && <RawToggle label="Raw bytecode" data={info.bytecode} />}
    </div>
  );
}
