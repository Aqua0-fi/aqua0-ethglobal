// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test, console2 } from "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { FXSwapMath } from "../src/libs/FXSwapMath.sol";
import { FXSwapArgsBuilder, FXSwapPricing } from "../src/instructions/FXSwap.sol";

/// @title FXSwapVectorsTest
/// @notice Replays `test/fixtures/fxswap-vectors.json` through the exact pricing path the instruction uses
///         (FXSwapPricing.quote: raw → adjusted units → FXSwapMath → raw), with the oracle price injected directly.
/// @dev Vector schema (all integers as decimal strings):
///      name, source, description
///      tokenInIsLt (bool)       tokenIn has the lower address
///      decimalsLt, decimalsGt   token decimals (rate = 10^(18 − decimals))
///      priceGtPerLt             whole tokenGt per 1 whole tokenLt, WAD
///      A                        whitepaper A * 1e4
///      gamma, midFee, outFee, feeGamma   WAD
///      balanceIn, balanceOut, amount     raw token amounts (amount = amountIn if isExactIn else amountOut)
///      isExactIn (bool)
///      expected                 raw amountOut (exact in) or amountIn (exact out)
///      expectedD                D in adjusted units; "0" skips the check
///      relTolerance             WAD-relative tolerance on expected and expectedD
///      absTolerance             absolute tolerance in raw units (and adjusted units for D)
///      Self-generated vectors come from an independent 100-digit mpmath implementation with no rounding, so the
///      contract result must also sit on the maker-favourable side: exact-in ≤ expected, exact-out ≥ expected.
///      Vectors with another `source` only get the tolerance check.
contract FXSwapVectorsTest is Test {
    string internal constant PATH = "test/fixtures/fxswap-vectors.json";

    struct Vector {
        string name;
        string source;
        bool tokenInIsLt;
        uint256 decimalsLt;
        uint256 decimalsGt;
        uint256 priceGtPerLt;
        uint256 a;
        uint256 gamma;
        uint256 midFee;
        uint256 outFee;
        uint256 feeGamma;
        uint256 balanceIn;
        uint256 balanceOut;
        uint256 amount;
        bool isExactIn;
        uint256 expected;
        uint256 expectedD;
        uint256 relTolerance;
        uint256 absTolerance;
    }

    function test_Vectors() public view {
        string memory json = vm.readFile(PATH);
        uint256 count;
        for (;; ++count) {
            string memory key = string.concat(".vectors[", vm.toString(count), "]");
            if (!vm.keyExistsJson(json, key)) break;
            _check(_load(json, key));
        }
        assertGt(count, 0, "no vectors");
        console2.log("vectors checked:", count);
    }

    function _load(string memory json, string memory key) internal pure returns (Vector memory v) {
        v.name = vm.parseJsonString(json, string.concat(key, ".name"));
        v.source = vm.parseJsonString(json, string.concat(key, ".source"));
        v.tokenInIsLt = vm.parseJsonBool(json, string.concat(key, ".tokenInIsLt"));
        v.isExactIn = vm.parseJsonBool(json, string.concat(key, ".isExactIn"));
        v.decimalsLt = vm.parseJsonUint(json, string.concat(key, ".decimalsLt"));
        v.decimalsGt = vm.parseJsonUint(json, string.concat(key, ".decimalsGt"));
        v.priceGtPerLt = _uint(json, key, ".priceGtPerLt");
        v.a = _uint(json, key, ".A");
        v.gamma = _uint(json, key, ".gamma");
        v.midFee = _uint(json, key, ".midFee");
        v.outFee = _uint(json, key, ".outFee");
        v.feeGamma = _uint(json, key, ".feeGamma");
        v.balanceIn = _uint(json, key, ".balanceIn");
        v.balanceOut = _uint(json, key, ".balanceOut");
        v.amount = _uint(json, key, ".amount");
        v.expected = _uint(json, key, ".expected");
        v.expectedD = _uint(json, key, ".expectedD");
        v.relTolerance = _uint(json, key, ".relTolerance");
        v.absTolerance = _uint(json, key, ".absTolerance");
    }

    function _uint(string memory json, string memory key, string memory field) internal pure returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, string.concat(key, field)));
    }

    function _check(Vector memory v) internal pure {
        FXSwapArgsBuilder.Args memory args;
        args.a = uint64(v.a);
        args.gamma = uint64(v.gamma);
        args.midFee = uint64(v.midFee);
        args.outFee = uint64(v.outFee);
        args.feeGamma = uint64(v.feeGamma);
        args.rateLt = uint64(10 ** (18 - v.decimalsLt));
        args.rateGt = uint64(10 ** (18 - v.decimalsGt));

        (uint256 result, uint256 d) = FXSwapPricing.quote(
            args, v.priceGtPerLt, v.tokenInIsLt, v.isExactIn, v.balanceIn, v.balanceOut, v.amount
        );

        uint256 tol = Math.max(v.absTolerance, v.expected * v.relTolerance / 1e18);
        assertApproxEqAbs(result, v.expected, tol, string.concat(v.name, ": result"));
        if (v.expectedD != 0) {
            uint256 tolD = Math.max(v.absTolerance, v.expectedD * v.relTolerance / 1e18);
            assertApproxEqAbs(d, v.expectedD, tolD, string.concat(v.name, ": D"));
        }
        if (keccak256(bytes(v.source)) == keccak256("self-generated")) {
            if (v.isExactIn) assertLe(result, v.expected, string.concat(v.name, ": exact-in must not exceed reference"));
            else assertGe(result, v.expected, string.concat(v.name, ": exact-out must not undercut reference"));
        }
    }
}
