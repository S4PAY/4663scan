import type { AppContext } from '../context.js';
import { makeViews, type Views } from '../views.js';
import { makeCold, type Cold } from './cold.js';
import { makeContract, type Contract } from './contract.js';
import { makeDecode, type Decode } from './decode.js';
import { makeFeed, type Feed } from './feed.js';
import { makeHeads, type Heads } from './heads.js';
import { makeLive, type Live } from './live.js';
import { makeMeta, type Meta } from './labels.js';
import { makePayments, type Payments } from './payments.js';
import { makeStatus, type Status } from './status.js';
import { makeStream, type Stream } from './stream.js';

export interface Services {
  heads: Heads;
  meta: Meta;
  decode: Decode;
  views: Views;
  cold: Cold;
  feed: Feed;
  live: Live;
  status: Status;
  stream: Stream;
  contract: Contract;
  payments: Payments;
}

export function buildServices(ctx: AppContext): Services {
  const heads = makeHeads(ctx);
  const meta = makeMeta(ctx);
  const decode = makeDecode(ctx);
  const views = makeViews(meta, decode);
  const cold = makeCold(ctx, heads);
  const feed = makeFeed(ctx, heads, cold, views);
  const live = makeLive(ctx, meta);
  const status = makeStatus(ctx, heads);
  const stream = makeStream(ctx, status, views);
  const contract = makeContract(ctx, meta, decode);
  const payments = makePayments(ctx, cold);
  return { heads, meta, decode, views, cold, feed, live, status, stream, contract, payments };
}
