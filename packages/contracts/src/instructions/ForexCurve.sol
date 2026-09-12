// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Context } from "@1inch/swap-vm/libs/VM.sol";
import { IPriceOracle } from "@1inch/swap-vm/instructions/interfaces/IPriceOracle.sol";

import { ForexCurveMath } from "../libs/ForexCurveMath.sol";

/// @title ForexCurveArgsBuilder - Program arguments for the ForexCurve instruction
/// @notice Byte layout (123 bytes, big-endian, packed):
///
///         offset  size  field           meaning
///         ------  ----  --------------  ----------------------------------------------------------------------
///              0     1  oracleKind      0 = Chainlink-style latestRoundData (the only kind accepted)
///              1     1  flags           bit 0 FLAG_INVERT_PRICE, bit 1 FLAG_QUOTE_IS_GT; other bits must be zero
///              2    20  oracle          price feed address
///             22     1  oracleDecimals  feed decimals; 0 = read decimals() from the feed on every swap
///             23     4  maxStaleness    max age of the feed answer in seconds, > 0
///             27    16  minPrice        lowest accepted feed answer, WAD, in the FEED's orientation
///             43    16  maxPrice        highest accepted feed answer, WAD, in the FEED's orientation
///             59     8  alpha           α, halt distance from the ideal, WAD, 0 < α < 1
///             67     8  beta            β, flat band half-width, WAD, 0 ≤ β < α
///             75     8  delta           δ, fee slope outside the band, WAD (the 8-byte field caps it at ≈ 18.45)
///             83     8  maxFee          MAX, fee rate cap, WAD, < 1/2 (so each quote has one solution)
///             91     8  lambda          λ, share of a shrinking fee returned to the taker, WAD, ≤ 1
///             99     8  epsilon         ε, proportional fee, WAD, < 0.1
///            107     8  rateLt          10^(18 − decimals) of the token with the LOWER address, 1..1e18
///            115     8  rateGt          10^(18 − decimals) of the token with the GREATER address, 1..1e18
///
/// @notice Price convention. The curve prices in the QUOTE token (the numeraire, e.g. USDC) and needs
///             p = QUOTE units per 1 LOCAL unit (WAD)
///         The feed answer is scaled to WAD, checked against [minPrice, maxPrice], then used as p directly, or inverted
///         (1e36 / answer) when FLAG_INVERT_PRICE is set, i.e. when the feed quotes LOCAL units per 1 QUOTE unit.
///         FLAG_QUOTE_IS_GT says which of the pair's two tokens is the quote: the greater address when set, else the lower.
///         Examples: USDC (0x3600…) / BRAt (0xa948…) with a USD-per-BRL feed: flags = 0.
///                   USDC (0x3600…) / ARGt (0xd8dE…) with an ARS-per-USD feed: flags = FLAG_INVERT_PRICE.
/// @notice Decimals convention: rate = 10^(18 − decimals), so `amount · rate` is the amount at 18 decimals.
library ForexCurveArgsBuilder {
    uint8 internal constant ORACLE_KIND_CHAINLINK = 0;
    /// @dev The feed quotes LOCAL units per 1 QUOTE unit
    uint8 internal constant FLAG_INVERT_PRICE = 0x01;
    /// @dev The quote (numeraire) token is the greater address of the pair
    uint8 internal constant FLAG_QUOTE_IS_GT = 0x02;
    uint256 internal constant ARGS_LENGTH = 123;
    /// @dev Exclusive upper bound of ε
    uint256 internal constant MAX_EPSILON = 1e17;
    /// @dev Exclusive upper bound of maxFee, the same for every α (see maxFeeLimit)
    uint256 internal constant MAX_FEE = 0.5e18;
    uint256 internal constant MAX_RATE = 1e18;

    error ForexCurveInvalidArgsLength();
    error ForexCurveUnsupportedOracleKind();
    error ForexCurveInvalidFlags();
    error ForexCurveInvalidOracle();
    error ForexCurveInvalidMaxStaleness();
    error ForexCurveInvalidPriceBand();
    error ForexCurveInvalidCurve();
    error ForexCurveInvalidFees();
    error ForexCurveInvalidRates();
    error ForexCurveInvalidPair();
    error ForexCurveUnsupportedDecimals(uint8 decimals);

    /// @notice ForexCurve configuration (see the byte layout above)
    struct Args {
        uint8 oracleKind;
        uint8 flags;
        address oracle;
        uint8 oracleDecimals;
        uint32 maxStaleness;
        uint128 minPrice;
        uint128 maxPrice;
        uint64 alpha;
        uint64 beta;
        uint64 delta;
        uint64 maxFee;
        uint64 lambda;
        uint64 epsilon;
        uint64 rateLt;
        uint64 rateGt;
    }

    /// @notice Validate and pack arguments for inclusion in a program
    function build(Args memory args) internal pure returns (bytes memory) {
        validate(args);
        return abi.encodePacked(
            abi.encodePacked(args.oracleKind, args.flags, args.oracle, args.oracleDecimals, args.maxStaleness),
            abi.encodePacked(args.minPrice, args.maxPrice),
            abi.encodePacked(args.alpha, args.beta, args.delta, args.maxFee),
            abi.encodePacked(args.lambda, args.epsilon, args.rateLt, args.rateGt)
        );
    }

    /// @notice Decode and validate program arguments
    function parse(bytes calldata data) internal pure returns (Args memory args) {
        require(data.length == ARGS_LENGTH, ForexCurveInvalidArgsLength());
        // Four words cover the 123 bytes: [0, 32), [27, 59), [59, 91), [91, 123)
        uint256 w0;
        uint256 w1;
        uint256 w2;
        uint256 w3;
        assembly ("memory-safe") {
            w0 := calldataload(data.offset)
            w1 := calldataload(add(data.offset, 27))
            w2 := calldataload(add(data.offset, 59))
            w3 := calldataload(add(data.offset, 91))
        }
        args.oracleKind = uint8(w0 >> 248);
        args.flags = uint8(w0 >> 240);
        args.oracle = address(uint160(w0 >> 80));
        args.oracleDecimals = uint8(w0 >> 72);
        args.maxStaleness = uint32(w0 >> 40);
        args.minPrice = uint128(w1 >> 128);
        args.maxPrice = uint128(w1);
        args.alpha = uint64(w2 >> 192);
        args.beta = uint64(w2 >> 128);
        args.delta = uint64(w2 >> 64);
        args.maxFee = uint64(w2);
        args.lambda = uint64(w3 >> 192);
        args.epsilon = uint64(w3 >> 128);
        args.rateLt = uint64(w3 >> 64);
        args.rateGt = uint64(w3);
        validate(args);
    }

    /// @notice Reject configurations the instruction cannot price safely
    function validate(Args memory args) internal pure {
        require(args.oracleKind == ORACLE_KIND_CHAINLINK, ForexCurveUnsupportedOracleKind());
        require(args.flags <= FLAG_INVERT_PRICE | FLAG_QUOTE_IS_GT, ForexCurveInvalidFlags());
        require(args.oracle != address(0), ForexCurveInvalidOracle());
        require(args.maxStaleness != 0, ForexCurveInvalidMaxStaleness());
        require(args.minPrice != 0 && args.minPrice <= args.maxPrice, ForexCurveInvalidPriceBand());
        unchecked {
            // α − 1 wraps for α = 0
            require(uint256(args.alpha) - 1 < ForexCurveMath.WAD - 1 && args.beta < args.alpha, ForexCurveInvalidCurve());
        }
        require(
            args.maxFee < MAX_FEE && args.lambda <= ForexCurveMath.WAD && args.epsilon < MAX_EPSILON,
            ForexCurveInvalidFees()
        );
        unchecked {
            // rate − 1 wraps for a zero rate
            require(
                uint256(args.rateLt) - 1 < MAX_RATE && uint256(args.rateGt) - 1 < MAX_RATE, ForexCurveInvalidRates()
            );
        }
    }

    /// @notice Largest maxFee (WAD) validate accepts: MAX_FEE − 1, the same for every α (the argument is kept so callers
    ///         and the TypeScript cross-check stay per-α)
    /// @dev Why 1/2. Along a trade the known balance is fixed and the other one moves with the retention s; outside the
    ///      band one asset is below and the other above with the same distance m, so both fees move together. ψ grows with
    ///      s only when the known asset is below the band, each m then growing at (1 − β)/2, and
    ///          dψ/ds ≤ 2·MAX·(1 − β) − MAX²/δ < 2·MAX      (capped fees give MAX·(1 − β))
    ///      so MAX < 1/2 keeps the residual s − c·(ψ(s) − ω) strictly increasing for every α, β, δ, λ: one root, the
    ///      DFX fixed point. There is no α-dependent bound: with α close to 1 a trade the size of the book can clear, but
    ///      the swap invariant still holds (g − ψ never drops, so the pool's value net of fees never falls), and the taker
    ///      never gets more than the oracle value of its input plus λ of the fee reduction.
    function maxFeeLimit(uint256) internal pure returns (uint256) {
        return MAX_FEE - 1;
    }

    /// @notice Curve parameters of a configuration
    function params(Args memory args) internal pure returns (ForexCurveMath.Params memory) {
        return ForexCurveMath.Params({
            alpha: args.alpha,
            beta: args.beta,
            delta: args.delta,
            maxFee: args.maxFee,
            lambda: args.lambda,
            epsilon: args.epsilon
        });
    }

    /// @notice Flags and rates for a pair
    /// @param quoteToken The numeraire token (e.g. USDC)
    /// @param quoteDecimals Its decimals, ≤ 18
    /// @param localToken The local currency token (e.g. BRAt)
    /// @param localDecimals Its decimals, ≤ 18
    /// @param feedQuotesLocalPerQuote Whether the feed quotes LOCAL units per 1 QUOTE unit (e.g. ARS per USD)
    /// @return flags FLAG_INVERT_PRICE and FLAG_QUOTE_IS_GT as they apply
    /// @return rateLt Decimals multiplier of the lower-address token
    /// @return rateGt Decimals multiplier of the greater-address token
    function pairFields(
        address quoteToken,
        uint8 quoteDecimals,
        address localToken,
        uint8 localDecimals,
        bool feedQuotesLocalPerQuote
    ) internal pure returns (uint8 flags, uint64 rateLt, uint64 rateGt) {
        require(quoteToken != localToken, ForexCurveInvalidPair());
        require(quoteDecimals <= 18, ForexCurveUnsupportedDecimals(quoteDecimals));
        require(localDecimals <= 18, ForexCurveUnsupportedDecimals(localDecimals));
        uint64 quoteRate = uint64(10 ** (18 - quoteDecimals));
        uint64 localRate = uint64(10 ** (18 - localDecimals));
        bool quoteIsGt = quoteToken > localToken;
        flags = (feedQuotesLocalPerQuote ? FLAG_INVERT_PRICE : 0) | (quoteIsGt ? FLAG_QUOTE_IS_GT : 0);
        (rateLt, rateGt) = quoteIsGt ? (localRate, quoteRate) : (quoteRate, localRate);
    }
}

/// @title ForexCurve - Shell v1 / DFX forex curve with an oracle, for floating FX pairs
/// @notice The curve DFX v2 runs in production for EURC, CADC and XSGD against USDC, solved in closed form
///         (ForexCurveMath). Within ±β of the ideal 50/50 value split the price is the oracle with zero slippage; outside
///         it each asset pays a micro fee that grows with the distance to the band, a trade that shrinks the fee returns λ
///         of it to the taker, and beyond ±α the swap halts. ε is a proportional fee on top.
/// @notice Every swap reads the feed the program names, rejects a stale or out-of-band answer, values both Aqua balances in
///         the quote token and quotes. There is no stored state: the result is a pure function of balances, the oracle
///         answer and the program args. The feed carries no confidence interval, so conf = 0 and the spread is ε.
contract ForexCurve {
    error ForexCurveRecomputeDetected();
    error ForexCurveOracleInvalidAnswer(int256 answer);
    error ForexCurveOracleStale(uint256 updatedAt, uint256 maxStaleness, uint256 nowTs);
    error ForexCurveOraclePriceOutOfBand(uint256 price, uint256 minPrice, uint256 maxPrice);

    /// @dev Oracle-anchored forex curve swap for two tokens
    /// @param ctx Swap context; balanceIn/balanceOut are the maker's Aqua balances
    /// @param args ForexCurveArgsBuilder layout, 123 bytes
    function _forexCurve2D(Context memory ctx, bytes calldata args) internal view {
        ForexCurveArgsBuilder.Args memory config = ForexCurveArgsBuilder.parse(args);
        uint256 price = _forexCurveOraclePrice(config);

        // tokenOut is the greater address iff tokenIn < tokenOut; it is the local token iff that side is not the quote's
        bool quoteIsGt = config.flags & ForexCurveArgsBuilder.FLAG_QUOTE_IS_GT != 0;
        bool localOut = (ctx.query.tokenIn < ctx.query.tokenOut) != quoteIsGt;
        (uint256 rateQuote, uint256 rateLocal) = quoteIsGt ? (config.rateGt, config.rateLt) : (config.rateLt, config.rateGt);
        (uint256 rateIn, uint256 rateOut, uint256 quoteBalance, uint256 localBalance) = localOut
            ? (rateQuote, rateLocal, ctx.swap.balanceIn * rateQuote, ctx.swap.balanceOut * rateLocal)
            : (rateLocal, rateQuote, ctx.swap.balanceOut * rateQuote, ctx.swap.balanceIn * rateLocal);
        ForexCurveMath.Params memory params = ForexCurveArgsBuilder.params(config);

        bool exactIn = ctx.query.isExactIn;
        require((exactIn ? ctx.swap.amountOut : ctx.swap.amountIn) == 0, ForexCurveRecomputeDetected());
        (uint256 amountIn, uint256 amountOut) = ForexCurveMath.quote(
            params,
            price,
            quoteBalance,
            localBalance,
            0,
            localOut,
            exactIn,
            exactIn ? ctx.swap.amountIn * rateIn : ctx.swap.amountOut * rateOut
        );
        if (exactIn) ctx.swap.amountOut = amountOut / rateOut;
        else ctx.swap.amountIn = (amountIn + rateIn - 1) / rateIn;
    }

    /// @dev Read and validate the feed, returning p (quote units per 1 local unit) in WAD
    function _forexCurveOraclePrice(ForexCurveArgsBuilder.Args memory config) internal view returns (uint256 price) {
        address oracle = config.oracle;
        uint256 latestRoundData = uint32(IPriceOracle.latestRoundData.selector);
        uint256 decimals = uint32(IPriceOracle.decimals.selector);
        uint256 oracleDecimals = config.oracleDecimals;
        int256 answer;
        uint256 updatedAt;
        // IPriceOracle.latestRoundData() and, when the program does not pin the decimals, IPriceOracle.decimals().
        // Reverts bubble up; a short return reverts.
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, shl(224, latestRoundData))
            let ok := staticcall(gas(), oracle, ptr, 4, ptr, 160)
            if iszero(and(ok, gt(returndatasize(), 159))) {
                returndatacopy(ptr, 0, returndatasize())
                revert(ptr, returndatasize())
            }
            answer := mload(add(ptr, 32))
            updatedAt := mload(add(ptr, 96))
            if iszero(oracleDecimals) {
                mstore(ptr, shl(224, decimals))
                ok := staticcall(gas(), oracle, ptr, 4, ptr, 32)
                if iszero(and(ok, gt(returndatasize(), 31))) {
                    returndatacopy(ptr, 0, returndatasize())
                    revert(ptr, returndatasize())
                }
                oracleDecimals := mload(ptr)
                if gt(oracleDecimals, 255) { revert(0, 0) }
            }
        }
        require(answer > 0, ForexCurveOracleInvalidAnswer(answer));
        require(
            updatedAt <= block.timestamp && block.timestamp - updatedAt <= config.maxStaleness,
            ForexCurveOracleStale(updatedAt, config.maxStaleness, block.timestamp)
        );

        uint256 feedPrice = uint256(answer);
        if (oracleDecimals <= 18) {
            uint256 scale;
            unchecked {
                scale = 10 ** (18 - oracleDecimals);
            }
            feedPrice *= scale;
        } else {
            // 10^77 is the largest power of ten below 2^256, and any answer is below 10^77
            unchecked {
                feedPrice = oracleDecimals < 96 ? feedPrice / 10 ** (oracleDecimals - 18) : 0;
            }
        }
        bool invert = config.flags & ForexCurveArgsBuilder.FLAG_INVERT_PRICE != 0;
        // An inverted answer above 1e36 would price at zero
        require(
            feedPrice >= config.minPrice && feedPrice <= config.maxPrice && (!invert || feedPrice <= 1e36),
            ForexCurveOraclePriceOutOfBand(feedPrice, config.minPrice, config.maxPrice)
        );
        price = invert ? 1e36 / feedPrice : feedPrice;
    }
}
