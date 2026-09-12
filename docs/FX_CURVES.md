# Curvas de FX adaptables a un opcode de SwapVM

Relevamiento hecho el 2026-09-12 para reemplazar la curva actual de `scripts/fxswap_math.py`
(que resultó ser el PMM de DODO y tiene premium sin cota y leak con target dinámico, ver
`scripts/fxswap_math_edges.py`).

## 0. Qué puede hacer un opcode (verificado en `1inch/swap-vm` 0.0.5, solo lectura)

- Recibe `Context` (balances de Aqua, amounts, tokenIn/Out) y `args` inmutables del programa.
- Puede ser `pure` (XYCSwap, PeggedSwap, LimitSwap), `view` (OraclePriceAdjuster lee Chainlink) o
  **tener storage propio keyed por `orderHash`** (Decay, XYCConcentrate, TWAPSwap lo hacen).
  Una curva con estado (EMA, price_scale) es posible, no es gratis.
- Ya existen y sirven de base:
  - `PeggedSwap`: `√(x/X0) + √(y/Y0) + A·(x/X0 + y/Y0) = 1 + A`. Curva tipo StableSwap con solución
    cerrada (cuadrática en `√v`), escala 1e27. `X0, Y0` son "reservas de referencia" con rate
    multipliers, o sea, el peg está en los args.
  - `XYCSwap` + `XYCConcentrate`: producto constante con reservas virtuales (deltas).
  - `OraclePriceAdjuster`: lee Chainlink y solo mejora el precio al taker (para LimitSwap).
  - `Power.sol`: potencias fraccionarias (necesario para Clipper).

## 1. Candidatas

### A. Curve CryptoSwap (v2)
- Invariante: `K0 = ∏x'_i·n^n/D^n`, `K = A·K0·γ²/(γ+1-K0)²`, `K·D^(n-1)·Σx'_i + ∏x'_i = K·D^n + (D/n)^n`,
  con `x'_i = x_i·price_scale_i`.
- Oráculo interno: EMA de los precios que el pool observa. El `price_scale` se mueve hacia el EMA solo
  si la pérdida de re-anclar cabe en la mitad del `xcp_profit` acumulado.
- Estado: `price_scale`, `price_oracle`, `last_prices`, `D`, `xcp_profit`, `virtual_price`, timestamps.
  `D` e `y` por Newton.
- Para FX: no necesita Pyth para cotizar, pero el precio se descubre off-chain y el repeg lo sigue
  con retraso y solo cuando hay fee acumulado. Es un pool, no un maker. Fit en opcode: bajo
  (storage grande + Newton + lógica de repeg).

### B. StableSwap con rate de oráculo (Curve stableswap-ng con oracle, Stabull, paper arXiv 2608.30957)
- `x' = x`, `y' = p·y` (BRL escalado a USDC por Pyth). Invariante `A·n^n·(x'+y') + D = A·n^n·D + D³/(4·x'·y')`.
- Para 2 activos `y'` sale de una cuadrática (forma cerrada). `D` es cúbica: Newton 2-4 iteraciones o
  Cardano. Ambos deterministas, sin estado.
- Fee dinámico por desbalance (`offpeg_fee_multiplier`) como defensa ante error de oráculo.
- El paper de FX recomienda `A ∈ [100, 200]`: `TVL/Q ≈ 1000/A` para 2 bps de slippage; con `A ≥ 500`
  el drenaje bajo shock llega al 60% de la reserva.
- Fit en opcode: **alto**. `PeggedSwap` ya es esta familia; recentrar `X0, Y0` con Pyth en cada swap
  ("PeggedSwap anclado a oráculo") es el camino más corto. Invariante recomputado desde balances en
  cada swap, o sea, path independent por construcción.
- Contras: el premium crece sin cota cuando una reserva se acerca a 0 (como xy=k), no hay límite
  explícito de inventario, hay que agregarlo (halt) o confiar en A moderado.

### C. Shell v1 / DFX v2 (curva piecewise anclada a oráculo)
- Fuente: `dfx-finance/protocol-v2/src/CurveMath.sol`.
- Ideal de cada activo: `ideal_i = gLiq·w_i` con `gLiq = Σ x'_i` (todo a oráculo).
- `psi = Σ microFee(bal_i, ideal_i)`:
  - dentro de `±beta` del ideal: 0 (precio = oráculo, slippage 0).
  - fuera: `m = |bal - ideal·(1∓beta)|`, `fee = min(m·delta/ideal, MAX)·m` (cuadrático en la
    desviación).
  - fuera de `±alpha`: **halt**, revierte.
- Trade: `out = -(in + omega - psi)` si la fee sube, `-(in + lambda·(omega - psi))` si baja
  (`lambda` decide cuánto de la mejora se devuelve al taker). DFX lo resuelve por iteración (32 max);
  con 2 activos y fee cuadrática por tramo es cerrable analíticamente.
- Params típicos DFX: `alpha=0.5, beta=0.35, delta=0.15, max=0.25, epsilon=fee base, lambda=0.3`.
- Fit en opcode: **alto**. Sin estado, forma cerrada por tramo, límites de inventario explícitos
  (`alpha`), pérdida acotada. Es lo más parecido a "un maker FX serio": spread base `epsilon`,
  zona plana, skew cuadrático, corte duro.
- Contras: dentro de `±beta` el único escudo contra error de oráculo es `epsilon`; hay que usar el
  `conf` de Pyth como fee dinámico y rechazar staleness.

### D. Clipper FMM (Shipyard, whitepaper `sushi-labs/market-making-whitepaper`)
- Invariante `I = (x_1^(1-k) + (M_2·x_2)^(1-k))^(1/(1-k))`, `M_2 = 1/p`, `k ∈ [0,1)`.
- Precio marginal: `oráculo^(1-k) · (ratio de inventario)^k`. `k=0` constant-sum al oráculo,
  `k→1` producto constante. Clipper usa `k=0.5` en mainnet y `k=0.1` en Polygon.
- Trade cerrado: `y_2 = ((I - x_1'^(1-k))^(1/(1-k)))/M_2`. Necesita `pow` fraccionaria (`Power.sol`).
- Fit en opcode: medio-alto. Sin estado, un solo parámetro con significado claro (cuánto confiar en
  el oráculo vs el inventario). Sin límite de inventario ni spread propio, hay que agregar fee.
- Contras: `pow` fraccionaria on-chain cuesta gas y precisión; sin halt.

### E. Mento (Celo) / Lifinity: producto constante sobre reservas virtuales ancladas al oráculo
- Buckets virtuales `X = f·U`, `Y = X/p` (o `c·inventario` en Lifinity), swap `xy=k` sobre los
  buckets con spread `s`: `out = in·(1-s)·Y/(X + in·(1-s))`. Mento resetea los buckets cada
  actualización de oráculo (~5 min); Lifinity v2 agrega target de inventario y rebalanceo diferido.
- Fit en opcode: alto si los buckets se derivan de oráculo+balances en cada swap (queda `pure`);
  medio si se quiere el reset periódico (storage). Es `XYCSwap` + `XYCConcentrate` con deltas
  calculados desde Pyth.
- Contras: pérdida por error de oráculo acotada por el tamaño del bucket, no por un halt; el skew de
  inventario es implícito.

### F. Mid ± spread con skew lineal (market making clásico, Avellaneda-Stoikov simplificado)
- `P(B) = p·(1 + λ·(B0 - B)/B0)`, `bid = P·(1 - s)`, `ask = P·(1 + s)`.
- Integral cuadrática, cerrada. Premium acotado en `λ` (en `B=0`), a diferencia del `k·r²` actual.
- Fit en opcode: máximo, es la curva actual con el término `(B0/B)²` reemplazado por uno lineal y
  spread explícito. Sin estado.
- Contras: sin límite duro de inventario salvo que se agregue; no hay literatura on-chain que lo
  respalde, es un diseño propio.

### G. La actual (DODO PMM) con arreglos
- Target fijo (`B0` en args, no recomputado), cap en `r = B0/B` o en el premium, validar estado
  inicial. Queda usable pero sigue sin spread propio y con la asimetría `k` vs `k·r²`.

## 2. Comparación

| | Forma cerrada | Estado | Oráculo | Premium acotado | Límite inventario | Path indep. | Fit opcode |
|---|---|---|---|---|---|---|---|
| A CryptoSwap | no (Newton) | mucho | interno (EMA) | no | no | sí | bajo |
| B StableSwap+oráculo | y sí, D Newton corto | no | Pyth | no | no (agregar) | sí | alto (reusa PeggedSwap) |
| C Shell/DFX | sí por tramo | no | Pyth | sí (MAX) | sí (alpha) | sí | alto |
| D Clipper FMM | sí, con pow | no | Pyth | no | no | sí | medio-alto |
| E Mento/Lifinity | sí | no / poco | Pyth | por bucket | no | sí | alto (reusa XYC) |
| F Mid+skew lineal | sí | no | Pyth | sí (λ) | no (agregar) | sí | máximo |
| G DODO arreglado | sí | no | Pyth | con cap | con cap | sí (target fijo) | ya hecho |

Común a todas las que usan Pyth: chequear `publishTime` (staleness) y usar `conf` como piso de fee.
El error de oráculo tolerado es siempre "el spread": si el oráculo se desvía más que el fee en la zona
plana, drenar es rentable (ver test 20 de la curva actual).

## 3. Recomendación

Finalistas: **C (Shell/DFX)** por ser el diseño de un maker de FX con límites explícitos, y **B
(StableSwap anclado)** por ser el más barato de implementar reusando `PeggedSwapMath`. F es el parche
mínimo si se quiere conservar la estructura actual.

Siguiente paso, a decidir: elijo una (o dos) y escribo la referencia en Python en `scripts/` con la
misma batería de tests 1-22 que ya corre contra la curva actual, para comparar con números.

## Fuentes
- swap-vm 0.0.5: `src/instructions/{PeggedSwap,XYCConcentrate,OraclePriceAdjuster,Decay}.sol`, `src/libs/PeggedSwapMath.sol`
- DFX v2: https://github.com/dfx-finance/protocol-v2 (`src/CurveMath.sol`), https://docs.dfx.finance/protocol/v2-dfx-amm
- Clipper FMM: https://www.shipyardsoftware.org/post/what-is-a-fmm , https://github.com/sushi-labs/market-making-whitepaper
- Curve CryptoSwap: https://docs.curve.finance/protocol/pool/understanding-cryptoswap , https://0xreviews.xyz/posts/2022-03-04-Curve-CryptoSwap-repegging/
- StableSwap-NG con oráculo y fee dinámico: https://docs.curve.finance/stableswap-exchange/stableswap-ng/pools/overview/ , https://mixbytes.io/blog/safe-stableswap-ng-deployment-how-to-avoid-risks-from-volatile-oracles
- Paper FX on-chain (A, TVL, drenaje): https://arxiv.org/html/2608.30957
- Mento: https://docs.celo.org/legacy/protocol/stability/doto , https://docs.mento.org/mento/economics/stability
- Lifinity v2: https://docs.lifinity.io/dex/v2
- Stabull: https://docs.stabull.finance/amm/liquidity
