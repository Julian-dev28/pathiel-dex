// Every chain the router quotes, as data. Every address below was verified to
// have bytecode on-chain by scripts/verify-addresses.sh, which runs in CI. None
// of them are copied from a blog post. Re-run that script after editing a table.

import { base, robinhood, type Chain } from 'viem/chains';
import { ROBINHOOD_V4_POOLS } from './v4-pools';

export type ChainKey = 'robinhood' | 'base';

/** Robinhood Chain is the default: the app, the API and the MCP tools open on it. */
export const DEFAULT_CHAIN: ChainKey = 'robinhood';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;

export type Token = {
  /** Which chain the address lives on. Symbols repeat across chains; addresses do not. */
  chainId: number;
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
};

/**
 * Concentrated-liquidity deployments, as data.
 *
 * Uniswap V3 and its forks share a quoter ABI, so a fork is a table entry
 * rather than a code path. What they do *not* share is the router: PancakeSwap
 * forked Uniswap's original `SwapRouter`, which carries a `deadline` field in
 * its swap params, while Uniswap moved to `SwapRouter02`, which does not.
 * Encoding one against the other reverts every swap, so the difference is
 * recorded here and checked in `scripts/probe-venues.ts` by reading the
 * selectors out of the deployed bytecode.
 *
 * Fee tiers differ too: Pancake's third tier is 0.25% where Uniswap's is 0.30%.
 */
export type V3Deployment = {
  name: string;
  quoter: `0x${string}`;
  router: `0x${string}`;
  factory: `0x${string}`;
  feeTiers: readonly number[];
  /**
   * Fee tiers considered for the *middle* of a multi-hop route. All four tiers
   * squared is sixteen candidates per intermediate, most of them dead pools
   * that each cost a contract call to discover; these cover the liquidity that
   * exists on the chain.
   */
  multiHopTiers: readonly number[];
  /** True when the router's swap params include a deadline (SwapRouter v1). */
  routerHasDeadline: boolean;
};

// V2 forks differ only in their factory, their router, and their fee numerator,
// so they are data rather than code. Fees are in basis points of 10_000 —
// BaseSwap takes 25bp where the others take 30, and one shared constant would
// misprice every BaseSwap trade.
export type V2Venue = {
  name: string;
  factory: `0x${string}`;
  router: `0x${string}`;
  feeBps: number;
};

/**
 * A Uniswap V4 pool, identified by its key.
 *
 * V4 has no factory to ask: every pool lives inside one PoolManager and is
 * named by (currency0, currency1, fee, tickSpacing, hooks). The fee and tick
 * spacing are free parameters rather than a handful of tiers, so the pools
 * cannot be guessed — they are read from the PoolManager's Initialize events
 * by scripts/scan-v4.ts and committed to v4-pools.ts.
 *
 * `currency` 0x0 is native ETH. Most V4 liquidity on Robinhood Chain is paired
 * against native ETH rather than WETH, so the router treats WETH and native
 * ETH as the same asset and wraps or unwraps at the ends of the route.
 */
export type V4PoolKey = {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
};

export type V4Deployment = {
  name: string;
  poolManager: `0x${string}`;
  quoter: `0x${string}`;
  /** Read-only view over PoolManager state; used by scripts/scan-v4.ts. */
  stateView: `0x${string}`;
  universalRouter: `0x${string}`;
  /**
   * Hookless pools only. A hook is arbitrary code on the swap path — it can
   * charge any fee, move any balance, or revert on a whim — and quoting one is
   * no promise about executing through it. Pools with hooks are left out.
   */
  pools: readonly V4PoolKey[];
};

export type ChainConfig = {
  key: ChainKey;
  id: number;
  name: string;
  viem: Chain;
  rpcUrls: readonly string[];
  explorer: string;
  explorerName: string;
  /** Typical block interval. Windows measured in blocks are derived from it. */
  blockMs: number;
  /** Used when the gas price cannot be read; roughly the chain's fee floor. */
  fallbackGasWei: bigint;
  tokens: Token[];
  weth: Token;
  /** The dollar the chain's liquidity is paired against. */
  usd: Token;
  /**
   * Tokens a two-hop route may pass through. Essentially all liquidity on
   * each chain is paired against one of these, so a route that cannot reach
   * one of them has no depth worth finding.
   */
  intermediates: Token[];
  v2: V2Venue[];
  v3: V3Deployment[];
  v4?: V4Deployment;
  aerodrome?: { router: `0x${string}`; factory: `0x${string}` };
  /**
   * The vertices of the arbitrage-cycle graph. Five or six tokens is twenty to
   * thirty ordered pairs — enough to be interesting, few enough to quote inside
   * a request. Each has real depth against both hubs, which is what makes an
   * edge meaningful rather than a wide spread nobody could trade.
   */
  graphTokens: string[];
};

const tokens = (chainId: number, list: Omit<Token, 'chainId'>[]): Token[] =>
  list.map((t) => ({ chainId, ...t }));

// ── Robinhood Chain ─────────────────────────────────────────────────────────
//
// An Arbitrum Orbit L2 with 100ms blocks. Liquidity is paired against USDG
// (Paxos's dollar, 6 decimals), not USDC. The tokenized stocks are Robinhood's
// own, taken from the Uniswap default token list and limited to those with a
// pool this router can reach.

const RH_TOKENS = tokens(4663, [
  { symbol: 'WETH', name: 'Wrapped Ether', address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', decimals: 18 },
  { symbol: 'USDG', name: 'Global Dollar', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6 },
  { symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', address: '0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4', decimals: 8 },
  { symbol: 'NVDA', name: 'NVIDIA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', decimals: 18 },
  { symbol: 'QQQ', name: 'Invesco QQQ', address: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68', decimals: 18 },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', address: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', decimals: 18 },
  { symbol: 'TSLA', name: 'Tesla', address: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', decimals: 18 },
  { symbol: 'GOOGL', name: 'Alphabet Class A', address: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3', decimals: 18 },
  { symbol: 'AMZN', name: 'Amazon', address: '0x12f190a9F9d7D37a250758b26824B97CE941bF54', decimals: 18 },
  { symbol: 'AAPL', name: 'Apple', address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', decimals: 18 },
  { symbol: 'MSFT', name: 'Microsoft', address: '0xe93237C50D904957Cf27E7B1133b510C669c2e74', decimals: 18 },
  { symbol: 'META', name: 'Meta Platforms', address: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35', decimals: 18 },
  { symbol: 'MSTR', name: 'Strategy Inc.', address: '0xec262a75e413fAfD0dF80480274532C79D42da09', decimals: 18 },
  { symbol: 'PLTR', name: 'Palantir Technologies', address: '0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A', decimals: 18 },
  { symbol: 'COIN', name: 'Coinbase', address: '0x6330D8C3178a418788dF01a47479c0ce7CCF450b', decimals: 18 },
]);

const ROBINHOOD: ChainConfig = {
  key: 'robinhood',
  id: 4663,
  name: 'Robinhood Chain',
  viem: robinhood,
  rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
  explorer: 'https://robinhoodchain.blockscout.com',
  explorerName: 'Blockscout',
  blockMs: 100,
  fallbackGasWei: 50_000_000n,
  tokens: RH_TOKENS,
  weth: RH_TOKENS[0],
  usd: RH_TOKENS[1],
  intermediates: [RH_TOKENS[0], RH_TOKENS[1]],
  v2: [
    {
      name: 'Uniswap V2',
      factory: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f',
      router: '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba',
      feeBps: 30,
    },
  ],
  v3: [
    {
      name: 'Uniswap V3',
      quoter: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
      router: '0xCaf681a66D020601342297493863E78C959E5cb2',
      factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
      feeTiers: [100, 500, 3000, 10000],
      // The stock tokens sit at 0.30% as often as 0.05%, and MSTR at 1%.
      multiHopTiers: [500, 3000, 10000],
      routerHasDeadline: false,
    },
    {
      name: 'PancakeSwap V3',
      quoter: '0x8553AA1615549A86882151784b329B017aA7c832',
      router: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
      factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
      feeTiers: [100, 500, 2500, 10000],
      multiHopTiers: [100, 500],
      routerHasDeadline: true,
    },
  ],
  v4: {
    name: 'Uniswap V4',
    poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
    quoter: '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94',
    stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
    universalRouter: '0x8876789976dEcBfCbBbe364623C63652db8C0904',
    pools: ROBINHOOD_V4_POOLS,
  },
  graphTokens: ['WETH', 'USDG', 'cbBTC', 'NVDA', 'SPY', 'QQQ'],
};

// ── Base ────────────────────────────────────────────────────────────────────

const BASE_TOKENS = tokens(8453, [
  { symbol: 'WETH', name: 'Wrapped Ether', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  { symbol: 'USDC', name: 'USD Coin', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  { symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 },
  { symbol: 'USDT', name: 'Tether USD', address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
  // Minted by the Base–Solana bridge; 9 decimals, same as native SOL.
  { symbol: 'SOL', name: 'Solana', address: '0x311935Cd80B76769bF2ecC9D8Ab7635b2139cf82', decimals: 9 },
  { symbol: 'cbXRP', name: 'Coinbase Wrapped XRP', address: '0xcb585250f852C6c6bf90434AB21A00f02833a4af', decimals: 6 },
  { symbol: 'DAI', name: 'Dai Stablecoin', address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
  { symbol: 'cbETH', name: 'Coinbase Wrapped Staked ETH', address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18 },
  { symbol: 'wstETH', name: 'Wrapped liquid staked Ether', address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', decimals: 18 },
  { symbol: 'rETH', name: 'Rocket Pool ETH', address: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c', decimals: 18 },
  { symbol: 'USDbC', name: 'USD Base Coin', address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', decimals: 6 },
  { symbol: 'AERO', name: 'Aerodrome', address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', decimals: 18 },
  { symbol: 'DEGEN', name: 'Degen', address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', decimals: 18 },
  { symbol: 'BRETT', name: 'Brett', address: '0x532f27101965dd16442E59d40670FaF5eBB142E4', decimals: 18 },
  { symbol: 'VIRTUAL', name: 'Virtual Protocol', address: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', decimals: 18 },
  // Coinbase tokenized stocks (B20 precompiles, listed at base.org/stocks). Only
  // those with a Uniswap or PancakeSwap V3 pool: MSTRc, SNDKc and TSLAc had none
  // this router can reach.
  { symbol: 'NVDAc', name: 'NVIDIA Corporation', address: '0xb20000000000000000000078ee7ce2fE4908108C', decimals: 8 },
  { symbol: 'AAPLc', name: 'Apple Inc.', address: '0xb200000000000000000000C2e324d24d7eEcd1fb', decimals: 8 },
  { symbol: 'GOOGLc', name: 'Alphabet Inc.', address: '0xb2000000000000000000002D0BA3164cc74f58B7', decimals: 8 },
  { symbol: 'SPCXc', name: 'Space Exploration Technologies Corp.', address: '0xb2000000000000000000007b9fcbd005511aCBd5', decimals: 8 },
  { symbol: 'AMZNc', name: 'Amazon.com Inc.', address: '0xb200000000000000000000d9192b6B456483C2E8', decimals: 8 },
  { symbol: 'MSFTc', name: 'Microsoft Corporation', address: '0xB200000000000000000000Ab99cFa739E253872B', decimals: 8 },
  { symbol: 'METAc', name: 'Meta Platforms Inc.', address: '0xb2000000000000000000008bC8786B856E61707C', decimals: 8 },
]);

const BASE: ChainConfig = {
  key: 'base',
  id: 8453,
  name: 'Base',
  viem: base,
  rpcUrls: ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base-rpc.publicnode.com'],
  explorer: 'https://basescan.org',
  explorerName: 'Basescan',
  blockMs: 2_000,
  // Base is an L2 with a fee floor around 0.01 gwei.
  fallbackGasWei: 10_000_000n,
  tokens: BASE_TOKENS,
  weth: BASE_TOKENS[0],
  usd: BASE_TOKENS[1],
  intermediates: [BASE_TOKENS[0], BASE_TOKENS[1]],
  v2: [
    {
      name: 'Uniswap V2',
      factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
      router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
      feeBps: 30,
    },
    {
      name: 'SushiSwap',
      factory: '0x71524B4f93c58fcbF659783284E38825f0622859',
      router: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891',
      feeBps: 30,
    },
    {
      name: 'BaseSwap',
      factory: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB',
      router: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',
      feeBps: 25,
    },
  ],
  v3: [
    {
      name: 'Uniswap V3',
      quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
      router: '0x2626664c2603336E57B271c5C0b26F421741e481',
      factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
      feeTiers: [100, 500, 3000, 10000],
      // On Base the 0.01% and 1% tiers are near-empty for anything but stable pairs.
      multiHopTiers: [500, 3000],
      routerHasDeadline: false,
    },
    {
      name: 'PancakeSwap V3',
      quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
      router: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
      factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
      feeTiers: [100, 500, 2500, 10000],
      multiHopTiers: [500, 2500],
      routerHasDeadline: true,
    },
  ],
  aerodrome: {
    router: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
    factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
  },
  graphTokens: ['WETH', 'USDC', 'cbBTC', 'cbETH', 'AERO'],
};

export const CHAINS: Record<ChainKey, ChainConfig> = { robinhood: ROBINHOOD, base: BASE };

/** Robinhood Chain first: it is the default everywhere a list of chains is shown. */
export const CHAIN_LIST: ChainConfig[] = [ROBINHOOD, BASE];

export const isChainKey = (s: string): s is ChainKey => s in CHAINS;

/**
 * Endpoints for a chain, a private one first when configured:
 * `RPC_URL_ROBINHOOD` / `RPC_URL_BASE`. Plain `RPC_URL` predates Robinhood
 * Chain support and still means Base.
 */
export function rpcUrlsFor(chain: ChainConfig): string[] {
  const own = process.env[`RPC_URL_${chain.key.toUpperCase()}`] ?? (chain.key === 'base' ? process.env.RPC_URL : undefined);
  return own ? [own, ...chain.rpcUrls] : [...chain.rpcUrls];
}

export function chainByKey(key: string | null | undefined): ChainConfig {
  if (!key) return CHAINS[DEFAULT_CHAIN];
  const k = key.toLowerCase();
  if (!isChainKey(k)) throw new Error(`unknown chain: ${key}`);
  return CHAINS[k];
}

export function chainById(id: number): ChainConfig {
  const c = CHAIN_LIST.find((x) => x.id === id);
  if (!c) throw new Error(`unsupported chain id: ${id}`);
  return c;
}

/** The chain a token lives on. Every quote and swap derives its chain from here. */
export const chainOf = (t: Token): ChainConfig => chainById(t.chainId);

type ChainRef = ChainKey | ChainConfig;
const resolve = (c: ChainRef): ChainConfig => (typeof c === 'string' ? CHAINS[c] : c);

export const bySymbol = (s: string, chain: ChainRef = DEFAULT_CHAIN): Token => {
  const cfg = resolve(chain);
  const t = cfg.tokens.find((x) => x.symbol.toLowerCase() === s.toLowerCase());
  if (!t) throw new Error(`unknown token on ${cfg.name}: ${s}`);
  return t;
};

export const byAddress = (a: string, chain: ChainRef = DEFAULT_CHAIN): Token | undefined =>
  resolve(chain).tokens.find((t) => t.address.toLowerCase() === a.toLowerCase());

export const sameToken = (a: Token, b: Token): boolean =>
  a.chainId === b.chainId && a.address.toLowerCase() === b.address.toLowerCase();
