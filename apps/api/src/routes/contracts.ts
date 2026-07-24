import type { FastifyInstance } from 'fastify';
import type { Abi, AbiFunction } from 'viem';
import type { ContractInfo, ContractReadResult, Paginated } from '@4663scan/shared/api-types';
import type { AppContext } from '../context.js';
import type { Services } from '../services/index.js';
import { setCache } from '../lib/cache.js';
import { ApiHttpError, badRequest } from '../lib/errors.js';
import { parseLimit, parsePairCursor, requireAddress } from '../lib/params.js';
import { withTimeout } from '../lib/timeout.js';

/** Live RPC identity lookups (code, proxy slots, token probes) budget. */
const IDENTITY_TIMEOUT_MS = 5_000;
const READ_TIMEOUT_MS = 5_000;

type AddrParams = { Params: { address: string }; Querystring: Record<string, unknown> };
type ReadBody = { fn?: unknown; args?: unknown };
type ReadParams = { Params: { address: string }; Body: ReadBody };

export function registerContractRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  s: Services,
): void {
  app.get<AddrParams>('/addresses/:address/contract', async (req, reply) => {
    const address = requireAddress(req.params.address);
    const info: ContractInfo = await withTimeout(
      s.contract.getContractInfo(address),
      IDENTITY_TIMEOUT_MS,
      'contract identity',
    );
    // Verified source is immutable once found, but a not-yet-verified
    // contract can become verified at any time — keep this short-lived
    // rather than the 'immutable' policy blocks/txs use at depth.
    setCache(reply, 'short');
    return info;
  });

  app.post<ReadParams>('/addresses/:address/contract/read', async (req, reply) => {
    const address = requireAddress(req.params.address);
    const fn = req.body?.fn;
    const args = req.body?.args;
    if (typeof fn !== 'string' || fn.length === 0) throw badRequest('invalid fn');
    if (args !== undefined && !Array.isArray(args)) throw badRequest('invalid args');

    const info = await withTimeout(
      s.contract.getContractInfo(address),
      IDENTITY_TIMEOUT_MS,
      'contract identity',
    );
    const abi = info.source.abi as Abi | null;
    if (!abi) throw new ApiHttpError(409, 'no ABI available (contract not verified)');
    const target = abi.find(
      (item): item is AbiFunction => item.type === 'function' && item.name === fn,
    );
    if (!target) throw badRequest(`unknown function ${fn}`);
    if (target.stateMutability !== 'view' && target.stateMutability !== 'pure') {
      throw badRequest('only view/pure functions can be called here');
    }
    if ((args?.length ?? 0) !== target.inputs.length) {
      throw badRequest(`${fn} expects ${target.inputs.length} argument(s)`);
    }

    // Reads target the address on the page (the proxy, if this is one) —
    // delegatecall proxies keep their own storage, so the call must hit the
    // proxy address even though it's decoded with the implementation's ABI.
    const result: ContractReadResult = await withTimeout(
      s.contract.readFunction(address, abi, fn, args ?? []),
      READ_TIMEOUT_MS,
      'contract read',
    ).catch((err: unknown) => ({
      success: false,
      outputs: null,
      error: err instanceof Error ? err.message : 'read timed out',
    }));
    setCache(reply, 'no-store');
    return result;
  });

  app.get<AddrParams>('/addresses/:address/contract/events', async (req, reply) => {
    const address = requireAddress(req.params.address);
    const limit = parseLimit(req.query.limit);
    const cursor = parsePairCursor(req.query.cursor);

    const info = await withTimeout(
      s.contract.getContractInfo(address),
      IDENTITY_TIMEOUT_MS,
      'contract identity',
    );
    const { items, nextCursor } = await s.contract.getEvents(
      address,
      limit,
      cursor,
      info.source.abi,
    );
    setCache(reply, 'short');
    const payload: Paginated<(typeof items)[number]> = { items, nextCursor };
    return payload;
  });
}
