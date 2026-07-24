'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Renders a QR code for the address entirely client-side (the `qrcode`
 * package, canvas-based) — no server round trip, no new API endpoint.
 * Popover pattern matches CopyButton's small icon-button footprint.
 */
export function QrButton({ value }: { value: string }) {
  const [open, setOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !canvasRef.current) return;
    let cancelled = false;
    void import('qrcode').then((QRCode) => {
      if (cancelled || !canvasRef.current) return;
      void QRCode.toCanvas(canvasRef.current, value, {
        width: 176,
        margin: 1,
        color: { dark: '#0a0a0a', light: '#ededee' },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Show QR code"
        aria-label="Show QR code"
        aria-expanded={open}
        className="ml-1 inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded border border-transparent align-middle text-xs text-muted transition-colors hover:border-border hover:text-text"
      >
        ▦
      </button>
      {open && (
        <div className="card absolute right-0 top-full z-20 mt-1.5 flex w-[212px] flex-col items-center gap-1.5 p-3">
          <canvas ref={canvasRef} width={176} height={176} className="bg-[#ededee]" />
          <span className="max-w-full break-all text-center font-mono text-[10px] text-muted">
            {value}
          </span>
        </div>
      )}
    </div>
  );
}
