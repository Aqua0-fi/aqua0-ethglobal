// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test, console2 } from "forge-std/Test.sol";

import { AquaRouter } from "@1inch/aqua/src/AquaRouter.sol";
import { ISwapVM } from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/libs/TakerTraits.sol";
import { IPriceOracle } from "@1inch/swap-vm/instructions/interfaces/IPriceOracle.sol";

import { AquaFXSwapVMRouter } from "../src/routers/AquaFXSwapVMRouter.sol";
import { FXSwap, FXSwapArgsBuilder } from "../src/instructions/FXSwap.sol";
import { FXSwapMath } from "../src/libs/FXSwapMath.sol";
import { ManualFxOracle } from "../src/mocks/ManualFxOracle.sol";

import { TestERC20 } from "./mocks/TestERC20.sol";

/// @dev External access to the args builder so its reverts can be asserted
contract FXSwapArgsHarness {
    function build(FXSwapArgsBuilder.Args memory args) external pure returns (bytes memory) {
        return FXSwapArgsBuilder.build(args);
    }

    function parse(bytes calldata data) external pure returns (FXSwapArgsBuilder.Args memory) {
        return FXSwapArgsBuilder.parse(data);
    }
}

/// @title FXSwapTest
/// @notice FXSwap through a real AquaFXSwapVMRouter and AquaRouter: a maker ships USD (6 dp) / ARS (18 dp) balances,
///         a taker swaps with transferFrom + Aqua push. The feed quotes ARS per 1 USD with 8 decimals.
contract FXSwapTest is Test {
    uint8 internal constant OP_FLAT_FEE_IN = 21;
    uint8 internal constant OP_PEGGED_SWAP = 31;
    uint8 internal constant OP_FX_SWAP = 34;

    address internal constant LOW = address(0x1000000000000000000000000000000000000001);
    address internal constant MID = address(0x8000000000000000000000000000000000000001);
    address internal constant HIGH = address(0xF000000000000000000000000000000000000001);

    uint256 internal constant USD_BALANCE = 100_000e6;
    uint256 internal constant ARS_BALANCE = 140_000_000e18;

    AquaRouter internal aqua;
    AquaFXSwapVMRouter internal router;
    ManualFxOracle internal oracle;
    FXSwapArgsHarness internal harness;
    TestERC20 internal usd;
    TestERC20 internal ars;

    address internal maker = makeAddr("maker");
    address internal taker = makeAddr("taker");

    function setUp() public {
        vm.warp(1_750_000_000);
        aqua = new AquaRouter();
        router = new AquaFXSwapVMRouter(address(aqua), address(0), address(this), "AquaSwapVMRouter", "1.0.2-fx");
        oracle = new ManualFxOracle(address(this), 8, "ARS / USD", 1400e8);
        harness = new FXSwapArgsHarness();
        _deployTokens(true);
    }

    // ═══════════════════════════════ helpers ═══════════════════════════════

    /// @dev usdIsLt: USD gets the lower address (canonical price = ARS per USD) or the higher one (inverted)
    function _deployTokens(bool usdIsLt) internal {
        deployCodeTo("TestERC20.sol:TestERC20", abi.encode("Test USD", "USD", uint8(6)), usdIsLt ? LOW : HIGH);
        deployCodeTo("TestERC20.sol:TestERC20", abi.encode("Test ARS", "ARS", uint8(18)), MID);
        usd = TestERC20(usdIsLt ? LOW : HIGH);
        ars = TestERC20(MID);
    }

    function _config() internal view returns (FXSwapArgsBuilder.Args memory cfg) {
        (bool invert, uint64 rateLt, uint64 rateGt) = FXSwapArgsBuilder.orientation(address(usd), 6, address(ars), 18);
        cfg = FXSwapArgsBuilder.Args({
            oracleKind: FXSwapArgsBuilder.ORACLE_KIND_CHAINLINK,
            flags: invert ? FXSwapArgsBuilder.FLAG_INVERT_PRICE : 0,
            oracle: address(oracle),
            oracleDecimals: 8,
            maxStaleness: 1 hours,
            minPrice: 1000e18,
            maxPrice: 2000e18,
            // A = 100, γ = 0.01, 5 bp at balance widening towards 1% with a 0.03 transition width
            a: uint64(100 * FXSwapMath.A_PRECISION),
            gamma: 1e16,
            midFee: 5e14,
            outFee: 1e16,
            feeGamma: 3e16,
            rateLt: rateLt,
            rateGt: rateGt
        });
    }

    function _program(FXSwapArgsBuilder.Args memory cfg) internal pure returns (bytes memory) {
        return abi.encodePacked(OP_FX_SWAP, uint8(FXSwapArgsBuilder.ARGS_LENGTH), FXSwapArgsBuilder.build(cfg));
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

    function _ship(ISwapVM.Order memory order, uint256 usdAmount, uint256 arsAmount) internal returns (bytes32 hash) {
        usd.mint(maker, usdAmount);
        ars.mint(maker, arsAmount);
        address[] memory tokens = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        (tokens[0], tokens[1], amounts[0], amounts[1]) = (address(usd), address(ars), usdAmount, arsAmount);
        vm.startPrank(maker);
        usd.approve(address(aqua), type(uint256).max);
        ars.approve(address(aqua), type(uint256).max);
        hash = aqua.ship(address(router), abi.encode(order), tokens, amounts);
        vm.stopPrank();
        assertEq(hash, router.hash(order), "Aqua strategy hash == order hash");
    }

    function _shipDefault() internal returns (ISwapVM.Order memory order) {
        order = _order(_program(_config()));
        _ship(order, USD_BALANCE, ARS_BALANCE);
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

    // ═══════════════════════════════ deployment ═══════════════════════════════

    function test_RouterFitsEip170AndIsAquaRouter() public view {
        uint256 size = address(router).code.length;
        console2.log("AquaFXSwapVMRouter runtime bytes:", size);
        assertLe(size, 24_576, "EIP-170");
        (, string memory name, string memory version,,,,) = router.eip712Domain();
        assertEq(name, "AquaSwapVMRouter", "AquaAdapter only accepts this domain name");
        assertEq(version, "1.0.2-fx");
        assertEq(address(router.AQUA()), address(aqua));
    }

    // ═══════════════════════════════ pricing ═══════════════════════════════

    function _checkExactInFollowsOracle(bool usdIsLt) internal {
        _deployTokens(usdIsLt);
        ISwapVM.Order memory order = _shipDefault();
        bytes32 hash = router.hash(order);

        (uint256 amountIn, uint256 amountOut) = _swap(order, usd, ars, 100e6, true);
        assertEq(amountIn, 100e6);
        // 100 USD at 1400 ARS/USD minus the 0.05% mid fee, near balance
        assertApproxEqRel(amountOut, 140_000e18 * (1e18 - 5e14) / 1e18, 0.0005e18, "priced at the oracle rate");
        assertLt(amountOut, 140_000e18, "never better than the oracle rate");

        (uint248 usdAqua,) = aqua.rawBalances(maker, address(router), hash, address(usd));
        (uint248 arsAqua,) = aqua.rawBalances(maker, address(router), hash, address(ars));
        assertEq(usdAqua, USD_BALANCE + amountIn, "maker USD balance");
        assertEq(arsAqua, ARS_BALANCE - amountOut, "maker ARS balance");
        assertEq(ars.balanceOf(taker), amountOut, "taker received");

        (, uint256 back) = _swap(order, ars, usd, 1_400_000e18, true);
        assertApproxEqRel(back, 1_000e6 * (1e18 - 5e14) / 1e18, 0.0015e18, "reverse direction priced at 1/1400");
        assertLt(back, 1_000e6, "never better than the oracle rate");
    }

    function test_ExactIn_FollowsOracle_UsdLowerAddress() public {
        _checkExactInFollowsOracle(true);
    }

    function test_ExactIn_FollowsOracle_UsdHigherAddress() public {
        _checkExactInFollowsOracle(false);
    }

    function _checkExactOut(bool usdIsLt) internal returns (uint256 amountIn) {
        _deployTokens(usdIsLt);
        ISwapVM.Order memory order = _shipDefault();
        (uint256 quotedIn, uint256 quotedOut) = _quote(order, usd, ars, 1_000_000e18, false);
        uint256 arsBefore = ars.balanceOf(taker); // token addresses are reused across orderings, so use deltas
        uint256 amountOut;
        (amountIn, amountOut) = _swap(order, usd, ars, 1_000_000e18, false);
        assertEq(amountOut, 1_000_000e18, "exact output delivered");
        assertEq(ars.balanceOf(taker) - arsBefore, 1_000_000e18);
        assertEq(amountIn, quotedIn, "quote == swap (exact out)");
        assertEq(amountOut, quotedOut);
        // ~714.29 USD plus fee
        assertApproxEqRel(amountIn, uint256(1_000_000e6) / 1400, 0.002e18, "exact out at the oracle rate");
        assertGt(amountIn, uint256(1_000_000e6) / 1400, "never cheaper than the oracle rate");
    }

    function test_ExactOut_BothOrderings() public {
        uint256 lt = _checkExactOut(true);
        uint256 gt = _checkExactOut(false);
        assertApproxEqAbs(lt, gt, 2, "token ordering does not change the price");
    }

    function test_BothOrderingsAgree_ExactIn() public {
        _deployTokens(true);
        (, uint256 outLt) = _swap(_shipDefault(), usd, ars, 2_500e6, true);
        _deployTokens(false);
        (, uint256 outGt) = _swap(_shipDefault(), usd, ars, 2_500e6, true);
        assertApproxEqRel(outLt, outGt, 1e6, "ordering-independent up to rounding");
    }

    function test_QuoteEqualsSwap_ExactIn() public {
        ISwapVM.Order memory order = _shipDefault();
        (uint256 qIn, uint256 qOut) = _quote(order, usd, ars, 7_777e6, true);
        (uint256 sIn, uint256 sOut) = _swap(order, usd, ars, 7_777e6, true);
        assertEq(qIn, sIn);
        assertEq(qOut, sOut);
    }

    function test_PriceMove_QuotesFollow() public {
        ISwapVM.Order memory order = _shipDefault();
        (, uint256 at1400) = _quote(order, usd, ars, 500e6, true);

        oracle.setAnswer(1500e8);
        (, uint256 at1500) = _quote(order, usd, ars, 500e6, true);
        (, uint256 swapped) = _swap(order, usd, ars, 500e6, true);
        assertEq(swapped, at1500, "swap uses the new price");

        // The pool was value-balanced at 1400. At 1500 its ARS side is worth less than its USD side, so buying ARS
        // deepens the imbalance and pays a slightly wider dynamic spread, while selling ARS rebalances and trades
        // close to the oracle. Either way the execution price tracks the feed.
        assertApproxEqRel(at1500 * 1400, at1400 * 1500, 0.0025e18, "execution price follows the oracle");
        assertGt(at1500, at1400);
        (, uint256 sellAt1500) = _quote(order, ars, usd, 750_000e18, true);
        assertApproxEqRel(sellAt1500, 500e6, 0.001e18, "rebalancing direction trades at ~1/1500");

        oracle.setAnswer(1300e8);
        (, uint256 at1300) = _quote(order, usd, ars, 500e6, true);
        assertApproxEqRel(at1300 * 1400, at1400 * 1300, 0.0025e18, "and back down");
    }

    function test_InvertedFeed_MatchesDirectFeed() public {
        ISwapVM.Order memory direct = _shipDefault();
        (, uint256 viaDirect) = _quote(direct, usd, ars, 1_000e6, true);

        // Same market, feed quoting USD per 1 ARS with 18 decimals
        ManualFxOracle inverse = new ManualFxOracle(address(this), 18, "USD / ARS", int256(uint256(1e36) / 1400e18));
        FXSwapArgsBuilder.Args memory cfg = _config();
        (bool invert, uint64 rateLt, uint64 rateGt) = FXSwapArgsBuilder.orientation(address(ars), 18, address(usd), 6);
        cfg.flags = invert ? FXSwapArgsBuilder.FLAG_INVERT_PRICE : 0;
        (cfg.rateLt, cfg.rateGt) = (rateLt, rateGt);
        cfg.oracle = address(inverse);
        cfg.oracleDecimals = 18;
        (cfg.minPrice, cfg.maxPrice) = (uint128(uint256(1e36) / 2000e18), uint128(uint256(1e36) / 1000e18));
        ISwapVM.Order memory viaInverseOrder = _order(_program(cfg));
        _ship(viaInverseOrder, USD_BALANCE, ARS_BALANCE);
        (, uint256 viaInverse) = _quote(viaInverseOrder, usd, ars, 1_000e6, true);

        assertApproxEqRel(viaInverse, viaDirect, 1e4, "inverted feed prices identically (1/1400 truncation only)");
    }

    function test_OracleDecimalsZero_ReadsFeedDecimals() public {
        ISwapVM.Order memory declared = _shipDefault();
        (, uint256 a) = _quote(declared, usd, ars, 1_000e6, true);
        FXSwapArgsBuilder.Args memory cfg = _config();
        cfg.oracleDecimals = 0;
        ISwapVM.Order memory fetched = _order(_program(cfg));
        _ship(fetched, USD_BALANCE, ARS_BALANCE);
        (, uint256 b) = _quote(fetched, usd, ars, 1_000e6, true);
        assertEq(a, b);
    }

    function test_DynamicSpreadWidensAsInventoryDrains() public {
        ISwapVM.Order memory order = _shipDefault();
        uint256 firstRate;
        uint256 prevRate = type(uint256).max;
        for (uint256 i; i < 6; ++i) {
            (uint256 amountIn, uint256 amountOut) = _swap(order, usd, ars, 10_000e6, true);
            uint256 rate = amountOut * 1e6 / amountIn; // ARS wei per USD
            assertLt(rate, prevRate, "each further USD->ARS trade gets a worse rate");
            if (i == 0) firstRate = rate;
            prevRate = rate;
        }
        assertGt(firstRate, 1400e18 * 99 / 100, "first 10% trade stays within 1% of the oracle");
        assertLt(prevRate, firstRate * 99 / 100, "after draining half the ARS side the spread is wide");
    }

    function test_NoProfitableRoundTrip() public {
        ISwapVM.Order memory order = _shipDefault();
        (, uint256 arsOut) = _swap(order, usd, ars, 25_000e6, true);
        (, uint256 usdBack) = _swap(order, ars, usd, arsOut, true);
        assertLt(usdBack, 25_000e6, "round trip loses at least the fees");
    }

    function test_FlatFeeAmountIn_WrapsFXSwap() public {
        ISwapVM.Order memory plain = _shipDefault();
        (, uint256 plainOut) = _quote(plain, usd, ars, 1_000e6, true);
        (, uint256 plainOutAfterFee) = _quote(plain, usd, ars, 997e6, true);

        bytes memory program = bytes.concat(abi.encodePacked(OP_FLAT_FEE_IN, uint8(4), uint32(3_000_000)), _program(_config()));
        ISwapVM.Order memory withFee = _order(program);
        _ship(withFee, USD_BALANCE, ARS_BALANCE);
        (uint256 amountIn, uint256 amountOut) = _swap(withFee, usd, ars, 1_000e6, true);
        assertEq(amountIn, 1_000e6);
        assertLt(amountOut, plainOut);
        assertEq(amountOut, plainOutAfterFee, "0.3% input fee then FXSwap on the rest");
    }

    function test_PeggedSwapIndexUnchanged() public {
        // The v1.0.2 AquaOpcodes indices used by Aqua0's existing pegged FX strategies still dispatch
        uint256 usdRate = 1400e12;
        bytes memory program = abi.encodePacked(
            abi.encodePacked(OP_FLAT_FEE_IN, uint8(4), uint32(3_000_000)),
            abi.encodePacked(OP_PEGGED_SWAP, uint8(160)),
            address(usd) < address(ars)
                ? abi.encode(USD_BALANCE * usdRate, ARS_BALANCE, 10e27, usdRate, 1)
                : abi.encode(ARS_BALANCE, USD_BALANCE * usdRate, 10e27, 1, usdRate)
        );
        ISwapVM.Order memory order = _order(program);
        _ship(order, USD_BALANCE, ARS_BALANCE);
        (, uint256 amountOut) = _swap(order, usd, ars, 100e6, true);
        assertApproxEqRel(amountOut, 140_000e18, 0.01e18);
    }

    // ═══════════════════════════════ oracle validation ═══════════════════════════════

    function test_Reverts_StaleOracle() public {
        ISwapVM.Order memory order = _shipDefault();
        vm.warp(block.timestamp + 1 hours + 1);
        usd.mint(taker, 100e6);
        vm.startPrank(taker);
        usd.approve(address(router), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(FXSwap.FXSwapOracleStale.selector, block.timestamp - 1 hours - 1, 1 hours, block.timestamp)
        );
        router.swap(order, address(usd), address(ars), 100e6, _takerData(true));
        vm.stopPrank();
    }

    function test_Reverts_OracleUpdatedInFuture() public {
        ISwapVM.Order memory order = _shipDefault();
        vm.mockCall(
            address(oracle),
            abi.encodeWithSelector(IPriceOracle.latestRoundData.selector),
            abi.encode(uint80(2), int256(1400e8), block.timestamp, block.timestamp + 10, uint80(2))
        );
        vm.expectPartialRevert(FXSwap.FXSwapOracleStale.selector);
        _quote(order, usd, ars, 100e6, true);
    }

    function test_Reverts_PriceOutOfBand() public {
        ISwapVM.Order memory order = _shipDefault();
        oracle.setAnswer(2001e8);
        vm.expectRevert(abi.encodeWithSelector(FXSwap.FXSwapOraclePriceOutOfBand.selector, 2001e18, 1000e18, 2000e18));
        _quote(order, usd, ars, 100e6, true);

        oracle.setAnswer(999e8);
        vm.expectRevert(abi.encodeWithSelector(FXSwap.FXSwapOraclePriceOutOfBand.selector, 999e18, 1000e18, 2000e18));
        _quote(order, usd, ars, 100e6, true);
    }

    function test_Reverts_NonPositiveAnswer() public {
        ISwapVM.Order memory order = _shipDefault();
        vm.mockCall(
            address(oracle),
            abi.encodeWithSelector(IPriceOracle.latestRoundData.selector),
            abi.encode(uint80(2), int256(0), block.timestamp, block.timestamp, uint80(2))
        );
        vm.expectRevert(abi.encodeWithSelector(FXSwap.FXSwapOracleInvalidAnswer.selector, int256(0)));
        _quote(order, usd, ars, 100e6, true);
    }

    function test_Reverts_RecomputeDetected() public {
        bytes memory fx = _program(_config());
        ISwapVM.Order memory order = _order(bytes.concat(fx, fx));
        _ship(order, USD_BALANCE, ARS_BALANCE);
        vm.expectRevert(FXSwap.FXSwapRecomputeDetected.selector);
        _quote(order, usd, ars, 100e6, true);
    }

    // ═══════════════════════════════ args ═══════════════════════════════

    function test_Args_RoundTrip() public view {
        FXSwapArgsBuilder.Args memory cfg = _config();
        cfg.flags = FXSwapArgsBuilder.FLAG_INVERT_PRICE;
        bytes memory packed = harness.build(cfg);
        assertEq(packed.length, FXSwapArgsBuilder.ARGS_LENGTH);
        assertEq(keccak256(abi.encode(harness.parse(packed))), keccak256(abi.encode(cfg)));
        // Spot-check the documented byte offsets
        assertEq(uint8(packed[1]), FXSwapArgsBuilder.FLAG_INVERT_PRICE);
        assertEq(address(bytes20(this.slice(packed, 2, 22))), address(oracle));
        assertEq(uint64(bytes8(this.slice(packed, 59, 67))), 100 * FXSwapMath.A_PRECISION);
        assertEq(uint64(bytes8(this.slice(packed, 107, 115))), cfg.rateGt);
    }

    function slice(bytes calldata data, uint256 from, uint256 to) external pure returns (bytes memory) {
        return data[from:to];
    }

    function test_Args_Validation() public {
        FXSwapArgsBuilder.Args memory cfg = _config();

        cfg.oracleKind = FXSwapArgsBuilder.ORACLE_KIND_PYTH;
        vm.expectRevert(abi.encodeWithSelector(FXSwapArgsBuilder.FXSwapUnsupportedOracleKind.selector, uint8(1)));
        harness.build(cfg);

        cfg = _config();
        cfg.maxStaleness = 0;
        vm.expectRevert(FXSwapArgsBuilder.FXSwapInvalidMaxStaleness.selector);
        harness.build(cfg);

        cfg = _config();
        cfg.minPrice = 3000e18;
        vm.expectRevert(abi.encodeWithSelector(FXSwapArgsBuilder.FXSwapInvalidPriceBand.selector, 3000e18, 2000e18));
        harness.build(cfg);

        cfg = _config();
        cfg.gamma = 1;
        vm.expectRevert(abi.encodeWithSelector(FXSwapArgsBuilder.FXSwapInvalidCurve.selector, cfg.a, 1));
        harness.build(cfg);

        cfg = _config();
        cfg.midFee = 2e16;
        vm.expectRevert(abi.encodeWithSelector(FXSwapArgsBuilder.FXSwapInvalidFees.selector, 2e16, 1e16, 3e16));
        harness.build(cfg);

        cfg = _config();
        cfg.flags = 0x02;
        vm.expectRevert(abi.encodeWithSelector(FXSwapArgsBuilder.FXSwapInvalidFlags.selector, uint8(2)));
        harness.build(cfg);

        vm.expectRevert(abi.encodeWithSelector(FXSwapArgsBuilder.FXSwapInvalidArgsLength.selector, 114));
        harness.parse(new bytes(114));
    }

    // ═══════════════════════════════ gas ═══════════════════════════════

    function test_Gas_Swap() public {
        ISwapVM.Order memory order = _shipDefault();
        usd.mint(taker, 1e30);
        ars.mint(taker, 1e30);
        vm.startPrank(taker);
        usd.approve(address(router), type(uint256).max);
        ars.approve(address(router), type(uint256).max);
        // Warm the balances so the measurement reflects a steady-state swap
        router.swap(order, address(usd), address(ars), 1e6, _takerData(true));

        uint256 g = gasleft();
        router.swap(order, address(usd), address(ars), 1_000e6, _takerData(true));
        uint256 exactIn = g - gasleft();
        g = gasleft();
        router.swap(order, address(usd), address(ars), 1_000_000e18, _takerData(false));
        uint256 exactOut = g - gasleft();
        vm.stopPrank();
        console2.log("gas router.swap exact-in  (oracle + FXSwap + Aqua push/pull):", exactIn);
        console2.log("gas router.swap exact-out (dynamic fee, 3 solves):", exactOut);
    }
}
