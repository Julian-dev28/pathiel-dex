/**
 * Local MCP server over stdio, with trading.
 *
 * Same tools as the hosted /api/mcp, plus `get_wallet` and `swap`, which sign
 * with a private key that never leaves this machine. The key is read from
 * `PATHIEL_PRIVATE_KEY`, either in the environment or in the repo's
 * `.env.local` (gitignored). Without it the server runs read-only.
 *
 *   npm run mcp
 *
 * Use a dedicated wallet funded with only what you intend to trade.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { registerTools } from '../src/lib/mcp';

// stdout is the protocol channel. Anything else printed there — a log line
// from the solver — corrupts the stream, so all console output goes to stderr.
console.log = console.info = console.debug = console.error;

try {
  process.loadEnvFile(new URL('../.env.local', import.meta.url));
} catch {
  // No .env.local; the environment may still carry the key.
}

const raw = process.env.PATHIEL_PRIVATE_KEY?.trim();
let account: PrivateKeyAccount | undefined;
// Hyperliquid signs with the raw key, which a PrivateKeyAccount does not give back.
let key: string | undefined;
if (raw) {
  key = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error('pathiel-dex mcp: PATHIEL_PRIVATE_KEY is not a 32-byte hex key');
    process.exit(1);
  }
  account = privateKeyToAccount(key as `0x${string}`);
  console.error(`pathiel-dex mcp: trading enabled for ${account.address}`);
} else {
  console.error('pathiel-dex mcp: no PATHIEL_PRIVATE_KEY, running read-only');
}

serveStdio(() => {
  const server = new McpServer({ name: 'pathiel-dex', version: '0.1.0' }, { capabilities: { tools: {} } });
  registerTools(server, account, key as `0x${string}` | undefined);
  return server;
});
