/**
 * CLI review tool for the token-submission queue (M7, paid gate added M8).
 * Nothing submitted via POST /v1/submissions is ever auto-published — a row
 * starts 'awaiting_payment', only a verified on-chain payment moves it to
 * 'pending', and only a human running this tool moves it from there to
 * 'approved'/'rejected'. Approving an unpaid ('awaiting_payment') row is
 * refused outright, not just silently unreachable.
 *
 * Usage:
 *   pnpm --filter @4663scan/api review-submissions list [awaiting_payment|pending|approved|rejected|all]
 *   pnpm --filter @4663scan/api review-submissions show <id>
 *   pnpm --filter @4663scan/api review-submissions approve <id> ["review note"]
 *   pnpm --filter @4663scan/api review-submissions reject <id> ["review note"]
 */
import { and, desc, eq } from 'drizzle-orm';
import { makeDb } from '@4663scan/shared/db';
import { env } from '@4663scan/shared/env';
import { formatUnitsTrim } from '@4663scan/shared/format';
import { tokenSubmissions } from '@4663scan/shared/db/schema';

const STATUSES = ['awaiting_payment', 'pending', 'approved', 'rejected'] as const;
type Status = (typeof STATUSES)[number];

function isStatus(s: string): s is Status {
  return (STATUSES as readonly string[]).includes(s);
}

function formatRow(row: typeof tokenSubmissions.$inferSelect): string {
  return [
    `#${row.id} [${row.status}]`,
    `  token:      ${row.tokenAddress}`,
    `  project:    ${row.projectName}`,
    `  contact:    ${row.contactEmail}`,
    `  website:    ${row.website ?? '-'}`,
    `  socials:    ${row.socials ?? '-'}`,
    `  logo:       ${row.logoPath ?? '(none)'}`,
    `  ip:         ${row.submitterIp ?? '-'}`,
    `  created:    ${row.createdAt.toISOString()}`,
    `  price quoted: $${row.priceQuotedUsd}, quote expires ${row.quoteExpiresAt.toISOString()}`,
    row.paymentTxHash
      ? `  paid:       ${formatUnitsTrim(row.paidAmount ?? '0', env.PAYMENT_TOKEN_DECIMALS, env.PAYMENT_TOKEN_DECIMALS)} ${row.paidAsset} at ${row.paidAt?.toISOString()} (tx ${row.paymentTxHash})`
      : '  paid:       not yet',
    row.reviewedAt ? `  reviewed:   ${row.reviewedAt.toISOString()}` : null,
    row.reviewNote ? `  note:       ${row.reviewNote}` : null,
    row.description ? `  description:\n    ${row.description.replace(/\n/g, '\n    ')}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

async function main(): Promise<void> {
  const [cmd, arg1, ...rest] = process.argv.slice(2);
  const { db, sql } = makeDb({ max: 1 });

  try {
    if (cmd === 'list') {
      const filter = arg1 ?? 'pending';
      const rows =
        filter === 'all'
          ? await db
              .select()
              .from(tokenSubmissions)
              .orderBy(desc(tokenSubmissions.createdAt))
              .limit(100)
          : await db
              .select()
              .from(tokenSubmissions)
              .where(eq(tokenSubmissions.status, requireStatus(filter)))
              .orderBy(desc(tokenSubmissions.createdAt))
              .limit(100);
      if (rows.length === 0) {
        console.log(`(no ${filter} submissions)`);
        return;
      }
      for (const row of rows) {
        console.log(
          `#${row.id}\t[${row.status}]\t${row.projectName}\t${row.tokenAddress}\t${row.contactEmail}\t${row.createdAt.toISOString()}`,
        );
      }
      return;
    }

    if (cmd === 'show') {
      const id = requireId(arg1);
      const [row] = await db.select().from(tokenSubmissions).where(eq(tokenSubmissions.id, id));
      if (!row) {
        console.error(`no submission #${id}`);
        process.exitCode = 1;
        return;
      }
      console.log(formatRow(row));
      return;
    }

    if (cmd === 'approve' || cmd === 'reject') {
      const id = requireId(arg1);
      const note = rest.join(' ') || null;
      const status: Status = cmd === 'approve' ? 'approved' : 'rejected';

      // Look the row up first so a blocked action gets a SPECIFIC, honest
      // reason — "unpaid" and "already reviewed" are different problems for
      // an operator, not just two flavors of "the UPDATE matched 0 rows".
      const [existing] = await db
        .select()
        .from(tokenSubmissions)
        .where(eq(tokenSubmissions.id, id));
      if (!existing) {
        console.error(`no submission #${id}`);
        process.exitCode = 1;
        return;
      }
      if (existing.status === 'awaiting_payment') {
        console.error(
          `submission #${id} is still awaiting payment — cannot ${cmd} an unpaid submission`,
        );
        process.exitCode = 1;
        return;
      }
      if (existing.status !== 'pending') {
        console.error(`submission #${id} was already reviewed (status: ${existing.status})`);
        process.exitCode = 1;
        return;
      }

      const [row] = await db
        .update(tokenSubmissions)
        .set({ status, reviewedAt: new Date(), reviewNote: note })
        .where(and(eq(tokenSubmissions.id, id), eq(tokenSubmissions.status, 'pending')))
        .returning();
      if (!row) {
        // Raced with another reviewer between the select above and this
        // update — rare, but the WHERE clause (not the select) is what
        // actually prevents a double-review, so still handle it.
        console.error(`submission #${id} was reviewed by someone else just now`);
        process.exitCode = 1;
        return;
      }
      console.log(`#${id} -> ${status}`);
      console.log(formatRow(row));
      if (status === 'approved') {
        console.log(
          '\nApproving here only marks the row reviewed — publishing it into the live',
          '\ntoken/stock-token listing (if desired) is a separate, deliberate step.',
        );
      }
      return;
    }

    console.error(
      'usage: review-submissions <list [status]|show <id>|approve <id> [note]|reject <id> [note]>',
    );
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function requireId(raw: string | undefined): number {
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id <= 0) {
    console.error(`invalid id: ${raw ?? '(missing)'}`);
    process.exit(1);
  }
  return id;
}

function requireStatus(raw: string): Status {
  if (!isStatus(raw)) {
    console.error(
      `invalid status filter: ${raw} (expected awaiting_payment|pending|approved|rejected|all)`,
    );
    process.exit(1);
  }
  return raw;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
