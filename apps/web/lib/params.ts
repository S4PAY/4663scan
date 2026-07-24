/**
 * Next delivers a repeated query param (?q=a&q=b) as string[]. Every page
 * should normalize through this before touching a searchParams value, or a
 * crafted URL turns `.trim()` / `encodeURIComponent()` into a 500.
 */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
