// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console2 } from "forge-std/Script.sol";

import { IRedstoneAdapter } from "@redstone-finance/on-chain-relayer/contracts/core/IRedstoneAdapter.sol";

import { AquaRedStoneMultiFeedAdapter, AquaRedStonePriceFeed } from "../src/oracles/AquaRedStoneFeeds.sol";

/// @title DeployRedStoneFeeds
/// @notice Deploys the RedStone price feeds FXSwap reads on Arc Testnet: one AquaRedStoneMultiFeedAdapter holding
///         RedStone `redstone-primary-prod` values, and one Chainlink-style AquaRedStonePriceFeed per feed.
///         - `BRL`:  USD per 1 BRL, 8 decimals (FXSwap strategies on USDC/BRL set FLAG_INVERT_PRICE accordingly)
///         - `MXNe`: MXN per 1 USD, 8 decimals, priced from Etherfuse's MXNe stablecoin
///         Values arrive only through signed RedStone payloads pushed with `updateDataFeedsValuesPartial`; there is
///         no owner and nothing to configure after deployment.
/// @dev Example (simulation only): forge script script/DeployRedStoneFeeds.s.sol --rpc-url $RPC
contract DeployRedStoneFeeds is Script {
    function run() external returns (address adapter, address brlFeed, address mxnFeed) {
        vm.startBroadcast();
        adapter = address(new AquaRedStoneMultiFeedAdapter());
        brlFeed = address(
            new AquaRedStonePriceFeed(IRedstoneAdapter(adapter), bytes32("BRL"), "RedStone BRL / USD (USD per 1 BRL)")
        );
        mxnFeed = address(
            new AquaRedStonePriceFeed(IRedstoneAdapter(adapter), bytes32("MXNe"), "RedStone MXNe (MXN per 1 USD)")
        );
        vm.stopBroadcast();

        console2.log("AquaRedStoneMultiFeedAdapter", adapter);
        console2.log("AquaRedStonePriceFeed BRL", brlFeed);
        console2.log("AquaRedStonePriceFeed MXNe", mxnFeed);
    }
}
