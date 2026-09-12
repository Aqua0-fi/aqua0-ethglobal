// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Minimal views of the pre-existing Aqua0 vault contracts deployed on Arc Testnet.
/// @dev Only the members this package calls. Signatures match the Arc deployment (Aqua0 contracts @ 8a9f1c2).

interface IVaultRegistry {
    function classForStrategy(bytes32 strategyKey) external view returns (uint256);
    function registerStrategyClass(bytes32 strategyKey) external returns (uint256 classId);
}

interface IAssetVault {
    function classStrategist(uint256 strategyId) external view returns (address);
    function registerStrategy(uint256 strategyId, address strategist) external;
    function deposit(uint256 assets, address receiver) external returns (uint256 received);
    function setCommitment(uint256 strategyId, bool backing) external;
    function freePrincipal(address lp) external view returns (uint256);
    function committedBacking(uint256 strategyId) external view returns (uint256);
    function availableFor(uint256 strategyId) external view returns (uint256);
}

interface IAquaAdapter {
    function strategistNonces(address strategist) external view returns (uint256);
    function currentAquaHash(bytes32 strategyId) external view returns (bytes32);
    function shipStrategyWithFee(
        uint256 classId,
        bytes calldata strategyBytes,
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint32 feePpb,
        uint256 nonce,
        uint256 deadline,
        bytes calldata strategistSig
    ) external returns (bytes32 strategyId);
}

/// @notice The ARGt / BRAt demo tokens on Arc Testnet expose an open mint.
interface IMintableERC20 {
    function mint(address to, uint256 amount) external;
}
