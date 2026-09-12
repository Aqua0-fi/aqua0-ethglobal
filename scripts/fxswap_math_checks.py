"""
fxswap math, checks 8-13. imports the reference from fxswap_math.py, does not modify it.
run: python3 scripts/fxswap_math_checks.py
"""
from decimal import Decimal, getcontext
import math, random
from fxswap_math import (D, integral, integral_f, quote, rnd_state, rel, target)

getcontext().prec = 60

def P(p, k, B0, B):
    return p * (1 - k + k * (B0 / B) ** 2)

# 8 closed form is the integral of P: dI(Ba,Bb)/dBb == P(Bb), dI/dBa == -P(Ba). Decimal central difference.
def test8_integral_is_antiderivative(n=2000):
    worst = 0
    for _ in range(n):
        p, k, t, U, B1 = rnd_state()
        p, k, B1 = D(p), D(k), D(B1)
        B0 = D(t) * (D(U) + p * B1) / p
        Ba = B1 * D(10) ** D(random.uniform(-1, 0))
        Bb = B1 * D(10) ** D(random.uniform(0, 1))
        h = Bb * D("1e-18")
        dI = (integral(p, k, B0, Ba, Bb + h) - integral(p, k, B0, Ba, Bb - h)) / (2 * h)
        worst = max(worst, rel(dI, P(p, k, B0, Bb)))
        h = Ba * D("1e-18")
        dI = (integral(p, k, B0, Ba + h, Bb) - integral(p, k, B0, Ba - h, Bb)) / (2 * h)
        worst = max(worst, rel(dI, -P(p, k, B0, Ba)))
        # float form equals Decimal form
        worst_f = rel(integral_f(float(p), float(k), float(B0), float(Ba), float(Bb - Ba)),
                      float(integral(p, k, B0, Ba, Bb)))
        worst = max(worst, D(worst_f) if worst_f > 1e-13 else D(0))
    return float(worst)

# 9 price properties
def test9_price_properties(n=20000):
    fails = {"P(B0)=p": 0, "P decreasing": 0, "buy eff >= marginal": 0, "sell eff <= marginal": 0,
             "buy eff -> marginal": 0, "sell eff -> marginal": 0}
    worst_conv = 0
    for _ in range(n):
        p, k, t, U, B1 = rnd_state()
        B0 = target(U, B1, p, t)
        if rel(P(p, k, B0, B0), p) > 1e-14: fails["P(B0)=p"] += 1
        if not P(p, k, B0, B1 * 1.001) < P(p, k, B0, B1): fails["P decreasing"] += 1
        Pm = P(p, k, B0, B1)
        Q = p * B1 * 10 ** random.uniform(-4, 0)
        _, dy = quote(p, k, t, U, B1, Q, True, True, B0)
        if not Q / dy >= Pm * (1 - 1e-12): fails["buy eff >= marginal"] += 1
        dx = B1 * 10 ** random.uniform(-4, 0)
        try:
            _, Qs = quote(p, k, t, U, B1, dx, False, True, B0)
            if not Qs / dx <= Pm * (1 + 1e-12): fails["sell eff <= marginal"] += 1
        except ValueError:
            pass
        # small amounts: effective price -> marginal, error first order in size
        Q = p * B1 * 1e-9
        _, dy = quote(p, k, t, U, B1, Q, True, True, B0)
        e = rel(Q / dy, Pm); worst_conv = max(worst_conv, e)
        if e > 1e-6: fails["buy eff -> marginal"] += 1
        dx = B1 * 1e-9
        _, Qs = quote(p, k, t, U, B1, dx, False, True, B0)
        e = rel(Qs / dx, Pm); worst_conv = max(worst_conv, e)
        if e > 1e-6: fails["sell eff -> marginal"] += 1
    return fails, worst_conv

# 10 homogeneity: (U,B1,amount) -> lam*(...) gives lam*output ; p -> mu*p gives Q -> mu*Q, dy unchanged
def test10_homogeneity(n=20000):
    worst = 0
    for _ in range(n):
        p, k, t, U, B1 = rnd_state()
        lam = 10 ** random.uniform(-3, 3); mu = 10 ** random.uniform(-3, 3)
        for brl_out, exact_in, amt in [(True, True, p * B1 * 0.1), (True, False, B1 * 0.1),
                                       (False, True, B1 * 0.1), (False, False, min(U, p * B1) * 0.1)]:
            try: a, b = quote(p, k, t, U, B1, amt, brl_out, exact_in)
            except ValueError: continue          # drains USDC: legitimate revert, skip
            a2, b2 = quote(p, k, t, U * lam, B1 * lam, amt * lam, brl_out, exact_in)
            worst = max(worst, rel(a2, a * lam), rel(b2, b * lam))
            # price scaling: USDC amounts scale by mu, BRL amounts do not
            amt_p = amt * mu if (brl_out and exact_in) or (not brl_out and not exact_in) else amt
            a3, b3 = quote(p * mu, k, t, U * mu, B1, amt_p, brl_out, exact_in)
            usdc_in = brl_out
            worst = max(worst, rel(a3, a * (mu if usdc_in else 1)), rel(b3, b * (1 if usdc_in else mu)))
    return worst

# 11 k calibration at r=1 (book on target). buy fraction x of BRL:
#    effective premium  Q/(p dy) - 1 = k x/(1-x)      marginal after  P(B0(1-x))/p - 1 = k(1/(1-x)^2 - 1)
def test11_k_table():
    p, t, U, B1 = 5.0, 0.5, 1e6, 2e5   # exactly on target
    rows = []; worst = 0
    for k in [0.001, 0.01, 0.05, 0.1, 0.3, 0.5]:
        row = []
        for x in [0.01, 0.05, 0.10, 0.25, 0.50]:
            B0 = target(U, B1, p, t)
            Q, _ = quote(p, k, t, U, B1, x * B1, True, False, B0)
            eff = Q / (p * x * B1) - 1
            marg = P(p, k, B0, B1 * (1 - x)) / p - 1
            worst = max(worst, rel(eff, k * x / (1 - x)), rel(marg, k * (1 / (1 - x) ** 2 - 1)))
            row.append((eff, marg))
        rows.append((k, row))
    return rows, worst

# 12 dynamic-target leak, concrete numbers + the worst case found
def test12_dynamic_leak_example(n=20000):
    p, k, t, U, B1 = 5.0, 0.05, 0.5, 1e6, 2e5
    Q = 1e5
    ex = {}
    for name, fixed in [("fixed", True), ("dynamic", False)]:
        B0 = target(U, B1, p, t) if fixed else None
        _, dy = quote(p, k, t, U, B1, Q, True, True, B0)
        U2, B2 = U + Q, B1 - dy
        B0_after = B0 if fixed else target(U2, B2, p, t)
        _, Qb = quote(p, k, t, U2, B2, dy, False, True, B0)
        ex[name] = dict(dy=dy, B0_before=target(U, B1, p, t), B0_after=B0_after,
                        P_after=P(p, k, B0_after, B2), Qback=Qb, taker_gain=Qb - Q)
    # worst case from test 2 conditions
    worst = (0, None)
    for _ in range(n):
        p, k, t, U, B1 = rnd_state()
        Q = p * B1 * 10 ** random.uniform(-6, 0)
        _, dy = quote(p, k, t, U, B1, Q, True, True)
        try: _, Qb = quote(p, k, t, U + Q, B1 - dy, dy, False, True)
        except ValueError: continue
        g = (Qb - Q) / Q
        if g > worst[0]:
            worst = (g, dict(p=p, k=k, t=t, U=U, B1=B1, brl_share=p * B1 / (U + p * B1), Q_over_pB1=Q / (p * B1),
                             dy_over_B1=dy / B1, r_before=target(U, B1, p, t) / B1,
                             r_after=target(U + Q, B1 - dy, p, t) / (B1 - dy)))
    return ex, worst

# 13 test5 drains: the maker buys dx = B0-B back to target. since B < B0 there, P > p, so the cost
#    I(B,B0) exceeds p*dx. a drain means U < I(B,B0): the book cannot afford its own target. curve is fine.
def test13_drain_cause(n=2000):
    drains = 0; ratios = []
    for _ in range(n):
        p, k, t, U, B = rnd_state()
        B *= 10 ** random.uniform(-1, 1)
        for it in range(1, 60):
            B0 = target(U, B, p, t)
            if abs(B / B0 - 1) < 1e-9: break
            if B > B0:
                dy = B - B0
                Q, _ = quote(p, k, t, U, B, dy, True, False); U += Q; B -= dy
            else:
                dx = B0 - B
                need = integral_f(p, k, B0, B, dx)
                try: _, Q = quote(p, k, t, U, B, dx, False, True)
                except ValueError:
                    drains += 1
                    assert need > U and need > p * dx
                    ratios.append((U / (p * dx), need / (p * dx), k))
                    break
                U -= Q; B += dx
    return drains, min(r[0] for r in ratios), max(r[0] for r in ratios), max(r[1] for r in ratios)

if __name__ == "__main__":
    random.seed(7)
    print("8  I is antiderivative of P (Decimal central diff), worst rel err:", f"{test8_integral_is_antiderivative():.2e}")
    f, w = test9_price_properties()
    print("9  price properties, fails:", f, "| worst small-trade conv err", f"{w:.2e}")
    print("10 homogeneity (scale inventory+amount, scale p), worst rel err:", f"{test10_homogeneity():.2e}")
    rows, w = test11_k_table()
    print("11 k calibration on target (eff premium / marginal after), worst err vs closed form", f"{w:.1e}")
    print("        x:      1%            5%           10%           25%           50%")
    for k, row in rows:
        print(f"    k={k:<6}" + "".join(f"  {e*100:5.2f}%/{m*100:6.2f}%" for e, m in row))
    ex, (g, st) = test12_dynamic_leak_example()
    print("12 dynamic leak example: p=5 k=0.05 t=0.5 U=1e6 B=2e5 (on target), buy with Q=100k, sell dy back")
    for name, d in ex.items():
        print(f"    {name:8s} dy={d['dy']:,.2f}  B0 {d['B0_before']:,.0f}->{d['B0_after']:,.2f}  "
              f"P_after={d['P_after']:.5f}  Qback={d['Qback']:,.2f}  taker gain={d['taker_gain']:+,.2f}")
    print(f"    worst random case: taker gain {g:+.2%}")
    for kk, vv in st.items(): print(f"      {kk:>10} = {vv:.4g}")
    d, lo, hi, mx = test13_drain_cause()
    print(f"13 test5 drains: {d} total, all with U < I(B,B0) (book cannot afford its target). "
          f"U/(p*dx) in [{lo:.3g}, {hi:.3g}], cost/(p*dx) up to {mx:.3g}")
