// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test, console2 } from "forge-std/Test.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ISwapVM } from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import { MakerTraits } from "@1inch/swap-vm/libs/MakerTraits.sol";

import { AquaForexSwapVMRouter } from "../../src/routers/AquaForexSwapVMRouter.sol";
import { ForexCurveArgsBuilder } from "../../src/instructions/ForexCurve.sol";
import { ManualFxOracle } from "../../src/mocks/ManualFxOracle.sol";
import { IAquaAdapter, IAssetVault, IMintableERC20, IVaultRegistry } from "../../src/interfaces/IAqua0Arc.sol";

interface IForexAccessControlLike {
    function grantRole(bytes32 role, address account) external;
}

interface IForexVaultRegistryAdmin {
    function setAdapterAllowed(address adapter, bool allowed) external;
}

interface IForexAquaAdapterAdmin {
    function setOneStrategyPerToken(bool enabled) external;
}

/// @title ForexCurveArcForkTest
/// @notice End-to-end on an Arc Testnet fork (local simulation, nothing is broadcast): a fresh AquaForexSwapVMRouter on the
///         live stock Aqua, a fresh Aqua0 AquaAdapter wired into the live VaultRegistry and USDC / ARGt vaults, a
///         `[Salt][ForexCurve]` strategy shipped from vault capital against an ARS-per-USD feed (FLAG_INVERT_PRICE), then
///         USDC → ARGt swaps before and after an oracle move.
/// @dev Skipped when FOREX_SKIP_FORK or FXSWAP_SKIP_FORK is true (CI sets the latter); ARC_TESTNET_RPC_URL overrides the
///      public RPC. Also skips when the Aqua0 AquaAdapter artifact is missing (it is compiled from the Aqua0 contracts
///      repo by the deploy scripts).
contract ForexCurveArcForkTest is Test {
    address internal constant REGISTRY = 0x9E094b21C4263e0BE5BEffa0f8296B3fd982fFFf;
    address internal constant COMPOSER = 0x656F28021a624aDfA0d92dDFdBb20577674aFEC7;
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant ARGT = 0xd8dE250970842A581f89E885dA0F5165037714Ef;
    address internal constant USDC_VAULT = 0x99c2ab427b29dB1Cc14D228d970596015d1C4429;
    address internal constant ARGT_VAULT = 0x8a3d6188C58d7877499592E179DfE3bd80c4F460;
    address internal constant CORE_ADMIN = 0xBaA361817C8676b4A8a8C5e6fd050253f81f407C;
    address internal constant STOCK_AQUA = 0x490d2eceD9aCF99e1db6090f820775bFa70020D4;
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5_042_002;

    string internal constant ADAPTER_ARTIFACT = "cache/aqua0-out/AquaAdapter.sol/AquaAdapter.json";
    uint8 internal constant OP_SALT = 20;
    uint8 internal constant OP_FOREX_CURVE = 34;
    uint256 internal constant REQUIRED_TRAITS = (1 << 254) | (1 << 251) | (1 << 250);
    uint16 internal constant TAKER_FLAGS_EXACT_IN = 0x0041;
    uint32 internal constant FEE_PPB = 1_000_000; // 0.1% adapter fee, recorded at ship

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant SHIP_STRATEGY_FEE_TYPEHASH = keccak256(
        "ShipStrategy(uint256 classId,bytes32 strategyId,address[] tokens,uint256[] amounts,uint32 feePpb,uint256 nonce,uint256 deadline)"
    );

    AquaForexSwapVMRouter internal router;
    ManualFxOracle internal oracle;
    address internal adapter;

    address internal adapterAdmin = makeAddr("adapterAdmin");
    address internal operator = makeAddr("operator");
    address internal guardian = makeAddr("guardian");
    address internal lp = makeAddr("lp");
    address internal taker = makeAddr("taker");
    uint256 internal strategistKey = 0xA11CE;
    address internal strategist;

    function setUp() public {
        if (vm.envOr("FOREX_SKIP_FORK", false) || vm.envOr("FXSWAP_SKIP_FORK", false) || !vm.exists(ADAPTER_ARTIFACT)) {
            vm.skip(true);
        }
        vm.createSelectFork(vm.envOr("ARC_TESTNET_RPC_URL", string("https://rpc.testnet.arc.network")));
        require(block.chainid == ARC_TESTNET_CHAIN_ID, "not Arc Testnet");
        strategist = vm.addr(strategistKey);

        // Arc's USDC calls native precompiles a fork does not implement: run a plain mintable ERC-20 at its address
        vm.etch(USDC, ARGT.code);

        router = new AquaForexSwapVMRouter(STOCK_AQUA, address(0), address(this), "AquaSwapVMRouter", "1.0.2-forex");
        oracle = new ManualFxOracle(address(this), 8, "ARS / USD", 1400e8);
        adapter = deployCode(
            ADAPTER_ARTIFACT,
            abi.encode(adapterAdmin, operator, guardian, REGISTRY, COMPOSER, STOCK_AQUA, address(router), "1")
        );
        vm.prank(adapterAdmin);
        IForexAquaAdapterAdmin(adapter).setOneStrategyPerToken(false);

        vm.startPrank(CORE_ADMIN);
        IForexVaultRegistryAdmin(REGISTRY).setAdapterAllowed(adapter, true);
        IForexAccessControlLike(USDC_VAULT).grantRole(keccak256("VENUE_SETTLER_ROLE"), adapter);
        IForexAccessControlLike(ARGT_VAULT).grantRole(keccak256("VENUE_SETTLER_ROLE"), adapter);
        vm.stopPrank();
    }

    function test_Fork_ShipAndSwap_FollowsOracle() public {
        uint256 usdcShip = 20_000e6;
        uint256 argtShip = 28_000_000e18; // value-balanced at 1400 ARS / USD
        uint256 classId = _prepareClass(usdcShip, argtShip);
        ISwapVM.Order memory order = _ship(classId, usdcShip, argtShip);

        uint256 swapIn = 100e6;
        IMintableERC20(USDC).mint(taker, 10 * swapIn);
        vm.prank(taker);
        IERC20(USDC).approve(address(router), type(uint256).max);

        (uint256 quotedIn, uint256 quotedOut,) = router.quote(order, USDC, ARGT, swapIn, _takerData());
        (uint256 in1, uint256 out1) = _swap(order, swapIn);
        uint256 takerArgt = IERC20(ARGT).balanceOf(taker);

        oracle.setAnswer(1500e8);
        (, uint256 out2) = _swap(order, swapIn);

        console2.log("AquaForexSwapVMRouter runtime bytes:", address(router).code.length);
        console2.log("AquaAdapter:", adapter);
        console2.log("strategy class:", classId);
        console2.log("swap 1 @ 1400 ARS/USD  amountOut (ARGt wei):", out1);
        console2.log("swap 2 @ 1500 ARS/USD  amountOut (ARGt wei):", out2);

        assertEq(in1, quotedIn, "quote == swap: amountIn");
        assertEq(out1, quotedOut, "quote == swap: amountOut");
        assertEq(takerArgt, out1, "taker received ARGt");
        // Inside the band: 100 USDC at 1400 minus ε (30 bp); p = 1e36 / 1400e18 truncates, worth < 1e-15
        assertApproxEqRel(out1, 139_580e18, 1e3, "priced at the oracle rate");
        assertApproxEqRel(out2 * 1400, out1 * 1500, 1e3, "execution price follows the oracle");
    }

    // ═══════════════════════════════ helpers ═══════════════════════════════

    function _prepareClass(uint256 usdcAmount, uint256 argtAmount) internal returns (uint256 classId) {
        classId = IVaultRegistry(REGISTRY).registerStrategyClass(keccak256(abi.encode("ForexCurve fork", address(this))));
        IAssetVault(USDC_VAULT).registerStrategy(classId, strategist);
        IAssetVault(ARGT_VAULT).registerStrategy(classId, strategist);

        IMintableERC20(USDC).mint(lp, usdcAmount);
        IMintableERC20(ARGT).mint(lp, argtAmount);
        vm.startPrank(lp);
        IERC20(USDC).approve(USDC_VAULT, usdcAmount);
        IERC20(ARGT).approve(ARGT_VAULT, argtAmount);
        IAssetVault(USDC_VAULT).deposit(usdcAmount, lp);
        IAssetVault(ARGT_VAULT).deposit(argtAmount, lp);
        IAssetVault(USDC_VAULT).setCommitment(classId, true);
        IAssetVault(ARGT_VAULT).setCommitment(classId, true);
        vm.stopPrank();
    }

    function _config() internal view returns (ForexCurveArgsBuilder.Args memory cfg) {
        (uint8 flags, uint64 rateLt, uint64 rateGt) = ForexCurveArgsBuilder.pairFields(USDC, 6, ARGT, 18, true);
        cfg = ForexCurveArgsBuilder.Args({
            oracleKind: ForexCurveArgsBuilder.ORACLE_KIND_CHAINLINK,
            flags: flags,
            oracle: address(oracle),
            oracleDecimals: 8,
            maxStaleness: 1 hours,
            minPrice: 1000e18,
            maxPrice: 2000e18,
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

    function _ship(uint256 classId, uint256 usdcAmount, uint256 argtAmount) internal returns (ISwapVM.Order memory order) {
        order = ISwapVM.Order({
            maker: adapter,
            traits: MakerTraits.wrap(REQUIRED_TRAITS),
            data: abi.encodePacked(
                abi.encodePacked(OP_SALT, uint8(32), keccak256("forex fork")),
                abi.encodePacked(OP_FOREX_CURVE, uint8(ForexCurveArgsBuilder.ARGS_LENGTH), ForexCurveArgsBuilder.build(_config()))
            )
        });
        bytes memory strategyBytes = abi.encode(order);
        address[] memory tokens = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        (tokens[0], tokens[1], amounts[0], amounts[1]) = (USDC, ARGT, usdcAmount, argtAmount);

        uint256 nonce = IAquaAdapter(adapter).strategistNonces(strategist);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _shipDigest(classId, keccak256(strategyBytes), tokens, amounts, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(strategistKey, digest);

        vm.prank(operator, operator);
        IAquaAdapter(adapter).shipStrategyWithFee(
            classId, strategyBytes, tokens, amounts, FEE_PPB, nonce, deadline, abi.encodePacked(r, s, v)
        );
        assertEq(IAquaAdapter(adapter).currentAquaHash(keccak256(strategyBytes)), router.hash(order), "shipped");
    }

    function _swap(ISwapVM.Order memory order, uint256 amountIn) internal returns (uint256 inAmount, uint256 outAmount) {
        vm.prank(taker);
        (inAmount, outAmount,) = router.swap(order, USDC, ARGT, amountIn, _takerData());
    }

    function _takerData() internal pure returns (bytes memory) {
        return abi.encodePacked(uint160(0), TAKER_FLAGS_EXACT_IN);
    }

    function _shipDigest(
        uint256 classId,
        bytes32 strategyId,
        address[] memory tokens,
        uint256[] memory amounts,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("AquaAdapter"), keccak256("1"), block.chainid, adapter)
        );
        bytes32 structHash = keccak256(
            abi.encode(
                SHIP_STRATEGY_FEE_TYPEHASH,
                classId,
                strategyId,
                keccak256(abi.encodePacked(tokens)),
                keccak256(abi.encodePacked(amounts)),
                FEE_PPB,
                nonce,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
}
