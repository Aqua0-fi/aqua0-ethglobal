// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IRedstoneAdapter } from "@redstone-finance/on-chain-relayer/contracts/core/IRedstoneAdapter.sol";
import { MultiFeedAdapterWithoutRoundsPrimaryProd } from
    "@redstone-finance/on-chain-relayer/contracts/price-feeds/data-services/MultiFeedAdapterWithoutRoundsPrimaryProd.sol";
import { PriceFeedWithoutRoundsForMultiFeedAdapter } from
    "@redstone-finance/on-chain-relayer/contracts/price-feeds/without-rounds/PriceFeedWithoutRoundsForMultiFeedAdapter.sol";

/// @title AquaRedStoneMultiFeedAdapter - RedStone primary-prod prices for FXSwap on Arc Testnet
/// @notice Stores RedStone `redstone-primary-prod` values. Anyone can push a signed RedStone payload with
///         `updateDataFeedsValuesPartial(bytes32[])`, the payload appended to the calldata; a value is stored only
///         when 3 of the 5 RedStone primary-prod signers agree, its data timestamp is newer than the stored one and
///         at most 3 minutes old. No keeper and no owner: the swap client pushes the payload before it swaps.
contract AquaRedStoneMultiFeedAdapter is MultiFeedAdapterWithoutRoundsPrimaryProd { }

/// @title AquaRedStonePriceFeed - Chainlink-style view of one RedStone feed
/// @notice FXSwap reads this with oracle kind 0 (`latestRoundData`). `answer` has 8 decimals and `updatedAt` is the
///         block time of the last successful update, so FXSwap's `maxStaleness` bounds the time since the last push.
///         Reads revert once the stored value is older than the adapter's 30 hour limit.
contract AquaRedStonePriceFeed is PriceFeedWithoutRoundsForMultiFeedAdapter {
    IRedstoneAdapter private immutable ADAPTER;
    bytes32 private immutable DATA_FEED_ID;
    string private feedDescription;

    constructor(IRedstoneAdapter adapter, bytes32 dataFeedId, string memory description_) {
        ADAPTER = adapter;
        DATA_FEED_ID = dataFeedId;
        feedDescription = description_;
    }

    function getDataFeedId() public view override returns (bytes32) {
        return DATA_FEED_ID;
    }

    function getPriceFeedAdapter() public view override returns (IRedstoneAdapter) {
        return ADAPTER;
    }

    function description() public view override returns (string memory) {
        return feedDescription;
    }
}
