# Vendored RedStone contracts

The minimal set of RedStone sources that `src/oracles/AquaRedStoneFeeds.sol` compiles against, copied unmodified from npm:

| Directory | Package | Version | License |
| --- | --- | --- | --- |
| `on-chain-relayer/contracts` | `@redstone-finance/on-chain-relayer` | 0.9.0 | BUSL-1.1 (see `on-chain-relayer/LICENSE`) |
| `evm-connector/contracts` | `@redstone-finance/evm-connector` | 0.9.0 | BUSL-1.1 (see `evm-connector/LICENSE`) |
| `chainlink/src/v0.8/shared/interfaces/AggregatorV3Interface.sol` | `@chainlink/contracts` | 1.2.0 | MIT |

Only the files needed for `MultiFeedAdapterWithoutRoundsPrimaryProd` and `PriceFeedWithoutRoundsForMultiFeedAdapter` are included. They are vendored instead of installed because the full relayer package pulls in its off-chain relayer runtime. `remappings.txt` maps the package import paths here, and `@openzeppelin/contracts-upgradeable` to the OpenZeppelin 5.4 copy already under `lib/swap-vm` (only `Initializable` and `SafeCast` are used).

Aqua0 uses these contracts on Arc Testnet only.
