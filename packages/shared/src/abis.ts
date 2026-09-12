/**
 * Hand-written minimal ABI fragments for the Aqua0 vault contracts (vault registry, AssetVault) and the
 * Aqua/SwapVM venue on Arc.
 * Only the members the MCP/CLI call, plus the custom errors those calls can revert with (so viem can
 * decode reverts into readable names instead of raw selectors).
 */

const uint256 = (name: string) => ({ name, type: "uint256" }) as const;
const address = (name: string) => ({ name, type: "address" }) as const;
const bytes32 = (name: string) => ({ name, type: "bytes32" }) as const;

export const erc20Errors = [
  {
    type: "error",
    name: "ERC20InsufficientBalance",
    inputs: [address("sender"), uint256("balance"), uint256("needed")]
  },
  {
    type: "error",
    name: "ERC20InsufficientAllowance",
    inputs: [address("spender"), uint256("allowance"), uint256("needed")]
  }
] as const;

export const mintableErc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [address("account")],
    outputs: [uint256("")],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "allowance",
    inputs: [address("owner"), address("spender")],
    outputs: [uint256("")],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "approve",
    inputs: [address("spender"), uint256("amount")],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "mint",
    inputs: [address("to"), uint256("amount")],
    outputs: [],
    stateMutability: "nonpayable"
  },
  ...erc20Errors
] as const;

export const vaultRegistryAbi = [
  {
    type: "function",
    name: "classForStrategy",
    inputs: [bytes32("")],
    outputs: [uint256("")],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "registerStrategyClass",
    inputs: [bytes32("strategyKey")],
    outputs: [uint256("classId")],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "lastClassId",
    inputs: [],
    outputs: [uint256("")],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "isAllowedAdapter",
    inputs: [address("adapter")],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view"
  }
] as const;

export const assetVaultErrors = [
  {
    type: "error",
    name: "AccessControlUnauthorizedAccount",
    inputs: [address("account"), bytes32("neededRole")]
  },
  { type: "error", name: "ClassAlreadyRegistered", inputs: [uint256("classId")] },
  { type: "error", name: "ClassIsPaused", inputs: [uint256("classId")] },
  { type: "error", name: "ClassNotRegistered", inputs: [uint256("classId")] },
  { type: "error", name: "EnforcedPause", inputs: [] },
  {
    type: "error",
    name: "ExceedsWithdrawable",
    inputs: [address("owner"), uint256("requested"), uint256("withdrawable")]
  },
  {
    type: "error",
    name: "InsufficientSharedIdle",
    inputs: [uint256("requested"), uint256("available")]
  },
  { type: "error", name: "NoPrincipalToCommit", inputs: [address("lp")] },
  { type: "error", name: "NotStrategist", inputs: [address("strategist")] },
  {
    type: "error",
    name: "PrincipalUnauthorized",
    inputs: [address("caller"), address("owner")]
  },
  {
    type: "error",
    name: "VenueOutflowMeterExceeded",
    inputs: [uint256("attempted"), uint256("windowRemaining")]
  },
  { type: "error", name: "SafeERC20FailedOperation", inputs: [address("token")] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] }
] as const;

export const assetVaultAbi = [
  {
    type: "function",
    name: "registerStrategy",
    inputs: [uint256("strategyId"), address("strategist")],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "classStrategist",
    inputs: [uint256("strategyId")],
    outputs: [address("strategist")],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "setCommitment",
    inputs: [uint256("strategyId"), { name: "backing", type: "bool" }],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "deposit",
    inputs: [uint256("assets"), address("receiver")],
    outputs: [uint256("received")],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "withdraw",
    inputs: [uint256("assets"), address("receiver"), address("owner")],
    outputs: [uint256("")],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "principal",
    inputs: [address("lp")],
    outputs: [uint256("")],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "freePrincipal",
    inputs: [address("lp")],
    outputs: [uint256("")],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "committed",
    inputs: [address("lp"), uint256("strategyId")],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "committedBacking",
    inputs: [uint256("strategyId")],
    outputs: [uint256("")],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "availableFor",
    inputs: [uint256("strategyId")],
    outputs: [uint256("")],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "deployedAssets",
    inputs: [uint256("strategyId")],
    outputs: [uint256("")],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "hasRole",
    inputs: [bytes32("role"), address("account")],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view"
  },
  ...assetVaultErrors
] as const;

export const aquaAdapterErrors = [
  {
    type: "error",
    name: "AccessControlUnauthorizedAccount",
    inputs: [address("account"), bytes32("neededRole")]
  },
  { type: "error", name: "ClassHasNoStrategist", inputs: [uint256("classId")] },
  { type: "error", name: "ClassStrategistMismatch", inputs: [uint256("classId")] },
  { type: "error", name: "DuplicateToken", inputs: [address("token")] },
  { type: "error", name: "EmptyStrategy", inputs: [] },
  {
    type: "error",
    name: "FeeRateOutOfRange",
    inputs: [
      { name: "feePpb", type: "uint32" },
      { name: "maxFeePpb", type: "uint32" }
    ]
  },
  { type: "error", name: "HookCallerNotRouter", inputs: [address("caller")] },
  { type: "error", name: "HookMakerMismatch", inputs: [address("maker")] },
  { type: "error", name: "HookNotEnabled", inputs: [] },
  {
    type: "error",
    name: "HookTokenNotInStrategy",
    inputs: [bytes32("strategyId"), address("token")]
  },
  { type: "error", name: "HookUnknownOrder", inputs: [bytes32("orderHash")] },
  {
    type: "error",
    name: "InsufficientFreeBalance",
    inputs: [address("token"), uint256("requested"), uint256("free")]
  },
  { type: "error", name: "InvalidStrategyTraits", inputs: [uint256("traits")] },
  { type: "error", name: "LengthMismatch", inputs: [] },
  { type: "error", name: "OperatorMustBeEOA", inputs: [] },
  {
    type: "error",
    name: "ShipExceedsVaultBacking",
    inputs: [address("token"), uint256("classId"), uint256("amount"), uint256("idle")]
  },
  {
    type: "error",
    name: "ShipsPerBlockCapExceeded",
    inputs: [uint256("attempted"), uint256("cap")]
  },
  {
    type: "error",
    name: "SignatureExpired",
    inputs: [uint256("deadline"), uint256("nowTs")]
  },
  {
    type: "error",
    name: "StrategistNonceMismatch",
    inputs: [address("strategist"), uint256("provided"), uint256("expected")]
  },
  { type: "error", name: "StrategyAlreadyShipped", inputs: [bytes32("strategyId")] },
  { type: "error", name: "StrategyClassUnknown", inputs: [uint256("classId")] },
  { type: "error", name: "StrategyMakerMismatch", inputs: [address("maker")] },
  { type: "error", name: "StrategyNotActive", inputs: [bytes32("strategyId")] },
  { type: "error", name: "StrategyUnknown", inputs: [bytes32("strategyId")] },
  {
    type: "error",
    name: "SwapOrderMismatch",
    inputs: [bytes32("expected"), bytes32("actual")]
  },
  { type: "error", name: "TokenAlreadyHasLiveStrategy", inputs: [address("token")] },
  { type: "error", name: "TokenHasNoVault", inputs: [address("token")] }
] as const;

const swapVmOrderTuple = {
  name: "order",
  type: "tuple",
  components: [
    { name: "maker", type: "address" },
    { name: "traits", type: "uint256" },
    { name: "data", type: "bytes" }
  ]
} as const;

export const aquaAdapterAbi = [
  {
    type: "function",
    name: "strategistNonces",
    inputs: [address("strategist")],
    outputs: [uint256("")],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "currentAquaHash",
    inputs: [bytes32("strategyId")],
    outputs: [bytes32("")],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "strategyClassId",
    inputs: [bytes32("strategyId")],
    outputs: [uint256("")],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "strategyFeePpb",
    inputs: [bytes32("strategyId")],
    outputs: [{ name: "", type: "uint32" }],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "strategyAmount",
    inputs: [bytes32("strategyId"), address("token")],
    outputs: [uint256("")],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "getStrategyTokens",
    inputs: [bytes32("strategyId")],
    outputs: [{ name: "", type: "address[]" }],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "hasRole",
    inputs: [bytes32("role"), address("account")],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "DOMAIN_VERSION_HASH",
    inputs: [],
    outputs: [bytes32("")],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "shipStrategyWithFee",
    inputs: [
      uint256("classId"),
      { name: "strategyBytes", type: "bytes" },
      { name: "tokens", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "feePpb", type: "uint32" },
      uint256("nonce"),
      uint256("deadline"),
      { name: "strategistSig", type: "bytes" }
    ],
    outputs: [bytes32("strategyId")],
    stateMutability: "nonpayable"
  },
  ...aquaAdapterErrors,
  ...assetVaultErrors.filter((error) => error.name !== "AccessControlUnauthorizedAccount")
] as const;

export const aquaSwapVMRouterAbi = [
  {
    type: "function",
    name: "quote",
    inputs: [
      swapVmOrderTuple,
      address("tokenIn"),
      address("tokenOut"),
      uint256("amount"),
      { name: "takerTraitsAndData", type: "bytes" }
    ],
    outputs: [uint256("amountIn"), uint256("amountOut"), bytes32("orderHash")],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "swap",
    inputs: [
      swapVmOrderTuple,
      address("tokenIn"),
      address("tokenOut"),
      uint256("amount"),
      { name: "takerTraitsAndData", type: "bytes" }
    ],
    outputs: [uint256("amountIn"), uint256("amountOut"), bytes32("orderHash")],
    stateMutability: "nonpayable"
  },
  {
    type: "error",
    name: "AquaBalanceInsufficientAfterTakerPush",
    inputs: [uint256("balance"), uint256("preBalance"), uint256("amount"), uint256("amountNetPulled")]
  },
  { type: "error", name: "InsufficientBalance", inputs: [] },
  { type: "error", name: "MakerTraitsTokenInAndTokenOutMustBeDifferent", inputs: [] },
  { type: "error", name: "MakerTraitsZeroAmountInNotAllowed", inputs: [] },
  { type: "error", name: "PeggedSwapBothBalancesZero", inputs: [] },
  { type: "error", name: "PeggedSwapInvalidArgsLength", inputs: [uint256("length")] },
  {
    type: "error",
    name: "PeggedSwapInvalidInitialBalances",
    inputs: [uint256("x0"), uint256("y0")]
  },
  { type: "error", name: "PeggedSwapInvalidLinearWidth", inputs: [uint256("linearWidth")] },
  {
    type: "error",
    name: "PeggedSwapInvalidRates",
    inputs: [uint256("rateLt"), uint256("rateGt")]
  },
  { type: "error", name: "PeggedSwapMathInvalidInput", inputs: [] },
  { type: "error", name: "PeggedSwapMathNoSolution", inputs: [] },
  { type: "error", name: "PeggedSwapRecomputeDetected", inputs: [] },
  {
    type: "error",
    name: "RunLoopExcessiveCall",
    inputs: [uint256("pc"), uint256("programLength")]
  },
  { type: "error", name: "SafeTransferFailed", inputs: [] },
  { type: "error", name: "SafeTransferFromFailed", inputs: [] },
  {
    type: "error",
    name: "TakerTraitsAmountOutMustBeGreaterThanZero",
    inputs: [uint256("amountOut")]
  },
  { type: "error", name: "TakerTraitsDeadlineExpired", inputs: [] },
  {
    type: "error",
    name: "TakerTraitsInsufficientMinOutputAmount",
    inputs: [uint256("amountOut"), uint256("amountOutMin")]
  },
  {
    type: "error",
    name: "TakerTraitsTakerAmountInMismatch",
    inputs: [uint256("takerAmount"), uint256("computedAmount")]
  },
  { type: "error", name: "UnexpectedLock", inputs: [] },
  ...aquaAdapterErrors,
  ...erc20Errors
] as const;

/** 1inch Aqua `Shipped` event; carries the full strategy bytes, used to recover an order by strategyId. */
export const aquaShippedEvent = {
  type: "event",
  name: "Shipped",
  inputs: [
    { name: "maker", type: "address", indexed: false },
    { name: "app", type: "address", indexed: false },
    { name: "strategyHash", type: "bytes32", indexed: false },
    { name: "strategy", type: "bytes", indexed: false }
  ]
} as const;
