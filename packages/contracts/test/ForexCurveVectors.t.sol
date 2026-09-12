// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test, console2 } from "forge-std/Test.sol";

import { ForexCurveMath } from "../src/libs/ForexCurveMath.sol";

/// @dev External access to the math so reverts can be caught per vector
contract ForexCurveMathHarness {
    function quote(
        ForexCurveMath.Params memory params,
        uint256 price,
        uint256 quoteBalance,
        uint256 localBalance,
        uint256 conf,
        bool localOut,
        bool exactIn,
        uint256 amount
    ) external pure returns (uint256 amountIn, uint256 amountOut) {
        return ForexCurveMath.quote(params, price, quoteBalance, localBalance, conf, localOut, exactIn, amount);
    }

    function trade(ForexCurveMath.Params memory params, uint256 x, uint256 y, bool knownIsQuote, int256 a)
        external
        pure
        returns (int256)
    {
        return ForexCurveMath.trade(params, x, y, knownIsQuote, a);
    }

    function psi(ForexCurveMath.Params memory params, uint256 x, uint256 y) external pure returns (int256) {
        return ForexCurveMath.psi(params, int256(x), int256(y), false);
    }
}

/// @title ForexCurveVectorsTest
/// @notice Replays every vector of Tomás's forex curve reference (`scripts/fixtures/fxforex_vectors.json`, from
///         `scripts/fxforex_math.py`) through ForexCurveMath.quote, via the integer WAD fixture written by
///         `test/fixtures/gen_fxforex_wad.py`.
/// @dev Per vector:
///      - `revert` set: the call must revert with that ForexCurve error.
///      - otherwise the computed side (amountOut for exact in, amountIn for exact out) must match
///        a) the reference float result within REL_TOLERANCE (or `absTol` for the live DFX EURC/USDC quotes, which are
///           6-decimal on-chain outputs), and
///        b) the 100-digit re-solve of the same integer inputs within HP_TOLERANCE numeraire wei (a local-token result is
///           converted at p), on the maker's side: exact in never pays more than the exact result, exact out never
///           charges less.
contract ForexCurveVectorsTest is Test {
    string internal constant PATH = "test/fixtures/fxforex-vectors-wad.json";
    string internal constant VECTOR_TYPE =
        "Vector(string name,string set,uint256 alpha,uint256 beta,uint256 delta,uint256 maxFee,uint256 lambda,uint256 epsilon,uint256 p,uint256 quoteBalance,uint256 localBalance,uint256 conf,uint256 amount,bool localOut,bool exactIn,string revert,uint256 amountIn,uint256 amountOut,string hpRevert,uint256 hpAmountIn,uint256 hpAmountOut,uint256 absTol)";

    /// @dev 1e-9 relative, WAD
    uint256 internal constant REL_TOLERANCE = 1e9;
    /// @dev Absolute floor of the reference comparison, token wei
    uint256 internal constant ABS_FLOOR = 16;
    /// @dev Against the 100-digit reference, numeraire (quote) wei
    uint256 internal constant HP_TOLERANCE = 8;

    struct Vector {
        string name;
        string set;
        uint256 alpha;
        uint256 beta;
        uint256 delta;
        uint256 maxFee;
        uint256 lambda;
        uint256 epsilon;
        uint256 p;
        uint256 quoteBalance;
        uint256 localBalance;
        uint256 conf;
        uint256 amount;
        bool localOut;
        bool exactIn;
        string expectedRevert;
        uint256 amountIn;
        uint256 amountOut;
        string hpRevert;
        uint256 hpAmountIn;
        uint256 hpAmountOut;
        uint256 absTol;
    }

    struct SetStats {
        string name;
        uint256 total;
        uint256 passed;
        uint256 reverts;
        uint256 worstRelRef; // WAD
        uint256 worstAbsHp; // numeraire wei
        uint256 worstRelHp; // WAD
        uint256 worstAbsDfx; // wei, live DFX quotes only
        uint256 gasMax;
        uint256 gasSum;
        uint256 quotes;
    }

    ForexCurveMathHarness internal harness;

    function setUp() public {
        harness = new ForexCurveMathHarness();
    }

    function test_AllReferenceVectors() public {
        Vector[] memory vectors =
            abi.decode(vm.parseJsonTypeArray(vm.readFile(PATH), ".vectors", VECTOR_TYPE), (Vector[]));
        assertEq(vectors.length, 979, "fixture size");

        SetStats[] memory sets = new SetStats[](6);
        string[6] memory names = ["onchain_dfx", "dfx_prod", "conservative", "no_flat_zone", "cap_regime", "edge"];
        for (uint256 i; i < 6; ++i) {
            sets[i].name = names[i];
        }

        uint256 failures;
        for (uint256 i; i < vectors.length; ++i) {
            Vector memory v = vectors[i];
            SetStats memory st = sets[_setIndex(names, v.set)];
            st.total += 1;
            if (_check(v, st)) st.passed += 1;
            else failures += 1;
        }

        uint256 passed;
        for (uint256 i; i < 6; ++i) {
            SetStats memory st = sets[i];
            passed += st.passed;
            console2.log(string.concat("set ", st.name));
            console2.log("  pass / total:", st.passed, st.total);
            console2.log("  expected reverts:", st.reverts);
            console2.log("  worst rel err vs reference float (1e-18):", st.worstRelRef);
            console2.log("  worst err vs 100-digit (numeraire wei), rel (1e-18):", st.worstAbsHp, st.worstRelHp);
            if (st.worstAbsDfx != 0) console2.log("  worst abs err vs live DFX pool (wei):", st.worstAbsDfx);
            if (st.quotes != 0) console2.log("  gas per quote avg / max:", st.gasSum / st.quotes, st.gasMax);
        }
        console2.log("TOTAL pass / fail / total:", passed, failures, vectors.length);
        assertEq(failures, 0, "vector failures");
    }

    function _check(Vector memory v, SetStats memory st) internal view returns (bool ok) {
        ForexCurveMath.Params memory params = ForexCurveMath.Params({
            alpha: v.alpha, beta: v.beta, delta: v.delta, maxFee: v.maxFee, lambda: v.lambda, epsilon: v.epsilon
        });
        uint256 gasBefore = gasleft();
        try harness.quote(params, v.p, v.quoteBalance, v.localBalance, v.conf, v.localOut, v.exactIn, v.amount) returns (
            uint256 amountIn, uint256 amountOut
        ) {
            uint256 gasUsed = gasBefore - gasleft();
            if (bytes(v.expectedRevert).length != 0) {
                console2.log("FAIL expected revert", v.name, v.expectedRevert);
                return false;
            }
            st.quotes += 1;
            st.gasSum += gasUsed;
            if (gasUsed > st.gasMax) st.gasMax = gasUsed;
            return _checkAmounts(v, st, amountIn, amountOut);
        } catch (bytes memory reason) {
            if (bytes(v.expectedRevert).length == 0) {
                console2.log("FAIL unexpected revert", v.name);
                console2.logBytes(reason);
                return false;
            }
            st.reverts += 1;
            if (bytes4(reason) != _selector(v.expectedRevert)) {
                console2.log("FAIL wrong revert", v.name, v.expectedRevert);
                console2.logBytes(reason);
                return false;
            }
            return true;
        }
    }

    function _checkAmounts(Vector memory v, SetStats memory st, uint256 amountIn, uint256 amountOut)
        internal
        pure
        returns (bool ok)
    {
        ok = true;
        (uint256 got, uint256 known, uint256 expected, uint256 hp) = v.exactIn
            ? (amountOut, amountIn, v.amountOut, v.hpAmountOut)
            : (amountIn, amountOut, v.amountIn, v.hpAmountIn);
        if (known != v.amount) {
            console2.log("FAIL known side changed", v.name);
            ok = false;
        }

        uint256 diffRef = _absDiff(got, expected);
        if (v.absTol != 0) {
            if (diffRef > st.worstAbsDfx) st.worstAbsDfx = diffRef;
            if (diffRef > v.absTol) {
                console2.log("FAIL live pool", v.name, got, expected);
                ok = false;
            }
        } else {
            uint256 rel = expected == 0 ? (got == 0 ? 0 : type(uint256).max) : diffRef * 1e18 / expected;
            if (rel > st.worstRelRef) st.worstRelRef = rel;
            if (rel > REL_TOLERANCE && diffRef > ABS_FLOOR) {
                console2.log("FAIL reference", v.name, got, expected);
                ok = false;
            }
        }

        // A local-token result (exact in buying local, exact out paying local) is worth p / 1e18 quote wei per wei
        // (one token wei is always tolerated: at p > 8 a single local wei is already worth more than HP_TOLERANCE)
        uint256 diffToken = _absDiff(got, hp);
        uint256 diffHp = v.exactIn == v.localOut ? (diffToken * v.p + 1e18 - 1) / 1e18 : diffToken;
        if (diffHp > st.worstAbsHp) st.worstAbsHp = diffHp;
        uint256 relHp = hp == 0 ? 0 : diffToken * 1e18 / hp;
        if (relHp > st.worstRelHp) st.worstRelHp = relHp;
        if (diffHp > HP_TOLERANCE && diffToken > 1) {
            console2.log("FAIL 100-digit", v.name, got, hp);
            ok = false;
        }
        if (v.exactIn ? got > hp : got < hp) {
            console2.log("FAIL taker-favourable rounding", v.name, got, hp);
            ok = false;
        }
    }

    function _selector(string memory name) internal pure returns (bytes4) {
        bytes32 h = keccak256(bytes(name));
        if (h == keccak256("EmptySide")) return ForexCurveMath.ForexCurveEmptySide.selector;
        if (h == keccak256("Drain")) return ForexCurveMath.ForexCurveDrain.selector;
        if (h == keccak256("NoConsistentPiece")) return ForexCurveMath.ForexCurveNoConsistentPiece.selector;
        if (h == keccak256("UpperHalt")) return ForexCurveMath.ForexCurveUpperHalt.selector;
        if (h == keccak256("LowerHalt")) return ForexCurveMath.ForexCurveLowerHalt.selector;
        if (h == keccak256("SwapInvariant")) return ForexCurveMath.ForexCurveSwapInvariant.selector;
        revert(string.concat("unknown revert name ", name));
    }

    function _setIndex(string[6] memory names, string memory set) internal pure returns (uint256) {
        for (uint256 i; i < 6; ++i) {
            if (keccak256(bytes(names[i])) == keccak256(bytes(set))) return i;
        }
        revert(string.concat("unknown set ", set));
    }

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }
}
