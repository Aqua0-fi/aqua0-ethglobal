// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { ForexCurveMath } from "../src/libs/ForexCurveMath.sol";
import { ForexCurveArgsBuilder } from "../src/instructions/ForexCurve.sol";

import { ForexCurveMathHarness } from "./ForexCurveVectors.t.sol";

/// @title ForexCurveInvariantsTest
/// @notice Fuzzed properties of the forex curve from the reference's own checks (`fxforex_math.t2_invariants`,
///         `t3_inverse`): utility g − ψ never drops, inside the band the price is the oracle (o = −a), round trips,
///         split trades and closed sequences never leave the taker a gain, and exact in / exact out invert each other.
/// @dev Parameter sets are the reference's (with MAX lowered to a valid value where α = 0.9) plus a fuzzed valid set with
///      α up to 1 and MAX within 1% of ForexCurveArgsBuilder.maxFeeLimit(α).
///      States are log-uniform in price (0.01 .. 1e4 quote per local) and book size (1e3 .. 1e9 quote units), with the
///      local share inside the halts; trades span 1e-7 of the book up to α of it. ε = 0, so only the curve and the
///      rounding are under test. Tolerances are the rounding of integer states: a local amount converts to numeraire
///      with at most one wei of loss, worth p / 1e18 quote wei per local wei.
contract ForexCurveInvariantsTest is Test {
    ForexCurveMathHarness internal h;

    struct State {
        ForexCurveMath.Params params;
        uint256 p;
        uint256 quoteBalance;
        uint256 localBalance;
        uint256 x;
        uint256 y;
    }

    function setUp() public {
        h = new ForexCurveMathHarness();
    }

    // ═══════════════════════════════ generators ═══════════════════════════════

    /// @dev Valid parameter sets (all pass ForexCurveArgsBuilder.validate), ε = 0
    function _set(uint256 seed) internal pure returns (ForexCurveMath.Params memory) {
        uint256 i = seed % 5;
        if (i == 0) return ForexCurveMath.Params(0.5e18, 0.35e18, 0.5e18, 0.25e18, 1e18, 0); // DFX production
        if (i == 1) return ForexCurveMath.Params(0.5e18, 0.15e18, 0.5e18, 0.25e18, 0.3e18, 0); // recommended
        if (i == 2) return ForexCurveMath.Params(0.9e18, 0, 0.15e18, 0.05e18, 0.3e18, 0); // no flat zone
        if (i == 3) return ForexCurveMath.Params(0.5e18, 0.35e18, 3e18, 0.25e18, 0.3e18, 0); // capped fee regime
        return _nearFeeBound(uint256(keccak256(abi.encode(seed))));
    }

    /// @dev α in [0.5, 1) (a third of the time within 0.01 of 1), MAX within 1% of its limit, any β < α, δ, λ
    function _nearFeeBound(uint256 r) internal pure returns (ForexCurveMath.Params memory p) {
        p.alpha = r % 3 == 0 ? 1e18 - 1 - (r >> 8) % 1e16 : 0.5e18 + (r >> 8) % 0.5e18;
        uint256 limit = ForexCurveArgsBuilder.maxFeeLimit(p.alpha);
        p.maxFee = limit - (r >> 72) % (limit / 100 + 1);
        p.beta = p.alpha * ((r >> 136) % 4) / 10;
        p.delta = (r >> 144) % type(uint64).max;
        p.lambda = (r >> 208) % (1e18 + 1);
    }

    /// @dev base · 10^(k/10), k ∈ [0, 10·decades)
    function _logUniform(uint256 seed, uint256 base, uint256 decades) internal pure returns (uint256) {
        uint8[10] memory mantissa = [10, 12, 15, 20, 25, 32, 40, 50, 63, 79];
        uint256 k = seed % (decades * 10);
        return base * 10 ** (k / 10) * mantissa[k % 10] / 10;
    }

    function _state(uint256 setSeed, uint256 pSeed, uint256 vSeed, uint256 shareSeed, bool insideBand)
        internal
        pure
        returns (State memory st)
    {
        st.params = _set(setSeed);
        st.p = _logUniform(pSeed, 1e16, 6);
        uint256 v = _logUniform(vSeed, 1e21, 6);
        uint256 width = insideBand ? st.params.beta : st.params.alpha;
        uint256 share = width == 0 ? 0.5e18 : bound(shareSeed, (1e18 - width) / 2 * 1001 / 1000, (1e18 + width) / 2 * 999 / 1000);
        st.quoteBalance = v * (1e18 - share) / 1e18;
        st.localBalance = v * share / st.p;
        st.x = st.quoteBalance;
        st.y = st.p * st.localBalance / 1e18;
    }

    /// @dev book · cap · 10^(−k/10), k ∈ [0, 70)
    function _size(uint256 book, uint256 cap, uint256 seed) internal pure returns (uint256) {
        uint8[10] memory mantissa = [10, 12, 15, 20, 25, 32, 40, 50, 63, 79];
        uint256 k = seed % 70;
        return book * cap / 1e18 * 10 / mantissa[k % 10] / 10 ** (k / 10);
    }

    function _inBand(uint256 beta, int256 a, int256 b) internal pure returns (bool) {
        int256 g = a + b;
        int256 lo = g * int256(1e18 - beta);
        int256 hi = g * int256(1e18 + beta);
        return 2e18 * a >= lo && 2e18 * a <= hi && 2e18 * b >= lo && 2e18 * b <= hi;
    }

    // ═══════════════════════════════ properties ═══════════════════════════════

    /// forge-config: default.fuzz.runs = 1024
    function testFuzz_ValidSetsPassValidation(uint256 setSeed) public pure {
        ForexCurveMath.Params memory p = _set(setSeed);
        ForexCurveArgsBuilder.Args memory args;
        (args.oracle, args.maxStaleness, args.minPrice, args.maxPrice, args.rateLt, args.rateGt) =
            (address(1), 1, 1, 1, 1, 1);
        (args.alpha, args.beta, args.delta, args.maxFee, args.lambda) =
            (uint64(p.alpha), uint64(p.beta), uint64(p.delta), uint64(p.maxFee), uint64(p.lambda));
        ForexCurveArgsBuilder.validate(args);
    }

    /// @dev A trade that moves at least the book value g (exact in) or takes it (exact out) never clears, from any
    ///      state, including states already past the halts, with any valid parameters
    /// forge-config: default.fuzz.runs = 2048
    function testFuzz_BookSizedTradeNeverSucceeds(
        uint256 setSeed,
        uint256 vSeed,
        uint256 shareSeed,
        uint256 sizeSeed,
        bool knownIsQuote,
        bool intoPool
    ) public view {
        ForexCurveMath.Params memory params = _set(setSeed);
        uint256 v = _logUniform(vSeed, 1e21, 6);
        uint256 share = bound(shareSeed, 1e12, 1e18 - 1e12);
        (uint256 x, uint256 y) = (v * (1e18 - share) / 1e18, v * share / 1e18);
        uint256 size = (x + y) + (x + y) * (sizeSeed % 2e18) / 1e18;
        int256 a = intoPool ? int256(size) : -int256(size);
        try h.trade(params, x, y, knownIsQuote, a) returns (int256) {
            revert("a trade of the book's size cleared");
        } catch { }
    }

    /// @dev At α = 1/2 and MAX just below 1/2 the residual slope 1 − dψ/ds gets close to zero (quadratic fees near the cap,
    ///      β ≈ 0, δ large). Small trades well inside the halts must still solve.
    /// forge-config: default.fuzz.runs = 2048
    function testFuzz_SmallTradesAtTheFeeBoundSolve(
        uint256 pSeed,
        uint256 vSeed,
        uint256 shareSeed,
        uint256 paramSeed,
        uint256 sizeSeed,
        bool knownIsQuote,
        bool intoPool
    ) public view {
        ForexCurveMath.Params memory params;
        params.alpha = 0.5e18;
        params.maxFee = 0.5e18 - 1 - paramSeed % 0.05e18;
        params.beta = (paramSeed >> 64) % 0.05e18;
        params.delta = 10e18 + (paramSeed >> 128) % (type(uint64).max - 10e18);
        params.lambda = (paramSeed >> 192) % (1e18 + 1);
        uint256 p = _logUniform(pSeed, 1e16, 6);
        uint256 v = _logUniform(vSeed, 1e21, 6);
        uint256 share = bound(shareSeed, 0.45e18, 0.55e18);
        uint256 localBalance = v * share / p;
        (uint256 x, uint256 y) = (v * (1e18 - share) / 1e18, p * localBalance / 1e18);
        int256 a = int256(_size(x + y, 1e15, sizeSeed));
        if (!intoPool) a = -a;
        h.trade(params, x, y, knownIsQuote, a);
    }

    /// forge-config: default.fuzz.runs = 1024
    function testFuzz_UtilityNeverDrops(
        uint256 setSeed,
        uint256 pSeed,
        uint256 vSeed,
        uint256 shareSeed,
        uint256 sizeSeed,
        bool knownIsQuote,
        bool intoPool
    ) public view {
        State memory st = _state(setSeed, pSeed, vSeed, shareSeed, false);
        int256 a = int256(_size(st.x + st.y, st.params.alpha, sizeSeed));
        if (!intoPool) a = -a;
        try h.trade(st.params, st.x, st.y, knownIsQuote, a) returns (int256 o) {
            (int256 nx, int256 ny) =
                knownIsQuote ? (int256(st.x) + a, int256(st.y) + o) : (int256(st.x) + o, int256(st.y) + a);
            int256 before = int256(st.x + st.y) - h.psi(st.params, st.x, st.y);
            int256 afterTrade = nx + ny - h.psi(st.params, uint256(nx), uint256(ny));
            assertGe(afterTrade, before, "utility g - psi dropped");
        } catch { }
    }

    /// forge-config: default.fuzz.runs = 1024
    function testFuzz_InsideBandPriceIsOracle(
        uint256 setSeed,
        uint256 pSeed,
        uint256 vSeed,
        uint256 shareSeed,
        uint256 sizeSeed,
        bool knownIsQuote,
        bool intoPool
    ) public view {
        State memory st = _state(setSeed, pSeed, vSeed, shareSeed, true);
        if (st.params.beta == 0) return;
        int256 a = int256(_size(st.x + st.y, st.params.beta, sizeSeed));
        if (!intoPool) a = -a;
        (int256 nx, int256 ny) =
            knownIsQuote ? (int256(st.x) + a, int256(st.y) - a) : (int256(st.x) - a, int256(st.y) + a);
        if (!_inBand(st.params.beta, int256(st.x), int256(st.y)) || !_inBand(st.params.beta, nx, ny)) return;
        assertEq(h.trade(st.params, st.x, st.y, knownIsQuote, a), -a, "inside the band o = -a");
    }

    /// forge-config: default.fuzz.runs = 1024
    function testFuzz_RoundTripNoGain(
        uint256 setSeed,
        uint256 pSeed,
        uint256 vSeed,
        uint256 shareSeed,
        uint256 sizeSeed,
        bool buyLocalFirst
    ) public view {
        State memory st = _state(setSeed, pSeed, vSeed, shareSeed, false);
        if (buyLocalFirst) {
            uint256 q = _size(st.x + st.y, 0.5e18, sizeSeed);
            try h.quote(st.params, st.p, st.quoteBalance, st.localBalance, 0, true, true, q) returns (uint256, uint256 d) {
                try h.quote(st.params, st.p, st.quoteBalance + q, st.localBalance - d, 0, false, true, d) returns (
                    uint256, uint256 qBack
                ) {
                    assertLe(qBack, q, "buy local then sell it back");
                } catch { }
            } catch { }
        } else {
            uint256 d = _size(st.localBalance, 0.5e18, sizeSeed);
            try h.quote(st.params, st.p, st.quoteBalance, st.localBalance, 0, false, true, d) returns (uint256, uint256 q) {
                try h.quote(st.params, st.p, st.quoteBalance - q, st.localBalance + d, 0, true, true, q) returns (
                    uint256, uint256 dBack
                ) {
                    assertLe(dBack, d, "sell local then buy it back");
                } catch { }
            } catch { }
        }
    }

    /// forge-config: default.fuzz.runs = 1024
    function testFuzz_SplitNoGain(
        uint256 setSeed,
        uint256 pSeed,
        uint256 vSeed,
        uint256 shareSeed,
        uint256 sizeSeed,
        uint8 partsSeed
    ) public view {
        State memory st = _state(setSeed, pSeed, vSeed, shareSeed, false);
        uint256 q = _size(st.x + st.y, 0.5e18, sizeSeed);
        uint256 parts = 2 + partsSeed % 7;
        uint256 single;
        try h.quote(st.params, st.p, st.quoteBalance, st.localBalance, 0, true, true, q) returns (uint256, uint256 d) {
            single = d;
        } catch {
            return;
        }
        (uint256 u, uint256 b, uint256 total) = (st.quoteBalance, st.localBalance, 0);
        for (uint256 i; i < parts; ++i) {
            uint256 part = i + 1 == parts ? q - q / parts * (parts - 1) : q / parts;
            try h.quote(st.params, st.p, u, b, 0, true, true, part) returns (uint256, uint256 d) {
                (u, b, total) = (u + part, b - d, total + d);
            } catch {
                return;
            }
        }
        // one wei of numeraire rounding per step is worth 1e18 / p local wei
        assertLe(total, single + parts * (1e18 / st.p + 2), "split buys never beat one buy");
    }

    /// forge-config: default.fuzz.runs = 512
    function testFuzz_ClosedSequenceNoGain(
        uint256 setSeed,
        uint256 pSeed,
        uint256 vSeed,
        uint256 shareSeed,
        uint256 sequenceSeed
    ) public view {
        State memory st = _state(setSeed, pSeed, vSeed, shareSeed, false);
        (uint256 u, uint256 b) = (st.quoteBalance, st.localBalance);
        int256 position; // local held by the taker
        int256 quotePnl; // quote received minus quote paid
        uint256 steps = 2 + sequenceSeed % 5;
        for (uint256 i; i < steps; ++i) {
            uint256 r = uint256(keccak256(abi.encode(sequenceSeed, i)));
            if (r % 2 == 0) {
                uint256 q = _size(st.p * b / 1e18, 0.1e18, r >> 8) / 1000 + 1;
                try h.quote(st.params, st.p, u, b, 0, true, true, q) returns (uint256, uint256 d) {
                    (u, b, position, quotePnl) = (u + q, b - d, position + int256(d), quotePnl - int256(q));
                } catch {
                    return;
                }
            } else {
                uint256 d = _size(b, 0.1e18, r >> 8) / 1000 + 1;
                try h.quote(st.params, st.p, u, b, 0, false, true, d) returns (uint256, uint256 q) {
                    (u, b, position, quotePnl) = (u - q, b + d, position - int256(d), quotePnl + int256(q));
                } catch {
                    return;
                }
            }
        }
        if (position > 0) {
            try h.quote(st.params, st.p, u, b, 0, false, true, uint256(position)) returns (uint256, uint256 q) {
                quotePnl += int256(q);
            } catch {
                return;
            }
        } else if (position < 0) {
            try h.quote(st.params, st.p, u, b, 0, true, false, uint256(-position)) returns (uint256 q, uint256) {
                quotePnl -= int256(q);
            } catch {
                return;
            }
        }
        assertLe(quotePnl, int256(steps + 1) * 2, "closed sequence left the taker a gain");
    }

    /// forge-config: default.fuzz.runs = 1024
    function testFuzz_ExactInExactOutInverse(
        uint256 setSeed,
        uint256 pSeed,
        uint256 vSeed,
        uint256 shareSeed,
        uint256 sizeSeed,
        bool localOut
    ) public view {
        State memory st = _state(setSeed, pSeed, vSeed, shareSeed, false);
        uint256 amountIn = localOut ? _size(st.x, 0.3e18, sizeSeed) : _size(st.localBalance, 0.3e18, sizeSeed);
        if (amountIn == 0) return;
        uint256 out;
        try h.quote(st.params, st.p, st.quoteBalance, st.localBalance, 0, localOut, true, amountIn) returns (
            uint256, uint256 o
        ) {
            out = o;
        } catch {
            return;
        }
        if (out == 0) return;
        try h.quote(st.params, st.p, st.quoteBalance, st.localBalance, 0, localOut, false, out) returns (uint256 back, uint256) {
            // exact out of the floored output never needs more than the exact input (up to the solver's wei)
            assertLe(back, amountIn + 16, "exact out charges more than the exact input");
            // one wei of output is worth p / 1e18 (or 1e18 / p) wei of input; plus 1e-12 relative
            uint256 unit = localOut ? st.p / 1e18 : 1e18 / st.p;
            assertGe(back + 2 * unit + amountIn / 1e12 + 16, amountIn, "exact out undercuts the exact input");
        } catch {
            revert("exact out of a quoted output reverted");
        }
    }
}
