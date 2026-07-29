import type { Metadata } from 'next';
import { SectionTitle } from '@/components/DataTable';

export const metadata: Metadata = {
  title: 'API Docs',
  description: 'Free, keyless REST API for Robinhood Chain block/transaction/token data.',
};

const BASE_URL = 'https://4663scan.io/api/v1';

interface EndpointDoc {
  method: 'GET' | 'POST';
  path: string;
  summary: string;
  params?: string;
  body?: string;
  example: string;
}

function Endpoint({ doc }: { doc: EndpointDoc }) {
  return (
    <div className="card px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          className={
            doc.method === 'GET'
              ? 'badge badge-green font-mono'
              : 'badge badge-amber font-mono'
          }
        >
          {doc.method}
        </span>
        <code className="font-mono text-[13px] text-text">{doc.path}</code>
      </div>
      <p className="mt-2 text-[13px] text-muted">{doc.summary}</p>
      {doc.params && (
        <p className="mt-2 font-mono text-xs text-muted">
          <span className="text-text">params</span> {doc.params}
        </p>
      )}
      {doc.body && (
        <p className="mt-2 font-mono text-xs text-muted">
          <span className="text-text">body</span> {doc.body}
        </p>
      )}
      <pre className="raw mt-2">{doc.example}</pre>
    </div>
  );
}

const GROUPS: { title: string; endpoints: EndpointDoc[] }[] = [
  {
    title: 'Chain',
    endpoints: [
      {
        method: 'GET',
        path: '/status',
        summary: 'Chain head, indexed height, backfill progress, retention state.',
        example: `{"chainId":4663,"headBlock":1928431,"indexedBlock":1928428,
 "indexedBlockTimestamp":1753200214,"indexStartBlock":1000000,
 "backfill":{"enabled":true,"cursor":950213,"floor":0,"done":false},
 "blocksIndexed":928428,"txsIndexed":4820193,"blockTimeSeconds":0.1,
 "baseFeePerGas":"1000000"}`,
      },
      {
        method: 'GET',
        path: '/feed',
        summary:
          'Newest ~12 blocks and their txs, read live from RPC (not the DB index) — always current, even while backfill is far behind.',
        example: `{"headBlock":1928431,"blockTimeSeconds":0.11,
 "blocks":[{"number":1928431,"hash":"0xbeef...1234","timestamp":1753200300,
 "txCount":12,"gasUsed":1523000,"gasLimit":30000000,"miner":"0x1111...0000"}],
 "txs":[{"hash":"0xa1b2...c3d4","blockNumber":1928431,"txIndex":0,
 "from":{"address":"0x1234...abcd","label":null},
 "to":{"address":"0xdead...5678","label":null},
 "value":"1000000000000000000","status":1,"methodName":"transfer"}]}`,
      },
      {
        method: 'GET',
        path: '/stream',
        summary:
          'Server-Sent Events. Emits event: status every 10s and event: block on every new block. Each data: line is JSON; a bare : ping comment is sent every 15s as a keep-alive.',
        example: `event: block
data: {"type":"block","block":{"number":1928431,"hash":"0xbeef...1234","txCount":12},"txs":[...]}

event: status
data: {"type":"status","status":{"chainId":4663,"headBlock":1928431,...}}`,
      },
    ],
  },
  {
    title: 'Blocks',
    endpoints: [
      {
        method: 'GET',
        path: '/blocks',
        summary: 'Newest-first, keyset paginated.',
        params: 'limit (1-100, default 25), cursor (block number of the last item seen)',
        example: `{"items":[{"number":1928431,"hash":"0xbeef...1234","timestamp":1753200300,
 "txCount":12,"gasUsed":1523000,"gasLimit":30000000,"miner":"0x1111...0000"}],
 "nextCursor":"1928406"}`,
      },
      {
        method: 'GET',
        path: '/blocks/:id',
        summary: 'id is a decimal block number or a 0x + 64-hex block hash.',
        example: `{"number":1928431,"hash":"0xbeef...1234","timestamp":1753200300,"txCount":12,
 "gasUsed":1523000,"gasLimit":30000000,"miner":"0x1111...0000",
 "parentHash":"0xaaaa...aaaa","size":48213,"confirmations":10005}`,
      },
      {
        method: 'GET',
        path: '/blocks/:id/txs',
        summary: 'Transactions in one block.',
        params: 'limit, cursor ("<blockNumber>_<txIndex>")',
        example: `{"items":[{"hash":"0xa1b2...c3d4","blockNumber":1928431,"txIndex":0,
 "from":{"address":"0x1234...abcd","label":null},
 "to":{"address":"0xdead...5678","label":null},
 "value":"1000000000000000000","status":1,"methodName":"transfer"}],
 "nextCursor":"1928431_1"}`,
      },
    ],
  },
  {
    title: 'Transactions',
    endpoints: [
      {
        method: 'GET',
        path: '/txs',
        summary: 'Newest-first across the whole chain, keyset paginated.',
        params: 'limit, cursor ("<blockNumber>_<txIndex>")',
        example: `{"items":[{"hash":"0xa1b2...c3d4","blockNumber":1928431,"txIndex":0,
 "from":{"address":"0x1234...abcd","label":null},
 "to":{"address":"0xdead...5678","label":null},
 "value":"1000000000000000000","status":1,"methodName":"transfer"}],
 "nextCursor":"1928431_0"}`,
      },
      {
        method: 'GET',
        path: '/txs/:hash',
        summary: 'Full detail: decoded input, token transfers, logs.',
        example: `{"hash":"0xa1b2...c3d4","blockNumber":1928431,"txIndex":0,"status":1,
 "from":{"address":"0x1234...abcd","label":null},
 "to":{"address":"0xdead...5678","label":"Sample Token"},
 "value":"1000000000000000000","gasUsed":21000,"effectiveGasPrice":"1000000000",
 "input":"0xa9059cbb0000...","decoded":{"signature":"transfer(address,uint256)",
 "name":"transfer","source":"known","params":[
   {"name":"to","type":"address","value":"0x1234...abcd"},
   {"name":"amount","type":"uint256","value":"1000000000000000000"}]},
 "transfers":[{"logIndex":0,"token":{"address":"0xdead...5678","symbol":"SMPL"},
   "from":{"address":"0x1234...abcd","label":null},
   "to":{"address":"0x9999...1111","label":null},"value":"1000000000000000000"}],
 "logs":[{"logIndex":0,"address":{"address":"0xdead...5678","label":"Sample Token"},
   "topics":["0xddf2...ef","0x0000...abcd","0x0000...1111"],"data":"0x0000..."}]}`,
      },
    ],
  },
  {
    title: 'Addresses',
    endpoints: [
      {
        method: 'GET',
        path: '/addresses/:address',
        summary: 'Live balance + contract check, indexed tx count.',
        example: `{"address":"0x1234...abcd","balanceWei":"2500000000000000000",
 "isContract":false,"labels":[],"token":null,"indexedTxCount":142}`,
      },
      {
        method: 'GET',
        path: '/addresses/:address/txs',
        summary: 'Transactions where the address is sender, recipient, or creator.',
        params: 'limit, cursor ("<blockNumber>_<txIndex>")',
        example: `{"items":[{"hash":"0xa1b2...c3d4","blockNumber":1928431,"txIndex":0, ...}],
 "nextCursor":"1928431_0"}`,
      },
      {
        method: 'GET',
        path: '/addresses/:address/transfers',
        summary: 'Token transfers into or out of the address.',
        params: 'limit, cursor ("<blockNumber>_<logIndex>")',
        example: `{"items":[{"logIndex":0,"token":{"address":"0xdead...5678","symbol":"SMPL"},
 "from":{"address":"0x1234...abcd","label":null},
 "to":{"address":"0x9999...1111","label":null},"value":"1000000000000000000"}],
 "nextCursor":"1928431_0"}`,
      },
      {
        method: 'GET',
        path: '/addresses/:address/tokens',
        summary: 'Live per-token balanceOf for every token the address has ever touched.',
        example: `{"items":[{"token":{"address":"0xdead...5678","symbol":"SMPL","decimals":18},
 "balance":"1000000000000000000"}],"degraded":false}`,
      },
    ],
  },
  {
    title: 'Contracts',
    endpoints: [
      {
        method: 'GET',
        path: '/addresses/:address/contract',
        summary:
          'Bytecode identity, token/proxy detection, creator, and verified source (Sourcify, then Blockscout) when available.',
        example: `{"isContract":true,"codeSize":4213,"tokenType":"erc20",
 "token":{"address":"0xdead...5678","symbol":"SMPL","decimals":18},
 "proxy":null,"creator":{"address":"0x1234...abcd","txHash":"0xa1b2...c3d4"},
 "source":{"verified":true,"name":"SampleToken","compilerVersion":"v0.8.24+commit.e11b9ed9",
 "abi":[{"type":"function","name":"transfer","stateMutability":"nonpayable"}],
 "files":[{"path":"SampleToken.sol","content":"// SPDX-License-Identifier: MIT\\n..."}],
 "provider":"sourcify"}}`,
      },
      {
        method: 'POST',
        path: '/addresses/:address/contract/read',
        summary:
          'Calls a view/pure function from the verified ABI via eth_call. 400 if the contract is unverified or the function/arity does not match.',
        body: '{ "fn": "balanceOf", "args": ["0x1234567890abcdef1234567890abcdef1234abcd"] }',
        example: `{"success":true,"outputs":["1000000000000000000000000"],"error":null}`,
      },
      {
        method: 'GET',
        path: '/addresses/:address/contract/events',
        summary: 'Logs emitted by the contract, decoded against its own verified ABI.',
        params: 'limit, cursor ("<blockNumber>_<logIndex>")',
        example: `{"items":[{"blockNumber":1928431,"logIndex":0,"txHash":"0xa1b2...c3d4",
 "topics":["0xddf2...ef","0x0000...abcd","0x0000...1111"],
 "decoded":{"name":"Transfer","params":[
   {"name":"from","type":"address","value":"0x1234...abcd"},
   {"name":"to","type":"address","value":"0x9999...1111"},
   {"name":"value","type":"uint256","value":"1000000000000000000"}]}}],
 "nextCursor":"1928431_0"}`,
      },
    ],
  },
  {
    title: 'Tokens',
    endpoints: [
      {
        method: 'GET',
        path: '/tokens',
        summary: 'Stock tokens sorted first, then everything else by symbol.',
        params:
          'limit, cursor (plain offset, not a keyset pair), q (symbol/name match), stock ("true"|"false")',
        example: `{"items":[{"address":"0xdead...5678","name":"Sample Token","symbol":"SMPL",
 "decimals":18,"type":"erc20","isStockToken":false,"totalSupply":"1000000000000000000000000",
 "holderCount":842}],"nextCursor":"25"}`,
      },
      {
        method: 'GET',
        path: '/tokens/:address',
        summary: 'Single token, including stock metadata (ticker, logo, Chainlink feed) when set.',
        example: `{"address":"0xdead...5678","name":"Sample Token","symbol":"SMPL","decimals":18,
 "isStockToken":true,"holderCount":842,
 "stock":{"ticker":"XYZ","companyName":"Example Corp","logoPath":"/token-logos/xyz.webp",
 "assetClass":"stock","chainlinkFeed":null}}`,
      },
      {
        method: 'GET',
        path: '/tokens/:address/transfers',
        summary: 'Transfer log for one token.',
        params: 'limit, cursor ("<blockNumber>_<logIndex>")',
        example: `{"items":[{"logIndex":0,"from":{"address":"0x1234...abcd","label":null},
 "to":{"address":"0x9999...1111","label":null},"value":"1000000000000000000"}],
 "nextCursor":"1928431_0"}`,
      },
    ],
  },
  {
    title: 'Search',
    endpoints: [
      {
        method: 'GET',
        path: '/search',
        summary:
          'One box, many shapes: 64-hex resolves as a tx (or block hash), 40-hex as an address/token, a plausible decimal as a block number, anything else as a token/label text match.',
        params: 'q',
        example: `{"query":"0xdead...5678","results":[
 {"type":"token","address":"0xdead...5678","name":"Sample Token","symbol":"SMPL"},
 {"type":"address","address":"0xdead...5678","label":null}]}`,
      },
    ],
  },
];

export default function DocsPage() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-lg font-semibold">API</h1>
      <p className="mt-2 text-[13px] text-muted">
        Free, read-only REST API over RHEX&apos;s own index — no signup,
        no API key. This is the exact same API the site itself calls.
      </p>

      <pre className="raw mt-4">{`curl ${BASE_URL}/status`}</pre>

      <SectionTitle>Conventions</SectionTitle>
      <ul className="list-outside list-disc space-y-1.5 pl-4 text-[13px] text-muted">
        <li>
          Base URL: <code className="font-mono text-text">{BASE_URL}</code>. CORS is open
          (<code className="font-mono">Access-Control-Allow-Origin: *</code>) — call it
          directly from browser JS on any origin.
        </li>
        <li>
          Rate limit: <strong className="text-text">120 requests/minute per IP</strong>,
          shared across all endpoints below. Exceeding it returns HTTP 429:
          <code className="mt-1 block font-mono text-xs">
            {`{"error":"rate limit exceeded — max 120 requests per 1 minute, try again in 40s","statusCode":429}`}
          </code>
        </li>
        <li>
          Errors are always <code className="font-mono text-text">{`{ "error": string, "statusCode": number }`}</code>{' '}
          — 400 for bad input (address/hash/cursor shape), 404 for unknown resources, 429 for
          rate limiting, 502 for a momentary upstream/indexing race (safe to retry once), 500
          for anything else.
        </li>
        <li>
          List endpoints are keyset-paginated: pass the response&apos;s{' '}
          <code className="font-mono text-text">nextCursor</code> back as{' '}
          <code className="font-mono text-text">?cursor=</code> to get the next page; a{' '}
          <code className="font-mono text-text">null</code> cursor means there is no more
          data. Cursor format varies by endpoint (shown per-endpoint below) — treat it as
          opaque either way.
        </li>
        <li>
          Deep, confirmed blocks/transactions are sent with a one-year immutable{' '}
          <code className="font-mono text-text">Cache-Control</code> — safe to cache
          aggressively on your end too.
        </li>
      </ul>

      {GROUPS.map((group) => (
        <div key={group.title}>
          <SectionTitle>{group.title}</SectionTitle>
          <div className="space-y-3">
            {group.endpoints.map((doc) => (
              <Endpoint key={doc.method + doc.path} doc={doc} />
            ))}
          </div>
        </div>
      ))}

      <SectionTitle>Not covered here</SectionTitle>
      <p className="text-[13px] text-muted">
        <code className="font-mono text-text">POST /v1/submissions</code> (the{' '}
        <a href="/submit-token" className="hashlink">
          token submission form
        </a>
        ) is a write endpoint for the review queue, not a general-purpose API
        — it&apos;s intentionally left out of the read-only surface above.
      </p>
    </div>
  );
}
