'use client';

import { useEffect, useState } from 'react';
import { NEXT_PUBLIC_API_URL } from '@/lib/config';

interface AbiInput {
  name: string;
  type: string;
}
interface AbiFunctionLike {
  type: string;
  name: string;
  stateMutability?: string;
  inputs: AbiInput[];
}

interface ReadResult {
  success: boolean;
  outputs: string[] | null;
  error: string | null;
}

async function callRead(
  address: string,
  fn: string,
  args: string[],
): Promise<ReadResult> {
  try {
    const res = await fetch(`${NEXT_PUBLIC_API_URL}/v1/addresses/${address}/contract/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fn, args }),
    });
    return (await res.json()) as ReadResult;
  } catch {
    return { success: false, outputs: null, error: 'request failed' };
  }
}

function FunctionCard({ address, fn }: { address: string; fn: AbiFunctionLike }) {
  const [args, setArgs] = useState<string[]>(() => fn.inputs.map(() => ''));
  const [result, setResult] = useState<ReadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const zeroArg = fn.inputs.length === 0;

  const run = async () => {
    setLoading(true);
    const r = await callRead(address, fn.name, args);
    setResult(r);
    setLoading(false);
  };

  // Zero-arg reads auto-populate on mount, matching the common
  // "Read Contract" convention — the browser's own per-origin connection
  // cap naturally bounds how many fire concurrently.
  useEffect(() => {
    if (zeroArg) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="card px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono text-[13px] font-medium">{fn.name}</span>
        <span className="text-xs text-muted">
          ({fn.inputs.map((i) => i.type).join(', ')})
        </span>
        {!zeroArg && (
          <button
            type="button"
            onClick={() => void run()}
            disabled={loading}
            className="btn ml-auto px-2 py-1 text-xs"
          >
            {loading ? 'Querying…' : 'Query'}
          </button>
        )}
      </div>

      {!zeroArg && (
        <div className="mt-2 flex flex-col gap-1.5">
          {fn.inputs.map((inp, i) => (
            <input
              key={i}
              type="text"
              placeholder={`${inp.name || `arg${i}`} (${inp.type})`}
              value={args[i] ?? ''}
              onChange={(e) => {
                const next = [...args];
                next[i] = e.target.value;
                setArgs(next);
              }}
              className="w-full border border-border bg-bg px-2 py-1 font-mono text-xs text-text outline-none focus:border-accent/60"
            />
          ))}
        </div>
      )}

      {loading && zeroArg && (
        <div className="mt-1.5 text-xs text-muted">loading…</div>
      )}
      {result && (
        <div className="mt-1.5">
          {result.success ? (
            <div className="flex flex-col gap-0.5">
              {(result.outputs ?? []).map((o, i) => (
                <span key={i} className="mono break-all text-[13px] text-accent">
                  {o}
                </span>
              ))}
              {(result.outputs?.length ?? 0) === 0 && (
                <span className="text-xs text-muted">(no output)</span>
              )}
            </div>
          ) : (
            <span className="break-all text-xs text-red">{result.error ?? 'call failed'}</span>
          )}
        </div>
      )}
    </div>
  );
}

export function ContractReadTab({ address, abi }: { address: string; abi: unknown[] }) {
  const readFns = (abi as AbiFunctionLike[]).filter(
    (item) =>
      item.type === 'function' &&
      (item.stateMutability === 'view' || item.stateMutability === 'pure'),
  );

  if (readFns.length === 0) {
    return (
      <div className="card px-4 py-8 text-center text-sm text-muted">
        No view/pure functions in this contract's ABI.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {readFns.map((fn, i) => (
        <FunctionCard key={`${fn.name}-${i}`} address={address} fn={fn} />
      ))}
    </div>
  );
}
