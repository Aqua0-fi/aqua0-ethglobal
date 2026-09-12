// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Generates packages/shared/test/fixtures/fxswap-args-vectors.json from the authoritative Solidity
// FXSwapArgsBuilder (packages/contracts/src/instructions/FXSwap.sol), so the TypeScript encoder in
// packages/shared/src/swapvm.ts can be checked byte for byte. Not part of any build.
//
// Regenerate: copy this file into a scratch Foundry project whose remappings resolve
//   forge-std/, @openzeppelin/contracts/, @1inch/swap-vm/ (as in packages/contracts/remappings.txt) and
//   aqua0-contracts/ -> packages/contracts/src/
// with fs_permissions allowing writes to VECTORS_OUT, then run
//   VECTORS_OUT=/abs/path/fxswap-args-vectors.json forge script FXSwapArgsVectors.s.sol

import { Script } from "forge-std/Script.sol";

import { FXSwapArgsBuilder } from "aqua0-contracts/instructions/FXSwap.sol";

contract FXSwapArgsVectors is Script {
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant ARGT = 0xd8dE250970842A581f89E885dA0F5165037714Ef;
    address internal constant BRAT = 0xa9482a878A3784663512f0Bf8d0be17aD6DEA38E;
    address internal constant ARS_FEED = 0xc05A3Fb016f973C82b0232EF50336d4C0466E70C;
    address internal constant BRL_FEED = 0x1AE6542b9da89Ed2AEf00600710Bba75DbFF5e71;

    string internal json = "vectors";

    function run() external {
        string memory out = vm.envString("VECTORS_OUT");
        string memory vectors;

        // 1. USDC/ARS demo defaults: feed decimals read on swap, 7 day staleness, 700..2800 band, A 100, gamma 0.1
        {
            (bool invert, uint64 rateLt, uint64 rateGt) = FXSwapArgsBuilder.orientation(USDC, 6, ARGT, 18);
            FXSwapArgsBuilder.Args memory args = FXSwapArgsBuilder.Args({
                oracleKind: 0,
                flags: invert ? 1 : 0,
                oracle: ARS_FEED,
                oracleDecimals: 0,
                maxStaleness: 604_800,
                minPrice: 700e18,
                maxPrice: 2800e18,
                a: 1_000_000,
                gamma: 1e17,
                midFee: 1e15,
                outFee: 1e16,
                feeGamma: 3e16,
                rateLt: rateLt,
                rateGt: rateGt
            });
            vectors = _vector("usdc-ars-defaults", args, 0, false);
        }

        // 2. USDC/BRL with a flat input fee prefix, explicit feed decimals, flat-fee curve (midFee == outFee, feeGamma 0)
        {
            (bool invert, uint64 rateLt, uint64 rateGt) = FXSwapArgsBuilder.orientation(USDC, 6, BRAT, 18);
            FXSwapArgsBuilder.Args memory args = FXSwapArgsBuilder.Args({
                oracleKind: 0,
                flags: invert ? 1 : 0,
                oracle: BRL_FEED,
                oracleDecimals: 8,
                maxStaleness: 86_400,
                minPrice: 2.75e18,
                maxPrice: 11e18,
                a: 2_505_000,
                gamma: 1e10,
                midFee: 5e14,
                outFee: 5e14,
                feeGamma: 0,
                rateLt: rateLt,
                rateGt: rateGt
            });
            vectors = _vector("usdc-brl-flat-fee", args, 3_000_000, true);
        }

        // 3. Inverted feed orientation and every field at its extreme, to pin big-endian widths
        {
            (bool invert, uint64 rateLt, uint64 rateGt) = FXSwapArgsBuilder.orientation(ARGT, 18, USDC, 6);
            FXSwapArgsBuilder.Args memory args = FXSwapArgsBuilder.Args({
                oracleKind: 0,
                flags: invert ? 1 : 0,
                oracle: 0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF,
                oracleDecimals: 255,
                maxStaleness: type(uint32).max,
                minPrice: 1,
                maxPrice: type(uint128).max,
                a: 10_000_000_000,
                gamma: 1e18,
                midFee: 0,
                outFee: 5e17,
                feeGamma: 1e18,
                rateLt: rateLt,
                rateGt: rateGt
            });
            vectors = _vector("inverted-extremes", args, 999_999_999, true);
        }

        // Orientation helper outputs
        string memory o = "orientation";
        _orientation(o, "usdc6-argt18", USDC, 6, ARGT, 18);
        _orientation(o, "argt18-usdc6", ARGT, 18, USDC, 6);
        _orientation(o, "usdc6-brat18", USDC, 6, BRAT, 18);
        _orientation(o, "brat18-usdc6", BRAT, 18, USDC, 6);
        string memory orientations = _orientation(o, "low0-high18", address(1), 0, address(2), 18);
        vectors = vm.serializeString(json, "orientation", orientations);

        vm.writeJson(vectors, out);
    }

    function _vector(string memory name, FXSwapArgsBuilder.Args memory args, uint32 flatFeePpb, bool withFlatFee)
        internal
        returns (string memory)
    {
        bytes memory built = FXSwapArgsBuilder.build(args);
        bytes memory fx = abi.encodePacked(uint8(34), uint8(FXSwapArgsBuilder.ARGS_LENGTH), built);
        bytes memory program = withFlatFee ? bytes.concat(abi.encodePacked(uint8(21), uint8(4), flatFeePpb), fx) : fx;

        string memory k = name;
        vm.serializeUint(k, "oracleKind", args.oracleKind);
        vm.serializeUint(k, "flags", args.flags);
        vm.serializeAddress(k, "oracle", args.oracle);
        vm.serializeUint(k, "oracleDecimals", args.oracleDecimals);
        vm.serializeUint(k, "maxStaleness", args.maxStaleness);
        vm.serializeString(k, "minPrice", vm.toString(uint256(args.minPrice)));
        vm.serializeString(k, "maxPrice", vm.toString(uint256(args.maxPrice)));
        vm.serializeString(k, "a", vm.toString(uint256(args.a)));
        vm.serializeString(k, "gamma", vm.toString(uint256(args.gamma)));
        vm.serializeString(k, "midFee", vm.toString(uint256(args.midFee)));
        vm.serializeString(k, "outFee", vm.toString(uint256(args.outFee)));
        vm.serializeString(k, "feeGamma", vm.toString(uint256(args.feeGamma)));
        vm.serializeString(k, "rateLt", vm.toString(uint256(args.rateLt)));
        vm.serializeString(k, "rateGt", vm.toString(uint256(args.rateGt)));
        vm.serializeUint(k, "flatFeePpb", withFlatFee ? flatFeePpb : 0);
        vm.serializeBool(k, "withFlatFee", withFlatFee);
        vm.serializeBytes(k, "program", program);
        string memory vector = vm.serializeBytes(k, "args", built);
        return vm.serializeString(json, name, vector);
    }

    function _orientation(string memory o, string memory name, address base, uint8 bd, address quote, uint8 qd)
        internal
        returns (string memory)
    {
        (bool invert, uint64 rateLt, uint64 rateGt) = FXSwapArgsBuilder.orientation(base, bd, quote, qd);
        string memory k = string.concat("o-", name);
        vm.serializeAddress(k, "base", base);
        vm.serializeUint(k, "baseDecimals", bd);
        vm.serializeAddress(k, "quote", quote);
        vm.serializeUint(k, "quoteDecimals", qd);
        vm.serializeBool(k, "invertPrice", invert);
        vm.serializeString(k, "rateLt", vm.toString(uint256(rateLt)));
        string memory item = vm.serializeString(k, "rateGt", vm.toString(uint256(rateGt)));
        return vm.serializeString(o, name, item);
    }
}
