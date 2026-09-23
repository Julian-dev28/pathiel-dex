/**
 * Signing for the Hyperliquid exchange endpoint.
 *
 * Nothing here decides what to trade. It turns an action into the exact bytes
 * the exchange verifies, and that is the entire risk surface: a signature over
 * the wrong bytes is rejected with no detail at all, or — worse — accepted for
 * something the caller did not mean. Every constant below is copied from the
 * official Python SDK (`hyperliquid/utils/signing.py`) and pinned by that SDK's
 * own test vectors in `test/hl-sign.test.ts`. Do not adjust one to make a call
 * start working; a passing call with a changed constant means the action was
 * not the one that was signed.
 *
 * There are two schemes here and they are not interchangeable:
 *
 *   1. **L1 actions** — order, cancel, updateLeverage, scheduleCancel. The
 *      action is msgpack'd together with the nonce and the vault address,
 *      hashed, and the hash is signed inside a *phantom agent*: an EIP-712
 *      struct over a domain that is a deliberate fiction — chain 1337, the zero
 *      contract — so the signature can never be replayed as a transaction.
 *      An agent (API) wallet may sign these.
 *   2. **User-signed actions** — approveAgent, approveBuilderFee, sendAsset.
 *      The action *is* the EIP-712 message, over a real chain id, with named
 *      fields a wallet can display to a human. No msgpack, no action hash.
 *
 * Two details that look like typos and are not. The phantom agent's `source` is
 * `'a'` on mainnet and `'b'` on testnet — one letter is all that keeps a
 * testnet signature off mainnet. And the `expiresAfter` marker byte is `0x00`,
 * the same byte that means "no vault", because it is a separate field appended
 * after the vault byte.
 */

import { encode } from '@msgpack/msgpack';
import { concatHex, keccak256, numberToHex, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** The exchange wants r, s and v apart, not a 65-byte blob. */
export type Signature = { r: Hex; s: Hex; v: number };

const ZERO_CONTRACT: Address = '0x0000000000000000000000000000000000000000';

/**
 * The hash an L1 action is signed over.
 *
 * msgpack of the action — key order is part of the hash, so an action object
 * must be built in the exchange's field order — then the nonce as 8 big-endian
 * bytes, then one byte for the vault address's presence, then, if there is one,
 * the expiry.
 */
export function actionHash(
  action: unknown,
  vaultAddress: Address | null,
  nonce: number,
  expiresAfter: number | null,
): Hex {
  const parts: Hex[] = [
    toHex(encode(action)),
    numberToHex(nonce, { size: 8 }),
    vaultAddress ? concatHex(['0x01', vaultAddress]) : '0x00',
  ];
  if (expiresAfter !== null) parts.push('0x00', numberToHex(expiresAfter, { size: 8 }));
  return keccak256(concatHex(parts));
}

const splitSignature = (sig: Hex): Signature => ({
  r: `0x${sig.slice(2, 66)}`,
  s: `0x${sig.slice(66, 130)}`,
  v: parseInt(sig.slice(130, 132), 16),
});

export type L1SignOpts = {
  vaultAddress?: Address | null;
  expiresAfter?: number | null;
  isMainnet?: boolean;
};

/** Sign an L1 action. The key may be an agent (API) wallet's. */
export async function signL1Action(
  privateKey: Hex,
  action: unknown,
  nonce: number,
  { vaultAddress = null, expiresAfter = null, isMainnet = true }: L1SignOpts = {},
): Promise<Signature> {
  const sig = await privateKeyToAccount(privateKey).signTypedData({
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: ZERO_CONTRACT },
    // viem derives the EIP712Domain type from the fields present, in the
    // canonical order, so declaring it here as the SDK's payload does would
    // hash to the same bytes.
    types: {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' },
      ],
    },
    primaryType: 'Agent',
    message: {
      source: isMainnet ? 'a' : 'b',
      connectionId: actionHash(action, vaultAddress, nonce, expiresAfter),
    },
  });
  return splitSignature(sig);
}

/**
 * The chain a user-signed action is signed *on*. Any chain would do — the
 * exchange only reads it back out of the action — and 0x66eee (Arbitrum
 * Sepolia) is what every Hyperliquid SDK sends. `hyperliquidChain` inside the
 * action, not this, is what separates mainnet from testnet.
 */
export const SIGNATURE_CHAIN_ID = '0x66eee';

export type UserAction = {
  signatureChainId: string;
  hyperliquidChain: 'Mainnet' | 'Testnet';
  [field: string]: unknown;
};

type Eip712Field = { name: string; type: string };

/**
 * Sign a user-signed action: the action's own fields, typed, are the message.
 *
 * `fields` must list exactly the fields the exchange hashes, in its order. The
 * action carries more than that — `type`, `signatureChainId` — and those extra
 * keys are posted but not signed, which is how the SDK does it too.
 */
export async function signUserAction(
  privateKey: Hex,
  action: UserAction,
  fields: readonly Eip712Field[],
  primaryType: string,
): Promise<Signature> {
  const sig = await privateKeyToAccount(privateKey).signTypedData({
    domain: {
      name: 'HyperliquidSignTransaction',
      version: '1',
      chainId: Number(action.signatureChainId),
      verifyingContract: ZERO_CONTRACT,
    },
    types: { [primaryType]: [...fields] },
    primaryType,
    message: action,
  });
  return splitSignature(sig);
}

/**
 * A price or size as the exchange wants it: a plain decimal, at most 8 places,
 * no trailing zeros and no exponent.
 *
 * The throw is the point. A size that does not survive the round trip would be
 * silently truncated into a different order, so it is refused here instead.
 */
export function floatToWire(x: number): string {
  const rounded = x.toFixed(8);
  if (Math.abs(Number(rounded) - x) >= 1e-12) throw new Error(`${x} does not fit 8 decimal places`);
  const trimmed = rounded.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' ? '0' : trimmed;
}
