"""
pool simulations for the forex curve (fxforex_math.quote) on small books:
USDC/ARS, USDC/BRL, BRL/ARS. 30 days, hourly steps. run: python3 scripts/fxforex_sim.py
conventions: pair = (quote token, local token). p = quote per 1 local. U = quote balance, B = local balance.
"""
import math, random, statistics
from fxforex_math import quote, Revert, psi

HOURS = 24 * 30
DFX  = dict(alpha=0.5, beta=0.35, delta=0.5,  maxf=0.25, lam=1.0, eps=0.0015)   # DFX production params
CONS = dict(alpha=0.5, beta=0.15, delta=0.5,  maxf=0.25, lam=0.3, eps=0.0030)   # tighter band, more spread, keeps 70% of rebalancing gain

# ------------------------------------------------------------- price processes (USD per unit of local)
def gbm_path(p0, vol_yr, drift_yr, n, jump_prob_month=0.0, jump_size=-0.10):
    dt = 1 / (24 * 365); out = [p0]; p = p0
    for _ in range(n):
        p *= math.exp((drift_yr - 0.5 * vol_yr ** 2) * dt + vol_yr * math.sqrt(dt) * random.gauss(0, 1))
        if jump_prob_month and random.random() < jump_prob_month / (24 * 30): p *= (1 + jump_size)
        out.append(p)
    return out

PAIRS = {
    # quote, local, USD price of quote, USD price path of local, oracle conf (rel), oracle noise (rel), oracle basis
    "USDC/BRL": dict(q="USDC", l="BRL", conf=0.0007, noise=0.0003, basis=0.0),
    "USDC/ARS": dict(q="USDC", l="ARS", conf=0.0050, noise=0.0020, basis=0.0),
    "USDC/ARS oracle basis 1%": dict(q="USDC", l="ARS", conf=0.0050, noise=0.0020, basis=0.01),
    "BRL/ARS":  dict(q="BRL",  l="ARS", conf=0.0060, noise=0.0020, basis=0.0),
}

def usd_paths(n):
    brl = gbm_path(1 / 5.4, 0.15, 0.0, n)                                   # USD per BRL
    ars = gbm_path(1 / 1450, 0.20, -0.24, n, jump_prob_month=0.03, jump_size=-0.10)  # USD per ARS, crawling + devaluation risk
    return dict(USDC=[1.0] * (n + 1), BRL=brl, ARS=ars)

# ------------------------------------------------------------- one pool run
def run_pool(pair, book_usd, P, paths, taker_rate=0.5, taker_med_usd=100.0, usd_bias=0.5, gas_usd=0.02, seed=0,
             lag=0, tol_bps=(20, 300)):
    """takers: absolute sizes (lognormal, median taker_med_usd, sigma 1.2), each with a max acceptable cost
    drawn uniformly in tol_bps; they walk away if the pool quote is worse. lag = oracle staleness in hours."""
    random.seed(seed)
    cfg = PAIRS[pair]; qp, lp = paths[cfg["q"]], paths[cfg["l"]]
    p_true = [l / q for l, q in zip(lp, qp)]                 # quote per local
    # start balanced 50/50 at t=0
    U = book_usd / 2 / qp[0]; B = book_usd / 2 / lp[0]
    U0, B0 = U, B
    st = dict(arb_in=0.0, arb_out=0.0, taker_vol=0.0, taker_cost=[], reverts=0, trades=0, walked=0,
              out_band=0, near_halt=0, arb_trades=0, min_share=1.0, max_share=0.0, dd=0.0)
    peak = 0.0
    for t in range(1, HOURS + 1):
        pt = p_true[t]
        # oracle: true price `lag` hours ago, plus noise, plus basis
        por = p_true[max(0, t - lag)] * (1 + random.gauss(0, cfg["noise"])) * (1 + cfg["basis"])
        conf = por * cfg["conf"]
        def q(amount, local_out, exact_in, U=U, B=B): return quote(por, U, B, amount, local_out, exact_in, P, conf=conf)
        # --- takers
        n_tk = sum(1 for _ in range(10) if random.random() < taker_rate / 10)
        for _ in range(n_tk):
            size_usd = taker_med_usd * math.exp(random.gauss(0, 1.2))
            tol = random.uniform(*tol_bps) / 1e4
            buy_local = random.random() > usd_bias   # usd_bias = share of takers buying the quote (USD side)
            try:
                if buy_local:
                    Q = size_usd / qp[t]; _, dy = q(Q, True, True); cost = (Q / dy) / pt - 1
                    if cost > tol: st["walked"] += 1; continue
                    U += Q; B -= dy
                else:
                    dx = size_usd / lp[t]; _, Q = q(dx, False, True); cost = 1 - (Q / dx) / pt
                    if cost > tol: st["walked"] += 1; continue
                    U -= Q; B += dx
                st["taker_cost"].append(cost); st["taker_vol"] += size_usd; st["trades"] += 1
            except Revert: st["reverts"] += 1
        # --- arbitrageur: best trade against the true price, either direction
        best = (gas_usd / qp[t], None)
        for e in range(-30, 6):
            f = 10 ** (e / 8)
            try:
                dx = B * f; _, Q = q(dx, False, True); pr = Q - dx * pt          # sell local to pool
                if pr > best[0]: best = (pr, ("sell", dx, Q))
            except Revert: pass
            try:
                Q = U * f; _, dy = q(Q, True, True); pr = dy * pt - Q            # buy local from pool
                if pr > best[0]: best = (pr, ("buy", Q, dy))
            except Revert: pass
        if best[1]:
            kind, a1, a2 = best[1]
            x, y = U, pt * B
            before_out = all(((x + y) / 2) * (1 - P["beta"]) <= b <= ((x + y) / 2) * (1 + P["beta"]) for b in (x, y))
            if kind == "sell": U -= a2; B += a1
            else: U += a1; B -= a2
            st["arb_trades"] += 1
            # arb profit = pool loss at the true price. split by where the pool was: inside the band it is pure
            # oracle error; outside it also includes the lambda rebalancing rebate.
            if before_out: st["arb_in"] += best[0] * qp[t]
            else: st["arb_out"] += best[0] * qp[t]
        # --- book state
        x, y = U * qp[t], B * lp[t]; g = x + y; share = y / g
        st["min_share"] = min(st["min_share"], share); st["max_share"] = max(st["max_share"], share)
        if not (0.5 * (1 - P["beta"]) <= share <= 0.5 * (1 + P["beta"])): st["out_band"] += 1
        if not (0.5 * (1 - P["alpha"]) * 1.05 <= share <= 0.5 * (1 + P["alpha"]) * 0.95): st["near_halt"] += 1
        hold = U0 * qp[t] + B0 * lp[t]; pnl = g - hold
        peak = max(peak, pnl); st["dd"] = max(st["dd"], peak - pnl)
    hold = U0 * qp[-1] + B0 * lp[-1]; final = U * qp[-1] + B * lp[-1]
    st["pnl_vs_hold"] = final - hold; st["hold_change"] = hold - book_usd; st["final_share"] = B * lp[-1] / final
    st["avg_cost_bps"] = statistics.mean(st["taker_cost"]) * 1e4 if st["taker_cost"] else float("nan")
    return st

def fmt(st, book):
    return (f"pnl {st['pnl_vs_hold']:+8.2f} ({st['pnl_vs_hold']/book*100:+5.2f}%)  vol {st['taker_vol']:7.0f} "
            f"trades {st['trades']:4d} walk {st['walked']:3d} rev {st['reverts']:3d} cost {st['avg_cost_bps']:5.1f}bp  "
            f"arbs {st['arb_trades']:3d} in-band {st['arb_in']:7.2f} out-band {st['arb_out']:7.2f}  "
            f"share[{st['min_share']:.2f},{st['max_share']:.2f}] out {st['out_band']/HOURS*100:4.1f}% halt-zone {st['near_halt']/HOURS*100:4.1f}%  dd {st['dd']:6.2f}")

if __name__ == "__main__":
    random.seed(2026); paths = usd_paths(HOURS)
    print(f"30 days hourly. USD/BRL {1/paths['BRL'][0]:.3f} -> {1/paths['BRL'][-1]:.3f}   USD/ARS {1/paths['ARS'][0]:.0f} -> {1/paths['ARS'][-1]:.0f}   "
          f"BRL/ARS {paths['BRL'][0]/paths['ARS'][0]:.1f} -> {paths['BRL'][-1]/paths['ARS'][-1]:.1f}")
    print("takers ~12/day, median $100 lognormal(1.2), walk away above their tolerance U[20,300]bps, 60% buy USD on ARS pairs.")
    print("arb gas $0.02. oracle fresh (noise+conf) unless 'stale'. pnl = LP value vs holding the initial inventory, in USD.")
    for name, P in (("DFX prod  a.5 b.35 d.5 e15bps l1", DFX), ("conservative a.5 b.15 d.5 e30bps l.3", CONS)):
        print(f"\n===== params {name}")
        for pair in PAIRS:
            bias = 0.6 if "ARS" in pair and pair.startswith("USDC") else 0.5
            for book in (5_000, 25_000, 100_000):
                st = run_pool(pair, book, P, paths, usd_bias=bias, seed=7)
                print(f"  {pair:24s} ${book:>7,}  " + fmt(st, book))
    print("\n===== stale oracle (1h old) vs fresh, $25k, DFX params")
    for pair in ("USDC/BRL", "USDC/ARS"):
        for lag in (0, 1):
            st = run_pool(pair, 25_000, DFX, paths, usd_bias=0.6 if "ARS" in pair else 0.5, seed=7, lag=lag)
            print(f"  {pair:10s} lag {lag}h  " + fmt(st, 25_000))
    print("\n===== USDC/ARS $25k, DFX params, epsilon sweep (conf 0.5% in spread)")
    for eps in (0.0005, 0.0015, 0.003, 0.006, 0.01):
        st = run_pool("USDC/ARS", 25_000, dict(DFX, eps=eps), paths, usd_bias=0.6, seed=7)
        print(f"  eps {eps*1e4:4.0f}bps  " + fmt(st, 25_000))
    print("\n===== USDC/ARS $25k, DFX params, conf added to spread: yes vs no")
    for use_conf in (True, False):
        PAIRS["USDC/ARS"]["conf"] = 0.005 if use_conf else 0.0
        st = run_pool("USDC/ARS", 25_000, DFX, paths, usd_bias=0.6, seed=7)
        print(f"  conf in spread {str(use_conf):5s} " + fmt(st, 25_000))
    PAIRS["USDC/ARS"]["conf"] = 0.005
    print("\n===== lambda sweep, USDC/BRL $25k (b.35 d.5 e15bps)")
    for lam in (1.0, 0.5, 0.3, 0.0):
        st = run_pool("USDC/BRL", 25_000, dict(DFX, lam=lam), paths, seed=7)
        print(f"  lam {lam:3.1f}  " + fmt(st, 25_000))
    print("\n===== taker flow, USDC/BRL $5k DFX: 3/day vs 12/day vs 48/day (small book vs absolute trade sizes)")
    for rate in (0.125, 0.5, 2.0):
        st = run_pool("USDC/BRL", 5_000, DFX, paths, taker_rate=rate, seed=7)
        print(f"  {rate*24:4.0f}/day  " + fmt(st, 5_000))

    # ---------------------------------------------------------------- lambda where it matters: small ARS book that leaves the band
    print("\n===== lambda sweep, USDC/ARS $5k (b.35 d.5 e15bps), 60% USD buyers")
    for lam in (1.0, 0.5, 0.3, 0.0):
        st = run_pool("USDC/ARS", 5_000, dict(DFX, lam=lam), paths, usd_bias=0.6, seed=7)
        print(f"  lam {lam:3.1f}  " + fmt(st, 5_000))
    print("\n===== heavy flow 48/day on $5k USDC/BRL: DFX vs conservative")
    for name, P in (("DFX", DFX), ("CONS", CONS)):
        st = run_pool("USDC/BRL", 5_000, P, paths, taker_rate=2.0, seed=7)
        print(f"  {name:5s} " + fmt(st, 5_000))
    # ---------------------------------------------------------------- devaluation shock: ARS -15% at hour 360
    print("\n===== ARS devaluation shock -15% at hour 360, USDC/ARS $25k, DFX params")
    shock = dict(paths); ars = list(paths["ARS"]); ars = ars[:360] + [v * 0.85 for v in ars[360:]]; shock["ARS"] = ars
    for lag in (0, 1, 6):
        st = run_pool("USDC/ARS", 25_000, DFX, shock, usd_bias=0.6, seed=7, lag=lag)
        print(f"  oracle lag {lag}h  " + fmt(st, 25_000))
    # ---------------------------------------------------------------- monte carlo over price paths and flow
    print("\n===== monte carlo, 8 seeds (price paths + flow). pnl% vs hold: mean [min, max]; reverts and walk-aways per month, mean")
    for name, P in (("DFX ", DFX), ("CONS", CONS)):
        for pair in ("USDC/BRL", "USDC/ARS", "BRL/ARS"):
            bias = 0.6 if pair == "USDC/ARS" else 0.5
            for book in (5_000, 25_000):
                res = []
                for sd in range(8):
                    random.seed(100 + sd); pth = usd_paths(HOURS)
                    st = run_pool(pair, book, P, pth, usd_bias=bias, seed=sd)
                    res.append((st["pnl_vs_hold"] / book * 100, st["reverts"], st["walked"], st["out_band"] / HOURS * 100, st["arb_in"] + st["arb_out"]))
                pn = [r[0] for r in res]
                print(f"  {name} {pair:9s} ${book:>6,}  pnl {statistics.mean(pn):+5.2f}% [{min(pn):+5.2f}, {max(pn):+5.2f}]  "
                      f"rev {statistics.mean(r[1] for r in res):5.1f}  walk {statistics.mean(r[2] for r in res):5.1f}  "
                      f"out-band {statistics.mean(r[3] for r in res):4.1f}%  arb loss ${statistics.mean(r[4] for r in res):6.2f}")
