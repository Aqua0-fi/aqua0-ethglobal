// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console2 } from "forge-std/Script.sol";

import { AquaFXSwapVMRouter } from "../src/routers/AquaFXSwapVMRouter.sol";
import { ManualFxOracle } from "../src/mocks/ManualFxOracle.sol";

/// @title DeployFXVenue
/// @notice Deploys the FXSwap venue pieces next to an existing Aqua: two manually-set Chainlink-compatible FX feeds
///         (ARS / USD and BRL / USD) and an AquaFXSwapVMRouter bound to that Aqua. FXSwap is opcode index 34; every
///         other index the router keeps matches swap-vm v1.0.2 AquaOpcodes (FlatFeeAmountIn 21, PeggedSwap 31, ...).
/// @dev Environment:
///      AQUA              Aqua (AquaRouter) address the router reads balances from (required)
///      ROUTER_OWNER      router owner, allowed to rescue funds (required)
///      ROUTER_WETH       default address(0) (Arc has no WETH)
///      ROUTER_NAME       default "AquaSwapVMRouter" (the EIP-712 name Aqua0's AquaAdapter accepts)
///      ROUTER_VERSION    default "1.0.2-fx"
///      ORACLE_OWNER      account that sets feed answers, default ROUTER_OWNER
///      ORACLE_DECIMALS   feed decimals, default 8
///      ARS_PER_USD       initial ARS / USD answer in feed decimals, default 1400e8
///      BRL_PER_USD       initial BRL / USD answer in feed decimals, default 5.5e8
///      Example (simulation only): forge script script/DeployFXVenue.s.sol --rpc-url $RPC
contract DeployFXVenue is Script {
    function run() external returns (address router, address arsFeed, address brlFeed) {
        address aqua = vm.envAddress("AQUA");
        address owner = vm.envAddress("ROUTER_OWNER");
        address weth = vm.envOr("ROUTER_WETH", address(0));
        string memory name = vm.envOr("ROUTER_NAME", string("AquaSwapVMRouter"));
        string memory version = vm.envOr("ROUTER_VERSION", string("1.0.2-fx"));
        address oracleOwner = vm.envOr("ORACLE_OWNER", owner);
        uint8 oracleDecimals = uint8(vm.envOr("ORACLE_DECIMALS", uint256(8)));
        int256 arsPerUsd = int256(vm.envOr("ARS_PER_USD", uint256(1400e8)));
        int256 brlPerUsd = int256(vm.envOr("BRL_PER_USD", uint256(5.5e8)));

        vm.startBroadcast();
        arsFeed = address(new ManualFxOracle(oracleOwner, oracleDecimals, "ARS / USD", arsPerUsd));
        brlFeed = address(new ManualFxOracle(oracleOwner, oracleDecimals, "BRL / USD", brlPerUsd));
        router = address(new AquaFXSwapVMRouter(aqua, weth, owner, name, version));
        vm.stopBroadcast();

        require(address(AquaFXSwapVMRouter(payable(router)).AQUA()) == aqua, "router bound to a different Aqua");
        require(router.code.length <= 24_576, "router exceeds EIP-170");

        console2.log("ARS / USD ManualFxOracle:", arsFeed);
        console2.log("BRL / USD ManualFxOracle:", brlFeed);
        console2.log("AquaFXSwapVMRouter:", router);
        console2.log("  runtime bytes:", router.code.length);
        console2.log("  FXSwap opcode index: 34");
    }
}
