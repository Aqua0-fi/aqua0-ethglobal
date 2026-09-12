// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test, console2 } from "forge-std/Test.sol";

import { AquaRouter } from "@1inch/aqua/src/AquaRouter.sol";
import { ISwapVM } from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/libs/TakerTraits.sol";
import { IPriceOracle } from "@1inch/swap-vm/instructions/interfaces/IPriceOracle.sol";

import { AquaForexSwapVMRouter } from "../src/routers/AquaForexSwapVMRouter.sol";
import { ForexCurve, ForexCurveArgsBuilder } from "../src/instructions/ForexCurve.sol";
import { ForexCurveMath } from "../src/libs/ForexCurveMath.sol";
import { ManualFxOracle } from "../src/mocks/ManualFxOracle.sol";

import { TestERC20 } from "./mocks/TestERC20.sol";
import { ForexCurveMathHarness } from "./ForexCurveVectors.t.sol";

/// @dev External access to the args builder so its reverts can be asserted
contract ForexCurveArgsHarness {
    function build(ForexCurveArgsBuilder.Args memory args) external pure returns (bytes memory) {
        return ForexCurveArgsBuilder.build(args);
    }

    function parse(bytes calldata data) external pure returns (ForexCurveArgsBuilder.Args memory) {
        return ForexCurveArgsBuilder.parse(data);
    }

    function maxFeeLimit(uint256 alpha) external pure returns (uint256) {
        return ForexCurveArgsBuilder.maxFeeLimit(alpha);
    }

    function pairFields(address quoteToken, uint8 quoteDecimals, address localToken, uint8 localDecimals, bool invert)
        external
        pure
        returns (uint8, uint64, uint64)
    {
        return ForexCurveArgsBuilder.pairFields(quoteToken, quoteDecimals, localToken, localDecimals, invert);
    }
}

/// @title ForexCurveTest
/// @notice ForexCurve through a real AquaForexSwapVMRouter and AquaRouter: a maker ships USDC (6 dp) / BRL (18 dp) balances
///         behind a `[Salt][ForexCurve]` program, a taker swaps with transferFrom + Aqua push. The BRL feed quotes USD per
///         1 BRL with 8 decimals (like the RedStone BRL feed); the ARS case uses an ARS-per-USD feed and FLAG_INVERT_PRICE.
///         Parameters are the recommended α 0.5, β 0.15, δ 0.5, MAX 0.25, λ 0.3, ε 30 bp.
contract ForexCurveTest is Test {
    uint8 internal constant OP_SALT = 20;
    uint8 internal constant OP_FOREX_CURVE = 34;

    address internal constant LOW = address(0x1000000000000000000000000000000000000001);
    address internal constant MID = address(0x8000000000000000000000000000000000000001);
    address internal constant HIGH = address(0xF000000000000000000000000000000000000001);

    uint256 internal constant USDC_BALANCE = 100_000e6;
    uint256 internal constant BRL_BALANCE = 500_000e18; // value-balanced at 0.2 USD per BRL
    bytes32 internal constant SALT = keccak256("forex curve test");

    AquaRouter internal aqua;
    AquaForexSwapVMRouter internal router;
    ManualFxOracle internal brlFeed;
    ForexCurveArgsHarness internal harness;
    ForexCurveMathHarness internal math;
    TestERC20 internal usdc;
    TestERC20 internal brl;

    address internal maker = makeAddr("maker");
    address internal taker = makeAddr("taker");

    function setUp() public {
        vm.warp(1_750_000_000);
        aqua = new AquaRouter();
        router = new AquaForexSwapVMRouter(address(aqua), address(0), address(this), "AquaSwapVMRouter", "1.0.2-forex");
        brlFeed = new ManualFxOracle(address(this), 8, "BRL / USD (USD per 1 BRL)", 0.2e8);
        harness = new ForexCurveArgsHarness();
        math = new ForexCurveMathHarness();
        _deployTokens(true);
    }

    // ═══════════════════════════════ helpers ═══════════════════════════════

    /// @dev usdcIsLt: USDC gets the lower address (flags without FLAG_QUOTE_IS_GT) or the higher one
    function _deployTokens(bool usdcIsLt) internal {
        deployCodeTo("TestERC20.sol:TestERC20", abi.encode("Test USDC", "USDC", uint8(6)), usdcIsLt ? LOW : HIGH);
        deployCodeTo("TestERC20.sol:TestERC20", abi.encode("Test BRL", "BRL", uint8(18)), MID);
        usdc = TestERC20(usdcIsLt ? LOW : HIGH);
        brl = TestERC20(MID);
    }

    function _config() internal view returns (ForexCurveArgsBuilder.Args memory cfg) {
        (uint8 flags, uint64 rateLt, uint64 rateGt) = ForexCurveArgsBuilder.pairFields(address(usdc), 6, address(brl), 18, false);
        cfg = ForexCurveArgsBuilder.Args({
            oracleKind: ForexCurveArgsBuilder.ORACLE_KIND_CHAINLINK,
            flags: flags,
            oracle: address(brlFeed),
            oracleDecimals: 8,
            maxStaleness: 1 hours,
            minPrice: 0.1e18,
            maxPrice: 0.4e18,
            alpha: 0.5e18,
            beta: 0.15e18,
            delta: 0.5e18,
            maxFee: 0.25e18,
            lambda: 0.3e18,
            epsilon: 0.003e18,
            rateLt: rateLt,
            rateGt: rateGt
        });
    }

    function _program(ForexCurveArgsBuilder.Args memory cfg) internal pure returns (bytes memory) {
        return bytes.concat(
            abi.encodePacked(OP_SALT, uint8(32), SALT),
            abi.encodePacked(OP_FOREX_CURVE, uint8(ForexCurveArgsBuilder.ARGS_LENGTH), ForexCurveArgsBuilder.build(cfg))
        );
    }

    function _order(bytes memory program) internal view returns (ISwapVM.Order memory) {
        return MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: maker,
                receiver: address(0),
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: true,
                allowZeroAmountIn: false,
                hasPreTransferInHook: false,
                hasPostTransferInHook: false,
                hasPreTransferOutHook: false,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: address(0),
                postTransferInData: "",
                preTransferOutTarget: address(0),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: program
            })
        );
    }

    function _ship(ISwapVM.Order memory order, uint256 usdcAmount, uint256 localAmount) internal returns (bytes32 hash) {
        usdc.mint(maker, usdcAmount);
        brl.mint(maker, localAmount);
        address[] memory tokens = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        (tokens[0], tokens[1], amounts[0], amounts[1]) = (address(usdc), address(brl), usdcAmount, localAmount);
        vm.startPrank(maker);
        usdc.approve(address(aqua), type(uint256).max);
        brl.approve(address(aqua), type(uint256).max);
        hash = aqua.ship(address(router), abi.encode(order), tokens, amounts);
        vm.stopPrank();
        assertEq(hash, router.hash(order), "Aqua strategy hash == order hash");
    }

    function _shipDefault() internal returns (ISwapVM.Order memory order) {
        order = _order(_program(_config()));
        _ship(order, USDC_BALANCE, BRL_BALANCE);
    }

    function _takerData(bool isExactIn) internal view returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: taker,
                isExactIn: isExactIn,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: true,
                threshold: "",
                to: address(0),
                deadline: 0,
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: "",
                signature: ""
            })
        );
    }

    function _swap(ISwapVM.Order memory order, TestERC20 tokenIn, TestERC20 tokenOut, uint256 amount, bool isExactIn)
        internal
        returns (uint256 amountIn, uint256 amountOut)
    {
        tokenIn.mint(taker, isExactIn ? amount : 10 * amount + 1e30);
        vm.startPrank(taker);
        tokenIn.approve(address(router), type(uint256).max);
        (amountIn, amountOut,) = router.swap(order, address(tokenIn), address(tokenOut), amount, _takerData(isExactIn));
        vm.stopPrank();
    }

    function _quote(ISwapVM.Order memory order, TestERC20 tokenIn, TestERC20 tokenOut, uint256 amount, bool isExactIn)
        internal
        returns (uint256 amountIn, uint256 amountOut)
    {
        vm.prank(taker);
        (amountIn, amountOut,) = router.quote(order, address(tokenIn), address(tokenOut), amount, _takerData(isExactIn));
    }

    function _balances(ISwapVM.Order memory order) internal view returns (uint256 usdcAqua, uint256 brlAqua) {
        bytes32 hash = router.hash(order);
        (usdcAqua,) = aqua.rawBalances(maker, address(router), hash, address(usdc));
        (brlAqua,) = aqua.rawBalances(maker, address(router), hash, address(brl));
    }

    function _params(ForexCurveArgsBuilder.Args memory cfg) internal pure returns (ForexCurveMath.Params memory) {
        return ForexCurveArgsBuilder.params(cfg);
    }

    // ═══════════════════════════════ deployment ═══════════════════════════════

    function test_RouterFitsEip170AndIsAquaRouter() public view {
        uint256 size = address(router).code.length;
        console2.log("AquaForexSwapVMRouter runtime bytes:", size);
        assertLe(size, 24_576, "EIP-170");
        (, string memory name, string memory version,,,,) = router.eip712Domain();
        assertEq(name, "AquaSwapVMRouter", "AquaAdapter only accepts this domain name");
        assertEq(version, "1.0.2-forex");
        assertEq(address(router.AQUA()), address(aqua));
    }

    // ═══════════════════════════════ pricing inside the band: the oracle price, ε only ═══════════════════════════════

    function _checkAllDirections(bool usdcIsLt) internal {
        _deployTokens(usdcIsLt);
        ISwapVM.Order memory order = _shipDefault();

        // 100 USDC at 5 BRL per USD, minus 30 bp
        (uint256 amountIn, uint256 amountOut) = _swap(order, usdc, brl, 100e6, true);
        assertEq(amountIn, 100e6);
        assertEq(amountOut, 498.5e18, "USDC -> BRL exact in");
        (uint256 usdcAqua, uint256 brlAqua) = _balances(order);
        assertEq(usdcAqua, USDC_BALANCE + 100e6, "maker USDC balance");
        assertEq(brlAqua, BRL_BALANCE - 498.5e18, "maker BRL balance");

        (amountIn, amountOut) = _swap(order, brl, usdc, 500e18, true);
        assertEq(amountOut, 99.7e6, "BRL -> USDC exact in");

        (amountIn, amountOut) = _swap(order, usdc, brl, 500e18, false);
        assertEq(amountOut, 500e18);
        assertEq(amountIn, 100.3e6, "USDC -> BRL exact out");

        (amountIn, amountOut) = _swap(order, brl, usdc, 100e6, false);
        assertEq(amountOut, 100e6);
        assertEq(amountIn, 501.5e18, "BRL -> USDC exact out");
    }

    function test_AllDirections_UsdcLowerAddress() public {
        _checkAllDirections(true);
    }

    function test_AllDirections_UsdcGreaterAddress_QuoteIsGtFlag() public {
        _checkAllDirections(false);
        assertEq(_config().flags, ForexCurveArgsBuilder.FLAG_QUOTE_IS_GT);
    }

    function test_QuoteEqualsSwap() public {
        ISwapVM.Order memory order = _shipDefault();
        (uint256 qIn, uint256 qOut) = _quote(order, usdc, brl, 7_777e6, true);
        (uint256 sIn, uint256 sOut) = _swap(order, usdc, brl, 7_777e6, true);
        assertEq(qIn, sIn);
        assertEq(qOut, sOut);
        (qIn, qOut) = _quote(order, brl, usdc, 12_345e6, false);
        (sIn, sOut) = _swap(order, brl, usdc, 12_345e6, false);
        assertEq(qIn, sIn);
        assertEq(qOut, sOut);
    }

    function test_PriceMove_InBandQuotesFollowExactly() public {
        ISwapVM.Order memory order = _shipDefault();
        brlFeed.setAnswer(0.25e8);
        (, uint256 out) = _quote(order, usdc, brl, 100e6, true);
        assertEq(out, 398.8e18, "100 USDC at 4 BRL per USD minus 30 bp");
        (, uint256 swapped) = _swap(order, usdc, brl, 100e6, true);
        assertEq(swapped, out, "swap uses the new price");
    }

    function test_SaltChangesTheStrategyOnly() public {
        ISwapVM.Order memory a = _shipDefault();
        bytes memory other = bytes.concat(
            abi.encodePacked(OP_SALT, uint8(32), keccak256("another salt")),
            abi.encodePacked(OP_FOREX_CURVE, uint8(ForexCurveArgsBuilder.ARGS_LENGTH), ForexCurveArgsBuilder.build(_config()))
        );
        ISwapVM.Order memory b = _order(other);
        _ship(b, USDC_BALANCE, BRL_BALANCE);
        assertTrue(router.hash(a) != router.hash(b), "salt makes a distinct strategy");
        (, uint256 outA) = _quote(a, usdc, brl, 1_000e6, true);
        (, uint256 outB) = _quote(b, usdc, brl, 1_000e6, true);
        assertEq(outA, outB);
    }

    // ═══════════════════════════════ pricing outside the band ═══════════════════════════════

    function test_OutsideBand_RouterMatchesMathAndPaysPremium() public {
        ISwapVM.Order memory order = _shipDefault();
        ForexCurveMath.Params memory params = _params(_config());

        // 40% of the book's USDC value: both assets leave the ±15% band
        (, uint256 out) = _quote(order, usdc, brl, 40_000e6, true);
        (, uint256 expected) = math.quote(params, 0.2e18, USDC_BALANCE * 1e12, BRL_BALANCE, 0, true, true, 40_000e18);
        assertEq(out, expected, "instruction == ForexCurveMath");
        assertApproxEqRel(out, 175_353.565169877e18, 1e9, "reference fxforex_math.quote");
        assertLt(out, 200_000e18 * 997 / 1000, "worse than the oracle rate");

        (uint256 inBrl,) = _quote(order, brl, usdc, 40_000e6, false);
        (uint256 expectedIn,) = math.quote(params, 0.2e18, USDC_BALANCE * 1e12, BRL_BALANCE, 0, false, false, 40_000e18);
        assertEq(inBrl, expectedIn, "instruction == ForexCurveMath (exact out)");
        assertApproxEqRel(inBrl, 239_196.874061587e18, 1e9, "reference fxforex_math.quote");
    }

    function test_RebalancingTradeGetsLambdaRebate() public {
        ISwapVM.Order memory order = _shipDefault();
        _swap(order, usdc, brl, 40_000e6, true); // push the book outside the band
        (uint256 usdcAqua, uint256 brlAqua) = _balances(order);
        // Selling BRL back rebalances: the fee shrinks and λ of it is returned, so the rate beats the oracle before ε
        (, uint256 back) = _quote(order, brl, usdc, 50_000e18, true);
        assertGt(back, 10_000e6 * 997 / 1000, "rebate on a rebalancing trade");
        ForexCurveMath.Params memory params = _params(_config());
        (, uint256 expected) = math.quote(params, 0.2e18, usdcAqua * 1e12, brlAqua, 0, false, true, 50_000e18);
        assertEq(back, expected / 1e12);
    }

    function test_NoProfitableRoundTrip() public {
        ISwapVM.Order memory order = _shipDefault();
        (, uint256 brlOut) = _swap(order, usdc, brl, 40_000e6, true);
        (, uint256 usdcBack) = _swap(order, brl, usdc, brlOut, true);
        assertLt(usdcBack, 40_000e6, "round trip loses at least epsilon");
    }

    // ═══════════════════════════════ halts and drains ═══════════════════════════════

    function test_Reverts_Halts() public {
        ISwapVM.Order memory order = _shipDefault();
        vm.expectRevert(ForexCurveMath.ForexCurveUpperHalt.selector);
        _quote(order, usdc, brl, 60_000e6, true);
        vm.expectRevert(ForexCurveMath.ForexCurveLowerHalt.selector);
        _quote(order, brl, usdc, 300_000e18, true);
        vm.expectRevert(ForexCurveMath.ForexCurveUpperHalt.selector);
        _quote(order, usdc, brl, 300_000e18, false);
        vm.expectRevert(ForexCurveMath.ForexCurveLowerHalt.selector);
        _quote(order, brl, usdc, 60_000e6, false);
    }

    function test_Reverts_Drain() public {
        ISwapVM.Order memory order = _shipDefault();
        vm.expectRevert(ForexCurveMath.ForexCurveDrain.selector);
        _quote(order, usdc, brl, BRL_BALANCE, false);
        vm.expectRevert(ForexCurveMath.ForexCurveDrain.selector);
        _quote(order, brl, usdc, USDC_BALANCE + 1, false);
    }

    // ═══════════════════════════════ oracle ═══════════════════════════════

    function test_InvertedFeed_ArsPerUsd_MatchesDirectFeed() public {
        ManualFxOracle arsPerUsd = new ManualFxOracle(address(this), 8, "ARS / USD", 1400e8);
        uint256 usdPerArs = uint256(1e36) / 1400e18;
        ManualFxOracle usdPerArsFeed = new ManualFxOracle(address(this), 18, "USD per 1 ARS", int256(usdPerArs));

        ForexCurveArgsBuilder.Args memory inverted = _config();
        (inverted.flags, inverted.rateLt, inverted.rateGt) =
            ForexCurveArgsBuilder.pairFields(address(usdc), 6, address(brl), 18, true);
        assertEq(inverted.flags, ForexCurveArgsBuilder.FLAG_INVERT_PRICE);
        (inverted.oracle, inverted.oracleDecimals, inverted.minPrice, inverted.maxPrice) =
            (address(arsPerUsd), 8, 700e18, 2800e18);
        ISwapVM.Order memory viaInverted = _order(_program(inverted));
        _ship(viaInverted, USDC_BALANCE, 140_000_000e18);

        ForexCurveArgsBuilder.Args memory direct = _config();
        (direct.oracle, direct.oracleDecimals, direct.minPrice, direct.maxPrice) =
            (address(usdPerArsFeed), 18, uint128(usdPerArs), uint128(usdPerArs));
        ISwapVM.Order memory viaDirect = _order(_program(direct));
        _ship(viaDirect, USDC_BALANCE, 140_000_000e18);

        (, uint256 a) = _quote(viaInverted, usdc, brl, 100e6, true);
        (, uint256 b) = _quote(viaDirect, usdc, brl, 100e6, true);
        assertEq(a, b, "p = 1e36 / answer");
        assertApproxEqRel(a, 139_580e18, 1e3, "100 USDC at 1400 ARS per USD minus 30 bp");

        // The band is checked on the feed's own orientation, before inversion
        arsPerUsd.setAnswer(2801e8);
        vm.expectRevert(abi.encodeWithSelector(ForexCurve.ForexCurveOraclePriceOutOfBand.selector, 2801e18, 700e18, 2800e18));
        _quote(viaInverted, usdc, brl, 100e6, true);
    }

    function test_OracleDecimalsZero_ReadsFeedDecimals() public {
        ISwapVM.Order memory declared = _shipDefault();
        (, uint256 a) = _quote(declared, usdc, brl, 1_000e6, true);
        ForexCurveArgsBuilder.Args memory cfg = _config();
        cfg.oracleDecimals = 0;
        ISwapVM.Order memory fetched = _order(_program(cfg));
        _ship(fetched, USDC_BALANCE, BRL_BALANCE);
        (, uint256 b) = _quote(fetched, usdc, brl, 1_000e6, true);
        assertEq(a, b);
    }

    function test_Reverts_StaleOracle() public {
        ISwapVM.Order memory order = _shipDefault();
        vm.warp(block.timestamp + 1 hours + 1);
        usdc.mint(taker, 100e6);
        vm.startPrank(taker);
        usdc.approve(address(router), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(ForexCurve.ForexCurveOracleStale.selector, block.timestamp - 1 hours - 1, 1 hours, block.timestamp)
        );
        router.swap(order, address(usdc), address(brl), 100e6, _takerData(true));
        vm.stopPrank();
    }

    function test_Reverts_OracleUpdatedInFuture() public {
        ISwapVM.Order memory order = _shipDefault();
        vm.mockCall(
            address(brlFeed),
            abi.encodeWithSelector(IPriceOracle.latestRoundData.selector),
            abi.encode(uint80(2), int256(0.2e8), block.timestamp, block.timestamp + 10, uint80(2))
        );
        vm.expectPartialRevert(ForexCurve.ForexCurveOracleStale.selector);
        _quote(order, usdc, brl, 100e6, true);
    }

    function test_Reverts_PriceOutOfBand() public {
        ISwapVM.Order memory order = _shipDefault();
        brlFeed.setAnswer(0.41e8);
        vm.expectRevert(abi.encodeWithSelector(ForexCurve.ForexCurveOraclePriceOutOfBand.selector, 0.41e18, 0.1e18, 0.4e18));
        _quote(order, usdc, brl, 100e6, true);

        brlFeed.setAnswer(0.09e8);
        vm.expectRevert(abi.encodeWithSelector(ForexCurve.ForexCurveOraclePriceOutOfBand.selector, 0.09e18, 0.1e18, 0.4e18));
        _quote(order, usdc, brl, 100e6, true);
    }

    function test_Reverts_NonPositiveAnswer() public {
        ISwapVM.Order memory order = _shipDefault();
        vm.mockCall(
            address(brlFeed),
            abi.encodeWithSelector(IPriceOracle.latestRoundData.selector),
            abi.encode(uint80(2), int256(-1), block.timestamp, block.timestamp, uint80(2))
        );
        vm.expectRevert(abi.encodeWithSelector(ForexCurve.ForexCurveOracleInvalidAnswer.selector, int256(-1)));
        _quote(order, usdc, brl, 100e6, true);
    }

    function test_Reverts_RecomputeDetected() public {
        bytes memory fx = abi.encodePacked(
            OP_FOREX_CURVE, uint8(ForexCurveArgsBuilder.ARGS_LENGTH), ForexCurveArgsBuilder.build(_config())
        );
        ISwapVM.Order memory order = _order(bytes.concat(_program(_config()), fx));
        _ship(order, USDC_BALANCE, BRL_BALANCE);
        vm.expectRevert(ForexCurve.ForexCurveRecomputeDetected.selector);
        _quote(order, usdc, brl, 100e6, true);
        vm.expectRevert(ForexCurve.ForexCurveRecomputeDetected.selector);
        _quote(order, usdc, brl, 100e18, false);
    }

    // ═══════════════════════════════ args ═══════════════════════════════

    function test_Args_RoundTripAndOffsets() public view {
        ForexCurveArgsBuilder.Args memory cfg = _config();
        cfg.flags = ForexCurveArgsBuilder.FLAG_INVERT_PRICE | ForexCurveArgsBuilder.FLAG_QUOTE_IS_GT;
        bytes memory packed = harness.build(cfg);
        assertEq(packed.length, 123);
        assertEq(keccak256(abi.encode(harness.parse(packed))), keccak256(abi.encode(cfg)));
        assertEq(uint8(packed[0]), 0);
        assertEq(uint8(packed[1]), 3);
        assertEq(address(bytes20(this.slice(packed, 2, 22))), address(brlFeed));
        assertEq(uint8(packed[22]), 8);
        assertEq(uint32(bytes4(this.slice(packed, 23, 27))), 1 hours);
        assertEq(uint128(bytes16(this.slice(packed, 27, 43))), 0.1e18);
        assertEq(uint128(bytes16(this.slice(packed, 43, 59))), 0.4e18);
        assertEq(uint64(bytes8(this.slice(packed, 59, 67))), 0.5e18);
        assertEq(uint64(bytes8(this.slice(packed, 67, 75))), 0.15e18);
        assertEq(uint64(bytes8(this.slice(packed, 75, 83))), 0.5e18);
        assertEq(uint64(bytes8(this.slice(packed, 83, 91))), 0.25e18);
        assertEq(uint64(bytes8(this.slice(packed, 91, 99))), 0.3e18);
        assertEq(uint64(bytes8(this.slice(packed, 99, 107))), 0.003e18);
        assertEq(uint64(bytes8(this.slice(packed, 107, 115))), cfg.rateLt);
        assertEq(uint64(bytes8(this.slice(packed, 115, 123))), cfg.rateGt);
    }

    function slice(bytes calldata data, uint256 from, uint256 to) external pure returns (bytes memory) {
        return data[from:to];
    }

    function test_Args_Validation() public {
        ForexCurveArgsBuilder.Args memory cfg = _config();
        cfg.oracleKind = 1;
        vm.expectRevert(ForexCurveArgsBuilder.ForexCurveUnsupportedOracleKind.selector);
        harness.build(cfg);

        cfg = _config();
        cfg.flags = 0x04;
        vm.expectRevert(ForexCurveArgsBuilder.ForexCurveInvalidFlags.selector);
        harness.build(cfg);

        cfg = _config();
        cfg.oracle = address(0);
        vm.expectRevert(ForexCurveArgsBuilder.ForexCurveInvalidOracle.selector);
        harness.build(cfg);

        cfg = _config();
        cfg.maxStaleness = 0;
        vm.expectRevert(ForexCurveArgsBuilder.ForexCurveInvalidMaxStaleness.selector);
        harness.build(cfg);

        cfg = _config();
        cfg.minPrice = 0.5e18;
        vm.expectRevert(ForexCurveArgsBuilder.ForexCurveInvalidPriceBand.selector);
        harness.build(cfg);

        cfg = _config();
        cfg.alpha = 1e18;
        vm.expectRevert(ForexCurveArgsBuilder.ForexCurveInvalidCurve.selector);
        harness.build(cfg);

        cfg = _config();
        cfg.alpha = 0;
        cfg.beta = 0;
        vm.expectRevert(ForexCurveArgsBuilder.ForexCurveInvalidCurve.selector);
        harness.build(cfg);

        cfg = _config();
        cfg.beta = 0.5e18;
        vm.expectRevert(ForexCurveArgsBuilder.ForexCurveInvalidCurve.selector);
        harness.build(cfg);

        // δ has no on-chain bound beyond its 8-byte field (uint64 max ≈ 18.45e18), so there is no δ revert to trigger

        cfg = _config();
        cfg.maxFee = 1e18 + 1;
        vm.expectRevert(ForexCurveArgsBuilder.ForexCurveInvalidFees.selector);
        harness.build(cfg);

        cfg = _config();
        cfg.lambda = 1e18 + 1;
        vm.expectRevert(ForexCurveArgsBuilder.ForexCurveInvalidFees.selector);
        harness.build(cfg);

        cfg = _config();
        cfg.epsilon = 0.1e18;
        vm.expectRevert(ForexCurveArgsBuilder.ForexCurveInvalidFees.selector);
        harness.build(cfg);

        cfg = _config();
        cfg.rateGt = 0;
        vm.expectRevert(ForexCurveArgsBuilder.ForexCurveInvalidRates.selector);
        harness.build(cfg);

        cfg = _config();
        cfg.rateLt = 1e18 + 1;
        vm.expectRevert(ForexCurveArgsBuilder.ForexCurveInvalidRates.selector);
        harness.build(cfg);

        vm.expectRevert(ForexCurveArgsBuilder.ForexCurveInvalidArgsLength.selector);
        harness.parse(new bytes(122));

        // Boundaries that are accepted
        cfg = _config();
        (cfg.alpha, cfg.beta, cfg.delta, cfg.maxFee, cfg.lambda, cfg.epsilon) =
            (1e18 - 1, 0, type(uint64).max, 0.5e18 - 1, 1e18, 0.1e18 - 1);
        harness.build(cfg);
        (cfg.alpha, cfg.maxFee) = (0.5e18, 0.5e18 - 1);
        harness.build(cfg);
    }

    function _withMaxFee(uint64 alpha, uint64 maxFee) internal view returns (ForexCurveArgsBuilder.Args memory cfg) {
        cfg = _config();
        (cfg.alpha, cfg.beta, cfg.maxFee) = (alpha, 0, maxFee);
    }

    function test_Args_MaxFeeBoundIsHalfForEveryAlpha() public {
        // MAX < 1/2 is the only bound, whatever α is
        uint64[4] memory alphas = [uint64(0.3e18), 0.5e18, 0.9e18, 1e18 - 1];
        for (uint256 i; i < alphas.length; ++i) {
            assertEq(harness.maxFeeLimit(alphas[i]), 0.5e18 - 1, "maxFeeLimit is 0.5e18 - 1 for every alpha");
            harness.build(_withMaxFee(alphas[i], 0.5e18 - 1));
            vm.expectRevert(ForexCurveArgsBuilder.ForexCurveInvalidFees.selector);
            harness.build(_withMaxFee(alphas[i], 0.5e18));
        }
        vm.expectRevert(ForexCurveArgsBuilder.ForexCurveInvalidFees.selector);
        harness.build(_withMaxFee(0.5e18, 0.5e18 + 1));

        // The instruction parses on every swap: hand-packed args above the limit revert inside the router
        bytes memory packed = ForexCurveArgsBuilder.build(_withMaxFee(0.5e18, 0.5e18 - 1));
        for (uint256 i; i < 8; ++i) {
            packed[83 + i] = bytes1(uint8(uint256(0.5e18) >> (8 * (7 - i))));
        }
        vm.expectRevert(ForexCurveArgsBuilder.ForexCurveInvalidFees.selector);
        harness.parse(packed);
        ISwapVM.Order memory order = _order(
            bytes.concat(abi.encodePacked(OP_SALT, uint8(32), SALT), abi.encodePacked(OP_FOREX_CURVE, uint8(123), packed))
        );
        _ship(order, USDC_BALANCE, BRL_BALANCE);
        vm.expectRevert(ForexCurveArgsBuilder.ForexCurveInvalidFees.selector);
        _quote(order, usdc, brl, 100e6, true);
    }

    /// @dev Tomás's no_flat_zone set (α 0.9, β 0, δ 0.15, MAX 0.25, λ 0.3) validates and trades through the router. With
    ///      β = 0 every trade pays the inventory fee.
    function test_NoFlatZoneSet_ValidatesAndSwapsThroughRouter() public {
        ForexCurveArgsBuilder.Args memory cfg = _config();
        (cfg.alpha, cfg.beta, cfg.delta, cfg.maxFee, cfg.lambda) = (0.9e18, 0, 0.15e18, 0.25e18, 0.3e18);
        assertEq(keccak256(abi.encode(harness.parse(harness.build(cfg)))), keccak256(abi.encode(cfg)), "validates");
        ISwapVM.Order memory order = _order(_program(cfg));
        _ship(order, USDC_BALANCE, BRL_BALANCE);
        ForexCurveMath.Params memory params = _params(cfg);

        // 10,000 USDC in: the book leaves the even split, so the rate is below the oracle's even before ε
        (, uint256 quoted) = _quote(order, usdc, brl, 10_000e6, true);
        (uint256 amountIn, uint256 amountOut) = _swap(order, usdc, brl, 10_000e6, true);
        assertEq(amountIn, 10_000e6);
        assertEq(amountOut, quoted, "quote == swap");
        (, uint256 expected) = math.quote(params, 0.2e18, USDC_BALANCE * 1e12, BRL_BALANCE, 0, true, true, 10_000e18);
        assertEq(amountOut, expected, "instruction == ForexCurveMath");
        assertLt(amountOut, 50_000e18 * 997 / 1000, "inventory fee on top of epsilon");
        (uint256 usdcAqua, uint256 brlAqua) = _balances(order);
        assertEq(usdcAqua, USDC_BALANCE + 10_000e6, "maker USDC balance");
        assertEq(brlAqua, BRL_BALANCE - amountOut, "maker BRL balance");

        // Exact out the other way rebalances the book
        (amountIn, amountOut) = _swap(order, brl, usdc, 5_000e6, false);
        assertEq(amountOut, 5_000e6);
        (uint256 expectedIn,) = math.quote(params, 0.2e18, usdcAqua * 1e12, brlAqua, 0, false, false, 5_000e18);
        assertEq(amountIn, expectedIn, "instruction == ForexCurveMath (exact out)");
        (uint256 usdcAfter, uint256 brlAfter) = _balances(order);
        assertEq(usdcAfter, usdcAqua - 5_000e6, "maker USDC balance after exact out");
        assertEq(brlAfter, brlAqua + amountIn, "maker BRL balance after exact out");
    }

    function test_PairFields() public view {
        address usdcArc = 0x3600000000000000000000000000000000000000;
        address brat = 0xa9482a878A3784663512f0Bf8d0be17aD6DEA38E;
        address argt = 0xd8dE250970842A581f89E885dA0F5165037714Ef;
        (uint8 flags, uint64 rateLt, uint64 rateGt) = harness.pairFields(usdcArc, 6, brat, 18, false);
        assertEq(flags, 0);
        assertEq(rateLt, 1e12);
        assertEq(rateGt, 1);
        (flags, rateLt, rateGt) = harness.pairFields(usdcArc, 6, argt, 18, true);
        assertEq(flags, ForexCurveArgsBuilder.FLAG_INVERT_PRICE);
        (flags, rateLt, rateGt) = harness.pairFields(usdcArc, 6, address(1), 8, false);
        assertEq(flags, ForexCurveArgsBuilder.FLAG_QUOTE_IS_GT);
        assertEq(rateLt, 1e10);
        assertEq(rateGt, 1e12);
    }

    // ═══════════════════════════════ gas ═══════════════════════════════

    function test_Gas_Swap() public {
        ISwapVM.Order memory order = _shipDefault();
        usdc.mint(taker, 1e30);
        brl.mint(taker, 1e30);
        vm.startPrank(taker);
        usdc.approve(address(router), type(uint256).max);
        brl.approve(address(router), type(uint256).max);
        // Warm the balances so the measurement reflects a steady-state swap
        router.swap(order, address(usdc), address(brl), 1e6, _takerData(true));

        uint256 g = gasleft();
        router.swap(order, address(usdc), address(brl), 1_000e6, _takerData(true));
        uint256 inBand = g - gasleft();
        g = gasleft();
        router.swap(order, address(usdc), address(brl), 40_000e6, _takerData(true));
        uint256 outOfBand = g - gasleft();
        g = gasleft();
        router.swap(order, address(usdc), address(brl), 10_000e18, _takerData(false));
        uint256 outOfBandExactOut = g - gasleft();
        vm.stopPrank();
        console2.log("gas router.swap exact in, inside the band (oracle + ForexCurve + Aqua):", inBand);
        console2.log("gas router.swap exact in, leaving the band:", outOfBand);
        console2.log("gas router.swap exact out, outside the band:", outOfBandExactOut);
    }
}
