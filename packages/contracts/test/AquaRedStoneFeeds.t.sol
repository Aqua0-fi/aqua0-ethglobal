// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { IRedstoneAdapter } from "@redstone-finance/on-chain-relayer/contracts/core/IRedstoneAdapter.sol";

import { AquaRedStoneMultiFeedAdapter, AquaRedStonePriceFeed } from "../src/oracles/AquaRedStoneFeeds.sol";

/// @notice RedStone feeds FXSwap reads on Arc. The signed-payload test replays the exact `updateDataFeedsValuesPartial`
///         calldata sent on Arc Testnet (real redstone-primary-prod signatures), so signature, threshold and median
///         checks run here without a fork.
contract AquaRedStoneFeedsTest is Test {
    bytes32 internal constant DATA_FEEDS_STORAGE_LOCATION =
        0x5e9fb4cb0eb3c2583734d3394f30bb14b241acb9b3a034f7e7ba1a62db4370f1;
    uint256 internal constant ARC_BLOCK_TIMESTAMP = 1_789_221_672;

    AquaRedStoneMultiFeedAdapter internal adapter;
    AquaRedStonePriceFeed internal brl;
    AquaRedStonePriceFeed internal mxn;

    function setUp() public {
        vm.warp(ARC_BLOCK_TIMESTAMP);
        adapter = new AquaRedStoneMultiFeedAdapter();
        brl = new AquaRedStonePriceFeed(IRedstoneAdapter(address(adapter)), bytes32("BRL"), "RedStone BRL / USD (USD per 1 BRL)");
        mxn = new AquaRedStonePriceFeed(IRedstoneAdapter(address(adapter)), bytes32("MXNe"), "RedStone MXNe (MXN per 1 USD)");
    }

    function test_SignedArcPayloadStoresMedianValues() public {
        string memory json = vm.readFile("test/fixtures/redstone-arc-update.json");
        bytes memory calldata_ = vm.parseJsonBytes(json, ".calldata");

        (bool ok,) = address(adapter).call(calldata_);
        assertTrue(ok, "signed update");

        (, int256 brlAnswer,, uint256 brlUpdatedAt,) = brl.latestRoundData();
        (, int256 mxnAnswer,, uint256 mxnUpdatedAt,) = mxn.latestRoundData();
        assertEq(brlAnswer, int256(vm.parseJsonUint(json, ".stored.BRL")));
        assertEq(mxnAnswer, int256(vm.parseJsonUint(json, ".stored.MXNe")));
        assertEq(brlUpdatedAt, ARC_BLOCK_TIMESTAMP);
        assertEq(mxnUpdatedAt, ARC_BLOCK_TIMESTAMP);
        assertEq(brl.decimals(), 8);
        assertEq(brl.description(), "RedStone BRL / USD (USD per 1 BRL)");
        assertEq(brl.getDataFeedId(), bytes32("BRL"));

        // The same payload cannot be replayed: its data timestamp is not newer than the stored one.
        vm.warp(ARC_BLOCK_TIMESTAMP + 1);
        (ok,) = address(adapter).call(calldata_);
        assertTrue(ok, "replay is skipped, not reverted");
        (,,, brlUpdatedAt,) = brl.latestRoundData();
        assertEq(brlUpdatedAt, ARC_BLOCK_TIMESTAMP);
    }

    function test_PayloadOlderThanThreeMinutesReverts() public {
        bytes memory calldata_ = vm.parseJsonBytes(vm.readFile("test/fixtures/redstone-arc-update.json"), ".calldata");
        vm.warp(ARC_BLOCK_TIMESTAMP + 4 minutes);
        (bool ok,) = address(adapter).call(calldata_);
        assertFalse(ok);
    }

    function test_UnsignedUpdateReverts() public {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = bytes32("BRL");
        vm.expectRevert();
        adapter.updateDataFeedsValuesPartial(ids);
    }

    /// @dev Same packing the MCP uses for eth_call state overrides (packages/shared/src/redstone.ts).
    function test_StorageLayoutMatchesQuoteOverride() public {
        uint256 word = 1_789_221_660_000 | (ARC_BLOCK_TIMESTAMP << 48) | (uint256(19_402_073) << 96);
        vm.store(address(adapter), keccak256(abi.encode(bytes32("BRL"), DATA_FEEDS_STORAGE_LOCATION)), bytes32(word));

        (uint256 dataTimestamp, uint256 blockTimestamp, uint256 value) = adapter.getLastUpdateDetails(bytes32("BRL"));
        assertEq(dataTimestamp, 1_789_221_660_000);
        assertEq(blockTimestamp, ARC_BLOCK_TIMESTAMP);
        assertEq(value, 19_402_073);
        (, int256 answer,,,) = brl.latestRoundData();
        assertEq(answer, 19_402_073);
    }

    function test_ReadsRevertWithoutValueOrAfterThirtyHours() public {
        vm.expectRevert();
        brl.latestRoundData();

        uint256 word = 1_789_221_660_000 | (ARC_BLOCK_TIMESTAMP << 48) | (uint256(19_402_073) << 96);
        vm.store(address(adapter), keccak256(abi.encode(bytes32("BRL"), DATA_FEEDS_STORAGE_LOCATION)), bytes32(word));
        vm.warp(ARC_BLOCK_TIMESTAMP + 30 hours);
        vm.expectRevert();
        brl.latestRoundData();
    }
}
