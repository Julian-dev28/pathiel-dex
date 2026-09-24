import { PageHead, Card, Reveal } from '@/components/ui';
import { LEGAL_UPDATED, LEGAL_VERSION, OPERATOR } from '@/lib/legal';

export const metadata = { title: 'Privacy Policy' };

/**
 * What is collected, which is less than most policies have to admit.
 *
 * The honest version of a privacy policy for software with no accounts, no
 * database of users and no custody is short. Writing it long, in the usual
 * defensive register, would obscure the one fact worth knowing: the parts that
 * touch a user's money never reach a server at all.
 */
export default function Page() {
  return (
    <>
      <PageHead
        title="Privacy Policy"
        lede={`What ${OPERATOR.product} collects, what it cannot collect, and what is public whatever we do. Version ${LEGAL_VERSION}, ${LEGAL_UPDATED}.`}
      />

      <Card title="What never leaves your browser" step={1} tone="good">
        <ul className="c-list-plain">
          <li>
            <strong>The signature that derives your trading account</strong>, and the private key
            computed from it. Both are produced in the page and held in memory. Neither is
            transmitted, logged or stored by us, and a closed tab forgets them.
          </li>
          <li>
            <strong>Your wallet&rsquo;s private keys.</strong> We never see them; your wallet signs
            and hands back a signature.
          </li>
          <li>
            <strong>Order signatures for perpetual futures</strong>, which are sent from your
            browser directly to the venue. No server of ours sits in that path.
          </li>
        </ul>
      </Card>

      <Card title="What we do collect" step={2}>
        <ul className="c-list-plain">
          <li>
            <strong>Your invite code</strong>, so we can tell who has access and revoke it. Held
            against the invitation rather than against your identity.
          </li>
          <li>
            <strong>Addresses you ask about.</strong> Requesting a quote, a plan or a balance sends
            the relevant token, chain and address to our server so it can read public chain state.
            These are used to answer the request and kept in server logs, ordinarily for no more
            than 30 days.
          </li>
          <li>
            <strong>Ordinary request data</strong> — IP address, user agent, timestamps — as any
            web server records, used for rate limiting, abuse prevention and debugging.
          </li>
          <li>
            <strong>Your acceptance of the terms</strong>, recorded in your browser along with the
            version you accepted.
          </li>
        </ul>
        <p>
          We do not run advertising, we do not sell data, and we do not operate third-party
          analytics or tracking on this service.
        </p>
      </Card>

      <Card title="What is public no matter what we do" step={3} tone="warn">
        <p>
          Blockchains are public and permanent. Your trading account&rsquo;s address, its balances,
          and every transaction it ever sends are visible to anyone, for ever, and can be linked to
          the wallet that funded it. Nothing in this policy — or in any policy — changes that.
        </p>
        <p>
          If that matters to you, consider which wallet you fund the account from, since the
          funding transaction is the link between them.
        </p>
      </Card>

      <Card title="Who else sees your requests" step={4}>
        <p>
          Reading chain state and quoting trades means talking to third parties, and they see what
          you ask them:
        </p>
        <ul className="c-list-plain">
          <li>
            <strong>Public RPC endpoints</strong> for each chain, which see the addresses and calls
            being read.
          </li>
          <li>
            <strong>The bridge quoting service</strong>, when a cross-chain plan is priced, which
            sees the addresses and amounts involved.
          </li>
          <li>
            <strong>The perpetuals venue</strong>, when market data is read or an order is placed,
            which sees your account address and your orders.
          </li>
          <li>
            <strong>Our hosting provider</strong>, which processes requests on our behalf.
          </li>
        </ul>
        <p>Each has its own policy, and we do not control what they retain.</p>
      </Card>

      <Card title="Your rights, and their limits" step={5}>
        <p>
          Under Singapore&rsquo;s Personal Data Protection Act you may ask what personal data we
          hold about you, ask us to correct it, or ask us to delete it. Write to{' '}
          <a href={`mailto:${OPERATOR.contact}`}>{OPERATOR.contact}</a>.
        </p>
        <p>
          The limit is honest rather than legal: we cannot delete anything from a public
          blockchain, and we cannot delete what we never held — including your keys and your
          account.
        </p>

        <Reveal summary="Cookies and local storage">
          <p>
            We use no advertising or tracking cookies. The interface stores small preferences in
            your browser — the chain you last selected, whether you accepted the terms and which
            version, and your invite access — and these stay on your device. The trading
            account&rsquo;s key is deliberately <em>not</em> among them: it is held in memory only,
            which is why a reload asks you to sign again.
          </p>
        </Reveal>
      </Card>
    </>
  );
}
