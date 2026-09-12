# Forex opcode handoff (SwapVM, Arc Testnet, USDC/BRL)

Branch `fxswap-math` in `ethonline`.

| File | What |
|---|---|
| `scripts/fxforex_math.py` | **Reference to port.** Curve, closed-form solver, halts, fee, tests. `python3 fxforex_math.py` must report 0 failures. |
| `scripts/fixtures/fxforex_vectors.json` | 968 vectors (802 quotes, 166 expected reverts) from the reference + 9 live DFX pool quotes. |
| `scripts/gen_fxforex_vectors.py` | Regenerates the vectors. |
| `scripts/fxforex_sim.py` | Pool simulator for parameter choice. |
| `docs/FX_CURVES.md` | The curve, its verification, simulation takeaways. |

Ignore `fxswap_math*.py` and `fxcurves_compare.py`, they are not the curve.

## Parameters

Recommended: `α=0.5 β=0.15 δ=0.5 MAX=0.25 λ=0.3 ε=30 bps`, plus Pyth `conf/price` added to `ε`.
DFX production: `α=0.5 β=0.35 δ=0.5 λ=1 ε=15 bps`.

## Algorithm (2D, `view`, no storage)

Inputs: Aqua balances `U` (USDC), `B` (BRL); args `(α, β, δ, MAX, λ, ε, feedId, maxAge)`; amount, direction, exactIn/Out.

1. **Oracle.** `IPyth(0x2880aB155794e7179c9eE2e38200202908C17B43).getPriceNoOlderThan(feedId, maxAge)`.
   Feed is `FX.USD/BRL` (BRL per USD): `p = 10^-expo / price`. `εeff = ε + conf/price`.
2. **Numeraire.** `x = U`, `y = p·B`, decimals normalized.
3. **Trade.** `a` = change of the input asset (exactIn: `+amount`; exactOut: `−output`, result comes out positive). Output change `o`:
   - `ω = ψ(x, y)`. At `s = 0`: `x' = x ± a`, `y' = y ∓ a`. If `ω = 0` and `ψ(x', y') = 0` → `o = −a` (fast path, most trades).
   - Else, per regime of each asset (inside / below-quad / below-cap / above-quad / above-cap) and `c ∈ {1, λ}`: quadratic `A s² + B s + C = 0` with coefficients from `_regime_coeffs` and `_piece`; small root in stable form (`r1 = (−B − sign(B)√disc)/(2A)`, `s = C/(A·r1)`); accept the root whose regime and `c` are consistent. The regime at `s = 0` is right almost always: try it first, check `|s − c(ψ(s) − ω)|` is small.
   - `o = s − a`.
4. **Halts** (`enforce_halts`, verbatim DFX): a balance may end outside `±α` only if it already was and the excursion does not grow. **Invariant**: `(g' − ψ') − (g − ω) ≥ −1e-6`.
5. **ε.** exactIn: `out = −o·(1 − εeff)`. exactOut: solve with the exact output, then `in = in·(1 + εeff)`.
6. Back to token units (`/p` for BRL).

Rounding always against the taker. 1e18 scale is enough (`m²·δ` fits with balances ≤ 1e30).
Must revert: `U = 0`, `B = 0`, output ≥ balance.

## Validation

`vm.parseJson` the fixture, compare `amountIn/amountOut` within a few wei, reverts by name. The
`onchain_dfx_eurc_usdc` entries are live quotes from `0x8cd86fbC94BeBFD910CaaE7aE4CE374886132c48`.
Fuzz: utility never drops; `o = −a` inside the band; roundtrip and split never leave the taker a gain.

## SwapVM

Model it on `PeggedSwap._peggedSwapGrowPriceRange2D` (args parsing, pure math, 1e27) plus
`OraclePriceAdjuster._oraclePriceAdjuster1D` (oracle read in a `view` opcode). Pick the numeraire side
by token address order as `PeggedSwap` does. Use either the internal `ε` or SwapVM's `Fee`, not both.

## Pyth on Arc Testnet (verified 2026-09-12)

- Chain `5042002`, RPC `https://rpc.testnet.arc.network`, Pyth `0x2880aB155794e7179c9eE2e38200202908C17B43`.
- Feed id `0xd2db4dbf1aea74e0f666b0e8f73b9580d407f5e5cf931940b06dc633d7a95906`. **Never pushed on Arc** (`PriceFeedNotFound`). Pull oracle: call `updatePriceFeeds` with the Hermes update (fee 1 wei) before or in the swap tx.
- Hermes returns **401** on `/v2/updates/price/latest` (both public hosts). Needs a key or another provider. Open.
- Feed has market hours, closed on weekends. `validTimePeriodSeconds` is 60 s: pick a weekend `maxAge` policy or demo on a weekday.
- `conf` seen elsewhere: 10-30 bps. No ARS feed on Pyth.

## Open

Final parameters; staleness/weekend policy; who posts the Pyth update and from where; `ε` vs `Fee`.
