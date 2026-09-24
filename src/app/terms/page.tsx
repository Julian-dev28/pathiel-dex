import { PageHead, Card, Reveal } from '@/components/ui';
import { LEGAL_VERSION, LEGAL_UPDATED, OPERATOR, RESTRICTED_PERSONS } from '@/lib/legal';

export const metadata = { title: 'Terms of Service' };

/**
 * The terms someone accepts before the software will derive an account.
 *
 * Written to be read rather than clicked past: every clause that limits what a
 * user can expect is stated in the words they would use themselves, because a
 * term nobody understood is a term that will not hold when it matters. The
 * substance is shaped by what this product actually is — non-custodial,
 * invite-only, in beta, and pointed at venues it does not operate.
 */
export default function Page() {
  return (
    <>
      <PageHead
        title="Terms of Service"
        lede={`Version ${LEGAL_VERSION}, last updated ${LEGAL_UPDATED}. These terms govern access to the ${OPERATOR.product} beta. By signing the message that derives a trading account, you agree to them.`}
      />

      <Card title="1. What this is, and who provides it" step={1}>
        <p>
          {OPERATOR.product} is a non-custodial interface to third-party decentralised exchanges
          and derivatives venues. It is provided by {OPERATOR.legalName} (&ldquo;we&rdquo;,
          &ldquo;us&rdquo;), {OPERATOR.jurisdiction}.
        </p>
        <p>
          <strong>We never hold your assets.</strong> The software derives a trading account from a
          signature produced by your own wallet. The private key to that account is computed in
          your browser, is held only in memory for the life of a browser tab, and is never
          transmitted to us or stored by us. We cannot access your funds, move them, freeze them,
          or recover them. No part of this service is a custody, deposit-taking, money transmission
          or payment service.
        </p>
        <p>
          We do not operate any exchange, liquidity pool, bridge or derivatives venue. Trades you
          initiate execute against third-party protocols and venues, under their terms and their
          risks, and we are not a counterparty to any of them.
        </p>
      </Card>

      <Card title="2. Beta software, by invitation" step={2}>
        <p>
          Access is <strong>invite-only</strong> and the software is <strong>beta</strong>: it is
          incomplete, under active development, and may contain defects. It may change, break, or
          be withdrawn without notice. Invitations are personal to you, non-transferable, and may
          be revoked at any time for any reason or none.
        </p>
        <p>
          You should not commit funds you are unwilling to lose entirely. We make no representation
          that the software has been audited to any standard, and where parts of it have been
          reviewed, that review is not a guarantee of correctness.
        </p>
      </Card>

      <Card title="3. Who may not use it" step={3}>
        <p>You confirm that you are not, and are not acting for, any of the following:</p>
        <ul className="c-list-plain">
          {RESTRICTED_PERSONS.map((person) => (
            <li key={person}>{person}</li>
          ))}
        </ul>
        <p>
          You are responsible for determining whether your use is lawful where you are. If it is
          not, you must not use the service. We may block access from any jurisdiction at any time.
        </p>
      </Card>

      <Card title="4. Your account, your keys, your responsibility" step={4}>
        <p>
          The trading account is derived deterministically from a signature over a fixed message.
          That has consequences you accept by using it:
        </p>
        <ul className="c-list-plain">
          <li>
            <strong>The signature is the credential and it cannot be rotated.</strong> Anyone who
            obtains it can reproduce your account key and take everything in the account,
            permanently. Treat it as you would a seed phrase.
          </li>
          <li>
            <strong>Losing access to the signing wallet loses the account.</strong> We hold no copy
            of the key and no recovery mechanism exists. There is no password reset.
          </li>
          <li>
            <strong>The key is held in your browser.</strong> Malware, a malicious extension, or a
            compromise of your device or of this site could expose it. Keep in the account only
            what you intend to trade.
          </li>
          <li>
            <strong>You are responsible for every transaction the account signs</strong>, including
            those you authorise in error.
          </li>
        </ul>
      </Card>

      <Card title="5. No advice, no solicitation" step={5}>
        <p>
          Nothing in the software or its documentation is investment, financial, legal, tax or
          accounting advice, or a recommendation to enter any transaction. Quotes, routes,
          backtests, funding rates and any other figures are information, not offers. You alone
          decide what to trade, and you should take your own professional advice.
        </p>
        <p>
          Historical results, including any backtest shown, do not indicate future results. A
          quoted price is an estimate at a moment and is not a guarantee of execution.
        </p>
      </Card>

      <Card title="6. Third-party venues and protocols" step={6}>
        <p>
          The software helps you construct transactions against protocols we do not control,
          including decentralised exchanges, cross-chain bridges operated by third parties, and
          perpetual futures venues — including markets deployed by third parties on permissionless
          infrastructure, whose operators set their own oracle prices, margin parameters and fees.
        </p>
        <p>
          We do not guarantee the availability, solvency, honesty or correctness of any of them.
          Losses arising from a third-party protocol — a bridge failure, an oracle error, a venue
          halting withdrawals, a smart-contract exploit — are not losses we can compensate.
        </p>
      </Card>

      <Card title="7. Leverage and liquidation" step={7}>
        <p>
          Perpetual futures are leveraged instruments. A modest move against a position can remove
          the entire margin backing it. Liquidation can happen at any hour, without notice, and can
          leave you with nothing in that account. Funding costs accrue continuously and can exceed
          any gain on the position.
        </p>
        <p>See the <a href="/risk">Risk Disclosure</a> for a fuller statement before trading them.</p>
      </Card>

      <Card title="8. Fees" step={8}>
        <p>
          Any fee charged by us is disclosed in the interface before you authorise a transaction.
          Separately, and outside our control, you pay network gas, the trading fees of each venue,
          and the cost of any bridge you use. We do not rebate third-party costs.
        </p>
      </Card>

      <Card title="9. Availability, suspension and termination" step={9}>
        <p>
          We may modify, suspend or discontinue the service, in whole or for you specifically, at
          any time and without notice. Because the service is non-custodial, suspension does not
          affect your ability to move your funds: your account exists on public blockchains
          independently of us, and you can access it with your wallet and any compatible tool.
        </p>
      </Card>

      <Card title="10. Warranties and liability" step={10}>
        <p>
          The service is provided <strong>&ldquo;as is&rdquo; and &ldquo;as available&rdquo;</strong>,
          without warranty of any kind, express or implied, including merchantability, fitness for
          a particular purpose, and non-infringement.
        </p>
        <p>
          To the fullest extent permitted by law, we are not liable for any indirect, incidental,
          special, consequential or exemplary damages, nor for loss of profits, revenue, data, or
          digital assets, arising from your use of the service. Our aggregate liability for all
          claims is limited to the greater of the fees you paid us in the three months before the
          claim, or SGD 100.
        </p>
        <p>
          Nothing here excludes liability that cannot lawfully be excluded, including for fraud or
          fraudulent misrepresentation.
        </p>
      </Card>

      <Card title="11. Indemnity" step={11}>
        <p>
          You will indemnify us against claims, losses and reasonable costs arising from your use
          of the service, your breach of these terms, or your violation of any law or third-party
          right.
        </p>
      </Card>

      <Card title="12. Governing law" step={12}>
        <p>
          These terms are governed by the laws of {OPERATOR.governingLaw}, and the courts of{' '}
          {OPERATOR.governingLaw} have exclusive jurisdiction, without regard to conflict-of-laws
          rules.
        </p>
      </Card>

      <Card title="13. Changes" step={13}>
        <p>
          We may update these terms. The version and date at the top change when we do, and
          continued use after an update is acceptance of it. Material changes will be surfaced in
          the interface before you next sign.
        </p>

        <Reveal summary="Regulatory status, stated plainly">
          <p>
            {OPERATOR.legalName} is not licensed by the Monetary Authority of Singapore, and this
            service is provided on the basis that it is non-custodial: we do not hold, control or
            transmit customer assets, and we do not operate a market. That basis is what keeps this
            outside the licensing regimes that apply to custodial venues and to dealing in capital
            markets products.
          </p>
          <p>
            Tokenised equities and perpetual futures may be regulated products in your jurisdiction
            even where the interface to them is not. Access is restricted accordingly, and it is
            your responsibility to comply with the rules that apply to you.
          </p>
        </Reveal>
      </Card>

      <Card title="Contact">
        <p>
          Questions about these terms: <a href={`mailto:${OPERATOR.contact}`}>{OPERATOR.contact}</a>
        </p>
      </Card>
    </>
  );
}
