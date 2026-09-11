import { parseAbi } from "viem";

export const uniswapV2PairAbi = parseAbi([
    "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
]);

export const uniswapV3PoolAbi = parseAbi([
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() view returns (uint128)",
    "function fee() view returns (uint24)",
    "function tickSpacing() view returns (int24)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function tickBitmap(int16 wordPosition) view returns (uint256)",
    "function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)",
]);

export const swapRouterAbi = parseAbi([
    "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
    "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
    "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to) payable returns (uint256 amountOut)",
    "struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }",
    "function exactInput(ExactInputParams params) payable returns (uint256 amountOut)",
    "function multicall(bytes[] data) payable returns (bytes[] results)",
]);

// the events that change what a quote reads. a v3 swap emits its own post state; mint and burn
// carry the liquidity that moves at each tick; a v2 sync carries the reserves outright.
//
// pancakeswap v3 appends two protocol fee fields to its swap event, which changes the topic: a
// sync that only listens for uniswap's signature silently never sees a pancake pool move.
export const poolEventsAbi = parseAbi([
    "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
    "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint128 protocolFeesToken0, uint128 protocolFeesToken1)",
    "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
    "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
    "event Sync(uint112 reserve0, uint112 reserve1)",
    // a v3 pool's first price, which is the tick every later mint is judged in-range against
    "event Initialize(uint160 sqrtPriceX96, int24 tick)",
]);

// what a factory says when a pool comes into existence. uniswap v3, its forks and pancakeswap all
// emit the same PoolCreated; every v2 fork emits the same PairCreated.
export const factoryEventsAbi = parseAbi([
    "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
    "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)",
]);

export const erc20Abi = parseAbi([
    "function balanceOf(address account) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

// every v2 fork still runs the original router, which takes a deadline uniswap's SwapRouter02
// dropped. verified on a fork: sushiswap's router accepts this form and reverts on the other.
export const v2RouterAbi = parseAbi([
    "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
]);

// the original v3 SwapRouter, which sushiswap and hyperswap still run. the struct carries a deadline
// that SwapRouter02 later dropped, and a router given the wrong layout reverts.
export const v3RouterWithDeadlineAbi = parseAbi([
    "struct ExactInputSingleWithDeadlineParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
    "function exactInputSingle(ExactInputSingleWithDeadlineParams params) payable returns (uint256 amountOut)",
    "struct ExactInputWithDeadlineParams { bytes path; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; }",
    "function exactInput(ExactInputWithDeadlineParams params) payable returns (uint256 amountOut)",
]);
