// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console2 } from "forge-std/Script.sol";
import { AquaRouter } from "@1inch/aqua/src/AquaRouter.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/routers/AquaSwapVMRouter.sol";

/// @title DeployAquaVenue
/// @notice Deploys 1inch Aqua (`AquaRouter`: Aqua + Simulator + Multicall, the recommended deployment entry
///         point) at the aqua 0.1.0 release swap-vm v1.0.2 pins, and a stock `AquaSwapVMRouter` bound to it.
/// @dev Arc has no WETH, so the router's WETH defaults to the zero address: it only gates native-token
///      receipts and unwrap-on-output, neither of which an ERC-20 Aqua strategy on Arc uses.
///      The EIP-712 name defaults to `AquaSwapVMRouter`, one of the two names Aqua0's AquaAdapter accepts.
contract DeployAquaVenue is Script {
    function run() external returns (address aqua, address router) {
        address owner = vm.envAddress("ROUTER_OWNER");
        address weth = vm.envOr("ROUTER_WETH", address(0));
        string memory name = vm.envOr("ROUTER_NAME", string("AquaSwapVMRouter"));
        string memory version = vm.envOr("ROUTER_VERSION", string("1.0.2"));

        vm.startBroadcast();
        aqua = address(new AquaRouter());
        router = address(new AquaSwapVMRouter(aqua, weth, owner, name, version));
        vm.stopBroadcast();

        require(address(AquaSwapVMRouter(payable(router)).AQUA()) == aqua, "router bound to a different Aqua");

        console2.log("Aqua (AquaRouter):", aqua);
        console2.log("AquaSwapVMRouter:", router);
    }
}
