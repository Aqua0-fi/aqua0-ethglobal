// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test, console2 } from "forge-std/Test.sol";

import { FXSwapMath } from "../src/libs/FXSwapMath.sol";

/// @dev External wrappers so library reverts can be asserted and gas measured per call
contract FXSwapMathHarness {
    function computeD(uint256 x, uint256 y, uint256 a, uint256 gamma) external pure returns (uint256) {
        return FXSwapMath.computeD(x, y, a, gamma);
    }

    function computeY(uint256 x, uint256 d, uint256 a, uint256 gamma) external pure returns (uint256) {
        return FXSwapMath.computeY(x, d, a, gamma, 0);
    }

    function residual(uint256 x, uint256 y, uint256 d, uint256 a, uint256 gamma, bool roundUp)
        external
        pure
        returns (int256)
    {
        return FXSwapMath.residual(x, y, d, a, gamma, roundUp);
    }

    function getAmountOut(FXSwapMath.Pool memory pool, uint256 x, uint256 y, uint256 dx)
        external
        pure
        returns (uint256 dy, uint256 d, uint256 fee)
    {
        return FXSwapMath.getAmountOut(pool, x, y, dx);
    }

    function getAmountIn(FXSwapMath.Pool memory pool, uint256 x, uint256 y, uint256 dy)
        external
        pure
        returns (uint256 dx, uint256 d, uint256 fee)
    {
        return FXSwapMath.getAmountIn(pool, x, y, dy);
    }
}

contract FXSwapMathTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant AP = FXSwapMath.A_PRECISION;

    FXSwapMathHarness internal h;

    function setUp() public {
        h = new FXSwapMathHarness();
    }

    function _pool(uint256 aWhole, uint256 gamma, uint256 midFee, uint256 outFee, uint256 feeGamma)
        internal
        pure
        returns (FXSwapMath.Pool memory)
    {
        return FXSwapMath.Pool({ a: aWhole * AP, gamma: gamma, midFee: midFee, outFee: outFee, feeGamma: feeGamma });
    }

    /// @dev D is the smallest integer whose upward-rounded residual is ≤ 0
    function _assertDTight(uint256 x, uint256 y, uint256 a, uint256 gamma, uint256 d) internal view {
        assertLe(h.residual(x, y, d, a, gamma, true), 0, "D not on the safe side");
        if (d > 0 && d - 1 >= 2 * _sqrt(x * y) && a != 0) {
            assertGt(h.residual(x, y, d - 1, a, gamma, true), 0, "D not tight");
        }
    }

    /// @dev y is the smallest integer whose downward-rounded residual is ≥ 0
    function _assertYTight(uint256 x, uint256 d, uint256 a, uint256 gamma, uint256 y) internal view {
        assertGe(h.residual(x, y, d, a, gamma, false), 0, "y not on the safe side");
        uint256 lo = d > x ? d - x : 0;
        if (y > lo) assertLt(h.residual(x, y - 1, d, a, gamma, false), 0, "y not tight");
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _sqrt(uint256 v) internal pure returns (uint256 r) {
        if (v == 0) return 0;
        r = v;
        uint256 k = (v >> 1) + 1;
        while (k < r) {
            r = k;
            k = (v / k + k) >> 1;
        }
    }

    // ─────────────────────────── curve shape ───────────────────────────

    function test_Balanced_KEqualsA_AndDEqualsSum() public view {
        uint256[4] memory as_ = [uint256(1), 10, 100, 5000];
        uint256[3] memory gammas = [uint256(1e12), 1e15, 1e17];
        for (uint256 i; i < as_.length; ++i) {
            for (uint256 j; j < gammas.length; ++j) {
                uint256 x = 1_000_000e18;
                uint256 d = h.computeD(x, x, as_[i] * AP, gammas[j]);
                assertEq(d, 2 * x, "balanced D == x + y");
                uint256 k0 = FXSwapMath.k0(x, x, d);
                assertEq(k0, WAD, "balanced K0 == 1");
                assertEq(FXSwapMath.kFromK0(k0, as_[i] * AP, gammas[j]), as_[i] * WAD, "balanced K == A");
            }
        }
    }

    function test_KFallsAwayFromBalance() public pure {
        uint256 a = 100 * AP;
        uint256 gamma = 1e15;
        uint256 prev = type(uint256).max;
        for (uint256 k0 = WAD; k0 >= 0.5e18; k0 -= 0.01e18) {
            uint256 k = FXSwapMath.kFromK0(k0, a, gamma);
            assertLt(k, prev, "K decreasing as K0 falls");
            prev = k;
        }
        assertLt(prev, WAD / 1000, "K -> 0 (constant product) far from balance");
    }

    function test_ConstantProductLimit_AZero() public view {
        uint256 x = 3_000_000e18;
        uint256 y = 1_000_000e18;
        uint256 d = h.computeD(x, y, 0, 1e16);
        assertGe(d * d / 4, x * y, "D^2/4 >= xy");
        assertLt((d - 1) * (d - 1) / 4, x * y, "D is the ceil of 2 sqrt(xy)");

        uint256 xNew = x + 500_000e18;
        uint256 yNew = h.computeY(xNew, d, 0, 1e16);
        assertGe(xNew * yNew, (d * d + 3) / 4, "x'y' >= D^2/4");
        assertLt(xNew * (yNew - 1), (d * d + 3) / 4, "y' tight");
    }

    function test_ConstantSumLimit_LargeA() public view {
        FXSwapMath.Pool memory pool = _pool(1_000_000, WAD, 0, 0, 0);
        uint256 x = 1_100_000e18;
        uint256 y = 900_000e18;
        uint256 d = h.computeD(x, y, pool.a, pool.gamma);
        assertApproxEqRel(d, x + y, 1e12, "D ~ x + y");
        (uint256 dy,,) = h.getAmountOut(pool, x, y, 10_000e18);
        assertApproxEqRel(dy, 10_000e18, 1e14, "near 1:1 price");
    }

    function test_SpotPriceAtBalanceIsOne() public view {
        FXSwapMath.Pool memory pool = _pool(100, 1e15, 0, 0, 0);
        (uint256 dy,,) = h.getAmountOut(pool, 1_000_000e18, 1_000_000e18, 1e18);
        assertApproxEqRel(dy, 1e18, 1e12, "marginal price 1 at balance");
    }

    function test_ImbalanceWorsensPrice() public view {
        FXSwapMath.Pool memory pool = _pool(100, 1e15, 0, 0, 0);
        (uint256 balanced,,) = h.getAmountOut(pool, 1_000_000e18, 1_000_000e18, 1_000e18);
        (uint256 scarceOut,,) = h.getAmountOut(pool, 1_500_000e18, 500_000e18, 1_000e18);
        (uint256 plentyOut,,) = h.getAmountOut(pool, 500_000e18, 1_500_000e18, 1_000e18);
        assertLt(scarceOut, balanced, "buying the scarce side costs more");
        assertGt(plentyOut, balanced, "buying the plentiful side pays more");
    }

    // ─────────────────────────── convergence ───────────────────────────

    function test_ConvergenceGrid() public view {
        uint256[5] memory as_ = [uint256(1), 10, 100, 10_000, 1_000_000];
        uint256[4] memory gammas = [uint256(1e10), 1e13, 1e16, 1e18];
        uint256[4] memory ratios = [uint256(1), 3, 100, 5000];
        uint256[3] memory sizes = [uint256(1e12), 1e24, 1e33];
        for (uint256 i; i < as_.length; ++i) {
            for (uint256 j; j < gammas.length; ++j) {
                for (uint256 r; r < ratios.length; ++r) {
                    for (uint256 s; s < sizes.length; ++s) {
                        uint256 a = as_[i] * AP;
                        uint256 x = sizes[s];
                        uint256 y = x / ratios[r];
                        uint256 d = h.computeD(x, y, a, gammas[j]);
                        _assertDTight(x, y, a, gammas[j], d);
                        uint256 xNew = x + x / 7;
                        if (xNew <= FXSwapMath.MAX_BALANCE) {
                            _assertYTight(xNew, d, a, gammas[j], h.computeY(xNew, d, a, gammas[j]));
                        }
                        _assertYTight(y, d, a, gammas[j], h.computeY(y, d, a, gammas[j]));
                    }
                }
            }
        }
    }

    function testFuzz_ComputeD_TightAndSafe(uint256 x, uint256 y, uint256 aWhole, uint256 gamma) public view {
        x = bound(x, 1e6, FXSwapMath.MAX_BALANCE);
        y = bound(y, x / 1000 + 1, FXSwapMath.MAX_BALANCE);
        uint256 a = bound(aWhole, 0, FXSwapMath.MAX_A);
        gamma = bound(gamma, FXSwapMath.MIN_GAMMA, FXSwapMath.MAX_GAMMA);
        uint256 d = h.computeD(x, y, a, gamma);
        assertGe(d, 2 * _sqrt(x * y), "D >= constant-product D");
        assertLe(d, x + y, "D <= constant-sum D");
        _assertDTight(x, y, a, gamma, d);
    }

    function testFuzz_ComputeY_TightAndSafe(uint256 x, uint256 y, uint256 aWhole, uint256 gamma, uint256 dx)
        public
        view
    {
        x = bound(x, 1e6, FXSwapMath.MAX_BALANCE / 2);
        y = bound(y, x / 100 + 1, _min(x * 100, FXSwapMath.MAX_BALANCE / 2));
        uint256 a = bound(aWhole, 1, FXSwapMath.MAX_A);
        gamma = bound(gamma, FXSwapMath.MIN_GAMMA, FXSwapMath.MAX_GAMMA);
        dx = bound(dx, 0, x);
        uint256 d = h.computeD(x, y, a, gamma);
        _assertYTight(x + dx, d, a, gamma, h.computeY(x + dx, d, a, gamma));
    }

    // ─────────────────────────── swap properties ───────────────────────────

    function testFuzz_Symmetry(uint256 x, uint256 y, uint256 dx) public view {
        FXSwapMath.Pool memory pool = _pool(250, 3e14, 0, 0, 0);
        x = bound(x, 1e18, 1e30);
        y = bound(y, x / 50 + 1, _min(x * 50, 1e30));
        dx = bound(dx, 1, x / 2);
        assertEq(h.computeD(x, y, pool.a, pool.gamma), h.computeD(y, x, pool.a, pool.gamma), "D symmetric");
        (uint256 dyA,,) = h.getAmountOut(pool, x, y, dx);
        // Mirror: the same trade with the balances listed the other way round through computeY directly
        uint256 d = h.computeD(y, x, pool.a, pool.gamma);
        uint256 yNew = h.computeY(x + dx, d, pool.a, pool.gamma);
        assertEq(dyA, yNew >= y ? 0 : y - yNew, "mirror trade identical");
    }

    function testFuzz_MonotoneInAmount(uint256 dx1, uint256 dx2) public view {
        FXSwapMath.Pool memory pool = _pool(100, 1e15, 5e14, 3e16, 2e15);
        uint256 x = 800_000e18;
        uint256 y = 1_200_000e18;
        dx1 = bound(dx1, 1e12, 400_000e18);
        dx2 = bound(dx2, dx1, 400_000e18);
        (uint256 dy1,,) = h.getAmountOut(pool, x, y, dx1);
        (uint256 dy2,,) = h.getAmountOut(pool, x, y, dx2);
        assertGe(dy2, dy1, "more in never gives less out");
        // Each result may sit up to ~2 units under the exact value (floor + fee ceil), which matters only at dust
        assertLe(dy2 * dx1, (dy1 + 2) * dx2, "average price never improves with size");
    }

    function testFuzz_NoProfitableRoundTrip(uint256 x, uint256 y, uint256 dx, uint256 aWhole, uint256 gamma) public view {
        FXSwapMath.Pool memory pool = _pool(bound(aWhole, 0, 100_000), bound(gamma, 1e12, 1e18), 0, 0, 0);
        x = bound(x, 1e15, 1e30);
        y = bound(y, x / 100 + 1, _min(x * 100, 1e30));
        // Keep the trade within what the output side can supply (near constant sum it trades ~1:1 until drained)
        dx = bound(dx, 1, _min(x, y / 2));
        (uint256 dy,,) = h.getAmountOut(pool, x, y, dx);
        if (dy == 0) return;
        if ((y - dy) * FXSwapMath.MIN_BALANCE_FRACTION < h.computeD(x, y, pool.a, pool.gamma)) return;
        (uint256 back,,) = h.getAmountOut(pool, y - dy, x + dx, dy);
        assertLe(back, dx, "round trip never returns more than was put in");
    }

    function testFuzz_ExactOutNeverCheaperThanExactIn(uint256 dy, uint256 feeGamma, uint256 outFee) public view {
        uint256 midFee = 3e14;
        FXSwapMath.Pool memory pool =
            _pool(200, 5e14, midFee, bound(outFee, midFee, 5e16), bound(feeGamma, 1e12, WAD));
        uint256 x = 700_000e18;
        uint256 y = 1_300_000e18;
        dy = bound(dy, 1, 600_000e18);
        (uint256 dx,,) = h.getAmountIn(pool, x, y, dy);
        (uint256 received,,) = h.getAmountOut(pool, x, y, dx);
        assertGe(received, dy, "paying the exact-out input via exact-in buys at least dy");
    }

    function test_ExactOutWithFlatFeeInvertsExactIn() public view {
        FXSwapMath.Pool memory pool = _pool(100, 1e15, 1e15, 1e15, 0);
        uint256 x = 1_000_000e18;
        uint256 y = 1_000_000e18;
        (uint256 dy,,) = h.getAmountOut(pool, x, y, 5_000e18);
        (uint256 dx,,) = h.getAmountIn(pool, x, y, dy);
        assertGe(dx, 5_000e18 - 2e6, "exact-out input matches exact-in within rounding");
        assertLe(dx, 5_000e18 + 2e6, "exact-out input matches exact-in within rounding");
    }

    // ─────────────────────────── fee ───────────────────────────

    function test_DynamicFee_FlatWhenMidEqualsOut() public pure {
        for (uint256 k0; k0 <= WAD; k0 += 0.125e18) {
            assertEq(FXSwapMath.dynamicFee(k0, 3e15, 3e15, 1e16), 3e15);
        }
    }

    function test_DynamicFee_WidensWithImbalance() public pure {
        uint256 midFee = 5e14;
        uint256 outFee = 3e16;
        uint256 feeGamma = 2e15;
        assertEq(FXSwapMath.dynamicFee(WAD, midFee, outFee, feeGamma), midFee, "mid fee at balance");
        uint256 prev = midFee;
        for (uint256 k0 = WAD - 1e15; k0 >= 0.5e18; k0 -= 0.05e18) {
            uint256 fee = FXSwapMath.dynamicFee(k0, midFee, outFee, feeGamma);
            assertGe(fee, prev, "fee grows as K0 falls");
            assertLe(fee, outFee, "fee capped by out fee");
            prev = fee;
        }
        assertApproxEqRel(FXSwapMath.dynamicFee(0, midFee, outFee, feeGamma), outFee, 0.1e18, "~out fee far away");
    }

    function test_FeeLowersOutput() public view {
        uint256 x = 900_000e18;
        uint256 y = 1_100_000e18;
        (uint256 noFee,,) = h.getAmountOut(_pool(100, 1e15, 0, 0, 0), x, y, 50_000e18);
        (uint256 flat,, uint256 flatRate) = h.getAmountOut(_pool(100, 1e15, 3e15, 3e15, 0), x, y, 50_000e18);
        (uint256 dyn,, uint256 dynRate) = h.getAmountOut(_pool(100, 1e15, 3e15, 3e16, 1e15), x, y, 50_000e18);
        assertEq(flatRate, 3e15);
        assertEq(flat, noFee - (noFee * 3e15 + WAD - 1) / WAD, "flat fee applied to gross output");
        assertGt(dynRate, 3e15, "dynamic fee above mid off balance");
        assertLt(dyn, flat, "dynamic fee lowers output further");
    }

    // ─────────────────────────── domain ───────────────────────────

    function test_Reverts_ZeroBalance() public {
        vm.expectRevert(FXSwapMath.FXSwapMathZeroBalance.selector);
        h.computeD(0, 1e18, 100 * AP, 1e15);
    }

    function test_Reverts_BalanceTooLarge() public {
        vm.expectRevert(FXSwapMath.FXSwapMathBalanceTooLarge.selector);
        h.computeD(FXSwapMath.MAX_BALANCE + 1, 1e18, 100 * AP, 1e15);
    }

    function test_Reverts_DrainBelowMinimumFraction() public {
        FXSwapMath.Pool memory pool = _pool(100, 1e15, 0, 0, 0);
        // Pushing a huge input would leave the output side below D / 1e4
        vm.expectRevert(FXSwapMath.FXSwapMathUnsafeBalance.selector);
        h.getAmountOut(pool, 1_000e18, 1_000e18, 10_000_000e18);
    }

    function test_Reverts_ExactOutAboveBalance() public {
        FXSwapMath.Pool memory pool = _pool(100, 1e15, 0, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(FXSwapMath.FXSwapMathInsufficientBalance.selector, 1_000e18, 1_000e18));
        h.getAmountIn(pool, 1_000e18, 1_000e18, 1_000e18);
    }

    function test_ExtremeBalance_StillSolves() public view {
        FXSwapMath.Pool memory pool = _pool(1000, 1e14, 5e14, 2e16, 1e15);
        (uint256 dy, uint256 d,) = h.getAmountOut(pool, 9_000e18, 1e18, 1e17);
        assertGt(dy, 0);
        assertLt(dy, 1e17 / 100, "deep in constant-product territory the scarce side is expensive");
        _assertDTight(9_000e18, 1e18, pool.a, pool.gamma, d);
    }

    // ─────────────────────────── gas ───────────────────────────

    function test_Gas_GetAmountOut() public view {
        FXSwapMath.Pool memory pool = _pool(100, 1e15, 5e14, 3e16, 2e15);
        uint256 g = gasleft();
        h.getAmountOut(pool, 1_000_000e18, 1_050_000e18, 25_000e18);
        uint256 usedIn = g - gasleft();
        g = gasleft();
        h.getAmountIn(pool, 1_000_000e18, 1_050_000e18, 25_000e18);
        uint256 usedOut = g - gasleft();
        console2.log("gas getAmountOut (A=100, near balance, 2.5% trade):", usedIn);
        console2.log("gas getAmountIn  (dynamic fee, 3 solves):", usedOut);
    }
}
