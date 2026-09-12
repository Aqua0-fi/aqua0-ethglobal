// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @notice Derived from swap-vm v1.0.2 `src/opcodes/AquaOpcodes.sol` (© 2025 Degensoft Ltd), extended with FXSwap.

import { Context } from "@1inch/swap-vm/libs/VM.sol";

import { Controls } from "@1inch/swap-vm/instructions/Controls.sol";
import { XYCSwap } from "@1inch/swap-vm/instructions/XYCSwap.sol";
import { Fee } from "@1inch/swap-vm/instructions/Fee.sol";
import { Extruction } from "@1inch/swap-vm/instructions/Extruction.sol";
import { PeggedSwap } from "@1inch/swap-vm/instructions/PeggedSwap.sol";

import { FXSwap } from "../instructions/FXSwap.sol";

/// @title AquaFXOpcodes
/// @notice Aqua instruction set for FX strategies: v1.0.2 `AquaOpcodes` indices preserved, FXSwap appended at 34.
/// @dev Dispatch indices (program byte = index):
///        10 Controls._jump                         11 Controls._jumpIfTokenIn
///        12 Controls._jumpIfTokenOut               13 Controls._deadline
///        14 Controls._onlyTakerTokenBalanceNonZero 15 Controls._onlyTakerTokenBalanceGte
///        16 Controls._onlyTakerTokenSupplyShareGte 17 XYCSwap._xycSwapXD
///        20 Controls._salt                         21 Fee._flatFeeAmountInXD
///        31 PeggedSwap._peggedSwapGrowPriceRange2D 32 Extruction._extruction
///        33 Controls._onlyTxOriginTokenBalanceNonZero
///        34 FXSwap._fxSwap2D
///      Removed to fit EIP-170 (slots kept as no-ops so every other index matches AquaOpcodes):
///        18 XYCConcentrate, 19 Decay, 27 protocol fee, 28 Aqua protocol fee, 29 dynamic protocol fee,
///        30 Aqua dynamic protocol fee. 0-9 and 22-26 are unused, as in AquaOpcodes.
contract AquaFXOpcodes is Controls, XYCSwap, Fee, PeggedSwap, Extruction, FXSwap {
    constructor(address aqua) Fee(aqua) { }

    function _notInstruction(Context memory, /* ctx */ bytes calldata /* args */ ) internal view { }

    function _opcodes()
        internal
        pure
        virtual
        returns (function(Context memory, bytes calldata) internal[] memory result)
    {
        function(Context memory, bytes calldata) internal[36] memory instructions = [
            _notInstruction,
            // 0-9: Debug - reserved
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            // 10-16: Controls
            Controls._jump,
            Controls._jumpIfTokenIn,
            Controls._jumpIfTokenOut,
            Controls._deadline,
            Controls._onlyTakerTokenBalanceNonZero,
            Controls._onlyTakerTokenBalanceGte,
            Controls._onlyTakerTokenSupplyShareGte,
            // 17: XYCSwap
            XYCSwap._xycSwapXD,
            // 18: XYCConcentrate (not included)
            _notInstruction,
            // 19: Decay (not included)
            _notInstruction,
            // 20-21
            Controls._salt,
            Fee._flatFeeAmountInXD,
            // 22-26: unused
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            // 27-30: protocol fees (not included)
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            // 31-33
            PeggedSwap._peggedSwapGrowPriceRange2D,
            Extruction._extruction,
            Controls._onlyTxOriginTokenBalanceNonZero,
            // 34: FXSwap
            FXSwap._fxSwap2D
        ];

        // Turn the static array into a dynamic one by overwriting slot 0 (_notInstruction) with the length
        uint256 instructionsArrayLength = instructions.length - 1;
        assembly ("memory-safe") {
            result := instructions
            mstore(result, instructionsArrayLength)
        }
    }
}
