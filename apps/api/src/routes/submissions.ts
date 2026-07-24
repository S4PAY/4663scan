import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { tokenSubmissions } from '@4663scan/shared/db/schema';
import type { AppContext } from '../context.js';
import type { Services } from '../services/index.js';
import { badRequest } from '../lib/errors.js';
import { clientIp } from '../lib/rate-limit.js';
import { requireAddress } from '../lib/params.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** apps/api/src/routes/../../../web/public/submission-logos — same box,
 *  same filesystem, one monorepo (matches apps/indexer/src/logos.ts's
 *  token-logos convention). Kept in its OWN directory, separate from the
 *  verified stock-token logos in /token-logos/, since these are unreviewed
 *  submitter uploads — nothing here is wired into any public page until a
 *  human approves the row it belongs to. */
const SUBMISSION_LOGO_DIR = join(HERE, '..', '..', '..', 'web', 'public', 'submission-logos');
const LOGO_SIZE = 256;
const LOGO_FETCH_TIMEOUT_MS = 10_000;
const MAX_SHORT_TEXT = 200;
const MAX_LONG_TEXT = 2_000;
/** Real users never see or fill this (CSS-hidden in the form) — a filled
 *  honeypot means a bot. Pretend success without writing anything, so it
 *  never learns which check caught it. */
const HONEYPOT_FIELD = 'phone';

function cleanText(raw: unknown, maxLen: number): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLen) : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Decodes (validating it's a real image — sharp throws otherwise),
 *  normalizes to a square transparent-pad webp. Never writes a submitter's
 *  raw bytes to disk under any circumstance, uploaded file or fetched URL
 *  alike — only ever this re-encoded copy. */
async function normalizeToWebp(raw: Buffer): Promise<Buffer> {
  return sharp(raw)
    .resize(LOGO_SIZE, LOGO_SIZE, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp({ quality: 90 })
    .toBuffer();
}

export function registerSubmissionRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  s: Services,
): void {
  app.post(
    '/submissions',
    {
      config: {
        // Anti-spam: far stricter than the general public-API cap (see
        // main.ts) — this is a write endpoint that reaches the DB and the
        // filesystem, not a cached read.
        rateLimit: { max: 5, timeWindow: '1 day', keyGenerator: clientIp },
      },
    },
    async (req, reply) => {
      const fields: Record<string, string> = {};
      let fileBuffer: Buffer | null = null;

      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file as AsyncIterable<Buffer>) chunks.push(chunk);
          if (!part.file.truncated) fileBuffer = Buffer.concat(chunks);
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }

      if (cleanText(fields[HONEYPOT_FIELD], 1) != null) {
        reply.code(201);
        return { ok: true };
      }

      // Fail fast, before any RPC/contract check or logo fetch/decode work,
      // if payment isn't even configured — otherwise a misconfigured
      // treasury would still let a logo land on disk for a submission that
      // can never be inserted (newQuote() throws below in that case).
      const quote = s.payments.newQuote();

      const rawAddress = cleanText(fields.tokenAddress, 42);
      if (!rawAddress) throw badRequest('token address is required');
      const address = requireAddress(rawAddress);

      const projectName = cleanText(fields.projectName, MAX_SHORT_TEXT);
      if (!projectName) throw badRequest('project name is required');

      const contactEmail = cleanText(fields.contactEmail, MAX_SHORT_TEXT);
      if (!contactEmail || !EMAIL_RE.test(contactEmail)) {
        throw badRequest('a valid contact email is required');
      }

      // Cheap (one eth_getCode, already cached — see contract.ts) and the
      // one thing this route MUST check before accepting anything.
      const code = await s.contract.getCodeInfo(address);
      if (!code.isContract) {
        throw badRequest('that address is not a contract on this chain');
      }

      let logoPath: string | null = null;
      const logoUrl = cleanText(fields.logoUrl, 2_000);
      try {
        let raw = fileBuffer;
        if (!raw && logoUrl) {
          const res = await fetch(logoUrl, {
            signal: AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS),
          });
          if (res.ok) raw = Buffer.from(await res.arrayBuffer());
        }
        if (raw) {
          const webp = await normalizeToWebp(raw);
          await mkdir(SUBMISSION_LOGO_DIR, { recursive: true });
          const filename = `${randomUUID()}.webp`;
          await writeFile(join(SUBMISSION_LOGO_DIR, filename), webp);
          logoPath = `/submission-logos/${filename}`;
        }
      } catch (err) {
        // An unreadable/invalid logo shouldn't block the whole submission
        // — a reviewer can follow up with the submitter instead. Never
        // write anything unvalidated to disk in this branch.
        req.log.warn({ err }, 'submission logo processing failed; continuing without one');
      }

      const [row] = await ctx.db
        .insert(tokenSubmissions)
        .values({
          tokenAddress: address,
          projectName,
          logoPath,
          website: cleanText(fields.website, 300),
          socials: cleanText(fields.socials, MAX_LONG_TEXT),
          description: cleanText(fields.description, MAX_LONG_TEXT),
          contactEmail,
          submitterIp: clientIp(req),
          paymentToken: quote.paymentToken,
          priceQuotedUsd: quote.priceQuotedUsd,
          quoteExpiresAt: quote.quoteExpiresAt,
        })
        .returning({ id: tokenSubmissions.id });

      reply.code(201);
      return { ok: true, id: row?.id ?? null, paymentToken: quote.paymentToken };
    },
  );

  app.get('/payment-info', async () => s.payments.publicInfo());

  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/submissions/:id/payment',
    async (req) => {
      const id = requireSubmissionId(req.params.id);
      const token = cleanText(req.query.token, 128);
      if (!token) throw badRequest('missing payment token');
      return s.payments.paymentView(id, token);
    },
  );

  app.post<{ Params: { id: string }; Body: { token?: string; txHash?: string } }>(
    '/submissions/:id/verify-payment',
    {
      config: {
        // A legitimate payer may need a few tries (typo'd hash, tx not yet
        // mined) — looser than the 5/day submission cap, still far below
        // anything a scripted retry loop would need.
        rateLimit: { max: 20, timeWindow: '1 hour', keyGenerator: clientIp },
      },
    },
    async (req) => {
      const id = requireSubmissionId(req.params.id);
      const token = cleanText(req.body?.token, 128);
      const txHash = cleanText(req.body?.txHash, 128);
      if (!token) throw badRequest('missing payment token');
      if (!txHash) throw badRequest('missing transaction hash');
      return s.payments.verifyPayment(id, token, txHash);
    },
  );
}

function requireSubmissionId(raw: string): number {
  const id = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(id) || id <= 0) {
    throw badRequest('invalid submission id');
  }
  return id;
}
