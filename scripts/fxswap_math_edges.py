"""
fxswap math, edge hunting, tests 14-21. imports the reference from fxswap_math.py.
run: python3 scripts/fxswap_math_edges.py
"""
from decimal import Decimal, getcontext
import math, random
from fxswap_math import (D, integral, integral_f, quote, rnd_state, rel, target,
                         solve_dy_frac, solve_dx_frac, solve_B2_direct)

getcontext().prec = 80

def P(p, k, B0, B):
    return p * (1 - k + k * (B0 / B) ** 2)

def ref_v(k, r, q):
    """Decimal small root of (1-k)v^2 - (1-k+kr^2+q)v + q = 0"""
    k, r, q = D(k), D(r), D(q)
    S = 1 - k + k * r * r + q
    return 2 * q / (S + (S * S - 4 * (1 - k) * q).sqrt())

def ref_w(k, r, q):
    k, r, q = D(k), D(r), D(q)
    A = 1 - k; S = A + k * r * r - q
    return (-S + (S * S + 4 * A * q).sqrt()) / (2 * A)

# 14 float solvers vs Decimal on a grid of extremes
def test14_extreme_grid():
    ks = [1e-15, 1e-9, 1e-4, 0.5, 1 - 1e-4, 1 - 1e-9, 1 - 1e-15]
    rs = [1e-9, 1e-6, 1e-3, 1, 1e3, 1e6, 1e9]
    qs = [1e-18, 1e-9, 1e-3, 0.5, 1, 2, 1e3, 1e9, 1e18]
    worst = [(0, None), (0, None)]; neg_disc = []
    for k in ks:
        for r in rs:
            for q in qs:
                try: e = rel(solve_dy_frac(k, r, q), float(ref_v(k, r, q)))
                except AssertionError:
                    S = 1 - k + k * r * r + q
                    neg_disc.append((k, r, q, S * S - 4 * (1 - k) * q)); continue
                if e > worst[0][0]: worst[0] = (e, (k, r, q))
                e = rel(solve_dx_frac(k, r, q), float(ref_w(k, r, q)))
                if e > worst[1][0]: worst[1] = (e, (k, r, q))
    return worst, neg_disc

# 15 ill-conditioning: k -> 0 and q -> 1-k gives a near-double root. error and sensitivity.
def test15_double_root():
    rows = []
    for k in [1e-2, 1e-4, 1e-6, 1e-8, 1e-10]:
        r = 1.0
        q = 1 - k                      # exact kink for k=0: roots v=q and v=1 coincide
        vr = float(ref_v(k, r, q))
        try: v = solve_dy_frac(k, r, q)
        except AssertionError: rows.append((k, float("nan"), float("nan"), float("nan"))); continue
        # sensitivity: dv/dq numerically (Decimal)
        h = D("1e-20")
        dvdq = float((ref_v(k, r, D(q) + h) - ref_v(k, r, D(q) - h)) / (2 * h))
        rows.append((k, rel(v, vr), dvdq, 1 - v))
    return rows

# 16 dx branch switch at S=0 is continuous ; exactIn(exactOut(dy)) near dy -> B1: where does float break?
def test16_branch_and_near_drain():
    worst_branch = 0
    for _ in range(5000):
        k = 10 ** random.uniform(-4, math.log10(0.9)); r = 10 ** random.uniform(-3, 3)
        q0 = 1 - k + k * r * r          # S = 0 exactly here
        for eps in [1e-15, 1e-12, 1e-9]:
            w1 = solve_dx_frac(k, r, q0 * (1 - eps)); w2 = solve_dx_frac(k, r, q0 * (1 + eps))
            worst_branch = max(worst_branch, rel(w1, w2) / (2 * eps) if eps > 1e-14 else 0)
    p, k, t, U, B1 = 5.0, 0.05, 0.5, 1e6, 2e5
    B0 = target(U, B1, p, t)
    rows = []
    for e in [1e-3, 1e-6, 1e-9, 1e-12, 1e-14, 1e-15]:
        dy = B1 * (1 - e)
        Q, _ = quote(p, k, t, U, B1, dy, True, False, B0)
        _, dy2 = quote(p, k, t, U, B1, Q, True, True, B0)
        rows.append((e, Q / (p * B1), rel(dy2, dy), dy2 >= B1))
    return worst_branch, rows

# 17 reverse roundtrip (sell BRL first, then buy back) and split on case B, dynamic vs fixed
def test17_reverse_and_splitB(n=20000):
    out = {}
    for dyn in (True, False):
        rt_f = rt_w = 0; sp_f = sp_w = 0; rt_state = None
        for _ in range(n):
            p, k, t, U, B1 = rnd_state()
            B0 = None if dyn else target(U, B1, p, t)
            dx = B1 * 10 ** random.uniform(-6, 0)
            try: _, Q = quote(p, k, t, U, B1, dx, False, True, B0)
            except ValueError: continue
            U2, B2 = U - Q, B1 + dx
            _, dyb = quote(p, k, t, U2, B2, Q, True, True, B0)   # spend Q back, get dyb BRL
            g = (dyb - dx) / dx
            if g > rt_w:
                rt_w = g
                rt_state = dict(k=k, t=t, r_before=target(U, B1, p, t) / B1, r_after=target(U2, B2, p, t) / B2,
                                dx_over_B1=dx / B1, sell_px_over_p=Q / (dx * p), U_over_pB1=U / (p * B1))
            if dyb > dx * (1 + 1e-12): rt_f += 1
            # split case B
            m = random.randint(2, 20); Uc, Bc, tot = U, B1, 0; ok = True
            for _ in range(m):
                try: _, q_ = quote(p, k, t, Uc, Bc, dx / m, False, True, B0)
                except ValueError: ok = False; break
                Uc -= q_; Bc += dx / m; tot += q_
            if not ok: continue
            g = (tot - Q) / Q
            sp_w = max(sp_w, g)
            if tot > Q * (1 + 1e-12): sp_f += 1
        out["dynamic" if dyn else "fixed"] = (rt_f, rt_w, sp_f, sp_w, rt_state)
    return out

# 18 random interleaved sequences, close back to the initial BRL position. taker net USDC.
def test18_random_sequences(n=3000):
    out = {}
    for dyn in (True, False):
        fails = 0; worst = 0
        for _ in range(n):
            p, k, t, U, B1 = rnd_state()
            B0 = None if dyn else target(U, B1, p, t)
            Uc, Bc = U, B1; pos = 0.0; usdc = 0.0; ok = True
            for _ in range(random.randint(2, 12)):
                if random.random() < 0.5:
                    Q = p * Bc * 10 ** random.uniform(-4, -0.5)
                    _, dy = quote(p, k, t, Uc, Bc, Q, True, True, B0)
                    Uc += Q; Bc -= dy; pos += dy; usdc -= Q
                else:
                    dx = Bc * 10 ** random.uniform(-4, -0.5)
                    try: _, Q = quote(p, k, t, Uc, Bc, dx, False, True, B0)
                    except ValueError: ok = False; break
                    Uc -= Q; Bc += dx; pos -= dx; usdc += Q
            if not ok: continue
            # close: return to pos = 0
            try:
                if pos > 0:
                    _, Q = quote(p, k, t, Uc, Bc, pos, False, True, B0); usdc += Q
                elif pos < 0:
                    Q, _ = quote(p, k, t, Uc, Bc, -pos, True, False, B0); usdc -= Q
            except ValueError: continue
            g = usdc / (U + p * B1)
            worst = max(worst, g)
            if usdc > 1e-9 * (U + p * B1): fails += 1
        out["dynamic" if dyn else "fixed"] = (fails, worst)
    return out

# 19 oracle jump p -> p'. book on target at p. arb trades to the new fixed point.
#    closed form single-step loss at oracle marks: p' k (B0'-B)^2 / B.
#    fixed target: B0 stays = B, so r = 1 at the new price -> nothing to extract.
def test19_oracle_jump():
    rows = []; worst_cf = 0
    p, t, U, B = 5.0, 0.5, 1e6, 2e5
    V0 = U + p * B
    for k in [0.01, 0.05, 0.1]:
        row = []
        for mv in [0.001, 0.01, 0.05, 0.10, 0.20, -0.10]:
            pn = p * (1 + mv)
            # fixed: B0 = B -> P(B) = pn, no arb
            B0f = B
            loss_fixed = 0.0 if abs(P(pn, k, B0f, B) - pn) < 1e-9 else float("nan")
            # dynamic: iterate arb like test5
            Uc, Bc = U, B
            for _ in range(60):
                B0 = target(Uc, Bc, pn, t)
                if abs(Bc / B0 - 1) < 1e-12: break
                if Bc > B0:
                    dy = Bc - B0; Q, _ = quote(pn, k, t, Uc, Bc, dy, True, False); Uc += Q; Bc -= dy
                else:
                    dx = B0 - Bc; _, Q = quote(pn, k, t, Uc, Bc, dx, False, True); Uc -= Q; Bc += dx
            loss_dyn = (U + pn * B) - (Uc + pn * Bc)
            # closed form on the first step
            B01 = target(U, B, pn, t)
            cf = pn * k * (B01 - B) ** 2 / B
            worst_cf = max(worst_cf, rel(loss_dyn, cf))
            row.append((mv, loss_fixed / (U + pn * B), loss_dyn / (U + pn * B)))
        rows.append((k, row))
    return rows, worst_cf

# 20 oracle error larger than k: floor price p(1-k) means the whole U is drainable at a profit
def test20_usdc_drain_threshold():
    p_real, t, U, B = 5.0, 0.5, 1e6, 2e5
    rows = []
    for k in [0.01, 0.05, 0.1]:
        row = []
        for err in [0.5 * k, k, 1.5 * k, 3 * k]:
            p_or = p_real * (1 + err)                 # oracle too high: attacker sells BRL
            # find max dx the book will buy: Q(dx) = U (dynamic target, single trade)
            lo, hi = 0.0, 1e12
            for _ in range(200):
                mid = (lo + hi) / 2
                try: quote(p_or, k, t, U, B, mid, False, True); lo = mid
                except ValueError: hi = mid
            _, Q = quote(p_or, k, t, U, B, lo, False, True)
            profit = Q - lo * p_real
            # profit-maximising size (marginal price hits p_real) if below drain size
            B0 = target(U, B, p_or, t)
            if p_or * (1 - k) < p_real:              # floor below real: bounded optimum
                Bstar = B0 * math.sqrt(k / (p_real / p_or - 1 + k))
                dxo = min(max(0.0, Bstar - B), lo)     # cannot exceed the drain size
                _, Qo = quote(p_or, k, t, U, B, dxo, False, True)
                profit_opt = Qo - dxo * p_real
            else:
                dxo, profit_opt = lo, profit
            row.append((err, Q / U, profit, dxo, profit_opt))
        rows.append((k, row))
    return rows

# 21 parameter edges: t=0, t=1, U=0, amount 0, negative amount, k near 0 and near 1
def test21_param_edges():
    out = []
    def run(name, fn):
        try: out.append((name, fn()))
        except (ValueError, ZeroDivisionError, AssertionError) as e: out.append((name, f"revert: {e}"))
    p, U, B1 = 5.0, 1e6, 2e5
    run("t=0 buy 10%   (B0=0, flat price p(1-k))", lambda: f"Q/(p dy) = {quote(p,0.05,0.0,U,B1,2e4,True,False)[0]/(p*2e4):.6f}")
    run("t=0 sell 10%",                              lambda: f"Q/(p dx) = {quote(p,0.05,0.0,U,B1,2e4,False,True)[1]/(p*2e4):.6f}")
    run("t=1 buy 10%   (B0=U/p+B, r=2 here)",       lambda: f"Q/(p dy) = {quote(p,0.05,1.0,U,B1,2e4,True,False)[0]/(p*2e4):.6f}")
    run("t=1 sell 10%",                              lambda: f"Q/(p dx) = {quote(p,0.05,1.0,U,B1,2e4,False,True)[1]/(p*2e4):.6f}")
    run("t=1 U=100*pB sell 1% (r=101)",             lambda: f"Q/(p dx) = {quote(p,0.05,1.0,100*p*B1,B1,2e3,False,True)[1]/(p*2e3):.4f}")
    run("U=0 buy 10%  (r=t)",                        lambda: f"Q/(p dy) = {quote(p,0.05,0.5,0.0,B1,2e4,True,False)[0]/(p*2e4):.6f}")
    run("U=0 sell any",                              lambda: quote(p,0.05,0.5,0.0,B1,1.0,False,True))
    run("amount=0 A exactIn",                        lambda: quote(p,0.05,0.5,U,B1,0.0,True,True))
    run("amount=0 A exactOut",                       lambda: quote(p,0.05,0.5,U,B1,0.0,True,False))
    run("amount=0 B exactIn",                        lambda: quote(p,0.05,0.5,U,B1,0.0,False,True))
    run("amount=0 B exactOut",                       lambda: quote(p,0.05,0.5,U,B1,0.0,False,False))
    run("amount<0 A exactIn  (no guard!)",           lambda: quote(p,0.05,0.5,U,B1,-1e4,True,True))
    run("amount<0 A exactOut (no guard!)",           lambda: quote(p,0.05,0.5,U,B1,-1e4,True,False))
    run("amount<0 B exactIn  (no guard!)",           lambda: quote(p,0.05,0.5,U,B1,-1e4,False,True))
    run("amount<0 B exactOut (no guard!)",           lambda: quote(p,0.05,0.5,U,B1,-1e4,False,False))
    run("k=1e-15 buy 50%",                           lambda: f"Q/(p dy) = {quote(p,1e-15,0.5,U,B1,1e5,True,False)[0]/(p*1e5):.6f}")
    run("k=1-1e-15 buy 50%",                         lambda: f"Q/(p dy) = {quote(p,1-1e-15,0.5,U,B1,1e5,True,False)[0]/(p*1e5):.6f}")
    run("k=1-1e-15 sell 50% (S<0 branch)",           lambda: f"Q/(p dx) = {quote(p,1-1e-15,0.5,U,B1,1e5,False,True)[1]/(p*1e5):.6f}")
    run("k=1-1e-15 B exactOut Q=U",                  lambda: f"dx/B1 = {quote(p,1-1e-15,0.5,U,B1,U,False,False)[0]/B1:.6f}")
    run("p=1e-18 (tiny oracle) buy 10%",             lambda: f"Q/(p dy) = {quote(1e-18,0.05,0.5,U*1e-18,B1,2e4,True,False)[0]/(1e-18*2e4):.6f}")
    run("p=1e18 (huge oracle) buy 10%",              lambda: f"Q/(p dy) = {quote(1e18,0.05,0.5,U*1e18,B1,2e4,True,False)[0]/(1e18*2e4):.6f}")
    run("B1=1e-12 dust, buy half",                   lambda: f"Q/(p dy) = {quote(p,0.05,0.5,U,1e-12,5e-13,True,False)[0]/(p*5e-13):.4e}")
    return out

# 22 book short of BRL vs target (r = B0/B1 > 1): the maker pays ~p k r^2 per BRL. how much USDC leaves per BRL sold,
#    and how many BRL (at oracle value) drain the whole U. same with fixed or dynamic target, it is the curve.
def test22_short_book_faucet():
    p, k, t, U = 5.0, 0.05, 0.5, 1e6
    rows = []
    for B1 in [2e5, 1e5, 2e4, 2e3, 2e2, 20, 2]:
        r = target(U, B1, p, t) / B1
        prem = P(p, k, target(U, B1, p, t), B1) / p
        # BRL needed to drain U: bisection on dx
        lo, hi = 0.0, 1e12
        for _ in range(200):
            mid = (lo + hi) / 2
            try: quote(p, k, t, U, B1, mid, False, True); lo = mid
            except ValueError: hi = mid
        rows.append((B1, r, prem, lo, lo * p / U))
    return rows

if __name__ == "__main__":
    random.seed(11)
    ((e1, w1), (e2, w2)), neg = test14_extreme_grid()
    print(f"14 extreme grid vs Decimal: dy solver worst {e1:.2e} at (k,r,q)={w1} | dx solver worst {e2:.2e} at {w2}")
    print(f"   disc<0 in float (assert fails) at {len(neg)} grid points:")
    for k, r, q, d in neg: print(f"      k={k:<8.0e} r={r:<6.0e} q={q:<6.0e} disc={d:+.2e}")
    print("15 near-double root (r=1, q=1-k): k, rel err, dv/dq, 1-v")
    for k, e, s, one_minus_v in test15_double_root():
        print(f"    k={k:<7.0e} err={e:.2e}  dv/dq={s:9.3g}  1-v={one_minus_v:.3e}")
    wb, rows = test16_branch_and_near_drain()
    print(f"16 dx branch switch at S=0, worst |dw/w|/|dq/q| jump: {wb:.3g}")
    print("   exactIn(exactOut(dy)) as dy -> B1:  1-dy/B1, Q/(pB1), rel err, dy2>=B1")
    for e, qq, er, hit in rows: print(f"    {e:<6.0e} Q/(pB1)={qq:10.3e}  err={er:.2e}  drains={hit}")
    for name, (rf, rw, sf, sw, st) in test17_reverse_and_splitB().items():
        print(f"17 {name:8s} reverse roundtrip fails {rf:5d}/20000 worst {rw:+.2e} | split case B beats {sf:5d} worst {sw:+.2e}")
        if name == "dynamic": print("    worst reverse state: " + ", ".join(f"{a}={b:.3g}" for a, b in st.items()))
    for name, (f, w) in test18_random_sequences().items():
        print(f"18 {name:8s} random sequences, taker net > 0: {f:4d}/3000, worst net/book {w:+.2e}")
    rows, wcf = test19_oracle_jump()
    print(f"19 oracle jump, book on target, maker loss to arb / book value (fixed | dynamic). closed form err {wcf:.1e}")
    print("        move:   +0.1%          +1%            +5%           +10%           +20%           -10%")
    for k, row in rows:
        print(f"    k={k:<5}" + "".join(f"  {lf*100:4.2f}%|{ld*100:6.3f}%" for _, lf, ld in row))
    print("20 oracle too high by err, attacker sells BRL (k, err/k, Q/U at drain, profit at drain, optimal dx, optimal profit)")
    for k, row in test20_usdc_drain_threshold():
        for err, qu, pr, dxo, pro in row:
            print(f"    k={k:<5} err/k={err/k:3.1f}  Q/U={qu:6.3f}  profit@drain={pr:+12,.0f}  dx*={dxo:12,.0f}  profit*={pro:+12,.0f}")
    print("22 short book faucet: U=1e6 k=0.05 t=0.5. B1, r=B0/B1, marginal P/p, BRL that drains U, oracle value of that BRL / U")
    for B1, r, prem, dx, frac in test22_short_book_faucet():
        print(f"    B1={B1:9,.0f}  r={r:9.1f}  P/p={prem:12,.1f}  drain dx={dx:14,.2f} BRL  value/U={frac:.3g}")
    print("21 parameter edges:")
    for a, b in test21_param_edges(): print(f"    {a:42s} -> {b}")
