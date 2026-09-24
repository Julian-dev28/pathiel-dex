/**
 * Trading from the derived account, which is what removes the popups.
 *
 * The router already knows how to build a swap: `execute.ts` produces the
 * approvals and the call, and until now a wallet was asked to sign each one.
 * Here the account signs them itself, because the key is in the page — so a
 * trade is one click rather than one click and two wallet confirmations, on
 * whichever chain the asset happens to be cheapest.
 *
 * The same account is the Hyperliquid account, so a perp order is signed with
 * the same key through `perp-order.ts`. One balance, one signer, four venues.
 *
 * What is deliberately unchanged: the quoting, the routing and the slippage
 * floor. This is a different signer, not a different router, and the
 * protections that were enforced on chain before are enforced on chain now.
 *
 * The obligation that comes with holding a key in a page: **every function
 * here takes the account as an argument.** Nothing reads it from a module
 * global, a context or storage, so the set of places that can spend is the set
 * of call sites, and that set is greppable.
 */

import { createWalletClient, http, type Address, type PrivateKeyAccount } from 'viem';
import { CHAINS, rpcUrlsFor, type ChainConfig, type ChainKey } from '../chain';
import { client, type Venue } from '../quote';
import { GAS_FLOOR } from './funding';
import { approvalLabel, approvalTx, buildSwap, pendingApprovals } from '../execute';

/** A transaction this account sent, and what it was for. */
export type SentStep = {
  step: 'approve' | 'swap';
  description: string;
  hash: `0x${string}`;
};

export class TradeError extends Error {
  constructor(
    message: string,
    /** What did land, so a caller can say where a partial run stopped. */
    readonly sent: SentStep[],
  ) {
    super(message);
  }
}

/**
 * A wallet client for one chain, signing as the derived account.
 *
 * Built per call rather than cached: the account can be locked between trades,
 * and a cached client holding a key that the keyring has forgotten is exactly
 * the sort of thing that keeps a secret alive past its welcome.
 */
function walletFor(account: PrivateKeyAccount, chain: ChainConfig) {
  return createWalletClient({
    account,
    chain: chain.viem,
    transport: http(rpcUrlsFor(chain)[0]),
  });
}

/**
 * One transaction at a time per account and chain.
 *
 * Every send reads the account's nonce and then uses it. Two trades started
 * together therefore read the same nonce and build two transactions claiming
 * it: the chain accepts one and rejects the other, or — worse, and more often
 * — replaces the first with the second if the fee is higher, so a customer who
 * clicked twice gets one fill and an approval that silently vanished.
 *
 * A queue per (account, chain) rather than a global one, because trades on
 * different chains have nothing to do with each other and serialising them
 * would make the multi-chain case needlessly slow.
 */
const queues = new Map<string, Promise<unknown>>();

function serialise<T>(account: Address, chainKey: ChainKey, work: () => Promise<T>): Promise<T> {
  const key = `${account.toLowerCase()}:${chainKey}`;
  // Chained off whatever is pending, and off its failure too: one trade
  // failing must not stop the next from being attempted.
  const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
  queues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Execute a swap end to end from the account.
 *
 * Approvals first, each waited for: a swap submitted before its approval is
 * mined reverts, and on a chain making ten blocks a second the temptation to
 * fire them together is strong and wrong.
 *
 * Returns every transaction sent. On failure the error carries the same list,
 * because "which of these landed" is the only question worth asking when a
 * multi-step trade stops halfway.
 */
export async function swapFromAccount(
  account: PrivateKeyAccount,
  chainKey: ChainKey,
  venue: Venue,
  amountIn: bigint,
  minimumOut: bigint,
): Promise<SentStep[]> {
  return serialise(account.address, chainKey, () =>
    runSwap(account, chainKey, venue, amountIn, minimumOut),
  );
}

async function runSwap(
  account: PrivateKeyAccount,
  chainKey: ChainKey,
  venue: Venue,
  amountIn: bigint,
  minimumOut: bigint,
): Promise<SentStep[]> {
  const chain = CHAINS[chainKey];
  const publicClient = client(chain);
  const wallet = walletFor(account, chain);
  const sent: SentStep[] = [];

  try {
    // Read what is still outstanding rather than assuming: an account that has
    // traded this venue before needs no approval, and sending one anyway costs
    // the customer gas for nothing.
    const approvals = await pendingApprovals(publicClient, account.address, venue, amountIn);
    for (const approval of approvals) {
      const tx = approvalTx(approval, amountIn);
      const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n });
      await publicClient.waitForTransactionReceipt({ hash });
      sent.push({ step: 'approve', description: approvalLabel(approval), hash });
    }

    const swap = buildSwap(venue, amountIn, minimumOut, account.address);
    const hash = await wallet.sendTransaction({
      to: swap.to,
      data: swap.data,
      value: swap.value ?? 0n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    sent.push({ step: 'swap', description: venue.label, hash });
    if (receipt.status === 'reverted') {
      throw new TradeError(`the swap reverted on ${chain.name}`, sent);
    }
    return sent;
  } catch (e) {
    if (e instanceof TradeError) throw e;
    throw new TradeError(e instanceof Error ? e.message : 'the trade failed', sent);
  }
}

/**
 * Send one of the transfers `funding.ts` builds, as the account.
 *
 * Withdrawals are sent from the account and funding from the owner's wallet,
 * so only this direction belongs here.
 */
export async function sendFromAccount(
  account: PrivateKeyAccount,
  chainKey: ChainKey,
  transfer: { to: Address; data?: `0x${string}`; value?: bigint },
): Promise<`0x${string}`> {
  // Through the same queue as a trade: a withdrawal fired while a swap is in
  // flight would otherwise claim the same nonce and replace it.
  return serialise(account.address, chainKey, async () => {
    const chain = CHAINS[chainKey];
    const wallet = walletFor(account, chain);
    const hash = await wallet.sendTransaction({
      to: transfer.to,
      data: transfer.data,
      value: transfer.value ?? 0n,
    });
    await client(chain).waitForTransactionReceipt({ hash });
    return hash;
  });
}

/**
 * Can this account act on this chain right now?
 *
 * Asked before a trade rather than discovered during one: the answer decides
 * whether the interface offers a button or explains why it cannot.
 */
export async function canAct(account: Address, chainKey: ChainKey): Promise<boolean> {
  const chain = CHAINS[chainKey];
  const balance = await client(chain).getBalance({ address: account });
  return balance >= GAS_FLOOR[chainKey];
}
