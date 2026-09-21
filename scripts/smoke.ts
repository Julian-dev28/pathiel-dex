/**
 * Live sanity check. Quotes one real pair against every venue and prints the
 * ladder, so a wrong fee constant or an inverted reserve shows up as a number
 * that is obviously not the ETH price rather than as a silent 3bp drift.
 */
import { bySymbol, chainByKey } from '../src/lib/chain';
import { quoteLadder, ladder, bestRoute, interpolate } from '../src/lib/quote';
import { hopCostInToken } from '../src/lib/gas';
import { sig, bps } from '../src/lib/format';

// npm run smoke -- [in] [out] [amount] [chain]   (chain: robinhood | base)
const [, , inArg, outArg, amt = '10', chainArg] = process.argv;
const chain = chainByKey(chainArg);
const inSym = inArg ?? chain.weth.symbol;
const outSym = outArg ?? chain.usd.symbol;

const tokenIn = bySymbol(inSym, chain);
const tokenOut = bySymbol(outSym, chain);
const amountIn = BigInt(Math.round(Number(amt) * 10 ** tokenIn.decimals));

const t0 = Date.now();
const sizes = ladder(amountIn);
const curves = await quoteLadder(tokenIn, tokenOut, sizes);
const elapsed = Date.now() - t0;

console.log(`\n${amt} ${inSym} -> ${outSym} on ${chain.name}   (${elapsed}ms, ${curves.length} venues live)\n`);

for (const c of curves) {
  const out = interpolate(c, amountIn);
  const price = Number(out) / 10 ** tokenOut.decimals / Number(amt);
  console.log(
    `  ${c.venue.label.padEnd(26)} ${sig(out, tokenOut).padStart(16)} ${outSym}` +
      `   px ${price.toFixed(6)}   ${c.venue.path.map((t) => t.symbol).join('>')}`,
  );
}

const hop = await hopCostInToken(tokenOut);
const best = bestRoute(curves, amountIn, hop);
console.log(`\n  best single : ${sig(best.single.amountOut, tokenOut)} ${outSym}  via ${best.single.allocations[0]?.venue.label}`);
console.log(`  split       : ${sig(best.split.amountOut, tokenOut)} ${outSym}  across ${best.split.allocations.length}`);
for (const a of best.split.allocations) {
  console.log(`      ${a.share.toFixed(1).padStart(5)}%  ${a.venue.label}`);
}
console.log(`  edge        : ${bps(best.edgeBps)} gross, ${bps(best.netEdgeBps)} net of gas`);
console.log(`  hop cost    : ${sig(hop, tokenOut)} ${outSym}`);
console.log(`  chosen      : ${best.chosen}\n`);
