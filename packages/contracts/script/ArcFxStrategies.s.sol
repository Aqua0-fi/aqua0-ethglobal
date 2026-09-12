// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console2 } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ISwapVM } from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import { MakerTraits } from "@1inch/swap-vm/libs/MakerTraits.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/routers/AquaSwapVMRouter.sol";

import { IAquaAdapter, IAssetVault, IMintableERC20, IVaultRegistry } from "../src/interfaces/IAqua0Arc.sol";

/// @title ArcFxStrategies
/// @notice Stands up two FX strategies on Arc backed by ONE USDC deposit, then fills a swap against each:
///         1. registers the USDC/ARGt and USDC/BRAt strategy classes with the broadcasting signer as strategist
///         2. deposits USDC once and commits it to both classes; deposits and commits each FX leg
///         3. ships a fee + pegged-curve SwapVM program per class through the Aqua0 AquaAdapter
///         4. swaps USDC into each FX token through the AquaSwapVMRouter
/// @dev This is the stable-strategy path: the pegged curve's rate multipliers pin its flat zone at a fixed FX
///      price, so it does not follow a moving FX rate. The broadcasting signer is strategist, operator, LP and
///      taker at once, which is what a single demo wallet can prove on-chain.
contract ArcFxStrategies is Script {
    /// @dev AquaSwapVMRouter v1.0.2 `AquaOpcodes` dispatch indices.
    uint8 internal constant OPCODE_FLAT_FEE_IN = 21;
    uint8 internal constant OPCODE_PEGGED_SWAP = 31;

    /// @dev useAquaInsteadOfSignature | postTransferIn hook | preTransferOut hook: exactly what AquaAdapter accepts.
    uint256 internal constant REQUIRED_TRAITS = (1 << 254) | (1 << 251) | (1 << 250);

    /// @dev Taker traits flags: isExactIn | useTransferFromAndAquaPush.
    uint16 internal constant TAKER_FLAGS_EXACT_IN = 0x0041;

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant SHIP_STRATEGY_FEE_TYPEHASH = keccak256(
        "ShipStrategy(uint256 classId,bytes32 strategyId,address[] tokens,uint256[] amounts,uint32 feePpb,uint256 nonce,uint256 deadline)"
    );

    struct Config {
        address registry;
        address adapter;
        address router;
        address usdc;
        address usdcVault;
        uint256 usdcDeposit;
        uint256 usdcShip;
        uint256 usdcSwapIn;
        uint32 feePpb;
        uint256 linearWidth;
        string adapterDomainVersion;
    }

    struct FxLeg {
        string label;
        address token;
        address vault;
        /// @dev FX units per 1 USDC, times 100 (1400 ARS -> 140_000; 5.50 BRL -> 550).
        uint256 priceE2;
    }

    function run() external {
        Config memory cfg = Config({
            registry: vm.envAddress("VAULT_REGISTRY"),
            adapter: vm.envAddress("AQUA_ADAPTER"),
            router: vm.envAddress("AQUA_SWAPVM_ROUTER"),
            usdc: vm.envAddress("USDC"),
            usdcVault: vm.envAddress("USDC_VAULT"),
            usdcDeposit: vm.envOr("USDC_DEPOSIT", uint256(2e6)),
            usdcShip: vm.envOr("USDC_SHIP", uint256(1e6)),
            usdcSwapIn: vm.envOr("USDC_SWAP_IN", uint256(1e5)),
            feePpb: uint32(vm.envOr("FEE_PPB", uint256(3_000_000))),
            linearWidth: vm.envOr("LINEAR_WIDTH", uint256(10e27)),
            adapterDomainVersion: vm.envOr("ADAPTER_DOMAIN_VERSION", string("1"))
        });
        FxLeg[2] memory legs = [
            FxLeg("FXSwap ARS", vm.envAddress("ARGT"), vm.envAddress("ARGT_VAULT"), vm.envOr("ARS_PER_USDC_E2", uint256(140_000))),
            FxLeg("FXSwap BRL", vm.envAddress("BRAT"), vm.envAddress("BRAT_VAULT"), vm.envOr("BRL_PER_USDC_E2", uint256(550)))
        ];

        vm.startBroadcast();
        (, address signer,) = vm.readCallers();

        IERC20(cfg.usdc).approve(cfg.usdcVault, cfg.usdcDeposit);
        IAssetVault(cfg.usdcVault).deposit(cfg.usdcDeposit, signer);

        uint256[2] memory classIds;
        for (uint256 i; i < legs.length; ++i) {
            classIds[i] = _prepareClass(cfg, legs[i], signer);
        }
        for (uint256 i; i < legs.length; ++i) {
            _shipAndSwap(cfg, legs[i], classIds[i], signer);
        }

        vm.stopBroadcast();

        console2.log("USDC principal free for signer:", IAssetVault(cfg.usdcVault).freePrincipal(signer));
        for (uint256 i; i < legs.length; ++i) {
            console2.log(legs[i].label, "class", classIds[i]);
            console2.log("  USDC committed backing:", IAssetVault(cfg.usdcVault).committedBacking(classIds[i]));
            console2.log("  USDC available:", IAssetVault(cfg.usdcVault).availableFor(classIds[i]));
        }
    }

    /// @dev Register the class (key derived exactly like the Aqua0 MCP), register both vault legs to `signer`,
    ///      then fund and commit the FX leg and commit the shared USDC deposit.
    function _prepareClass(Config memory cfg, FxLeg memory leg, address signer) internal returns (uint256 classId) {
        bytes32 key = strategyKey(signer, block.chainid, cfg.usdc, leg.token, leg.label);
        classId = IVaultRegistry(cfg.registry).classForStrategy(key);
        if (classId == 0) classId = IVaultRegistry(cfg.registry).registerStrategyClass(key);

        _registerLeg(cfg.usdcVault, classId, signer);
        _registerLeg(leg.vault, classId, signer);

        uint256 fxShip = fxAmountFor(cfg.usdcShip, leg.priceE2);
        IMintableERC20(leg.token).mint(signer, fxShip);
        IERC20(leg.token).approve(leg.vault, fxShip);
        IAssetVault(leg.vault).deposit(fxShip, signer);
        IAssetVault(leg.vault).setCommitment(classId, true);
        IAssetVault(cfg.usdcVault).setCommitment(classId, true);
    }

    function _registerLeg(address vault, uint256 classId, address signer) internal {
        address current = IAssetVault(vault).classStrategist(classId);
        if (current == address(0)) IAssetVault(vault).registerStrategy(classId, signer);
        else require(current == signer, "vault leg already belongs to another strategist");
    }

    function _shipAndSwap(Config memory cfg, FxLeg memory leg, uint256 classId, address signer) internal {
        address[] memory tokens = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        (tokens[0], tokens[1]) = (cfg.usdc, leg.token);
        (amounts[0], amounts[1]) = (cfg.usdcShip, fxAmountFor(cfg.usdcShip, leg.priceE2));

        ISwapVM.Order memory order = ISwapVM.Order({
            maker: cfg.adapter,
            traits: MakerTraits.wrap(REQUIRED_TRAITS),
            data: buildProgram(cfg.usdc, leg.token, amounts[0], amounts[1], leg.priceE2, cfg.feePpb, cfg.linearWidth)
        });
        bytes memory strategyBytes = abi.encode(order);
        bytes32 strategyId = keccak256(strategyBytes);

        if (IAquaAdapter(cfg.adapter).currentAquaHash(strategyId) == bytes32(0)) {
            uint256 nonce = IAquaAdapter(cfg.adapter).strategistNonces(signer);
            uint256 deadline = block.timestamp + 1 hours;
            bytes32 digest = shipDigest(cfg, classId, strategyId, tokens, amounts, nonce, deadline);
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signer, digest);
            IAquaAdapter(cfg.adapter).shipStrategyWithFee(
                classId, strategyBytes, tokens, amounts, cfg.feePpb, nonce, deadline, abi.encodePacked(r, s, v)
            );
        }

        IERC20(cfg.usdc).approve(cfg.router, cfg.usdcSwapIn);
        (uint256 amountIn, uint256 amountOut,) = AquaSwapVMRouter(payable(cfg.router)).swap(
            order, cfg.usdc, leg.token, cfg.usdcSwapIn, abi.encodePacked(uint160(0), TAKER_FLAGS_EXACT_IN)
        );

        console2.log(leg.label, "strategy shipped and filled");
        console2.logBytes32(strategyId);
        console2.log("  swapped USDC in:", amountIn);
        console2.log("  received FX out:", amountOut);
    }

    /// @notice keccak256(abi.encode(strategist, chainId, sorted token0/token1, keccak256(label))), as the MCP derives it.
    function strategyKey(address strategist, uint256 chainId, address tokenA, address tokenB, string memory label)
        public
        pure
        returns (bytes32)
    {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encode(strategist, chainId, token0, token1, keccak256(bytes(label))));
    }

    /// @notice FX-token amount (18 decimals) worth `usdcAmount` (6 decimals) at `priceE2` FX units per USDC.
    function fxAmountFor(uint256 usdcAmount, uint256 priceE2) public pure returns (uint256) {
        return usdcAmount * 1e12 * priceE2 / 100;
    }

    /// @notice `[FlatFeeAmountIn(feePpb)][PeggedSwap(x0, y0, A, rateLt, rateGt)]` for a USDC (6 dp) / FX (18 dp) pair.
    /// @dev USDC's rate multiplier carries both the 12-decimal gap and the FX price, so the curve's balanced point
    ///      (and its flat, low-slippage zone) sits at `priceE2 / 100` FX units per USDC.
    function buildProgram(
        address usdc,
        address fxToken,
        uint256 usdcReserve,
        uint256 fxReserve,
        uint256 priceE2,
        uint32 feePpb,
        uint256 linearWidth
    ) public pure returns (bytes memory) {
        uint256 usdcRate = priceE2 * 1e10;
        uint256 fxRate = 1;
        (uint256 x0, uint256 y0, uint256 rateLt, uint256 rateGt) = usdc < fxToken
            ? (usdcReserve * usdcRate, fxReserve * fxRate, usdcRate, fxRate)
            : (fxReserve * fxRate, usdcReserve * usdcRate, fxRate, usdcRate);
        return abi.encodePacked(
            OPCODE_FLAT_FEE_IN,
            uint8(4),
            feePpb,
            OPCODE_PEGGED_SWAP,
            uint8(160),
            abi.encode(x0, y0, linearWidth, rateLt, rateGt)
        );
    }

    function shipDigest(
        Config memory cfg,
        uint256 classId,
        bytes32 strategyId,
        address[] memory tokens,
        uint256[] memory amounts,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("AquaAdapter"),
                keccak256(bytes(cfg.adapterDomainVersion)),
                block.chainid,
                cfg.adapter
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                SHIP_STRATEGY_FEE_TYPEHASH,
                classId,
                strategyId,
                keccak256(abi.encodePacked(tokens)),
                keccak256(abi.encodePacked(amounts)),
                cfg.feePpb,
                nonce,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
}
