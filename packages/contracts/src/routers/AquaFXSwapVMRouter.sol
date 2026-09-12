// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @notice Derived from swap-vm v1.0.2 `src/routers/AquaSwapVMRouter.sol` (© 2025 Degensoft Ltd).

import { Simulator } from "@1inch/solidity-utils/contracts/mixins/Simulator.sol";

import { Context } from "@1inch/swap-vm/libs/VM.sol";
import { SwapVM } from "@1inch/swap-vm/SwapVM.sol";

import { AquaFXOpcodes } from "../opcodes/AquaFXOpcodes.sol";

/// @title AquaFXSwapVMRouter
/// @notice Aqua SwapVM router whose instruction set adds FXSwap (index 34) to the AquaOpcodes indices it keeps.
/// @dev Deploy with EIP-712 name `AquaSwapVMRouter` so Aqua0's AquaAdapter accepts it, e.g. version `1.0.2-fx`.
contract AquaFXSwapVMRouter is Simulator, SwapVM, AquaFXOpcodes {
    /// @param aqua Aqua instance balances are read from and pulled through
    /// @param weth WETH address (zero on chains without WETH; only unwrap flows use it)
    /// @param owner Owner allowed to rescue funds
    /// @param name EIP-712 domain name
    /// @param version EIP-712 domain version
    constructor(address aqua, address weth, address owner, string memory name, string memory version)
        SwapVM(aqua, weth, owner, name, version)
        AquaFXOpcodes(aqua)
    { }

    /// @dev Returns instruction set for VM execution
    function _instructions()
        internal
        pure
        override
        returns (function(Context memory, bytes calldata) internal[] memory result)
    {
        return _opcodes();
    }
}
