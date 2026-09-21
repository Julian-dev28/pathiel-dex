/**
 * GET /api/openapi.json — the API contract, served from the code that implements it.
 *
 * Written by hand rather than generated. A generator would derive the schema
 * from the types, which sounds better until you notice it can only describe the
 * shape and not the semantics — that `amountIn` is a base-unit integer as a
 * string because JSON has no bigint, or that a 404 means "no pool" rather than
 * "wrong URL". Those are the parts a consumer actually needs.
 */

import { NextResponse } from 'next/server';
import { CHAIN_LIST, DEFAULT_CHAIN } from '@/lib/chain';

export const dynamic = 'force-dynamic';

/** Every chain's symbols. Which ones are valid depends on `chain`. */
const SYMBOLS = [...new Set(CHAIN_LIST.flatMap((c) => c.tokens.map((t) => t.symbol)))];

const chainParam = {
  name: 'chain',
  in: 'query',
  description: 'Which chain to route on. Token symbols are resolved on this chain.',
  schema: { type: 'string', enum: CHAIN_LIST.map((c) => c.key), default: DEFAULT_CHAIN },
};

const bigintString = {
  type: 'string',
  pattern: '^[0-9]+$',
  description: 'Base-unit integer as a decimal string. JSON has no bigint.',
};

export async function GET() {
  return NextResponse.json({
    openapi: '3.1.0',
    info: {
      title: 'PATHIEL DEX',
      version: '0.3.0',
      description:
        'On-chain route solver for Robinhood Chain and Base. Quotes every venue from pool state and solves the ' +
        'optimal split. No authentication: every endpoint reads public chain state, and the ' +
        'same calls work from anywhere. Rate limited to 120 requests per minute per IP.',
      license: { name: 'MIT' },
    },
    servers: [{ url: '/', description: 'this deployment' }],
    paths: {
      '/api/quote': {
        get: {
          summary: 'Solve a route',
          description:
            'Quotes every discovered venue at a ladder of sizes, returns the best single ' +
            'venue, the optimal split, and every venue curve behind the decision.',
          parameters: [
            chainParam,
            {
              name: 'in',
              in: 'query',
              schema: { type: 'string', enum: SYMBOLS },
              example: 'WETH',
            },
            {
              name: 'out',
              in: 'query',
              schema: { type: 'string', enum: SYMBOLS },
              example: 'USDG',
            },
            {
              name: 'amount',
              in: 'query',
              description: 'Human units of the input token, not base units.',
              schema: { type: 'string' },
              example: '1.5',
            },
          ],
          responses: {
            200: {
              description: 'A solved route',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      blockNumber: bigintString,
                      quotedAt: { type: 'integer', description: 'Unix ms when quoted.' },
                      expiresAt: {
                        type: 'integer',
                        description:
                          'Unix ms after which the interface refuses to sign this quote.',
                      },
                      cached: { type: 'boolean' },
                      latencyMs: { type: 'integer' },
                      route: {
                        type: 'object',
                        properties: {
                          single: { $ref: '#/components/schemas/Route' },
                          split: { $ref: '#/components/schemas/Route' },
                          chosen: { type: 'string', enum: ['single', 'split'] },
                          edgeBps: { type: 'number', description: 'Split advantage, gross.' },
                          netEdgeBps: { type: 'number', description: 'Split advantage, net of gas.' },
                        },
                      },
                    },
                  },
                },
              },
            },
            400: { description: 'Unknown chain or token, identical tokens, or an unparseable amount' },
            404: { description: 'No pool quotes this pair on the chain' },
            429: { description: 'Rate limited. Retry-After header is set.' },
          },
        },
      },
      '/api/analyze': {
        get: {
          summary: 'Execution intelligence for a pair',
          description:
            'Five measurements derived from quoting the pair in both directions: sandwich ' +
            'exposure at a given slippage, a slippage recommendation drawn from measured price ' +
            'drift, capacity at several impact budgets, liquidity fragmentation, and the best ' +
            'cross-venue round trip. Cached 20s.',
          parameters: [
            chainParam,
            { name: 'in', in: 'query', schema: { type: 'string' } },
            { name: 'out', in: 'query', schema: { type: 'string' } },
            { name: 'amount', in: 'query', schema: { type: 'string' } },
            {
              name: 'slippage',
              in: 'query',
              description: 'Tolerance in basis points to price the exposure against.',
              schema: { type: 'integer', default: 50 },
            },
          ],
          responses: {
            200: {
              description: 'Analysis',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      exposure: {
                        type: 'object',
                        description:
                          'quotedOut minus the on-chain floor: the most a sandwich can extract. ' +
                          'Exact, not estimated — it is the gap the user authorised.',
                      },
                      drift: {
                        type: 'object',
                        nullable: true,
                        description:
                          'Absolute price change over an inclusion window, in basis points, ' +
                          'measured from Uniswap V3 Swap events. Null when the pair has not ' +
                          'traded enough recently to measure.',
                      },
                      recommendation: {
                        type: 'object',
                        description:
                          'Slippage drawn from drift, widened when the sample is small. Never ' +
                          'tightens below the wallet default on a low-confidence sample.',
                      },
                      capacity: {
                        type: 'array',
                        description:
                          'Largest trade per impact budget. `atLeast` means the quoted range ' +
                          'was entirely within budget, so the figure is a lower bound.',
                      },
                      fragmentation: {
                        type: 'object',
                        description: 'Share of optimal execution happening away from the best venue.',
                      },
                      arb: {
                        type: 'object',
                        nullable: true,
                        description:
                          'Best two-venue round trip and the size that maximises it. Usually ' +
                          'unprofitable: these close within a block.',
                      },
                    },
                  },
                },
              },
            },
            400: { description: 'Bad pair or amount' },
            404: { description: 'No liquidity' },
            429: { description: 'Rate limited' },
          },
        },
      },
      '/api/venues': {
        get: {
          summary: 'Pool inventory for a pair',
          description:
            'Every distinct pool the router would consider, including pools that only appear ' +
            'mid-route on a two-hop path, with each pool’s ERC-20 balances.',
          parameters: [
            chainParam,
            { name: 'in', in: 'query', schema: { type: 'string' } },
            { name: 'out', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Pools' }, 400: { description: 'Bad pair' } },
        },
      },
      '/api/stream': {
        get: {
          summary: 'Live quotes (server-sent events)',
          description:
            'text/event-stream. Emits `open`, then a `quote` event whenever a new block ' +
            'changes the answer, then `bye` at the ten-minute cap. Coalesced to at most one ' +
            'quote every six seconds; unchanged quotes are not sent.',
          parameters: [
            chainParam,
            { name: 'in', in: 'query', schema: { type: 'string' } },
            { name: 'out', in: 'query', schema: { type: 'string' } },
            { name: 'amount', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            200: { description: 'An event stream', content: { 'text/event-stream': {} } },
            429: { description: 'Rate limited' },
          },
        },
      },
      '/api/health': {
        get: {
          summary: 'Liveness and chain freshness',
          description:
            'Returns 503 when the chain head is more than 60 seconds old, which is the ' +
            'failure a bare liveness check misses.',
          responses: { 200: { description: 'Healthy' }, 503: { description: 'Degraded or down' } },
        },
      },
      '/api/metrics': {
        get: {
          summary: 'In-process counters and quote latency percentiles',
          responses: { 200: { description: 'Metrics for this instance only' } },
        },
      },
    },
    components: {
      schemas: {
        Route: {
          type: 'object',
          properties: {
            amountIn: bigintString,
            amountOut: bigintString,
            gasEstimate: bigintString,
            allocations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  amountIn: bigintString,
                  amountOut: bigintString,
                  share: { type: 'number', description: 'Percent of the trade.' },
                  venue: { $ref: '#/components/schemas/Venue' },
                },
              },
            },
          },
        },
        Venue: {
          type: 'object',
          description: 'A route through one protocol family; hops.length === path.length - 1.',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            family: { type: 'string', enum: ['v2', 'v3', 'aero'] },
            path: { type: 'array', items: { $ref: '#/components/schemas/Token' } },
            hops: { type: 'array', items: { type: 'object' } },
            router: { type: 'string', description: 'Router that executes this route.' },
          },
        },
        Token: {
          type: 'object',
          properties: {
            chainId: { type: 'integer' },
            symbol: { type: 'string' },
            name: { type: 'string' },
            address: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
            decimals: { type: 'integer' },
          },
        },
      },
    },
    'x-chains': CHAIN_LIST.map((c) => ({ key: c.key, chainId: c.id, name: c.name })),
  });
}
