/**
 * Asserts every address in the chain tables is checksummed and has bytecode on
 * its chain.
 *
 * A wrong address is the cheapest way to ship a router that quotes zero, and
 * the cheapest thing to test for. Walks the config rather than grepping the
 * source, so every address a quote or swap can dial is checked against the
 * chain it will be dialled on. Run before any deploy.
 *
 *   npm run verify:addresses
 */

import { getAddress, type Address } from 'viem';
import { CHAIN_LIST, MULTICALL3, PERMIT2, type ChainConfig } from '../src/lib/chain';
import { client } from '../src/lib/quote';

function addressesOf(chain: ChainConfig): [string, Address][] {
  const out: [string, Address][] = [
    ['Multicall3', MULTICALL3],
    ['Permit2', PERMIT2],
    ...chain.tokens.map((t): [string, Address] => [t.symbol, t.address]),
  ];
  for (const v of chain.v2) out.push([`${v.name} factory`, v.factory], [`${v.name} router`, v.router]);
  for (const d of chain.v3) {
    out.push([`${d.name} quoter`, d.quoter], [`${d.name} router`, d.router], [`${d.name} factory`, d.factory]);
  }
  if (chain.v4) {
    const v4 = chain.v4;
    out.push(
      [`${v4.name} PoolManager`, v4.poolManager],
      [`${v4.name} quoter`, v4.quoter],
      [`${v4.name} StateView`, v4.stateView],
      [`${v4.name} Universal Router`, v4.universalRouter],
    );
    if (v4.positionManager) out.push([`${v4.name} PositionManager`, v4.positionManager]);
  }
  if (chain.aerodrome) {
    out.push(['Aerodrome router', chain.aerodrome.router], ['Aerodrome factory', chain.aerodrome.factory]);
  }
  return out;
}

let failures = 0;
for (const chain of CHAIN_LIST) {
  console.log(`\n${chain.name} (${chain.id})`);
  const c = client(chain);
  const checks = addressesOf(chain);
  const codes = await Promise.all(checks.map(([, a]) => c.getCode({ address: a }).catch(() => undefined)));
  checks.forEach(([name, address], i) => {
    const code = codes[i];
    // A mis-cased address still reads back its code here, then throws deep
    // inside viem the first time it is used in a call. Two X Layer addresses
    // were wrong this way, so the casing is checked rather than assumed.
    if (address !== getAddress(address)) {
      console.log(`  FAIL  ${name.padEnd(28)} ${address} (checksum; want ${getAddress(address)})`);
      failures++;
    } else if (!code || code === '0x') {
      console.log(`  FAIL  ${name.padEnd(28)} ${address} (no bytecode)`);
      failures++;
    } else {
      console.log(`  ok    ${name.padEnd(28)} ${address} (${(code.length - 2) / 2} bytes)`);
    }
  });
}

if (failures > 0) {
  console.error(`\n${failures} address(es) have no bytecode`);
  process.exit(1);
}
