// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Context } from "@1inch/swap-vm/libs/VM.sol";
import { IPriceOracle } from "@1inch/swap-vm/instructions/interfaces/IPriceOracle.sol";

import { FXSwapMath } from "../libs/FXSwapMath.sol";

/// @title FXSwapArgsBuilder - Program arguments for the FXSwap instruction
/// @notice Byte layout (115 bytes, big-endian, packed):
///
///         offset  size  field           meaning
///         ------  ----  --------------  ----------------------------------------------------------------------
///              0     1  oracleKind      0 = Chainlink AggregatorV3 (latestRoundData); 1 = reserved (Pyth pull)
///              1     1  flags           bit 0 FLAG_INVERT_PRICE; other bits must be zero
///              2    20  oracle          price feed address
///             22     1  oracleDecimals  feed decimals; 0 = read decimals() from the feed on every swap
///             23     4  maxStaleness    max age of the feed answer in seconds, > 0
///             27    16  minPrice        lowest accepted feed answer, WAD, in the FEED's orientation
///             43    16  maxPrice        highest accepted feed answer, WAD, in the FEED's orientation
///             59     8  a               A * FXSwapMath.A_PRECISION
///             67     8  gamma           γ, WAD
///             75     8  midFee          fee at balance, WAD
///             83     8  outFee          fee far from balance, WAD, ≥ midFee
///             91     8  feeGamma        fee transition width, WAD
///             99     8  rateLt          decimals multiplier of the token with the LOWER address
///            107     8  rateGt          decimals multiplier of the token with the GREATER address
///
/// @notice Price convention. The instruction works with one canonical price:
///             priceGtPerLt = whole units of the greater-address token per 1 whole unit of the lower-address token (WAD)
///         The feed answer is first scaled to WAD, checked against [minPrice, maxPrice], then used as priceGtPerLt
///         directly, or inverted (1e36 / answer) when FLAG_INVERT_PRICE is set, i.e. when the feed quotes
///         tokenLt per 1 tokenGt. `orientation` derives the flag and rates from "the feed quotes `quote` per 1 `base`".
///         Example: USDC (6 dp, 0x3600…) / ARGt (18 dp, 0xd8dE…), feed "ARS per USD" = 1400:
///             base = USDC is tokenLt ⇒ no inversion; rateLt = 1e12, rateGt = 1; minPrice/maxPrice bound 1400e18.
/// @notice Decimals convention: rate = 10^(18 − decimals), so `amount · rate` is the amount at 18 decimals.
library FXSwapArgsBuilder {
    uint8 internal constant ORACLE_KIND_CHAINLINK = 0;
    /// @dev Reserved: the price and its Pyth signature would come from taker data. Not implemented; rejected by parse.
    uint8 internal constant ORACLE_KIND_PYTH = 1;
    /// @dev Feed quotes tokenLt per 1 tokenGt
    uint8 internal constant FLAG_INVERT_PRICE = 0x01;
    uint256 internal constant ARGS_LENGTH = 115;

    error FXSwapInvalidArgsLength(uint256 length);
    error FXSwapUnsupportedOracleKind(uint8 oracleKind);
    error FXSwapInvalidFlags(uint8 flags);
    error FXSwapInvalidOracle();
    error FXSwapInvalidMaxStaleness();
    error FXSwapInvalidPriceBand(uint256 minPrice, uint256 maxPrice);
    error FXSwapInvalidCurve(uint256 a, uint256 gamma);
    error FXSwapInvalidFees(uint256 midFee, uint256 outFee, uint256 feeGamma);
    error FXSwapInvalidRates(uint256 rateLt, uint256 rateGt);
    error FXSwapInvalidPair();
    error FXSwapUnsupportedDecimals(uint8 decimals);

    /// @notice FXSwap configuration (see the byte layout above)
    struct Args {
        uint8 oracleKind;
        uint8 flags;
        address oracle;
        uint8 oracleDecimals;
        uint32 maxStaleness;
        uint128 minPrice;
        uint128 maxPrice;
        uint64 a;
        uint64 gamma;
        uint64 midFee;
        uint64 outFee;
        uint64 feeGamma;
        uint64 rateLt;
        uint64 rateGt;
    }

    /// @notice Validate and pack arguments for inclusion in a program
    function build(Args memory args) internal pure returns (bytes memory) {
        validate(args);
        return abi.encodePacked(
            abi.encodePacked(args.oracleKind, args.flags, args.oracle, args.oracleDecimals, args.maxStaleness),
            abi.encodePacked(args.minPrice, args.maxPrice),
            abi.encodePacked(args.a, args.gamma, args.midFee, args.outFee, args.feeGamma, args.rateLt, args.rateGt)
        );
    }

    /// @notice Decode and validate program arguments
    function parse(bytes calldata data) internal pure returns (Args memory args) {
        require(data.length == ARGS_LENGTH, FXSwapInvalidArgsLength(data.length));
        args.oracleKind = uint8(data[0]);
        args.flags = uint8(data[1]);
        args.oracle = address(bytes20(data[2:22]));
        args.oracleDecimals = uint8(data[22]);
        args.maxStaleness = uint32(bytes4(data[23:27]));
        args.minPrice = uint128(bytes16(data[27:43]));
        args.maxPrice = uint128(bytes16(data[43:59]));
        args.a = uint64(bytes8(data[59:67]));
        args.gamma = uint64(bytes8(data[67:75]));
        args.midFee = uint64(bytes8(data[75:83]));
        args.outFee = uint64(bytes8(data[83:91]));
        args.feeGamma = uint64(bytes8(data[91:99]));
        args.rateLt = uint64(bytes8(data[99:107]));
        args.rateGt = uint64(bytes8(data[107:115]));
        validate(args);
    }

    /// @notice Reject configurations the instruction cannot price safely
    function validate(Args memory args) internal pure {
        require(args.oracleKind == ORACLE_KIND_CHAINLINK, FXSwapUnsupportedOracleKind(args.oracleKind));
        require(args.flags & ~FLAG_INVERT_PRICE == 0, FXSwapInvalidFlags(args.flags));
        require(args.oracle != address(0), FXSwapInvalidOracle());
        require(args.maxStaleness != 0, FXSwapInvalidMaxStaleness());
        require(args.minPrice != 0 && args.minPrice <= args.maxPrice, FXSwapInvalidPriceBand(args.minPrice, args.maxPrice));
        require(
            args.a <= FXSwapMath.MAX_A && args.gamma >= FXSwapMath.MIN_GAMMA && args.gamma <= FXSwapMath.MAX_GAMMA,
            FXSwapInvalidCurve(args.a, args.gamma)
        );
        require(
            args.midFee <= args.outFee && args.outFee <= FXSwapMath.MAX_FEE && args.feeGamma <= FXSwapMath.WAD
                && (args.feeGamma != 0 || args.midFee == args.outFee),
            FXSwapInvalidFees(args.midFee, args.outFee, args.feeGamma)
        );
        require(args.rateLt != 0 && args.rateGt != 0, FXSwapInvalidRates(args.rateLt, args.rateGt));
    }

    /// @notice Orientation fields for a pair whose feed quotes `quote` units per 1 `base`
    /// @return invertPrice Whether FLAG_INVERT_PRICE must be set
    /// @return rateLt Decimals multiplier of the lower-address token
    /// @return rateGt Decimals multiplier of the greater-address token
    function orientation(address base, uint8 baseDecimals, address quote, uint8 quoteDecimals)
        internal
        pure
        returns (bool invertPrice, uint64 rateLt, uint64 rateGt)
    {
        require(base != quote, FXSwapInvalidPair());
        require(baseDecimals <= 18, FXSwapUnsupportedDecimals(baseDecimals));
        require(quoteDecimals <= 18, FXSwapUnsupportedDecimals(quoteDecimals));
        uint64 baseRate = uint64(10 ** (18 - baseDecimals));
        uint64 quoteRate = uint64(10 ** (18 - quoteDecimals));
        (invertPrice, rateLt, rateGt) = base < quote ? (false, baseRate, quoteRate) : (true, quoteRate, baseRate);
    }
}

/// @title FXSwapPricing - Token-space wrapper around FXSwapMath
/// @notice Converts raw token amounts to price-adjusted units and back, with maker-favourable rounding:
///         the input balance rounds up, the output balance down, an exact input down, an exact output up,
///         the computed amountOut down and the computed amountIn up.
/// @dev Adjusted units: `amount · rate` for tokenGt; `amount · rate · priceGtPerLt / 1e18` for tokenLt.
library FXSwapPricing {
    /// @notice Curve and fee parameters of a configuration
    function pool(FXSwapArgsBuilder.Args memory args) internal pure returns (FXSwapMath.Pool memory) {
        return FXSwapMath.Pool({
            a: args.a, gamma: args.gamma, midFee: args.midFee, outFee: args.outFee, feeGamma: args.feeGamma
        });
    }

    /// @notice Raw token amount → adjusted units
    function toAdjusted(uint256 amount, uint256 rate, bool isLt, uint256 priceGtPerLt, Math.Rounding rounding)
        internal
        pure
        returns (uint256)
    {
        return isLt ? Math.mulDiv(amount, rate * priceGtPerLt, FXSwapMath.WAD, rounding) : amount * rate;
    }

    /// @notice Adjusted units → raw token amount
    function fromAdjusted(uint256 adjusted, uint256 rate, bool isLt, uint256 priceGtPerLt, Math.Rounding rounding)
        internal
        pure
        returns (uint256)
    {
        return isLt ? Math.mulDiv(adjusted, FXSwapMath.WAD, rate * priceGtPerLt, rounding) : Math.mulDiv(adjusted, 1, rate, rounding);
    }

    /// @notice Price one side of a swap
    /// @param args FXSwap configuration
    /// @param priceGtPerLt Validated canonical price, WAD
    /// @param tokenInIsLt Whether tokenIn has the lower address
    /// @param isExactIn Exact input (returns amountOut) or exact output (returns amountIn)
    /// @param balanceIn Maker balance of tokenIn (raw)
    /// @param balanceOut Maker balance of tokenOut (raw)
    /// @param amount amountIn when isExactIn, otherwise amountOut (raw)
    /// @return computed amountOut when isExactIn, otherwise amountIn (raw)
    /// @return d Invariant D of the pre-trade balances (adjusted units)
    function quote(
        FXSwapArgsBuilder.Args memory args,
        uint256 priceGtPerLt,
        bool tokenInIsLt,
        bool isExactIn,
        uint256 balanceIn,
        uint256 balanceOut,
        uint256 amount
    ) internal pure returns (uint256 computed, uint256 d) {
        (uint256 rateIn, uint256 rateOut) = tokenInIsLt ? (args.rateLt, args.rateGt) : (args.rateGt, args.rateLt);
        uint256 x = toAdjusted(balanceIn, rateIn, tokenInIsLt, priceGtPerLt, Math.Rounding.Ceil);
        uint256 y = toAdjusted(balanceOut, rateOut, !tokenInIsLt, priceGtPerLt, Math.Rounding.Floor);

        if (isExactIn) {
            uint256 dx = toAdjusted(amount, rateIn, tokenInIsLt, priceGtPerLt, Math.Rounding.Floor);
            uint256 dy;
            (dy, d,) = FXSwapMath.getAmountOut(pool(args), x, y, dx);
            computed = fromAdjusted(dy, rateOut, !tokenInIsLt, priceGtPerLt, Math.Rounding.Floor);
        } else {
            uint256 dy = toAdjusted(amount, rateOut, !tokenInIsLt, priceGtPerLt, Math.Rounding.Ceil);
            uint256 dx;
            (dx, d,) = FXSwapMath.getAmountIn(pool(args), x, y, dy);
            computed = fromAdjusted(dx, rateIn, tokenInIsLt, priceGtPerLt, Math.Rounding.Ceil);
        }
    }
}

/// @title FXSwap - Oracle-anchored CryptoSwap curve for floating FX pairs
/// @notice PeggedSwap centres its flat zone on a fixed ratio; FX rates drift, so FXSwap centres it on an oracle price.
///         Every swap reads the feed the program names, rejects a stale or out-of-band answer, rescales both Aqua
///         balances into price-adjusted units (the oracle price is the price scale), computes D fresh from those
///         balances and solves for the other side (FXSwapMath). There is no stored price scale, EMA or profit
///         tracking: the result is a pure function of balances, the oracle answer and the program args.
/// @notice LP protection comes from a CryptoSwap dynamic fee that widens as the pool leaves balance, taken from the
///         output and left with the maker.
contract FXSwap {
    error FXSwapRecomputeDetected();
    error FXSwapOracleInvalidAnswer(int256 answer);
    error FXSwapOracleStale(uint256 updatedAt, uint256 maxStaleness, uint256 nowTs);
    error FXSwapOraclePriceOutOfBand(uint256 price, uint256 minPrice, uint256 maxPrice);

    /// @dev Oracle-anchored CryptoSwap swap for two tokens
    /// @param ctx Swap context; balanceIn/balanceOut are the maker's Aqua balances
    /// @param args FXSwapArgsBuilder layout, 115 bytes
    function _fxSwap2D(Context memory ctx, bytes calldata args) internal view {
        FXSwapArgsBuilder.Args memory config = FXSwapArgsBuilder.parse(args);
        uint256 priceGtPerLt = _fxSwapOraclePrice(config);
        bool tokenInIsLt = ctx.query.tokenIn < ctx.query.tokenOut;

        if (ctx.query.isExactIn) {
            require(ctx.swap.amountOut == 0, FXSwapRecomputeDetected());
            (ctx.swap.amountOut,) = FXSwapPricing.quote(
                config, priceGtPerLt, tokenInIsLt, true, ctx.swap.balanceIn, ctx.swap.balanceOut, ctx.swap.amountIn
            );
        } else {
            require(ctx.swap.amountIn == 0, FXSwapRecomputeDetected());
            (ctx.swap.amountIn,) = FXSwapPricing.quote(
                config, priceGtPerLt, tokenInIsLt, false, ctx.swap.balanceIn, ctx.swap.balanceOut, ctx.swap.amountOut
            );
        }
    }

    /// @dev Read and validate the feed, returning priceGtPerLt in WAD
    function _fxSwapOraclePrice(FXSwapArgsBuilder.Args memory config) internal view returns (uint256 priceGtPerLt) {
        IPriceOracle oracle = IPriceOracle(config.oracle);
        (, int256 answer,, uint256 updatedAt,) = oracle.latestRoundData();
        require(answer > 0, FXSwapOracleInvalidAnswer(answer));
        require(
            updatedAt <= block.timestamp && block.timestamp - updatedAt <= config.maxStaleness,
            FXSwapOracleStale(updatedAt, config.maxStaleness, block.timestamp)
        );

        uint8 oracleDecimals = config.oracleDecimals == 0 ? oracle.decimals() : config.oracleDecimals;
        uint256 feedPrice = uint256(answer);
        if (oracleDecimals < 18) {
            feedPrice *= 10 ** (18 - oracleDecimals);
        } else if (oracleDecimals > 18) {
            feedPrice /= 10 ** (oracleDecimals - 18);
        }
        require(
            feedPrice >= config.minPrice && feedPrice <= config.maxPrice,
            FXSwapOraclePriceOutOfBand(feedPrice, config.minPrice, config.maxPrice)
        );

        priceGtPerLt = config.flags & FXSwapArgsBuilder.FLAG_INVERT_PRICE == 0
            ? feedPrice
            : FXSwapMath.WAD * FXSwapMath.WAD / feedPrice;
        require(priceGtPerLt != 0, FXSwapOraclePriceOutOfBand(feedPrice, config.minPrice, config.maxPrice));
    }
}
