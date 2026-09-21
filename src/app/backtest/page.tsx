import { aggregate } from '@/lib/dataset';
import { EdgeHistogram } from '@/components/EdgeHistogram';
import { bySymbol, CHAINS } from '@/lib/chain';
import { sig, bps, addr } from '@/lib/format';
import { Card, Answer, Answers, Reveal, Chip, Empty, PageHead } from '@/components/ui';

export const metadata = { title: 'Backtest' };
export const dynamic = 'force-dynamic';

export default function Page() {
  const a = aggregate();

  if (a.samples === 0) {
    return (
      <>
        <PageHead title="Backtest" lede="No runs recorded yet." />
        <Card title="Nothing to show">
          <Empty>
            Run <code className="mono">npm run backtest</code> to replay some real trades.
          </Empty>
        </Card>
      </>
    );
  }

  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const beatOrMatched = a.samples > 0 ? (a.wins + a.ties) / a.samples : 0;

  return (
    <>
      <PageHead
        title="Backtest"
        lede="Every trade below actually happened. The router was re-quoted at the block before each one and asked what it would have done."
      />

      {/* the single claim */}
      <Card
        title="Against real trades"
        step={1}
        tone={a.medianEdgeBps >= 0 ? 'good' : 'warn'}
        meta={`${a.samples} replayed · ${a.runs} run${a.runs === 1 ? '' : 's'}`}
      >
        <Answers>
          <Answer
            label="Matched or beat"
            value={pct(beatOrMatched)}
            size="xl"
            tone="good"
            note={`${a.wins} better · ${a.ties} identical · ${a.losses} worse`}
          />
          <Answer
            label="Median edge"
            value={`${a.medianEdgeBps >= 0 ? '+' : ''}${a.medianEdgeBps.toFixed(1)}`}
            unit="bp"
            tone={a.medianEdgeBps >= 0 ? 'good' : 'bad'}
            note="vs. the fill they got"
          />
          <Answer
            label="Win / loss size"
            value={`+${a.medianWinBps.toFixed(0)} / ${a.medianLossBps.toFixed(0)}`}
            unit="bp"
            note="asymmetry beats the average"
          />
        </Answers>

        <div style={{ marginTop: 18 }}>
          <EdgeHistogram edges={a.edges} />
        </div>

        <Reveal summary="What is corrected for, and what isn't?">
          <p>
            <strong>Corrected.</strong> Each trade is re-quoted at the block <em>before</em> it
            executed, because its own swap moved the pool it landed in. Transactions containing
            more than one Swap log are discarded entirely — a single leg of somebody else&rsquo;s
            multi-hop route is not a complete trade, and comparing our whole route against one leg
            of theirs would flatter this project enormously.
          </p>
          <p>
            <strong>Not corrected.</strong> The comparison is gross of gas on both sides. We do
            not know what they paid, and our own extra-hop cost is not netted out either, which if
            anything favours them. We also cannot see <em>why</em> they routed as they did: a trade
            that looks beatable may have been a deliberate venue choice or an MEV-protected order.
          </p>
          <p>
            <strong>The sample is small and recent.</strong> Public RPC serves a few thousand
            blocks, so each run samples the last few hours. Depth accumulates across scheduled runs.
            Every figure here is recomputed from <code>data/backtest.jsonl</code>, which is
            committed — so any claim is auditable in the diff that introduced it.
          </p>
        </Reveal>
      </Card>

      <div className="c-two">
        <Card title="By pair" meta={`${a.byPair.length} pairs`}>
          <div className="c-scroll">
            <table className="c-table">
              <thead>
                <tr>
                  <th>Pair</th>
                  <th className="num">n</th>
                  <th className="num">Median</th>
                  <th className="num">Win rate</th>
                </tr>
              </thead>
              <tbody>
                {a.byPair.map((p) => (
                  <tr key={p.pair}>
                    <td className="mono">{p.pair}</td>
                    <td className="num mono">{p.samples}</td>
                    <td className={`num mono ${p.medianEdgeBps >= 0 ? 'up' : 'dn'}`}>
                      {bps(p.medianEdgeBps)}
                    </td>
                    <td className="num mono">{pct(p.winRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Venue the router picked">
          <ul className="c-list">
            {a.byVenue.slice(0, 7).map((v) => (
              <li key={v.venue}>
                <span>{v.venue}</span>
                <span className="mono">{v.count}</span>
              </li>
            ))}
          </ul>
          <p className="c-empty" style={{ marginTop: 10 }}>
            {a.multiHopUsed} of {a.samples} replays routed through an intermediate token.
          </p>
        </Card>
      </div>

      <Card title="Recent replays" meta="newest first">
        <div className="c-scroll">
          <table className="c-table">
            <thead>
              <tr>
                <th>Pair</th>
                <th className="num">Size</th>
                <th className="num">They got</th>
                <th className="num">Router</th>
                <th className="num">Edge</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {a.recent.slice(0, 25).map((s) => {
                const [inSym, outSym] = s.pair.split('/');
                // The dataset is Base swaps.
                const tIn = bySymbol(inSym, 'base');
                const tOut = bySymbol(outSym, 'base');
                return (
                  <tr key={`${s.txHash}-${s.blockNumber}`}>
                    <td className="mono">{s.pair}</td>
                    <td className="num mono">{sig(BigInt(s.amountIn), tIn, 4)}</td>
                    <td className="num mono">{sig(BigInt(s.actualOut), tOut, 6)}</td>
                    <td className="num mono">{sig(BigInt(s.routerOut), tOut, 6)}</td>
                    <td className={`num mono ${s.edgeBps > 0 ? 'up' : s.edgeBps < 0 ? 'dn' : 'mut'}`}>
                      {bps(s.edgeBps)}
                    </td>
                    <td className="mono">
                      <a href={`${CHAINS.base.explorer}/tx/${s.txHash}`} target="_blank" rel="noreferrer">
                        {addr(s.txHash)}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
