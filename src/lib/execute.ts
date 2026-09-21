/**
 * Turning a chosen route into a transaction.
 *
 * Every path here ends at a router someone else deployed and someone else
 * audited. This project builds calldata; it does not receive tokens, does not
 * hold approvals, and has no contract of its own on mainnet. The consequence
 * worth stating plainly: a bug in this file costs the user a bad fill, not
 * their balance.
 *
 * Multi-hop routes settle atomically — Uniswap V3 through `exactInput` with a
 * packed path, Uniswap V4 through one Universal Router call, the V2 forks and
 * Aerodrome through their multi-element path and route arguments. There is no version of this that sends two transactions and
 * hopes; a partially executed route leaves the user holding an intermediate
 * token they never asked for.
 */

import {
  encodeAbiParameters,
  encodeFunctionData,
  concatHex,
  parseAbi,
  parseAbiParameters,
  type Address,
  type PublicClient,
} from 'viem';
import { PERMIT2, type Token } from './chain';
import {
  univ3RouterAbi,
  v3RouterWithDeadlineAbi,
  aeroRouterAbi,
  v2RouterAbi,
  erc20Abi,
  universalRouterAbi,
  permit2Abi,
} from './abis';
import {
  encodeV3Path,
  chainOfVenue,
  v4PathCurrencies,
  v4PathKeys,
  type Venue,
  type Hop,
} from './quote';

const V3R = parseAbi(univ3RouterAbi);
const V3R_DEADLINE = parseAbi(v3RouterWithDeadlineAbi);
const AEROR = parseAbi(aeroRouterAbi);
const V2R = parseAbi(v2RouterAbi);
const UR = parseAbi(universalRouterAbi);
export const ERC20 = parseAbi(erc20Abi);
export const PERMIT2_ABI = parseAbi(permit2Abi);

export type SwapTx = { to: Address; data: `0x${string}`; value: bigint };

/**
 * Apply slippage tolerance to a quote.
 *
 * Integer basis points, floor division: the user's floor is always at or below
 * the number shown, never above it by a rounding error. `quotedOut` is what the
 * chain said a moment ago, so this is the only thing standing between the user
 * and an adverse move between quote and inclusion.
 */
export function minOut(quotedOut: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(5_000, Math.round(slippageBps))));
  return (quotedOut * (10_000n - bps)) / 10_000n;
}

/** The router that will pull the input token. */
export function spenderFor(venue: Venue): Address {
  if (venue.family === 'aero') return chainOfVenue(venue).aerodrome!.router;
  if (!venue.router) throw new Error(`venue ${venue.id} has no router`);
  return venue.router;
}

/**
 * One allowance a swap needs before it can run.
 *
 * Every venue but V4 needs one: the token approves the router. V4's Universal
 * Router pulls through Permit2, which needs two — the token approves Permit2,
 * then Permit2 grants the router an allowance of its own. Both are exact.
 */
export type Approval =
  | { kind: 'erc20'; token: Token; spender: Address }
  | { kind: 'permit2'; token: Token; spender: Address };

export function approvalsFor(venue: Venue): Approval[] {
  const token = venue.path[0];
  if (venue.family === 'v4') {
    return [
      { kind: 'erc20', token, spender: PERMIT2 },
      { kind: 'permit2', token, spender: spenderFor(venue) },
    ];
  }
  return [{ kind: 'erc20', token, spender: spenderFor(venue) }];
}

/**
 * The approvals still missing for `owner` to spend `amount` through `venue`,
 * in the order they must be sent.
 */
export async function pendingApprovals(
  c: PublicClient,
  owner: Address,
  venue: Venue,
  amount: bigint,
): Promise<Approval[]> {
  const needed = approvalsFor(venue);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const ok = await Promise.all(
    needed.map(async (a) => {
      if (a.kind === 'erc20') {
        const allowance = await c.readContract({
          address: a.token.address,
          abi: ERC20,
          functionName: 'allowance',
          args: [owner, a.spender],
        });
        return allowance >= amount;
      }
      const [allowed, expiration] = await c.readContract({
        address: PERMIT2,
        abi: PERMIT2_ABI,
        functionName: 'allowance',
        args: [owner, a.token.address, a.spender],
      });
      // A minute of margin: the allowance has to outlive the swap's inclusion.
      return allowed >= amount && BigInt(expiration) > now + 60n;
    }),
  );
  return needed.filter((_, i) => !ok[i]);
}

/**
 * How long a Permit2 allowance lasts. Long enough to sign the swap that
 * follows it, short enough that a forgotten one is dead by tomorrow.
 */
const PERMIT2_EXPIRY_SECONDS = 30 * 60;

export function approvalTx(a: Approval, amount: bigint): SwapTx {
  if (a.kind === 'erc20') return approveTx(a.token, a.spender, amount);
  if (amount >= 1n << 160n) throw new Error('amount too large for Permit2');
  return {
    to: PERMIT2,
    data: encodeFunctionData({
      abi: PERMIT2_ABI,
      functionName: 'approve',
      args: [a.token.address, a.spender, amount, Math.floor(Date.now() / 1000) + PERMIT2_EXPIRY_SECONDS],
    }),
    value: 0n,
  };
}

export const approvalLabel = (a: Approval): string =>
  a.kind === 'erc20' && a.spender === PERMIT2
    ? `Approve ${a.token.symbol} for Permit2`
    : a.kind === 'permit2'
      ? `Allow the router to spend ${a.token.symbol}`
      : `Approve ${a.token.symbol}`;

/**
 * Approve exactly the amount being spent, not `type(uint256).max`.
 *
 * Infinite approval is the convention and it is the reason a router bug or a
 * phished signature drains a wallet months later. An exact approval costs one
 * extra transaction per trade and bounds the loss to the trade itself.
 */
export function approveTx(token: Token, spender: Address, amount: bigint): SwapTx {
  return {
    to: token.address,
    data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [spender, amount] }),
    value: 0n,
  };
}

export function buildSwap(
  venue: Venue,
  amountIn: bigint,
  amountOutMinimum: bigint,
  recipient: Address,
  deadlineSeconds = 600,
): SwapTx {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
  const path = venue.path;
  const chain = chainOfVenue(venue);

  switch (venue.family) {
    case 'v4':
      return buildV4Swap(venue, amountIn, amountOutMinimum, recipient, deadline);

    case 'v3': {
      const v3hops = venue.hops as Extract<Hop, { family: 'v3' }>[];
      const fees = v3hops.map((h) => h.fee);
      const dep = chain.v3[v3hops[0].dex];
      const router = dep.router;
      const single = venue.hops.length === 1;

      // PancakeSwap forked Uniswap's original SwapRouter, whose params carry a
      // deadline; Uniswap's SwapRouter02 does not. Same function name,
      // different struct, different selector. Encoding the wrong one does not
      // fail gracefully — it reverts every swap on that venue.
      if (dep.routerHasDeadline) {
        return {
          to: router,
          data: single
            ? encodeFunctionData({
                abi: V3R_DEADLINE,
                functionName: 'exactInputSingle',
                args: [
                  {
                    tokenIn: path[0].address,
                    tokenOut: path[1].address,
                    fee: fees[0],
                    recipient,
                    deadline,
                    amountIn,
                    amountOutMinimum,
                    sqrtPriceLimitX96: 0n,
                  },
                ],
              })
            : encodeFunctionData({
                abi: V3R_DEADLINE,
                functionName: 'exactInput',
                args: [
                  {
                    path: encodeV3Path(path, fees),
                    recipient,
                    deadline,
                    amountIn,
                    amountOutMinimum,
                  },
                ],
              }),
          value: 0n,
        };
      }

      return {
        to: router,
        data: single
          ? encodeFunctionData({
              abi: V3R,
              functionName: 'exactInputSingle',
              args: [
                {
                  tokenIn: path[0].address,
                  tokenOut: path[1].address,
                  fee: fees[0],
                  recipient,
                  amountIn,
                  amountOutMinimum,
                  // No price limit: the minimum-output check is the guard, and
                  // a sqrtPrice bound on top of it produces confusing
                  // partial-fill reverts for no additional safety.
                  sqrtPriceLimitX96: 0n,
                },
              ],
            })
          : encodeFunctionData({
              abi: V3R,
              functionName: 'exactInput',
              args: [
                {
                  path: encodeV3Path(path, fees),
                  recipient,
                  amountIn,
                  // The floor applies to the end of the path, not to each hop.
                  amountOutMinimum,
                },
              ],
            }),
        value: 0n,
      };
    }

    case 'aero':
      return {
        to: chain.aerodrome!.router,
        data: encodeFunctionData({
          abi: AEROR,
          functionName: 'swapExactTokensForTokens',
          args: [
            amountIn,
            amountOutMinimum,
            venue.hops.map((h, i) => ({
              from: path[i].address,
              to: path[i + 1].address,
              stable: (h as Extract<Hop, { family: 'aero' }>).stable,
              factory: chain.aerodrome!.factory,
            })),
            recipient,
            deadline,
          ],
        }),
        value: 0n,
      };

    case 'v2':
      return {
        to: spenderFor(venue),
        data: encodeFunctionData({
          abi: V2R,
          functionName: 'swapExactTokensForTokens',
          args: [amountIn, amountOutMinimum, path.map((t) => t.address), recipient, deadline],
        }),
        value: 0n,
      };
  }
}

// ── Uniswap V4 ──────────────────────────────────────────────────────────────
//
// Universal Router commands and V4 router actions, from
// universal-router/contracts/libraries/Commands.sol and
// v4-periphery/src/libraries/Actions.sol.
const CMD = { PERMIT2_TRANSFER_FROM: 0x02, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, V4_SWAP: 0x10 } as const;
const ACTION = { SWAP_EXACT_IN_SINGLE: 0x06, SWAP_EXACT_IN: 0x07, SETTLE: 0x0b, TAKE: 0x0e } as const;

/** Universal Router placeholders: "the router itself", and "its whole balance". */
const ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002';
const CONTRACT_BALANCE = 1n << 255n;
/** V4 settle/take amount meaning "whatever the swap left owed". */
const OPEN_DELTA = 0n;
const NATIVE: Address = '0x0000000000000000000000000000000000000000';

const POOL_KEY = '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)';
const PATH_KEY = '(address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)';

const bytesOf = (codes: number[]): `0x${string}` =>
  concatHex(codes.map((c) => `0x${c.toString(16).padStart(2, '0')}` as `0x${string}`));

/**
 * A V4 swap as one Universal Router call.
 *
 * The swap itself is three V4 actions: swap, settle what is owed, take what is
 * due. The output floor lives in the swap action, so it is checked by the V4
 * router against the end of the path, exactly as V3's `exactInput` does.
 *
 * Native ETH is the one wrinkle. The app speaks WETH; most V4 pools here hold
 * ETH. When the route starts in an ETH pool, the router pulls the user's WETH
 * through Permit2 and unwraps it before the swap, and pays the pool from its
 * own balance. When it ends in one, the router takes the ETH and wraps it to
 * the recipient. No ETH ever passes through the user's wallet, and no step is
 * a separate transaction.
 */
function buildV4Swap(
  venue: Venue,
  amountIn: bigint,
  amountOutMinimum: bigint,
  recipient: Address,
  deadline: bigint,
): SwapTx {
  const chain = chainOfVenue(venue);
  const router = chain.v4!.universalRouter;
  const hops = venue.hops as Extract<Hop, { family: 'v4' }>[];
  const currencies = v4PathCurrencies(venue);
  const currencyIn = currencies[0];
  const currencyOut = currencies[currencies.length - 1];
  const unwrapIn = currencyIn === NATIVE;
  const wrapOut = currencyOut === NATIVE;

  if (amountIn >= 1n << 128n || amountOutMinimum >= 1n << 128n) throw new Error('amount too large for V4');

  const swap =
    hops.length === 1
      ? {
          action: ACTION.SWAP_EXACT_IN_SINGLE,
          param: encodeAbiParameters(
            parseAbiParameters(
              `(${POOL_KEY} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 maxHopSlippage, bytes hookData)`,
            ),
            [{ poolKey: hops[0].key, zeroForOne: hops[0].zeroForOne, amountIn, amountOutMinimum, maxHopSlippage: 0n, hookData: '0x' }],
          ),
        }
      : {
          action: ACTION.SWAP_EXACT_IN,
          param: encodeAbiParameters(
            parseAbiParameters(
              `(address currencyIn, ${PATH_KEY}[] path, uint256[] maxHopSlippage, uint128 amountIn, uint128 amountOutMinimum)`,
            ),
            [
              {
                currencyIn,
                path: v4PathKeys(venue),
                // Empty: no per-hop bound. The floor on the whole path is the guard.
                maxHopSlippage: [],
                amountIn,
                amountOutMinimum,
              },
            ],
          ),
        };

  const settle = encodeAbiParameters(parseAbiParameters('address, uint256, bool'), [
    currencyIn,
    OPEN_DELTA,
    // The router pays when it unwrapped the input itself; otherwise Permit2
    // pulls the input from the user.
    !unwrapIn,
  ]);
  const take = encodeAbiParameters(parseAbiParameters('address, address, uint256'), [
    currencyOut,
    wrapOut ? ADDRESS_THIS : recipient,
    OPEN_DELTA,
  ]);

  const v4Input = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [
    bytesOf([swap.action, ACTION.SETTLE, ACTION.TAKE]),
    [swap.param, settle, take],
  ]);

  const commands: number[] = [];
  const inputs: `0x${string}`[] = [];
  if (unwrapIn) {
    commands.push(CMD.PERMIT2_TRANSFER_FROM, CMD.UNWRAP_WETH);
    inputs.push(
      encodeAbiParameters(parseAbiParameters('address, address, uint160'), [chain.weth.address, ADDRESS_THIS, amountIn]),
      encodeAbiParameters(parseAbiParameters('address, uint256'), [ADDRESS_THIS, amountIn]),
    );
  }
  commands.push(CMD.V4_SWAP);
  inputs.push(v4Input);
  if (wrapOut) {
    commands.push(CMD.WRAP_ETH);
    inputs.push(encodeAbiParameters(parseAbiParameters('address, uint256'), [recipient, CONTRACT_BALANCE]));
  }

  return {
    to: router,
    data: encodeFunctionData({ abi: UR, functionName: 'execute', args: [bytesOf(commands), inputs, deadline] }),
    value: 0n,
  };
}
