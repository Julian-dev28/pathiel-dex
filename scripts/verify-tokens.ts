/**
 * Asserts the token table matches the chain.
 *
 * `scripts/verify-addresses.sh` proves each address has bytecode. That is not
 * enough: a token entry with the right address and the wrong `decimals` prices
 * every trade in it wrong by a factor of a thousand, silently, and no amount of
 * bytecode checking notices. So read `symbol()` and `decimals()` from each
 * contract and compare them to what we claim.
 *
 *   npm run verify:tokens
 */

import { parseAbi } from 'viem';
import { CHAIN_LIST } from '../src/lib/chain';
import { client } from '../src/lib/quote';

const abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

let failures = 0;
const TOKENS = CHAIN_LIST.flatMap((chain) => chain.tokens.map((t) => ({ t, chain })));

const results = await Promise.all(
  TOKENS.map(async ({ t, chain }) => {
    const c = client(chain);
    try {
      const [symbol, decimals] = await Promise.all([
        c.readContract({ address: t.address, abi, functionName: 'symbol' }),
        c.readContract({ address: t.address, abi, functionName: 'decimals' }),
      ]);
      return { t, symbol: symbol as string, decimals: Number(decimals), error: null as string | null };
    } catch (e) {
      return { t, symbol: '', decimals: -1, error: (e as Error).message.split('\n')[0] };
    }
  }),
);

for (const r of results) {
  const { t } = r;
  if (r.error) {
    console.log(`  FAIL  ${t.symbol.padEnd(8)} ${t.address}  ${r.error}`);
    failures++;
    continue;
  }
  // Symbol mismatch is a warning, not a failure: our label is for humans and a
  // few tokens report something different on-chain. Decimals are arithmetic.
  const decimalsOk = r.decimals === t.decimals;
  const symbolOk = r.symbol.toLowerCase() === t.symbol.toLowerCase();

  if (!decimalsOk) {
    console.log(
      `  FAIL  ${t.symbol.padEnd(8)} decimals: table says ${t.decimals}, chain says ${r.decimals}`,
    );
    failures++;
  } else if (!symbolOk) {
    console.log(`  warn  ${t.symbol.padEnd(8)} chain reports symbol "${r.symbol}"`);
  } else {
    console.log(`  ok    ${t.symbol.padEnd(8)} ${r.decimals} decimals`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} token(s) do not match the chain`);
  process.exit(1);
}
console.log(`\n${TOKENS.length} tokens verified against ${CHAIN_LIST.map((c) => c.name).join(' and ')}`);
