// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console2 } from "forge-std/Script.sol";

import { AquaForexSwapVMRouter } from "../src/routers/AquaForexSwapVMRouter.sol";

/// @title DeployForexVenue
/// @notice Deploys an AquaForexSwapVMRouter bound to an existing Aqua. ForexCurve (the Shell v1 / DFX forex curve) is opcode
///         index 34; every other index the router keeps matches swap-vm v1.0.2 AquaOpcodes (Salt 20, FlatFeeAmountIn 21,
///         PeggedSwap 31, ...). No feeds are deployed: forex strategies read the live RedStone BRL feed and the ARS
///         ManualFxOracle.
/// @dev Environment:
///      AQUA              Aqua (AquaRouter) address the router reads balances from (required)
///      ROUTER_OWNER      router owner, allowed to rescue funds (required)
///      ROUTER_WETH       default address(0) (Arc has no WETH)
///      ROUTER_NAME       default "AquaSwapVMRouter" (the EIP-712 name Aqua0's AquaAdapter accepts)
///      ROUTER_VERSION    default "1.0.2-forex"
///      Used by script/deploy-arc-forex-venue.sh, which reads `returns.router` from the broadcast.
///      Example (simulation only): forge script script/DeployForexVenue.s.sol --rpc-url $RPC
contract DeployForexVenue is Script {
    function run() external returns (address router) {
        address aqua = vm.envAddress("AQUA");
        address owner = vm.envAddress("ROUTER_OWNER");
        address weth = vm.envOr("ROUTER_WETH", address(0));
        string memory name = vm.envOr("ROUTER_NAME", string("AquaSwapVMRouter"));
        string memory version = vm.envOr("ROUTER_VERSION", string("1.0.2-forex"));

        vm.startBroadcast();
        router = address(new AquaForexSwapVMRouter(aqua, weth, owner, name, version));
        vm.stopBroadcast();

        require(address(AquaForexSwapVMRouter(payable(router)).AQUA()) == aqua, "router bound to a different Aqua");
        require(router.code.length <= 24_576, "router exceeds EIP-170");

        console2.log("AquaForexSwapVMRouter:", router);
        console2.log("  runtime bytes:", router.code.length);
        console2.log("  ForexCurve opcode index: 34");
    }
}
