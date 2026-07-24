/**
 * Client-visible config. NEXT_PUBLIC_* values are inlined at build time, so
 * this module is safe to import from client components.
 */
export const NEXT_PUBLIC_API_URL: string =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4663';
