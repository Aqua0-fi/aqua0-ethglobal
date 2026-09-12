# Forex curve for the SwapVM opcode

Shell v1 curve with an oracle, as DFX v2 runs it in production for EURC, CADC and XSGD against USDC.
Reference implementation: `scripts/fxforex_math.py`. Port guide: `docs/FX_OPCODE_HANDOFF.md`.

## The curve

Everything in numeraire: `x = USDC`, `y = p·BRL` (`p` = USDC per BRL from Pyth), `g = x + y`, ideal `I = g/2`.

- Within `±β` of the ideal: price = oracle, zero slippage.
- Outside: each asset pays `μ = min(δ·m/I, MAX)·m`, `m` = distance to the band. `ψ = μ_x + μ_y`.
- A trade retains `s = ψ_after − ψ_before` if the fee rises; if it falls, `λ·(ψ_before − ψ_after)` goes back to the taker.
- Beyond `±α`: revert (halt). `ε` is a separate proportional fee; add Pyth's `conf/price` to it.

Why this one: stateless, closed form, explicit inventory limits, bounded loss (`β band × oracle error`),
and every parameter has a plain meaning. DFX solves the trade by iterating 32 times; here it is a
quadratic per piece (unknown `s`, multiply the fixed point by `g+s`), which is what an opcode needs.

## Verification (2026-09-12)

- Matches DFX's own iteration at the ulp of the book (1e-16) in every piece, three parameter sets, ~20k trades each.
- Matches nine live quotes from the DFX EURC/USDC pool on Ethereum (`0x8cd86fbC…`) to 1e-6 token units, on both sides of the `β` band, including reverts.
- Matches an independent 40-digit Decimal bisection to 1e-16.
- Invariants, 0 failures: utility `g − ψ` never drops; price = oracle inside the band; roundtrip, split and closed sequences never leave the taker a gain; price continuous across `β`; inverse exactIn/exactOut at 1e-11.
- DFX's 32-step loop fails to converge on large trades (seen live with 1000 EURC); the closed form does not.

Premium buying x% of BRL, balanced book:

```
      x:        1%      5%     10%     20%     30%     40%     49%
    b=0.0  d=0.15   0.301%   1.522%   3.089%   6.347%   9.757%  13.295%    halt
    b=0.1  d=0.15   0.000%   0.000%   0.000%   1.539%   4.204%   7.245%    halt
    b=0.35 d=0.15   0.000%   0.000%   0.000%   0.000%   0.000%   0.189%   1.230%
```

## Simulations, small books (`scripts/fxforex_sim.py`)

30 days hourly, takers ~12/day with a $100 median size and a price tolerance, hourly arbitrageur
against the true price, Pyth-like oracle with `conf`. PnL vs holding the initial inventory, 8 paths.

| USDC/BRL | $5k | $25k |
|---|---|---|
| DFX prod `β=.35 ε=15bps λ=1` | +1.6% [0.9, 2.5], 11 halts/month | +0.7% [0.1, 1.6] |
| conservative `β=.15 ε=30bps λ=.3` | +2.6% [2.2, 2.9], 4 halts | +0.9% [0.5, 1.2] |

Takeaways:
- `conf` in the spread is the only defense inside the flat band. Without it a noisy oracle turns +1.2% into -3.8%.
- Oracle freshness matters: 1h of staleness turns +1.2% into -1.8% on BRL.
- $5k books halt 4-13 times a month and lose takers on price; at $25k halts disappear.
- Under heavy flow (48/day) the DFX params lose on a $5k book (-1.4%) and the conservative ones gain (+7.3%): the narrow band and `λ=0.3` stop giving the rebalancing away.
- `ε` between 5 and 100 bps barely moves PnL, takers leave as it rises. With `conf` in, 15-30 bps is enough.
- Directional flow leaves the book long the local currency; a devaluation hits it harder than hold. No curve covers that.

Recommended: `α=0.5 β=0.15 δ=0.5 MAX=0.25 λ=0.3 ε=30 bps` + `conf`.

## Demo

Arc Testnet, USDC/BRL. Pyth has no ARS feed. Details in `docs/FX_OPCODE_HANDOFF.md`.
