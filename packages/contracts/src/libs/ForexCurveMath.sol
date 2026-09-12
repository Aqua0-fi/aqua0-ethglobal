// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title ForexCurveMath - Shell v1 / DFX v2 forex curve with an oracle, two assets, solved in closed form
/// @notice Pure math core of the ForexCurve instruction. Port of the reference `scripts/fxforex_math.py`
///         (`quote`, `trade_closed`, `psi` / `micro`, `enforce_halts`, `enforce_swap_invariant`).
/// @notice The curve, in numeraire (quote units, 18 decimals):
///             x = quote balance, y = p·local balance (p = oracle, quote per local), g = x + y, ideal I = g/2
///         Each asset pays a micro fee once it leaves the ±β band around the ideal:
///             below: m = I(1 − β) − b     above: m = b − I(1 + β)     μ = min(δ·m/I, MAX)·m  (m > 0, else 0)
///         ψ = μ_x + μ_y, ω = ψ before the trade. A trade moves the known balance by `a` and the other by `o`; the pool
///         retains s = a + o, which is DFX calculateTrade's fixed point with ψ' taken at the new state:
///             s = ψ' − ω         if ψ' > ω   (the fee grows: the taker pays it)
///             s = λ·(ψ' − ω)     otherwise   (the fee shrinks: the taker receives λ of it)
///         Multiplying by g + s makes it a quadratic in s per piece (regime of each asset × c ∈ {1, λ}), solved exactly
///         instead of DFX's 32-step iteration. Inside the band s = 0: the price is the oracle.
/// @notice Post-trade checks, verbatim DFX: enforceHalts (a balance may end beyond ±α of the new ideal only if it already
///         was and the excursion does not grow) and enforceSwapInvariant (utility g − ψ may not drop by more than
///         0x10C6F7A0B5EE / 2^64 ≈ 1e-6 numeraire units). ε (plus conf/p) is a proportional fee on the output (exact in)
///         or the input (exact out).
/// @dev Fixed point: balances, amounts, `a`, `s` and ψ are integers in numeraire wei (1e18 = one quote unit); α, β, δ,
///      MAX, λ, ε, p and conf are WAD. The solver runs unchecked: every balance and |a| is at most MAX_BALANCE, δ < 2^64,
///      β, MAX, λ ≤ 1, and roots beyond ±MAX_ROOT are dropped before use, which bounds every coefficient (|B| < 1e35,
///      |C| < 1e67, |A| < 1e38 at 1e36), discriminant (< 1e70) and product below 1e76.
/// @dev Rounding is against the taker. The known change is rounded toward the pool (exact in credits less, exact out
///      removes more); the solved retention s is nudged until the residual s − c·(ψ' − ω), with ψ' rounded up and ω
///      rounded down, is ≥ 0 (the residual increases in s, so s ≥ the exact root); amountOut rounds down, amountIn up.
library ForexCurveMath {
    /// @dev 1.0 in WAD fixed point
    uint256 internal constant WAD = 1e18;
    /// @dev Precision of the quadratic's leading coefficient
    uint256 internal constant SCALE = 1e36;
    /// @dev Largest balance, and largest |a|, in numeraire wei (1e14 quote units)
    uint256 internal constant MAX_BALANCE = 1e32;
    /// @dev DFX enforceSwapInvariant tolerance, 0x10C6F7A0B5EE / 2^64 numeraire units, in wei (the integer comparison is exact)
    int256 internal constant MAX_UTILITY_DROP = 1e12;

    int256 private constant _IWAD = 1e18;
    int256 private constant _ISCALE = 1e36;
    /// @dev Roots beyond this retention are outside every representable state and are skipped
    int256 private constant _MAX_ROOT = 4e32;
    /// @dev Floor of the reference's c-consistency tolerance |ψ' − ω| ≤ 1e-12 · max(1, ω)
    int256 private constant _C_TOLERANCE_FLOOR = 1e6;
    /// @dev Upper bound on rounding nudges of the solved root (the step doubles each time, so a residual slope near zero
    ///      at MAX close to 1/2 still converges)
    uint256 private constant _MAX_NUDGES = 16;

    /// @dev Regime of one asset: 0 inside the band, 1 / 2 below it (quadratic / capped fee), 3 / 4 above it.
    ///      A piece is c·25 + regime(quote)·5 + regime(local), with c index 0 for c = 1 and 1 for c = λ.
    uint256 private constant _IN = 0;
    uint256 private constant _BELOW_QUAD = 1;
    uint256 private constant _BELOW_CAP = 2;
    uint256 private constant _ABOVE_QUAD = 3;
    /// @dev Bit r·5 + l set for the feasible regime pairs: both inside, or one below and the other above (x + y = 2I)
    uint256 private constant _FEASIBLE = (1 << 0) | (1 << 8) | (1 << 9) | (1 << 13) | (1 << 14) | (1 << 16) | (1 << 17)
        | (1 << 21) | (1 << 22);

    error ForexCurveEmptySide();
    error ForexCurveBalanceTooLarge();
    error ForexCurveDrain();
    error ForexCurveNoConsistentPiece();
    error ForexCurveUpperHalt();
    error ForexCurveLowerHalt();
    error ForexCurveSwapInvariant();

    /// @notice Curve parameters, all WAD
    /// @param alpha Halt distance from the ideal, 0 < α < 1
    /// @param beta Flat band half-width, 0 ≤ β < α
    /// @param delta Fee slope outside the band, < 2^64
    /// @param maxFee Fee rate cap (the reference's MAX), < 1/2 so the residual is increasing in s (ForexCurveArgsBuilder
    ///        also requires < (1 − α)/(2α), see ForexCurveArgsBuilder.maxFeeLimit)
    /// @param lambda Share of a shrinking fee returned to the taker, ≤ 1
    /// @param epsilon Proportional fee on the output (exact in) or input (exact out), < 1
    struct Params {
        uint256 alpha;
        uint256 beta;
        uint256 delta;
        uint256 maxFee;
        uint256 lambda;
        uint256 epsilon;
    }

    /// @dev A trade being solved. The known balance ends at `known`, the other one at `other0 + s`.
    struct Trade {
        int256 g;
        int256 omega;
        int256 known;
        int256 other0;
        bool knownIsQuote;
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
    //  Entry points
    // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Quote one side of a swap (reference `quote`)
    /// @param params Curve parameters
    /// @param price p, quote units per 1 local unit, WAD
    /// @param quoteBalance Quote balance U, 18 decimals
    /// @param localBalance Local balance B, 18 decimals
    /// @param conf Oracle confidence interval in quote units, WAD; widens ε by conf/p
    /// @param localOut Whether the taker receives the local token (reference `brl_out`)
    /// @param exactIn Exact input (amountOut computed) or exact output (amountIn computed)
    /// @param amount amountIn when exactIn, otherwise amountOut, 18 decimals of its token
    /// @return amountIn Input amount, 18 decimals (rounded up when computed)
    /// @return amountOut Output amount, 18 decimals (rounded down when computed)
    function quote(
        Params memory params,
        uint256 price,
        uint256 quoteBalance,
        uint256 localBalance,
        uint256 conf,
        bool localOut,
        bool exactIn,
        uint256 amount
    ) internal pure returns (uint256 amountIn, uint256 amountOut) {
        uint256 y = _mulDiv(price, localBalance, WAD, false);
        require(quoteBalance != 0 && y != 0, ForexCurveEmptySide());
        if (amount == 0) return (0, 0);

        // The known change is the input (exact in) or the output (exact out); it is the quote side iff localOut == exactIn
        bool knownIsQuote = localOut == exactIn;
        uint256 aMag = knownIsQuote ? amount : _mulDiv(price, amount, WAD, !exactIn);
        require(aMag <= MAX_BALANCE, ForexCurveBalanceTooLarge());
        int256 o = trade(params, quoteBalance, y, knownIsQuote, exactIn ? int256(aMag) : -int256(aMag));

        // εeff = ε + conf/p in a single division: 1 ∓ εeff = (p·(1 ∓ ε) ∓ conf) / p, and local amounts divide by p again
        uint256 denominator = price * (exactIn == localOut ? price : WAD);
        if (exactIn) {
            amountIn = amount;
            uint256 fee = params.epsilon * price + conf * WAD;
            if (o < 0 && fee < price * WAD) amountOut = _mulDiv(uint256(-o), price * WAD - fee, denominator, false);
            // (an exact output at or above its balance empties the known balance, which the solver rejects as a drain)
            require(amountOut < (localOut ? localBalance : quoteBalance), ForexCurveDrain());
        } else {
            amountOut = amount;
            if (o > 0) amountIn = _mulDiv(uint256(o), price * (WAD + params.epsilon) + conf * WAD, denominator, true);
        }
    }

    /// @notice Solve a trade and run the post-trade checks (reference `quote.run`: trade_closed, drain, halts, invariant)
    /// @param params Curve parameters
    /// @param x Quote balance, numeraire wei, 0 < x ≤ MAX_BALANCE
    /// @param y Local balance valued in quote (p·B), numeraire wei, 0 < y ≤ MAX_BALANCE
    /// @param knownIsQuote Whether `a` changes the quote balance (otherwise the local balance)
    /// @param a Signed numeraire change of the known balance (positive into the pool), |a| ≤ MAX_BALANCE
    /// @return o Signed numeraire change of the other balance, s − a
    function trade(Params memory params, uint256 x, uint256 y, bool knownIsQuote, int256 a)
        internal
        pure
        returns (int256 o)
    {
        unchecked {
            // |a| ≤ MAX_BALANCE as one unsigned comparison: a + MAX_BALANCE wraps below zero to a huge value
            require(
                x <= MAX_BALANCE && y <= MAX_BALANCE && uint256(a + int256(MAX_BALANCE)) <= 2 * MAX_BALANCE,
                ForexCurveBalanceTooLarge()
            );
            (int256 ix, int256 iy) = (int256(x), int256(y));
            (int256 s, int256 omega, int256 psiAfter) = _solve(params, ix, iy, knownIsQuote, a);
            o = s - a;
            (int256 nx, int256 ny) = knownIsQuote ? (ix + a, iy + o) : (ix + o, iy + a);
            require(nx > 0 && ny > 0, ForexCurveDrain());

            // DFX enforceHalts, quote balance first; compared at 2·WAD scale, exactly
            (int256 og, int256 ng) = (ix + iy, nx + ny);
            for (uint256 i; i < 2; ++i) {
                (int256 ob2w, int256 nb2w) = i == 0 ? (2 * _IWAD * ix, 2 * _IWAD * nx) : (2 * _IWAD * iy, 2 * _IWAD * ny);
                if (nb2w > _IWAD * ng) {
                    int256 up = int256(WAD + params.alpha);
                    (int256 oHalt, int256 nHalt) = (og * up, ng * up);
                    require(nb2w <= nHalt || (ob2w >= oHalt && nb2w - nHalt <= ob2w - oHalt), ForexCurveUpperHalt());
                } else {
                    int256 down = int256(WAD - params.alpha);
                    (int256 oHalt, int256 nHalt) = (og * down, ng * down);
                    require(nb2w >= nHalt || (ob2w <= oHalt && nHalt - nb2w <= oHalt - ob2w), ForexCurveLowerHalt());
                }
            }

            require(ng - psiAfter - (og - omega) >= -MAX_UTILITY_DROP, ForexCurveSwapInvariant());
        }
    }

    /// @notice Total micro fee ψ of a state (reference `psi`)
    /// @param x Quote balance, numeraire wei, 0 < x ≤ MAX_BALANCE
    /// @param y Local balance valued in quote, numeraire wei, 0 < y ≤ MAX_BALANCE
    /// @param roundUp Round each fee up (true) or down (false)
    function psi(Params memory params, int256 x, int256 y, bool roundUp) internal pure returns (int256 value) {
        (, value) = _psi(params, x, y, roundUp);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
    //  Solver
    // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Retention s of a trade, ω (rounded down) and ψ' at the solved state (rounded up). Tries the piece of the
    ///      s = 0 state first (right almost always), then scans every feasible piece, then nudges s up until its
    ///      maker-side residual is non-negative.
    ///      Acceptance follows the reference `trade_closed`: a root is consistent when its balances are positive and its
    ///      regimes and c are the piece's (c within 1e-12·max(1, ω) of flipping also passes). A root whose c is exactly
    ///      the piece's is taken as soon as it is found; otherwise the consistent root with the smallest residual, the
    ///      residual being measured with the c the new state actually has.
    function _solve(Params memory params, int256 x, int256 y, bool knownIsQuote, int256 a)
        private
        pure
        returns (int256 s, int256 omega, int256 psiAfter)
    {
        unchecked {
            Trade memory t;
            t.g = x + y;
            t.knownIsQuote = knownIsQuote;
            t.known = (knownIsQuote ? x : y) + a;
            require(t.known > 0, ForexCurveDrain());
            t.other0 = (knownIsQuote ? y : x) - a;
            (, omega) = _psi(params, x, y, false);
            t.omega = omega;

            bool found;
            uint256 bestResidual;
            // Pass 0 is the piece of the s = 0 state (when that state exists); passes 1..50 scan pieces 0..49
            uint256 first = 50;
            if (t.other0 > 0) {
                (int256 q0, int256 l0) = _balances(t, 0);
                (uint256 regimes, int256 psi0) = _psi(params, q0, l0, false);
                // Flat zone before and after at s = 0: the exact fast path of the reference
                if (omega == 0 && regimes == 0) return (0, 0, 0);
                first = (psi0 > omega || params.lambda == WAD ? 0 : 25) + regimes;
            }
            for (uint256 pass; pass <= 50; ++pass) {
                uint256 piece = pass == 0 ? first : pass - 1;
                if (piece == 50 || (pass != 0 && piece == first)) continue;
                if (piece >= 25 && params.lambda == WAD) break;
                if ((_FEASIBLE >> (piece % 25)) & 1 == 0) continue;
                (bool ok, bool isExact, int256 root, uint256 residual) = _tryPiece(params, t, piece);
                if (ok && (isExact || !found || residual < bestResidual)) (found, s, bestResidual) = (true, root, residual);
                if (isExact) break;
            }
            if (!found) {
                if ((a < 0 ? -a : a) >= t.g) revert ForexCurveDrain();
                revert ForexCurveNoConsistentPiece();
            }

            for (uint256 i;; ++i) {
                (int256 q1, int256 l1) = _balances(t, s);
                (, psiAfter) = _psi(params, q1, l1, true);
                int256 d = psiAfter - omega;
                // Lower bound of the residual s − max(d, λ·d)
                int256 deficit = d > 0 ? s - d : s + int256(_mulDiv(uint256(-d), params.lambda, WAD, false));
                if (deficit >= 0) break;
                require(i < _MAX_NUDGES, ForexCurveNoConsistentPiece());
                s -= deficit << i;
            }
        }
    }

    /// @dev Roots of one piece and its best consistent root.
    ///      s² + g·s + c·ω·(g + s) − c·Σ μᵢ(s)·(g + s) = 0, with μᵢ·(g + s) quadratic in s for the regime of asset i.
    ///      A is carried at 1e36 (at WAD its truncation moves large roots by s²/g·1e-18), B in wei, C in wei².
    function _tryPiece(Params memory params, Trade memory t, uint256 piece)
        private
        pure
        returns (bool found, bool exact, int256 best, uint256 bestResidual)
    {
        unchecked {
            int256 c = piece < 25 ? _IWAD : int256(params.lambda);
            int256 A = _ISCALE;
            int256 B = t.g + c * t.omega / _IWAD;
            int256 C = _mulDiv(c * t.omega, t.g, WAD);
            for (uint256 i; i < 2; ++i) {
                uint256 reg = i == 0 ? piece / 5 % 5 : piece % 5;
                if (reg == _IN) continue;
                // m(s) = m0 + k·s with k2 = 2k at WAD; the known balance is fixed, the other one moves one-for-one with s
                bool isKnown = (i == 0) == t.knownIsQuote;
                int256 b0 = isKnown ? t.known : t.other0;
                int256 up = int256(WAD + params.beta);
                int256 down = int256(WAD - params.beta);
                int256 m0;
                int256 k2;
                if (reg <= _BELOW_CAP) {
                    // m = (1 − β)(g + s)/2 − b(s)
                    (m0, k2) = (_mulDiv(t.g, down, 2 * WAD) - b0, isKnown ? down : -up);
                } else {
                    // m = b(s) − (1 + β)(g + s)/2
                    (m0, k2) = (b0 - _mulDiv(t.g, up, 2 * WAD), isKnown ? -up : down);
                }
                int256 a2;
                int256 b2;
                int256 c2;
                if (reg % 2 == 1) {
                    // quadratic: μ = δ·m²/I  ⇒  μ·(g + s) = 2δ·m²
                    int256 delta2 = 2 * int256(params.delta);
                    a2 = delta2 * k2 * k2 / (4 * _IWAD);
                    b2 = _mulDiv(m0 * k2, delta2, WAD * WAD);
                    c2 = _mulDiv(m0 * m0, delta2, WAD);
                } else {
                    // capped: μ = MAX·m  ⇒  μ·(g + s) = MAX·m·(g + s)
                    int256 maxFee = int256(params.maxFee);
                    a2 = maxFee * k2 / 2;
                    b2 = _mulDiv(2 * _IWAD * m0 + k2 * t.g, maxFee, 2 * WAD * WAD);
                    c2 = _mulDiv(m0 * t.g, maxFee, WAD);
                }
                (A, B, C) = (A - c * a2 / _IWAD, B - _mulDiv(b2, c, WAD), C - _mulDiv(c2, c, WAD));
            }

            int256 disc = B * B - _mulDiv(4 * A, C, SCALE);
            if (disc < 0) return (false, false, 0, 0);
            int256 sq = int256(Math.sqrt(uint256(disc)));
            // Stable pair: q = −(B + sign(B)·√disc)/2 carries no cancellation; the roots are q/A and C/q
            // (A = 0 leaves q = −B and the single root −C/B = C/q; the final nudge makes the rounding maker-side)
            int256 q = B >= 0 ? -(B + sq) / 2 : (sq - B) / 2;
            if (q == 0 && A == 0) return (false, false, 0, 0);

            // Reference acceptance: s > −g, positive balances, both regimes as assumed, c as assumed or ψ' within
            // tolerance of ω. The residual |s − c'·(ψ' − ω)| uses the c' the new state actually has.
            for (uint256 i; i < 2; ++i) {
                int256 s = i == 0 ? (A == 0 ? C / q : q * _ISCALE / A) : (q != 0 ? C / q : -B * _ISCALE / A);
                if (s <= -t.g || s > _MAX_ROOT || t.other0 + s <= 0) continue;
                (int256 qb, int256 lb) = _balances(t, s);
                (uint256 regimes, int256 psiNew) = _psi(params, qb, lb, false);
                if (regimes != piece % 25) continue;
                int256 d = psiNew - t.omega;
                int256 actualC = d > 0 ? _IWAD : int256(params.lambda);
                bool isExact = actualC == c;
                if (!isExact) {
                    int256 tolerance = t.omega / 1e12;
                    if (tolerance < _C_TOLERANCE_FLOOR) tolerance = _C_TOLERANCE_FLOOR;
                    if (d > tolerance || d < -tolerance) continue;
                }
                int256 r = s - actualC * d / _IWAD;
                uint256 residual = uint256(r < 0 ? -r : r);
                if (isExact || !found || residual < bestResidual) {
                    (found, exact, best, bestResidual) = (true, isExact, s, residual);
                    if (isExact) break;
                }
            }
        }
    }

    /// @dev Quote and local balances after retaining s
    function _balances(Trade memory t, int256 s) private pure returns (int256, int256) {
        unchecked {
            return t.knownIsQuote ? (t.known, t.other0 + s) : (t.other0 + s, t.known);
        }
    }

    /// @dev Regimes (regime(quote)·5 + regime(local)) and total micro fee of a state (reference `micro` /
    ///      `_check_regime`). Classification is exact: 2·WAD·m is compared in integers, a fee is capped iff δ·m/I ≥ MAX.
    function _psi(Params memory params, int256 q, int256 l, bool roundUp)
        private
        pure
        returns (uint256 regimes, int256 total)
    {
        unchecked {
            int256 g = q + l;
            for (uint256 i; i < 2; ++i) {
                int256 b2w = 2 * _IWAD * (i == 0 ? q : l);
                uint256 reg = _BELOW_QUAD;
                int256 m2w = g * int256(WAD - params.beta) - b2w;
                if (m2w <= 0) (reg, m2w) = (_ABOVE_QUAD, b2w - g * int256(WAD + params.beta));
                if (m2w <= 0) {
                    reg = _IN;
                } else {
                    uint256 m = uint256(m2w);
                    if (params.delta * m >= params.maxFee * WAD * uint256(g)) {
                        ++reg;
                        total += int256(_mulDiv(params.maxFee, m, 2 * WAD * WAD, roundUp));
                    } else {
                        total +=
                            int256(_mulDiv(_mulDiv(m, m, 2 * WAD * uint256(g), roundUp), params.delta, WAD * WAD, roundUp));
                    }
                }
                regimes = regimes * 5 + reg;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
    //  Arithmetic helpers
    // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev a·b/denominator, rounded up or down (full 512-bit intermediate)
    function _mulDiv(uint256 a, uint256 b, uint256 denominator, bool roundUp) private pure returns (uint256) {
        return Math.mulDiv(a, b, denominator, roundUp ? Math.Rounding.Ceil : Math.Rounding.Floor);
    }

    /// @dev a·b/denominator for signed a and b, rounded toward zero (full 512-bit intermediate)
    function _mulDiv(int256 a, int256 b, uint256 denominator) private pure returns (int256) {
        unchecked {
            int256 r = int256(Math.mulDiv(uint256(a < 0 ? -a : a), uint256(b < 0 ? -b : b), denominator));
            return (a < 0) == (b < 0) ? r : -r;
        }
    }

}
