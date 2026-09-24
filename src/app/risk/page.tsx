import { PageHead, Card, Answer, Answers } from '@/components/ui';
import { KEY_RISKS, LEGAL_UPDATED, LEGAL_VERSION } from '@/lib/legal';

export const metadata = { title: 'Risk Disclosure' };

/**
 * What can go wrong, in the order it is likely to.
 *
 * Separate from the terms on purpose. A risk warning buried in clause 14 of a
 * contract has been disclosed and not communicated, and the difference matters
 * most for the people least equipped to absorb the loss. This page is short,
 * unhedged, and linked from every point where someone is about to commit money.
 */
export default function Page() {
  return (
    <>
      <PageHead
        title="Risk Disclosure"
        lede={`Read this before you fund an account. Version ${LEGAL_VERSION}, ${LEGAL_UPDATED}.`}
      />

      <Card title="The short version" step={1} tone="warn">
        <Answers>
          <Answer
            label="Most likely outcome for most traders"
            value="A loss"
            size="xl"
            tone="bad"
            note="leveraged trading in particular"
          />
          <Answer label="Recoverable by us if it goes wrong" value="Nothing" tone="bad" note="we hold no keys and no funds" />
          <Answer label="Insured or compensated" value="Neither" tone="bad" note="no scheme covers this" />
        </Answers>
        <p style={{ marginTop: 14 }}>
          This software gives you a faster route to venues where you can lose money quickly. It
          does not make those venues safer, and it does not make you likelier to be right.
        </p>
      </Card>

      {KEY_RISKS.map((risk, i) => (
        <Card key={risk.title} title={risk.title} step={i + 2}>
          <p>{risk.body}</p>
        </Card>
      ))}

      <Card title="If you take one thing from this page">
        <p>
          Keep in the trading account only what you intend to trade in the near term, and move the
          rest back to a wallet whose key was never derived in a browser. The withdrawal path is
          always open and costs a transaction fee. Using it often is the cheapest insurance
          available here.
        </p>
      </Card>
    </>
  );
}
