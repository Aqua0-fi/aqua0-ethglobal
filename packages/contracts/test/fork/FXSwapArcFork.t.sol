// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test, console2 } from "forge-std/Test.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ISwapVM } from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import { MakerTraits } from "@1inch/swap-vm/libs/MakerTraits.sol";

import { AquaFXSwapVMRouter } from "../../src/routers/AquaFXSwapVMRouter.sol";
import { FXSwapArgsBuilder } from "../../src/instructions/FXSwap.sol";
import { FXSwapMath } from "../../src/libs/FXSwapMath.sol";
import { ManualFxOracle } from "../../src/mocks/ManualFxOracle.sol";
import { IAquaAdapter, IAssetVault, IMintableERC20, IVaultRegistry } from "../../src/interfaces/IAqua0Arc.sol";

interface IAccessControlLike {
    function grantRole(bytes32 role, address account) external;
}

interface IVaultRegistryAdmin {
    function setAdapterAllowed(address adapter, bool allowed) external;
}

interface IAquaAdapterAdmin {
    function setOneStrategyPerToken(bool enabled) external;
}

/// @title FXSwapArcForkTest
/// @notice End-to-end on an Arc Testnet fork (local simulation, nothing is broadcast): a fresh AquaFXSwapVMRouter on
///         the live stock Aqua, a fresh Aqua0 AquaAdapter wired into the live VaultRegistry and USDC / ARGt vaults, an
///         FXSwap strategy shipped from vault capital, then USDC → ARGt swaps before and after an oracle move.
/// @dev Set FXSWAP_SKIP_FORK=true to skip; ARC_TESTNET_RPC_URL overrides the public RPC. Also skips when the Aqua0
///      AquaAdapter artifact is missing (it is compiled from the Aqua0 contracts repo by the deploy scripts).
contract FXSwapArcForkTest is Test {
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
    uint8 internal constant OP_FLAT_FEE_IN = 21;
    uint8 internal constant OP_FX_SWAP = 34;
    uint256 internal constant REQUIRED_TRAITS = (1 << 254) | (1 << 251) | (1 << 250);
    uint16 internal constant TAKER_FLAGS_EXACT_IN = 0x0041;
    uint32 internal constant FEE_PPB = 1_000_000; // 0.1%

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant SHIP_STRATEGY_FEE_TYPEHASH = keccak256(
        "ShipStrategy(uint256 classId,bytes32 strategyId,address[] tokens,uint256[] amounts,uint32 feePpb,uint256 nonce,uint256 deadline)"
    );

    AquaFXSwapVMRouter internal router;
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
        if (vm.envOr("FXSWAP_SKIP_FORK", false) || !vm.exists(ADAPTER_ARTIFACT)) vm.skip(true);
        vm.createSelectFork(vm.envOr("ARC_TESTNET_RPC_URL", string("https://rpc.testnet.arc.network")));
        require(block.chainid == ARC_TESTNET_CHAIN_ID, "not Arc Testnet");
        strategist = vm.addr(strategistKey);

        // Arc's USDC calls native precompiles a fork does not implement: run a plain mintable ERC-20 at its address
        vm.etch(USDC, ARGT.code);

        router = new AquaFXSwapVMRouter(STOCK_AQUA, address(0), address(this), "AquaSwapVMRouter", "1.0.2-fx");
        oracle = new ManualFxOracle(address(this), 8, "ARS / USD", 1400e8);
        adapter = deployCode(
            ADAPTER_ARTIFACT,
            abi.encode(adapterAdmin, operator, guardian, REGISTRY, COMPOSER, STOCK_AQUA, address(router), "1")
        );
        vm.prank(adapterAdmin);
        IAquaAdapterAdmin(adapter).setOneStrategyPerToken(false);

        vm.startPrank(CORE_ADMIN);
        IVaultRegistryAdmin(REGISTRY).setAdapterAllowed(adapter, true);
        IAccessControlLike(USDC_VAULT).grantRole(keccak256("VENUE_SETTLER_ROLE"), adapter);
        IAccessControlLike(ARGT_VAULT).grantRole(keccak256("VENUE_SETTLER_ROLE"), adapter);
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
        (uint256 in2, uint256 out2) = _swap(order, swapIn);

        console2.log("AquaFXSwapVMRouter runtime bytes:", address(router).code.length);
        console2.log("AquaAdapter:", adapter);
        console2.log("strategy class:", classId);
        console2.log("swap 1 @ 1400 ARS/USD  amountIn (USDC wei):", in1);
        console2.log("swap 1 @ 1400 ARS/USD  amountOut (ARGt wei):", out1);
        console2.log("swap 2 @ 1500 ARS/USD  amountIn (USDC wei):", in2);
        console2.log("swap 2 @ 1500 ARS/USD  amountOut (ARGt wei):", out2);
        console2.log("execution price 1 (ARGt per USDC, 1e18):", out1 * 1e6 / in1);
        console2.log("execution price 2 (ARGt per USDC, 1e18):", out2 * 1e6 / in2);

        assertEq(in1, quotedIn, "quote == swap: amountIn");
        assertEq(out1, quotedOut, "quote == swap: amountOut");
        assertEq(takerArgt, out1, "taker received ARGt");
        // 100 USDC at 1400 minus the 0.1% flat fee and the 0.05% FXSwap mid fee
        assertApproxEqRel(out1, 140_000e18, 0.002e18, "priced at the oracle rate");
        assertLt(out1, 140_000e18, "never better than the oracle rate");
        assertApproxEqRel(out2 * 1400, out1 * 1500, 0.002e18, "execution price follows the oracle");
    }

    // ═══════════════════════════════ helpers ═══════════════════════════════

    function _prepareClass(uint256 usdcAmount, uint256 argtAmount) internal returns (uint256 classId) {
        classId = IVaultRegistry(REGISTRY).registerStrategyClass(keccak256(abi.encode("FXSwap fork", address(this))));
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

    function _config() internal view returns (FXSwapArgsBuilder.Args memory cfg) {
        (bool invert, uint64 rateLt, uint64 rateGt) = FXSwapArgsBuilder.orientation(USDC, 6, ARGT, 18);
        cfg = FXSwapArgsBuilder.Args({
            oracleKind: FXSwapArgsBuilder.ORACLE_KIND_CHAINLINK,
            flags: invert ? FXSwapArgsBuilder.FLAG_INVERT_PRICE : 0,
            oracle: address(oracle),
            oracleDecimals: 8,
            maxStaleness: 1 hours,
            minPrice: 1000e18,
            maxPrice: 2000e18,
            // A = 200, γ = 0.02, 5 bp at balance widening towards 0.5% with a 0.05 transition width
            a: uint64(200 * FXSwapMath.A_PRECISION),
            gamma: 2e16,
            midFee: 5e14,
            outFee: 5e15,
            feeGamma: 5e16,
            rateLt: rateLt,
            rateGt: rateGt
        });
    }

    function _ship(uint256 classId, uint256 usdcAmount, uint256 argtAmount) internal returns (ISwapVM.Order memory order) {
        order = ISwapVM.Order({
            maker: adapter,
            traits: MakerTraits.wrap(REQUIRED_TRAITS),
            data: abi.encodePacked(
                abi.encodePacked(OP_FLAT_FEE_IN, uint8(4), FEE_PPB),
                abi.encodePacked(OP_FX_SWAP, uint8(FXSwapArgsBuilder.ARGS_LENGTH), FXSwapArgsBuilder.build(_config()))
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
