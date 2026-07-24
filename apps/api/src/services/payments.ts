import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { PaymentPublicInfo, PaymentView } from '@4663scan/shared/api-types';
import { formatUnitsTrim } from '@4663scan/shared/format';
import { tokenSubmissions, tokenTransfers } from '@4663scan/shared/db/schema';
import type { AppContext } from '../context.js';
import { ApiHttpError, badRequest, notFound } from '../lib/errors.js';
import { requireTxHash } from '../lib/params.js';
import type { Cold, ColdTx } from './cold.js';

/** A transfer of the configured payment token, regardless of source. */
interface PaymentTransfer {
  tokenAddress: string;
  to: string;
  value: string;
}

export interface NewQuote {
  paymentToken: string;
  priceQuotedUsd: string;
  quoteExpiresAt: Date;
}

function requiredRawAmount(priceUsd: string, decimals: number): bigint {
  return BigInt(Math.round(Number(priceUsd) * 10 ** decimals));
}

export function makePayments(ctx: AppContext, cold: Cold) {
  function requireConfigured(): { treasury: string; token: string } {
    if (!ctx.env.TREASURY_ADDRESS) {
      throw new ApiHttpError(
        503,
        'token submissions are temporarily unavailable (payment not configured)',
      );
    }
    return {
      treasury: ctx.env.TREASURY_ADDRESS.toLowerCase(),
      token: ctx.env.PAYMENT_TOKEN_ADDRESS.toLowerCase(),
    };
  }

  function publicInfo(): PaymentPublicInfo {
    return {
      configured: Boolean(ctx.env.TREASURY_ADDRESS),
      priceUsd: ctx.env.SUBMISSION_PRICE_USD,
      asset: ctx.env.PAYMENT_TOKEN_SYMBOL,
      assetAddress: ctx.env.PAYMENT_TOKEN_ADDRESS,
      assetDecimals: ctx.env.PAYMENT_TOKEN_DECIMALS,
      quoteWindowHours: ctx.env.PAYMENT_QUOTE_WINDOW_HOURS,
      maxTxAgeHours: ctx.env.PAYMENT_MAX_TX_AGE_SECONDS / 3600,
    };
  }

  /** Called once, at submission-creation time — freezes the price/token. */
  function newQuote(): NewQuote {
    requireConfigured();
    const quoteExpiresAt = new Date(
      Date.now() + ctx.env.PAYMENT_QUOTE_WINDOW_HOURS * 60 * 60 * 1000,
    );
    return {
      paymentToken: randomBytes(32).toString('hex'),
      priceQuotedUsd: ctx.env.SUBMISSION_PRICE_USD.toFixed(2),
      quoteExpiresAt,
    };
  }

  async function requireRow(id: number, token: string) {
    const [row] = await ctx.db
      .select()
      .from(tokenSubmissions)
      .where(and(eq(tokenSubmissions.id, id), eq(tokenSubmissions.paymentToken, token)));
    // Same 404 whether the id doesn't exist or the token is wrong — no
    // signal to leak about which one failed.
    if (!row) throw notFound();
    return row;
  }

  async function paymentView(id: number, token: string): Promise<PaymentView> {
    const { treasury, token: assetAddress } = requireConfigured();
    const row = await requireRow(id, token);
    const decimals = ctx.env.PAYMENT_TOKEN_DECIMALS;
    const amountRaw = requiredRawAmount(row.priceQuotedUsd, decimals);
    return {
      status: row.status,
      treasuryAddress: treasury,
      asset: ctx.env.PAYMENT_TOKEN_SYMBOL,
      assetAddress,
      priceQuotedUsd: row.priceQuotedUsd,
      amountRaw: amountRaw.toString(),
      amountDisplay: formatUnitsTrim(amountRaw, decimals, decimals),
      quoteExpiresAt: row.quoteExpiresAt.toISOString(),
      quoteExpired: Date.now() > row.quoteExpiresAt.getTime(),
      paymentTxHash: row.paymentTxHash,
      paidAmountDisplay:
        row.paidAmount != null ? formatUnitsTrim(row.paidAmount, decimals, decimals) : null,
      paidAt: row.paidAt?.toISOString() ?? null,
    };
  }

  /** All payment-token transfers within one tx, however it's currently served. */
  async function transfersForTx(hash: string, coldTx: ColdTx): Promise<PaymentTransfer[]> {
    if (coldTx.ephemeral) {
      return coldTx.ephemeral.transfers
        .filter((t) => t.txHash === hash)
        .map((t) => ({ tokenAddress: t.tokenAddress, to: t.to, value: t.value }));
    }
    return ctx.db
      .select({
        tokenAddress: tokenTransfers.tokenAddress,
        to: tokenTransfers.to,
        value: tokenTransfers.value,
      })
      .from(tokenTransfers)
      .where(eq(tokenTransfers.txHash, hash));
  }

  async function verifyPayment(
    id: number,
    token: string,
    rawTxHash: string,
  ): Promise<{ status: string }> {
    const { treasury, token: assetAddress } = requireConfigured();
    const hash = requireTxHash(rawTxHash);

    const row = await requireRow(id, token);
    if (row.status !== 'awaiting_payment') {
      throw badRequest('this submission is not awaiting payment (already paid or reviewed)');
    }
    if (Date.now() > row.quoteExpiresAt.getTime()) {
      throw badRequest('this price quote has expired — submit the form again for a fresh quote');
    }

    const coldTx = await cold.ensureTx(hash);
    if (!coldTx) {
      throw badRequest(
        'transaction not found on chain 4663 — it may still be pending, or the hash may be wrong',
      );
    }
    if (coldTx.row.status !== 1) {
      throw badRequest('that transaction failed on-chain (reverted) — it cannot be used as payment');
    }
    const ageSeconds = Date.now() / 1000 - coldTx.row.timestamp;
    if (ageSeconds > ctx.env.PAYMENT_MAX_TX_AGE_SECONDS) {
      throw badRequest(
        `that transaction is older than the allowed ${Math.round(ctx.env.PAYMENT_MAX_TX_AGE_SECONDS / 3600)}h window`,
      );
    }

    const transfers = await transfersForTx(hash, coldTx);
    const paidRaw = transfers
      .filter((t) => t.tokenAddress === assetAddress && t.to === treasury)
      .reduce((sum, t) => sum + BigInt(t.value), 0n);
    if (paidRaw === 0n) {
      throw badRequest(
        `no ${ctx.env.PAYMENT_TOKEN_SYMBOL} transfer to the treasury address was found in that transaction`,
      );
    }
    const decimals = ctx.env.PAYMENT_TOKEN_DECIMALS;
    const requiredRaw = requiredRawAmount(row.priceQuotedUsd, decimals);
    if (paidRaw < requiredRaw) {
      throw badRequest(
        `underpayment — received ${formatUnitsTrim(paidRaw, decimals, decimals)} ${ctx.env.PAYMENT_TOKEN_SYMBOL}, ` +
          `need at least ${formatUnitsTrim(requiredRaw, decimals, decimals)} ${ctx.env.PAYMENT_TOKEN_SYMBOL}`,
      );
    }

    try {
      const [updated] = await ctx.db
        .update(tokenSubmissions)
        .set({
          status: 'pending',
          paymentTxHash: hash,
          paidAmount: paidRaw.toString(),
          paidAsset: ctx.env.PAYMENT_TOKEN_SYMBOL,
          paidAt: new Date(),
        })
        .where(
          and(
            eq(tokenSubmissions.id, id),
            eq(tokenSubmissions.paymentToken, token),
            eq(tokenSubmissions.status, 'awaiting_payment'),
          ),
        )
        .returning({ status: tokenSubmissions.status });
      if (!updated) {
        throw badRequest('this submission was already processed (paid or reviewed) by another request');
      }
      return { status: updated.status };
    } catch (err) {
      // 23505 = unique_violation. The payment_tx_hash UNIQUE index is what
      // makes replaying a hash against a second submission fail atomically
      // here, not just via the earlier application-level checks above.
      // drizzle-orm wraps the driver's PostgresError as `.cause` on a
      // DrizzleQueryError rather than copying `.code` onto the outer error
      // (confirmed by reading drizzle-orm/errors.js) — check both.
      const code =
        (err as { code?: string } | null)?.code ??
        (err as { cause?: { code?: string } } | null)?.cause?.code;
      if (code === '23505') {
        throw badRequest('that transaction hash has already been used for another submission');
      }
      throw err;
    }
  }

  return { publicInfo, newQuote, paymentView, verifyPayment };
}

export type Payments = ReturnType<typeof makePayments>;
