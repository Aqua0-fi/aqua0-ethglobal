// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IPriceOracle } from "@1inch/swap-vm/instructions/interfaces/IPriceOracle.sol";

/// @title ManualFxOracle
/// @notice Chainlink AggregatorV3-compatible FX feed whose answer the owner sets by hand.
/// @dev For tests and the Arc demo only: there is no aggregation, no heartbeat and no round history. Every update
///      opens a new round; getRoundData only serves the latest one.
contract ManualFxOracle is IPriceOracle, Ownable {
    error ManualFxOracleNonPositiveAnswer(int256 answer);
    error ManualFxOracleFutureTimestamp(uint256 updatedAt, uint256 nowTs);
    error ManualFxOracleNoDataPresent(uint80 roundId);

    /// @notice Chainlink's AggregatorInterface event, so off-chain tooling can follow updates
    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    uint8 private immutable _DECIMALS;

    /// @inheritdoc IPriceOracle
    string public description;

    uint80 private _roundId;
    int256 private _answer;
    uint256 private _updatedAt;

    /// @param owner_ Account allowed to set answers
    /// @param decimals_ Decimals of the answer (Chainlink FX feeds use 8)
    /// @param description_ Feed description, e.g. "ARS / USD"
    /// @param initialAnswer First answer, published at deployment time
    constructor(address owner_, uint8 decimals_, string memory description_, int256 initialAnswer) Ownable(owner_) {
        _DECIMALS = decimals_;
        description = description_;
        _publish(initialAnswer, block.timestamp);
    }

    /// @notice Publish a new answer timestamped now
    function setAnswer(int256 answer) external onlyOwner {
        _publish(answer, block.timestamp);
    }

    /// @notice Publish a new answer with an explicit (past or present) timestamp, e.g. to simulate a stale feed
    function setAnswerWithTimestamp(int256 answer, uint256 updatedAt) external onlyOwner {
        require(updatedAt <= block.timestamp, ManualFxOracleFutureTimestamp(updatedAt, block.timestamp));
        _publish(answer, updatedAt);
    }

    /// @inheritdoc IPriceOracle
    function decimals() external view returns (uint8) {
        return _DECIMALS;
    }

    /// @inheritdoc IPriceOracle
    function version() external pure returns (uint256) {
        return 1;
    }

    /// @inheritdoc IPriceOracle
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    /// @inheritdoc IPriceOracle
    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        require(roundId == _roundId, ManualFxOracleNoDataPresent(roundId));
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    function _publish(int256 answer, uint256 updatedAt) private {
        require(answer > 0, ManualFxOracleNonPositiveAnswer(answer));
        _answer = answer;
        _updatedAt = updatedAt;
        emit AnswerUpdated(answer, ++_roundId, updatedAt);
    }
}
