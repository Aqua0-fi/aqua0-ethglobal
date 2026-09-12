// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Generates packages/shared/test/fixtures/forex-args-vectors.json from the authoritative Solidity
// ForexCurveArgsBuilder (packages/contracts/src/instructions/ForexCurve.sol), so the TypeScript encoder of the
// ForexCurve instruction (AquaForexSwapVMRouter opcode 34, 123-byte args) can be checked byte for byte. Not part of any
// build.
//
// Regenerate: copy this file into a scratch Foundry project whose remappings resolve
//   forge-std/, @openzeppelin/contracts/, @1inch/swap-vm/ (as in packages/contracts/remappings.txt) and
//   aqua0-contracts/ -> packages/contracts/src/
// with fs_permissions allowing writes to VECTORS_OUT, then run
//   VECTORS_OUT=/abs/path/forex-args-vectors.json forge script ForexCurveArgsVectors.s.sol

import { Script } from "forge-std/Script.sol";

import { ForexCurveArgsBuilder } from "aqua0-contracts/instructions/ForexCurve.sol";

contract ForexCurveArgsVectors is Script {
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant ARGT = 0xd8dE250970842A581f89E885dA0F5165037714Ef;
    address internal constant BRAT = 0xa9482a878A3784663512f0Bf8d0be17aD6DEA38E;
    /// @dev Local token below USDC, to exercise FLAG_QUOTE_IS_GT
    address internal constant LOW_LOCAL = 0x1111111111111111111111111111111111111111;
    /// @dev ARS / USD ManualFxOracle (ARS per 1 USD, 8 decimals)
    address internal constant ARS_FEED = 0xc05A3Fb016f973C82b0232EF50336d4C0466E70C;
    /// @dev RedStone BRL feed (USD per 1 BRL, 8 decimals)
    address internal constant REDSTONE_BRL_FEED = 0xac4D10eE7FF790c2E505fBBD6A72d15D7Cbc1796;
    bytes32 internal constant SALT = 0x000000000000000000000000000000000000000000000000000000000000002a;

    string internal json = "vectors";

    function run() external {
        string memory out = vm.envString("VECTORS_OUT");
        string memory vectors;

        // 1. USDC/BRL, recommended parameters (α 0.5, β 0.15, δ 0.5, MAX 0.25, λ 0.3, ε 30 bp), USD-per-BRL feed: no invert
        {
            (uint8 flags, uint64 rateLt, uint64 rateGt) = ForexCurveArgsBuilder.pairFields(USDC, 6, BRAT, 18, false);
            ForexCurveArgsBuilder.Args memory args = _recommended(flags, rateLt, rateGt);
            (args.oracle, args.oracleDecimals, args.maxStaleness) = (REDSTONE_BRL_FEED, 8, 86_400);
            (args.minPrice, args.maxPrice) = (0.1e18, 0.4e18);
            vectors = _vector("usdc-brl-recommended", args, bytes32(0), false);
        }

        // 2. USDC/ARS, recommended parameters, ARS-per-USD feed (FLAG_INVERT_PRICE), feed decimals read on swap
        {
            (uint8 flags, uint64 rateLt, uint64 rateGt) = ForexCurveArgsBuilder.pairFields(USDC, 6, ARGT, 18, true);
            ForexCurveArgsBuilder.Args memory args = _recommended(flags, rateLt, rateGt);
            (args.oracle, args.oracleDecimals, args.maxStaleness) = (ARS_FEED, 0, 604_800);
            (args.minPrice, args.maxPrice) = (700e18, 2800e18);
            vectors = _vector("usdc-ars-recommended", args, bytes32(0), false);
        }

        // 3. USDC/BRL, custom set (DFX production: β 0.35, λ 1, ε 15 bp), behind a Salt (opcode 20) prefix
        {
            (uint8 flags, uint64 rateLt, uint64 rateGt) = ForexCurveArgsBuilder.pairFields(USDC, 6, BRAT, 18, false);
            ForexCurveArgsBuilder.Args memory args = ForexCurveArgsBuilder.Args({
                oracleKind: 0,
                flags: flags,
                oracle: REDSTONE_BRL_FEED,
                oracleDecimals: 8,
                maxStaleness: 3_600,
                minPrice: 0.125e18,
                maxPrice: 0.3e18,
                alpha: 0.5e18,
                beta: 0.35e18,
                delta: 0.5e18,
                maxFee: 0.25e18,
                lambda: 1e18,
                epsilon: 0.0015e18,
                rateLt: rateLt,
                rateGt: rateGt
            });
            vectors = _vector("usdc-brl-custom-salted", args, SALT, true);
        }

        // 4. Quote token at the greater address plus inverted feed, every field at an extreme, to pin big-endian widths.
        //    maxFee is the largest value validate accepts at that α (maxFeeLimit(1e18 − 1) = 0)
        {
            (uint8 flags, uint64 rateLt, uint64 rateGt) = ForexCurveArgsBuilder.pairFields(USDC, 6, LOW_LOCAL, 0, true);
            ForexCurveArgsBuilder.Args memory args = ForexCurveArgsBuilder.Args({
                oracleKind: 0,
                flags: flags,
                oracle: 0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF,
                oracleDecimals: 255,
                maxStaleness: type(uint32).max,
                minPrice: 1,
                maxPrice: type(uint128).max,
                alpha: 1e18 - 1,
                beta: 1e18 - 2,
                delta: type(uint64).max,
                maxFee: uint64(ForexCurveArgsBuilder.maxFeeLimit(1e18 - 1)),
                lambda: 1e18,
                epsilon: 1e17 - 1,
                rateLt: rateLt,
                rateGt: rateGt
            });
            vectors = _vector("quote-is-gt-extremes", args, bytes32(type(uint256).max), true);
        }

        // 5. maxFee at its limit for α = 1/2 (0.5e18 − 1), δ at the uint64 maximum, λ = 0
        {
            (uint8 flags, uint64 rateLt, uint64 rateGt) = ForexCurveArgsBuilder.pairFields(USDC, 6, BRAT, 18, false);
            ForexCurveArgsBuilder.Args memory args = _recommended(flags, rateLt, rateGt);
            (args.oracle, args.oracleDecimals, args.maxStaleness) = (REDSTONE_BRL_FEED, 8, 86_400);
            (args.minPrice, args.maxPrice) = (0.1e18, 0.4e18);
            (args.beta, args.delta, args.lambda) = (0, type(uint64).max, 0);
            args.maxFee = uint64(ForexCurveArgsBuilder.maxFeeLimit(args.alpha));
            vectors = _vector("usdc-brl-maxfee-limit", args, bytes32(0), false);
        }

        // maxFeeLimit(α) for a few α, as decimal strings
        string memory l = "maxFeeLimit";
        vm.serializeString(l, "300000000000000000", vm.toString(ForexCurveArgsBuilder.maxFeeLimit(0.3e18)));
        vm.serializeString(l, "500000000000000000", vm.toString(ForexCurveArgsBuilder.maxFeeLimit(0.5e18)));
        vm.serializeString(l, "600000000000000000", vm.toString(ForexCurveArgsBuilder.maxFeeLimit(0.6e18)));
        vm.serializeString(l, "900000000000000000", vm.toString(ForexCurveArgsBuilder.maxFeeLimit(0.9e18)));
        string memory limits =
            vm.serializeString(l, "999999999999999999", vm.toString(ForexCurveArgsBuilder.maxFeeLimit(1e18 - 1)));
        vectors = vm.serializeString(json, "maxFeeLimit", limits);

        // pairFields helper outputs
        string memory o = "pairFields";
        _pairFields(o, "usdc6-brat18-usd-per-brl", USDC, 6, BRAT, 18, false);
        _pairFields(o, "usdc6-argt18-ars-per-usd", USDC, 6, ARGT, 18, true);
        _pairFields(o, "usdc6-low0-local-per-quote", USDC, 6, LOW_LOCAL, 0, true);
        string memory pairs = _pairFields(o, "usdc6-low0-quote-per-local", USDC, 6, LOW_LOCAL, 0, false);
        vectors = vm.serializeString(json, "pairFields", pairs);

        vm.writeJson(vectors, out);
    }

    function _recommended(uint8 flags, uint64 rateLt, uint64 rateGt)
        internal
        pure
        returns (ForexCurveArgsBuilder.Args memory args)
    {
        args.flags = flags;
        (args.alpha, args.beta, args.delta, args.maxFee, args.lambda, args.epsilon) =
            (0.5e18, 0.15e18, 0.5e18, 0.25e18, 0.3e18, 0.003e18);
        (args.rateLt, args.rateGt) = (rateLt, rateGt);
    }

    function _vector(string memory name, ForexCurveArgsBuilder.Args memory args, bytes32 salt, bool withSalt)
        internal
        returns (string memory)
    {
        bytes memory built = ForexCurveArgsBuilder.build(args);
        bytes memory curve = abi.encodePacked(uint8(34), uint8(ForexCurveArgsBuilder.ARGS_LENGTH), built);
        bytes memory program = withSalt ? bytes.concat(abi.encodePacked(uint8(20), uint8(32), salt), curve) : curve;

        string memory k = name;
        vm.serializeUint(k, "oracleKind", args.oracleKind);
        vm.serializeUint(k, "flags", args.flags);
        vm.serializeAddress(k, "oracle", args.oracle);
        vm.serializeUint(k, "oracleDecimals", args.oracleDecimals);
        vm.serializeUint(k, "maxStaleness", args.maxStaleness);
        vm.serializeString(k, "minPrice", vm.toString(uint256(args.minPrice)));
        vm.serializeString(k, "maxPrice", vm.toString(uint256(args.maxPrice)));
        vm.serializeString(k, "alpha", vm.toString(uint256(args.alpha)));
        vm.serializeString(k, "beta", vm.toString(uint256(args.beta)));
        vm.serializeString(k, "delta", vm.toString(uint256(args.delta)));
        vm.serializeString(k, "maxFee", vm.toString(uint256(args.maxFee)));
        vm.serializeString(k, "lambda", vm.toString(uint256(args.lambda)));
        vm.serializeString(k, "epsilon", vm.toString(uint256(args.epsilon)));
        vm.serializeString(k, "rateLt", vm.toString(uint256(args.rateLt)));
        vm.serializeString(k, "rateGt", vm.toString(uint256(args.rateGt)));
        vm.serializeBool(k, "withSalt", withSalt);
        vm.serializeBytes32(k, "salt", withSalt ? salt : bytes32(0));
        vm.serializeBytes(k, "program", program);
        string memory vector = vm.serializeBytes(k, "args", built);
        return vm.serializeString(json, name, vector);
    }

    function _pairFields(
        string memory o,
        string memory name,
        address quoteToken,
        uint8 quoteDecimals,
        address localToken,
        uint8 localDecimals,
        bool feedQuotesLocalPerQuote
    ) internal returns (string memory) {
        (uint8 flags, uint64 rateLt, uint64 rateGt) =
            ForexCurveArgsBuilder.pairFields(quoteToken, quoteDecimals, localToken, localDecimals, feedQuotesLocalPerQuote);
        string memory k = string.concat("p-", name);
        vm.serializeAddress(k, "quote", quoteToken);
        vm.serializeUint(k, "quoteDecimals", quoteDecimals);
        vm.serializeAddress(k, "local", localToken);
        vm.serializeUint(k, "localDecimals", localDecimals);
        vm.serializeBool(k, "feedQuotesLocalPerQuote", feedQuotesLocalPerQuote);
        vm.serializeUint(k, "flags", flags);
        vm.serializeString(k, "rateLt", vm.toString(uint256(rateLt)));
        string memory item = vm.serializeString(k, "rateGt", vm.toString(uint256(rateGt)));
        return vm.serializeString(o, name, item);
    }
}
