# Handoff: opcode de forex para SwapVM (1inch Aqua) en Arc Testnet

Para quien porta la curva a Solidity. Todo lo de matemática está verificado; lo que falta es el opcode.

## 1. Dónde está todo

Repo `ethonline`, branch **`fxswap-math`** (pedile a Tom que la pushee si no la ves en origin).

| Archivo | Qué es |
|---|---|
| `docs/FX_CURVES.md` | Por qué se descartó la curva anterior, relevamiento de curvas, verificación, simulaciones. Leer §5 y §6. |
| `scripts/fxforex_math.py` | **La referencia a portar.** Curva + solver cerrado + halts + fee + tests. |
| `scripts/fixtures/fxforex_vectors.json` | 968 vectores de test (802 quotes, 166 reverts esperados) generados desde la referencia, más 9 cotizaciones reales de un pool de DFX en Ethereum. |
| `scripts/gen_fxforex_vectors.py` | Regenera los vectores si cambiás parámetros o querés más. |
| `scripts/fxforex_sim.py` | Simulador de pools chicos, para elegir parámetros. |
| `scripts/fxswap_math*.py`, `scripts/fxcurves_compare.py` | Historia (curva DODO descartada y comparación). **No portar.** |

Correr todo: `cd scripts && python3 fxforex_math.py` (2-3 min, todo debe dar 0 fallos).

## 2. La curva en cinco líneas

Es la curva de Shell v1 con oráculo, tal como la usa DFX v2 en producción para EURC, CADC, XSGD contra USDC.

- Todo se mide en **numerario**: `x = USDC`, `y = p · BRL`, con `p` = USDC por BRL del oráculo. `g = x + y`, ideal `I = g/2`.
- Dentro de `±β` del ideal: precio = oráculo, slippage cero.
- Fuera: cada activo paga una micro-fee `μ = min(δ·m/I, MAX) · m` con `m` = distancia a la banda. `ψ = μ_x + μ_y`.
- El trade retiene `s = ψ_después − ψ_antes` en el pool si la fee sube; si baja, devuelve `λ·(ψ_antes − ψ_después)` al taker.
- Fuera de `±α` del ideal: revert (halt). `ε` es una fee proporcional aparte.

Parámetros recomendados para USDC/BRL (ver `FX_CURVES.md` §6): `α=0.5 β=0.15 δ=0.5 MAX=0.25 λ=0.3 ε=30 bps`,
más el `conf` de Pyth sumado a `ε`. Los de DFX en producción son `α=0.5 β=0.35 δ=0.5 λ=1 ε=15 bps`.

## 3. Algoritmo del opcode (2D, `view`)

Entradas: balances de Aqua `U, B`, args inmutables `(α, β, δ, MAX, λ, ε, feedId, maxAge)`, `amount`, dirección, exactIn/Out.

1. **Oráculo.** `IPyth(0x2880aB155794e7179c9eE2e38200202908C17B43).getPriceNoOlderThan(feedId, maxAge)` → `(price, conf, expo, publishTime)`.
   El feed es `FX.USD/BRL` (BRL por USD): `p = 10^-expo / price` en tu escala. `confRel = conf / price`. `εeff = ε + confRel`.
2. **Numerario.** `x = U`, `y = p·B` (normalizar decimales: USDC 6, BRAt según el token).
3. **Trade en numerario.** Sea `a` el cambio del activo de entrada (positivo en exactIn; en exactOut es `−output` y el resultado sale positivo). Devuelve `o`, el cambio del activo de salida:
   - `ω = ψ(x, y)`. Estado a `s=0`: `x' = x + a`, `y' = y − a` (o al revés). Si `ω = 0` y `ψ(x', y') = 0` → `o = −a`, listo (camino rápido, la mayoría de los trades).
   - Si no, para cada régimen de cada activo (dentro / debajo-cuadrático / debajo-cap / arriba-cuadrático / arriba-cap) y para `c ∈ {1, λ}`: armar la cuadrática `A s² + B s + C = 0` con los coeficientes de `fxforex_math._regime_coeffs` y `_piece`, resolver con la raíz chica en forma estable (`r1 = (−B − sign(B)·√disc)/(2A)`, `s = C/(A·r1)`), y aceptar la raíz cuyo régimen y signo de `c` son consistentes. En la práctica el régimen a `s=0` es el correcto casi siempre; evaluá ese primero y verificá `|s − c·(ψ(s) − ω)|` chico.
   - `o = s − a`.
4. **Halts** (`enforce_halts`, copiado de DFX): un balance puede quedar fuera de `±α` solo si ya estaba fuera y la excursión no crece. **Invariante** (`enforce_swap_invariant`): `(g' − ψ') − (g − ω) ≥ −1e-6`.
5. **ε.** exactIn: `out = −o · (1 − εeff)`. exactOut: resolvés con el output exacto y después `in = in · (1 + εeff)`.
6. Convertir de numerario a unidades de token (`/p` para BRL).

Redondeo: siempre contra el taker (output hacia abajo, input hacia arriba, `s` hacia arriba). Escala sugerida 1e18 (WAD); con balances ≤ 1e30 no hay overflow en `m²·δ`.
Casos que deben revertir: `U = 0` o `B = 0`, salida ≥ balance, `amount = 0` puede devolver 0.

## 4. Cómo validar el port

Cargar `scripts/fixtures/fxforex_vectors.json` con `vm.parseJson` y comparar `amountIn/amountOut` con tolerancia de unos wei y los `revert` por nombre. Los vectores `onchain_dfx_eurc_usdc` son cotizaciones reales del pool de DFX `0x8cd86fbC94BeBFD910CaaE7aE4CE374886132c48`: si el port da lo mismo a 1e-6 de token, está bien.

Propiedades que también conviene fuzzear (todas dan 0 fallos en Python): utilidad `g − ψ` nunca baja; dentro de la banda `o = −a` exacto; comprar y revender nunca deja ganancia al taker; partir un trade nunca gana.

## 5. Integración en SwapVM (lo que vi en `1inch/swap-vm` 0.0.5)

- Modelo de opcode: `PeggedSwap._peggedSwapGrowPriceRange2D` para el parseo de args y la matemática pura en 1e27; `OraclePriceAdjuster._oraclePriceAdjuster1D` para leer un oráculo dentro de un opcode `view`. Este opcode es la combinación de los dos.
- Direccionalidad: como `PeggedSwap`, decidir cuál balance es el numerario por comparación de direcciones de token (`tokenIn < tokenOut`).
- No necesita storage. No hay 32 iteraciones.
- `Balances`/`Aqua`: los balances vienen del `Context`; `Fee` de SwapVM puede ir aparte o usar `ε` interno, elegir uno solo.

## 6. Pyth en Arc Testnet, lo verificado el 2026-09-12

- Chain id `5042002`, RPC `https://rpc.testnet.arc.network`. Contrato Pyth `0x2880aB155794e7179c9eE2e38200202908C17B43` (funciona, ETH/USD cargado).
- Feed `FX.USD/BRL` id `0xd2db4dbf1aea74e0f666b0e8f73b9580d407f5e5cf931940b06dc633d7a95906`. **Nunca fue empujado en Arc**: `getPriceUnsafe` revierte `PriceFeedNotFound`. Pyth es pull: hay que llamar `updatePriceFeeds(bytes[])` con el update de Hermes (fee `singleUpdateFeeInWei = 1`), antes del swap o en la misma tx.
- **Hermes devuelve 401** en `/v2/updates/price/latest` desde ambos hosts públicos (`hermes` y `hermes-beta`); el listado de feeds sí responde. Hace falta una key o un proveedor de Hermes alternativo. Abierto.
- **Horario de mercado**: el feed tiene `market_hours`, cerrado los fines de semana. Con `maxAge` de 60 s (el `validTimePeriodSeconds` del contrato) un sábado revierte siempre. Decidir: `maxAge` grande fuera de horario, o demo en día hábil.
- `conf` observado en otros chains para USD/BRL: 10 a 30 bps. Con `ε = 30 bps` el spread total queda en 40 a 60 bps.
- No hay feed de ARS en Pyth (en LatAm solo BRL y MXN). Por eso la demo es USDC/BRL.

## 7. Decisiones abiertas

1. Parámetros finales (recomendación en §2).
2. Política de staleness y fin de semana.
3. Quién postea el update de Pyth y con qué endpoint.
4. `ε` interno vs `Fee` de SwapVM.
