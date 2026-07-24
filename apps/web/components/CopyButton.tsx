'use client';

import { useEffect, useRef, useState } from 'react';

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = () => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };

  return (
    <button
      type="button"
      onClick={copy}
      title="Copy to clipboard"
      aria-label="Copy to clipboard"
      className={`ml-1 inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded border border-transparent align-middle text-xs transition-colors hover:border-border ${
        copied ? 'text-accent' : 'text-muted hover:text-text'
      }`}
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}
