// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title FXSwapMath - Stateless two-token CryptoSwap invariant for oracle-anchored FX pairs
/// @notice Pure math core of the FXSwap instruction. It knows nothing about tokens, decimals or oracles: every
///         balance and amount is already in *price-adjusted units*, where one unit of either token is worth the
///         same at the oracle price (see FXSwapPricing for the conversion).
/// @notice Invariant for n = 2 (CryptoSwap whitepaper):
///             K·D·(x + y) + x·y = K·D² + (D/2)²
///             K₀ = 4·x·y / D²
///             K  = A·K₀·γ² / (γ + 1 − K₀)²
///         A balanced pool (x = y) has K₀ = 1 and K = A: near constant-sum, flat price. As the pool leaves balance
///         K₀ falls, the denominator grows and K → 0: constant product. K → ∞ gives x + y = D, K → 0 gives x·y = (D/2)².
///         Dynamic fee: fee = midFee·g + outFee·(1 − g), g = feeGamma / (feeGamma + 1 − K₀).
/// @dev Fixed-point conventions:
///      - balances, amounts and D: integers in adjusted units (token amounts normalised to 18 decimals), each
///        balance ≤ MAX_BALANCE
///      - γ, midFee, outFee, feeGamma and the K₀ / K exposed by k0 / kFromK0: WAD (1e18 = 1.0)
///      - A: whitepaper A (the A in the formula above) scaled by A_PRECISION, so A = 100 is encoded as 1_000_000.
///        Deployed Curve pools fold n^n into their A parameter (ANN = A·n^n), so a Curve pool with A = X has A = 4·X here.
///      - internally K₀ and K are carried at SCALE = 1e36: at WAD, K₀ is constant across ~D/1e18 balance units, the
///        residual turns piecewise flat near the root and Newton stalls
/// @dev Numerics: D and the solved balance have no closed form. Both solves bracket the root with the analytic
///      constant-sum / constant-product limits and run Newton-Raphson guarded by the bracket (bisection fallback,
///      capped iterations, revert on non-convergence) until the bracket closes to one unit. The residual is evaluated
///      with directed rounding, so each solve returns the maker-favourable side of the root:
///      - computeD rounds D up: a larger D can only shrink what a taker receives or grow what it pays
///      - computeY rounds the solved balance up: larger post-trade balance ⇒ smaller amountOut / larger amountIn
///      - fees round up
library FXSwapMath {
    /// @dev 1.0 in WAD fixed point
    uint256 internal constant WAD = 1e18;
    /// @dev Internal precision of K₀ and K
    uint256 internal constant SCALE = 1e36;
    /// @dev A is stored as A * A_PRECISION
    uint256 internal constant A_PRECISION = 1e4;
    /// @dev Maximum A (whitepaper units): 1,000,000
    uint256 internal constant MAX_A = 1_000_000 * A_PRECISION;
    /// @dev γ bounds in WAD: [1e-8, 1.0]
    uint256 internal constant MIN_GAMMA = 1e10;
    uint256 internal constant MAX_GAMMA = WAD;
    /// @dev Maximum fee in WAD: 50%
    uint256 internal constant MAX_FEE = WAD / 2;
    /// @dev Largest supported adjusted balance (1e15 whole 18-decimal units). Keeps every intermediate in range.
    uint256 internal constant MAX_BALANCE = 1e33;
    /// @dev A balance a solve starts from, or a post-trade balance, must be at least D / MIN_BALANCE_FRACTION.
    ///      Bounds the numerical domain and stops a single trade from draining a side to dust.
    uint256 internal constant MIN_BALANCE_FRACTION = 1e4;
    /// @dev Iteration cap for each Newton solve
    uint256 internal constant MAX_ITERATIONS = 128;

    uint256 private constant _SCALE_PER_WAD = SCALE / WAD;

    error FXSwapMathZeroBalance();
    error FXSwapMathBalanceTooLarge();
    error FXSwapMathUnsafeBalance();
    error FXSwapMathInsufficientBalance(uint256 balance, uint256 amount);
    error FXSwapMathDidNotConverge();

    /// @notice Curve and fee parameters
    /// @param a A * A_PRECISION
    /// @param gamma γ in WAD
    /// @param midFee Fee at balance (K₀ = 1), WAD
    /// @param outFee Fee far from balance (K₀ → 0), WAD; must be ≥ midFee
    /// @param feeGamma Fee transition width, WAD
    struct Pool {
        uint256 a;
        uint256 gamma;
        uint256 midFee;
        uint256 outFee;
        uint256 feeGamma;
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
    //  Swap entry points (adjusted units)
    // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Output for an exact input
    /// @dev The curve releases `gross = y − y'`; the fee is evaluated at the post-trade balances (x + dx, y') and
    ///      taken from the output, so the taker receives `gross − ⌈gross · fee⌉`.
    /// @param pool Curve and fee parameters
    /// @param x Balance of the input token
    /// @param y Balance of the output token
    /// @param dx Input amount
    /// @return dy Output after fee, rounded down
    /// @return d Invariant D of the pre-trade balances, rounded up
    /// @return fee Fee rate charged, WAD
    function getAmountOut(Pool memory pool, uint256 x, uint256 y, uint256 dx)
        internal
        pure
        returns (uint256 dy, uint256 d, uint256 fee)
    {
        d = computeD(x, y, pool.a, pool.gamma);
        if (dx == 0) return (0, d, 0);

        uint256 xNew = x + dx;
        uint256 yNew = computeY(xNew, d, pool.a, pool.gamma, _fixedKGuess(x, y, xNew, d, pool.a, pool.gamma));
        if (yNew >= y) return (0, d, 0);
        require(yNew * MIN_BALANCE_FRACTION >= d, FXSwapMathUnsafeBalance());

        uint256 gross = y - yNew;
        fee = dynamicFee(k0(xNew, yNew, d), pool.midFee, pool.outFee, pool.feeGamma);
        dy = gross - Math.ceilDiv(gross * fee, WAD);
    }

    /// @notice Input required for an exact output
    /// @dev The fee is taken from the output like getAmountOut: the curve releases `gross` and the taker receives
    ///      `gross · (1 − fee)`. The fee at the post-trade balances depends on `gross` itself, so instead of solving that
    ///      fixed point the fee is bounded from above in closed form: the fixed point lies in
    ///      [dy / (1 − midFee), dy / (1 − outFee)], and along the curve the fee is valley-shaped in `gross` (K₀ peaks
    ///      at balance), so its maximum over that interval is at an endpoint. Pricing at that maximum means the input
    ///      charged here always buys at least `dy` through getAmountOut. A flat fee needs a single solve.
    /// @param pool Curve and fee parameters
    /// @param x Balance of the input token
    /// @param y Balance of the output token
    /// @param dy Output amount the taker receives
    /// @return dx Input required, rounded up
    /// @return d Invariant D of the pre-trade balances, rounded up
    /// @return fee Fee rate charged, WAD
    function getAmountIn(Pool memory pool, uint256 x, uint256 y, uint256 dy)
        internal
        pure
        returns (uint256 dx, uint256 d, uint256 fee)
    {
        d = computeD(x, y, pool.a, pool.gamma);
        if (dy == 0) return (0, d, 0);

        fee = pool.midFee;
        uint256 gross = _grossUp(dy, fee);
        uint256 xNew = _solveInBalance(pool, x, y, gross, d);

        if (pool.midFee != pool.outFee) {
            uint256 grossHi = _grossUp(dy, pool.outFee);
            uint256 xNewHi = _solveInBalance(pool, x, y, grossHi, d);
            fee = Math.max(
                dynamicFee(k0(xNew, y - gross, d), pool.midFee, pool.outFee, pool.feeGamma),
                dynamicFee(k0(xNewHi, y - grossHi, d), pool.midFee, pool.outFee, pool.feeGamma)
            );
            gross = _grossUp(dy, fee);
            xNew = gross == grossHi ? xNewHi : _solveInBalance(pool, x, y, gross, d);
        }
        dx = xNew > x ? xNew - x : 0;
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
    //  Invariant primitives
    // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice K₀ = 4·x·y / D² in WAD, rounded down, capped at WAD
    function k0(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        return _k0(x, y, d, false) / _SCALE_PER_WAD;
    }

    /// @notice K = A·K₀·γ² / (γ + 1 − K₀)² in WAD, rounded down
    /// @param k0Wad K₀ in WAD, ≤ WAD
    /// @param a A * A_PRECISION
    /// @param gamma γ in WAD
    function kFromK0(uint256 k0Wad, uint256 a, uint256 gamma) internal pure returns (uint256) {
        return _k(k0Wad * _SCALE_PER_WAD, a, gamma, false) / _SCALE_PER_WAD;
    }

    /// @notice CryptoSwap dynamic fee: midFee·g + outFee·(1 − g), g = feeGamma / (feeGamma + 1 − K₀)
    /// @dev Requires midFee ≤ outFee and K₀ ≤ WAD. g is rounded down and the fee up, both in the maker's favour.
    ///      midFee == outFee is a flat fee.
    function dynamicFee(uint256 k0Wad, uint256 midFee, uint256 outFee, uint256 feeGamma) internal pure returns (uint256) {
        if (midFee == outFee) return midFee;
        uint256 denominator = feeGamma + WAD - k0Wad;
        uint256 g = denominator == 0 ? WAD : Math.mulDiv(feeGamma, WAD, denominator);
        return Math.ceilDiv(midFee * g + outFee * (WAD - g), WAD);
    }

    /// @notice Signed invariant residual F = K·D·(x + y − D) + x·y − D²/4 with directed rounding
    /// @dev F = 0 on the curve. Requires x + y ≥ D. roundUp = true never returns less than the exact residual,
    ///      roundUp = false never returns more (up to the K₀ ≤ 1 cap, which only binds at the constant-product boundary).
    function residual(uint256 x, uint256 y, uint256 d, uint256 a, uint256 gamma, bool roundUp)
        internal
        pure
        returns (int256 f)
    {
        (f,,) = _residual(x, y, d, a, gamma, roundUp);
    }

    /// @notice Solve the invariant for D given both balances
    /// @dev Bracket: F(2√(xy)) ≥ 0 (constant-product limit) and F(x + y) ≤ 0 (constant-sum limit); F decreases in D.
    ///      Returns the smallest D whose upward-rounded residual is ≤ 0, i.e. D rounded up.
    /// @param x Balance of one token (adjusted units), 0 < x ≤ MAX_BALANCE
    /// @param y Balance of the other token (adjusted units), 0 < y ≤ MAX_BALANCE
    /// @param a A * A_PRECISION
    /// @param gamma γ in WAD
    function computeD(uint256 x, uint256 y, uint256 a, uint256 gamma) internal pure returns (uint256 d) {
        require(x != 0 && y != 0, FXSwapMathZeroBalance());
        require(x <= MAX_BALANCE && y <= MAX_BALANCE, FXSwapMathBalanceTooLarge());

        uint256 p = x * y;
        uint256 lo = 2 * Math.sqrt(p);
        if (a == 0) {
            // Constant product: the smallest D with ⌊D²/4⌋ ≥ x·y
            for (d = lo; d * d / 4 < p; ++d) { }
            return d;
        }

        uint256 s = x + y;
        uint256 hi = s;
        if (lo >= hi) return hi;
        (int256 fLo,,) = _residual(x, y, lo, a, gamma, true);
        if (fLo <= 0) return lo;

        d = hi;
        for (uint256 i; i < MAX_ITERATIONS; ++i) {
            (int256 f, uint256 k0_, uint256 k_) = _residual(x, y, d, a, gamma, true);
            if (f <= 0) hi = d;
            else lo = d;
            if (hi - lo <= 1) return hi;

            // dF/dD = K·(S − 2D) − 2·(dK/dK₀)·K₀·(S − D) − D/2, negative in the bracket
            int256 fp = _signedMulDiv(k_, s, 2 * d, SCALE)
                - int256(Math.mulDiv(Math.mulDiv(_dKdK0(k0_, a, gamma), k0_, SCALE), 2 * (s - d), SCALE))
                - int256(d / 2);
            // F decreases in D, so step on −F, which increases
            d = _nextGuess(d, -f, -fp, lo, hi);
        }
        revert FXSwapMathDidNotConverge();
    }

    /// @notice Solve the invariant for one balance given the other balance and D
    /// @dev Bracket: F(max(D − x, 0)) ≤ 0 (constant-sum limit) and F(⌈D²/4x⌉) ≥ 0 (constant-product limit); F increases
    ///      in y. Returns the smallest y whose downward-rounded residual is ≥ 0, i.e. y rounded up. The invariant is
    ///      symmetric, so this also solves for the input balance of an exact-out trade.
    /// @param x The known balance (adjusted units), D / MIN_BALANCE_FRACTION ≤ x ≤ MAX_BALANCE
    /// @param d Invariant D, ≤ 2 · MAX_BALANCE
    /// @param a A * A_PRECISION
    /// @param gamma γ in WAD
    /// @param guess Starting point; ignored unless strictly inside the bracket
    function computeY(uint256 x, uint256 d, uint256 a, uint256 gamma, uint256 guess) internal pure returns (uint256 y) {
        require(x != 0 && d != 0, FXSwapMathZeroBalance());
        require(x <= MAX_BALANCE && d <= 2 * MAX_BALANCE, FXSwapMathBalanceTooLarge());
        require(x * MIN_BALANCE_FRACTION >= d, FXSwapMathUnsafeBalance());

        if (a == 0) {
            // Constant product: the smallest y with x·y ≥ ⌈D²/4⌉
            return Math.ceilDiv(Math.ceilDiv(d * d, 4), x);
        }

        uint256 lo = d > x ? d - x : 0;
        uint256 hi = Math.ceilDiv(d * d, 4 * x);
        (int256 fLo,,) = _residual(x, lo, d, a, gamma, false);
        if (fLo >= 0) return lo;
        if (hi - lo <= 1) return hi;

        y = guess > lo && guess < hi ? guess : hi;
        for (uint256 i; i < MAX_ITERATIONS; ++i) {
            (int256 f, uint256 k0_, uint256 k_) = _residual(x, y, d, a, gamma, false);
            if (f >= 0) hi = y;
            else lo = y;
            if (hi - lo <= 1) return hi;

            // dF/dy = K·D + x + (dK/dK₀)·4x·(x + y − D)/D, positive in the bracket
            int256 fp = int256(
                Math.mulDiv(k_, d, SCALE) + x + Math.mulDiv(_dKdK0(k0_, a, gamma), 4 * x * (x + y - d), d * SCALE)
            );
            y = _nextGuess(y, f, fp, lo, hi);
        }
        revert FXSwapMathDidNotConverge();
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
    //  Internals
    // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev K₀ at SCALE, capped at SCALE. K₀ ≤ 1 holds exactly on or inside the curve; the cap only absorbs rounding
    ///      at the constant-product bracket endpoints.
    function _k0(uint256 x, uint256 y, uint256 d, bool roundUp) private pure returns (uint256 k) {
        Math.Rounding r = roundUp ? Math.Rounding.Ceil : Math.Rounding.Floor;
        k = Math.mulDiv(Math.mulDiv(4 * x, y, d, r), SCALE, d, r);
        if (k > SCALE) k = SCALE;
    }

    /// @dev K at SCALE from K₀ at SCALE. K increases in K₀, so rounding K₀ and every division one way rounds K that way.
    function _k(uint256 k0_, uint256 a, uint256 gamma, bool roundUp) private pure returns (uint256) {
        if (a == 0 || k0_ == 0) return 0;
        Math.Rounding r = roundUp ? Math.Rounding.Ceil : Math.Rounding.Floor;
        uint256 gammaS = gamma * _SCALE_PER_WAD;
        uint256 ratio = Math.mulDiv(gammaS, SCALE, gammaS + SCALE - k0_, r); // γ / (γ + 1 − K₀) ≤ 1
        return Math.mulDiv(a * Math.mulDiv(ratio, ratio, SCALE, r), k0_, A_PRECISION * SCALE, r);
    }

    /// @dev dK/dK₀ = A·γ²·(γ + 1 + K₀) / (γ + 1 − K₀)³ at SCALE. Only steers Newton, so it is not direction-rounded.
    function _dKdK0(uint256 k0_, uint256 a, uint256 gamma) private pure returns (uint256) {
        uint256 gammaS = gamma * _SCALE_PER_WAD;
        uint256 denominator = gammaS + SCALE - k0_;
        uint256 ratio = Math.mulDiv(gammaS, SCALE, denominator);
        return Math.mulDiv(a * Math.mulDiv(ratio, ratio, SCALE), gammaS + SCALE + k0_, A_PRECISION * denominator);
    }

    /// @dev Residual with the K₀ and K (both at SCALE) it was evaluated with
    function _residual(uint256 x, uint256 y, uint256 d, uint256 a, uint256 gamma, bool roundUp)
        private
        pure
        returns (int256 f, uint256 k0_, uint256 k_)
    {
        Math.Rounding r = roundUp ? Math.Rounding.Ceil : Math.Rounding.Floor;
        k0_ = _k0(x, y, d, roundUp);
        k_ = _k(k0_, a, gamma, roundUp);
        uint256 linear = Math.mulDiv(k_, d * (x + y - d), SCALE, r);
        uint256 quarterD2 = roundUp ? d * d / 4 : Math.ceilDiv(d * d, 4);
        f = int256(linear + x * y) - int256(quarterD2);
    }

    /// @dev One bracket-guarded Newton step for an INCREASING function (callers negate a decreasing one).
    ///      `current` was just assigned to `lo` (f < 0) or `hi` (f ≥ 0), and hi − lo ≥ 2.
    ///      - a Newton step of ≤ 1 probes the neighbouring integer, closing the bracket from the far side
    ///      - a Newton step landing strictly inside (lo, hi) is taken
    ///      - otherwise (including a non-positive derivative) the bracket is bisected
    function _nextGuess(uint256 current, int256 f, int256 fp, uint256 lo, uint256 hi) private pure returns (uint256) {
        if (fp > 0) {
            bool up = f < 0;
            uint256 step = Math.ceilDiv(uint256(f >= 0 ? f : -f), uint256(fp));
            if (step <= 1) return up ? current + 1 : current - 1;
            if (up ? step < hi - current : step < current - lo) return up ? current + step : current - step;
        }
        return lo + (hi - lo) / 2;
    }

    /// @dev Starting point for computeY: freeze K at its pre-trade value, which makes the invariant linear in the
    ///      unknown: y' = (K·D·(D − x') + D²/4) / (K·D + x'). Exact for small trades, close for large ones.
    /// @param x0 Pre-trade balance on the known side
    /// @param y0 Pre-trade balance on the solved side
    /// @param xNew Post-trade balance on the known side
    function _fixedKGuess(uint256 x0, uint256 y0, uint256 xNew, uint256 d, uint256 a, uint256 gamma)
        private
        pure
        returns (uint256)
    {
        uint256 k_ = _k(_k0(x0, y0, d, false), a, gamma, false);
        uint256 quarterD2 = d * d / 4;
        uint256 numerator;
        if (xNew <= d) {
            numerator = quarterD2 + Math.mulDiv(k_, d * (d - xNew), SCALE);
        } else {
            uint256 sub = Math.mulDiv(k_, d * (xNew - d), SCALE);
            numerator = quarterD2 > sub ? quarterD2 - sub : 0;
        }
        return numerator / (Math.mulDiv(k_, d, SCALE) + xNew);
    }

    /// @dev Input-side balance after the curve releases `gross` of the output token
    function _solveInBalance(Pool memory pool, uint256 x, uint256 y, uint256 gross, uint256 d)
        private
        pure
        returns (uint256)
    {
        require(gross < y, FXSwapMathInsufficientBalance(y, gross));
        uint256 yNew = y - gross;
        return computeY(yNew, d, pool.a, pool.gamma, _fixedKGuess(y, x, yNew, d, pool.a, pool.gamma));
    }

    /// @dev ⌈amount / (1 − fee)⌉
    function _grossUp(uint256 amount, uint256 fee) private pure returns (uint256) {
        return Math.mulDiv(amount, WAD, WAD - fee, Math.Rounding.Ceil);
    }

    /// @dev a · (b − c) / denominator as a signed value, rounded toward zero
    function _signedMulDiv(uint256 a, uint256 b, uint256 c, uint256 denominator) private pure returns (int256) {
        return b >= c ? int256(Math.mulDiv(a, b - c, denominator)) : -int256(Math.mulDiv(a, c - b, denominator));
    }
}
