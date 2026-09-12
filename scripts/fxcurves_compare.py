"""
python references for the two finalist FX curves (docs/FX_CURVES.md) and the current DODO curve,
under one interface, with a common test battery.

interface: quote(p, U, B, amount, brl_out, exact_in) -> (amountIn, amountOut), fee included.
  p   USDC per BRL (oracle)     U USDC balance     B BRL balance
  brl_out=True : USDC in, BRL out (case A)      brl_out=False : BRL in, USDC out (case B)
all curves work in numeraire: x = U, y = p*B.
run: python3 scripts/fxcurves_compare.py
"""
import math, random
from decimal import Decimal, getcontext
from fxswap_math import quote as dodo_quote, target as dodo_target

getcontext().prec = 50

class Revert(Exception): pass

# ------------------------------------------------------------------ B. stableswap anchored to oracle
def ss_D(x, y, A, sqrtf):
    S = x + y
    if S <= 0: return S * 0
    Ann = 4 * A; D = S
    for _ in range(255):
        D_P = D * D * D / (4 * x * y)
        Dp = D
        D = (Ann * S + 2 * D_P) * D / ((Ann - 1) * D + 3 * D_P)
        if D == Dp or abs(D - Dp) <= abs(D) * (4e-16 if isinstance(D, float) else Decimal("1e-45")): break
    return D

def ss_y(x, D, A, sqrtf):
    """closed form: y^2 + (x + D/Ann - D) y - D^3/(4 x Ann) = 0, positive root."""
    Ann = 4 * A
    b = x + D / Ann - D
    c = D * D * D / (4 * x * Ann)
    return (-b + sqrtf(b * b + 4 * c)) / 2

def ss_dynfee(x, y, fee, offpeg):
    """stableswap-ng: fee * offpeg / ((offpeg - 1) * 4xy/(x+y)^2 + 1). = fee when balanced, -> fee*offpeg when drained."""
    if offpeg == 1: return fee
    s2 = (x + y) * (x + y)
    return fee * offpeg / ((offpeg - 1) * 4 * x * y / s2 + 1)

class Curve:
    def begin(self, p, U, B): pass          # called once per scenario; lets a curve fix its target

class StableSwapFX(Curve):
    name = "B stableswap+oracle"
    def __init__(self, A=100, fee=0.0, offpeg=1, dec=False):
        self.A, self.fee, self.offpeg, self.dec = A, fee, offpeg, dec
    def quote(self, p, U, B, amount, brl_out, exact_in):
        if self.dec:
            p, U, B, amount = Decimal(p), Decimal(U), Decimal(B), Decimal(amount)
            A = Decimal(self.A); sq = lambda v: v.sqrt(); fee = Decimal(self.fee); off = Decimal(self.offpeg)
        else:
            A = self.A; sq = math.sqrt; fee = self.fee; off = self.offpeg
        if U <= 0 or B <= 0: raise Revert("empty side")
        x, y = U, p * B
        D = ss_D(x, y, A, sq)
        f = ss_dynfee(x, y, fee, off)
        if brl_out:
            if exact_in:
                Q = amount; y2 = ss_y(x + Q, D, A, sq); dy = (y - y2) * (1 - f) / p
                if dy >= B: raise Revert("drains BRL")
                return Q, dy
            dy = amount
            if dy >= B: raise Revert("drains BRL")
            y2 = y - p * dy / (1 - f); x2 = ss_y(y2, D, A, sq)
            return x2 - x, dy
        else:
            if exact_in:
                dx = amount; x2 = ss_y(y + p * dx, D, A, sq); Q = (x - x2) * (1 - f)
                if Q >= U: raise Revert("drains USDC")
                return dx, Q
            Q = amount
            if Q >= U: raise Revert("drains USDC")
            x2 = x - Q / (1 - f); y2 = ss_y(x2, D, A, sq)
            return (y2 - y) / p, Q

# ------------------------------------------------------------------ C. shell v1 / dfx v2 piecewise
class ShellFX(Curve):
    name = "C shell/dfx"
    def __init__(self, alpha=0.5, beta=0.35, delta=0.15, maxf=0.25, lam=0.3, eps=0.0):
        self.alpha, self.beta, self.delta, self.maxf, self.lam, self.eps = alpha, beta, delta, maxf, lam, eps
        self.w = (0.5, 0.5)
    def micro(self, bal, ideal):
        if bal < ideal:
            th = ideal * (1 - self.beta)
            if bal < th:
                m = th - bal; return min(m * self.delta / ideal, self.maxf) * m
        else:
            th = ideal * (1 + self.beta)
            if bal > th:
                m = bal - th; return min(m * self.delta / ideal, self.maxf) * m
        return 0.0
    def fee(self, g, bals):
        return sum(self.micro(b, g * w) for b, w in zip(bals, self.w))
    def trade(self, bals, i, j, amt_i):
        """DFX calculateTrade. amt_i signed change of bals[i]; returns signed change of bals[j]."""
        g0 = sum(bals); omega = self.fee(g0, bals)
        out = -amt_i
        for _ in range(32):
            nb = list(bals); nb[i] += amt_i; nb[j] += out
            g = g0 + amt_i + out
            psi = self.fee(g, nb)
            prev = out
            out = -(amt_i + omega - psi) if omega < psi else -(amt_i + self.lam * (omega - psi))
            if abs(out - prev) <= 1e-13 * max(1.0, abs(out)):
                nb = list(bals); nb[i] += amt_i; nb[j] += out; g = g0 + amt_i + out
                for t in range(2):
                    ideal = g * self.w[t]
                    if nb[t] > ideal * (1 + self.alpha) and nb[t] > bals[t]: raise Revert("upper halt")
                    if nb[t] < ideal * (1 - self.alpha) and nb[t] < bals[t]: raise Revert("lower halt")
                if nb[0] <= 0 or nb[1] <= 0: raise Revert("drain")
                return out
        raise Revert("no convergence")
    def quote(self, p, U, B, amount, brl_out, exact_in):
        if U <= 0 or B <= 0: raise Revert("empty side")
        bals = [U, p * B]
        if brl_out:
            if exact_in:
                out = self.trade(bals, 0, 1, amount)          # numeraire out of y
                dy = -out * (1 - self.eps) / p
                return amount, dy
            dy = amount; need = p * dy * (1 + self.eps)
            inp = self.trade(bals, 1, 0, -need)
            return inp, dy
        else:
            if exact_in:
                dx = amount
                out = self.trade(bals, 1, 0, p * dx)
                return dx, -out * (1 - self.eps)
            Q = amount; need = Q * (1 + self.eps)
            inp = self.trade(bals, 0, 1, -need)
            return inp / p, Q

# ------------------------------------------------------------------ G. current dodo, fixed target (reference)
class DodoFX(Curve):
    name = "G dodo fixed"
    def __init__(self, k=0.05, t=0.5): self.k, self.t = k, t; self.B0 = None
    def begin(self, p, U, B): self.B0 = dodo_target(U, B, p, self.t)   # fixed target for the scenario
    def quote(self, p, U, B, amount, brl_out, exact_in):
        B0 = self.B0 if self.B0 is not None else dodo_target(U, B, p, self.t)
        try: return dodo_quote(p, self.k, self.t, U, B, amount, brl_out, exact_in, B0)
        except (ValueError, AssertionError, ZeroDivisionError) as e: raise Revert(str(e))

# ------------------------------------------------------------------ battery
def rel(a, b): return abs(a - b) / max(abs(b), 1e-30)

def rnd_state():
    p = 10 ** random.uniform(-2, 2)
    B = 10 ** random.uniform(2, 7)
    U = p * B * 10 ** random.uniform(-0.6, 0.6)      # 20% .. 80% BRL share (inside shell's alpha)
    return p, U, B

def t_inverse(c, n=3000):
    worst = 0; rev = 0
    for _ in range(n):
        p, U, B = rnd_state(); c.begin(p, U, B)
        try:
            Q = p * B * 10 ** random.uniform(-6, -0.7)
            _, dy = c.quote(p, U, B, Q, True, True); Q2, _ = c.quote(p, U, B, dy, True, False)
            worst = max(worst, rel(Q2, Q))
            dx = B * 10 ** random.uniform(-6, -0.7)
            _, Qb = c.quote(p, U, B, dx, False, True); dx2, _ = c.quote(p, U, B, Qb, False, False)
            worst = max(worst, rel(dx2, dx))
        except Revert: rev += 1
    return worst, rev

def t_roundtrip(c, n=3000):
    fails = 0; worst = -1; rev = 0
    for _ in range(n):
        p, U, B = rnd_state(); c.begin(p, U, B)
        try:
            Q = p * B * 10 ** random.uniform(-6, -0.7)
            _, dy = c.quote(p, U, B, Q, True, True)
            _, Qb = c.quote(p, U + Q, B - dy, dy, False, True)
            g = (Qb - Q) / Q; worst = max(worst, g)
            if Qb > Q * (1 + 1e-9): fails += 1
            dx = B * 10 ** random.uniform(-6, -0.7)
            _, Qs = c.quote(p, U, B, dx, False, True)
            _, dyb = c.quote(p, U - Qs, B + dx, Qs, True, True)
            g = (dyb - dx) / dx; worst = max(worst, g)
            if dyb > dx * (1 + 1e-9): fails += 1
        except Revert: rev += 1
    return fails, worst, rev

def t_split(c, n=2000):
    fails = 0; worst = -1; rev = 0
    for _ in range(n):
        p, U, B = rnd_state(); c.begin(p, U, B)
        Q = p * B * 10 ** random.uniform(-3, -0.7); m = random.randint(2, 10)
        try:
            _, d1 = c.quote(p, U, B, Q, True, True)
            Uc, Bc, tot = U, B, 0.0
            for _ in range(m):
                _, d = c.quote(p, Uc, Bc, Q / m, True, True); Uc += Q / m; Bc -= d; tot += d
            g = (tot - d1) / d1; worst = max(worst, g)
            if tot > d1 * (1 + 1e-9): fails += 1
        except Revert: rev += 1
    return fails, worst, rev

def t_sequences(c, n=1000):
    fails = 0; worst = -1; rev = 0
    for _ in range(n):
        p, U, B = rnd_state(); c.begin(p, U, B); Uc, Bc, pos, usdc = U, B, 0.0, 0.0
        try:
            for _ in range(random.randint(2, 10)):
                if random.random() < 0.5:
                    Q = p * Bc * 10 ** random.uniform(-4, -1); _, dy = c.quote(p, Uc, Bc, Q, True, True)
                    Uc += Q; Bc -= dy; pos += dy; usdc -= Q
                else:
                    dx = Bc * 10 ** random.uniform(-4, -1); _, Q = c.quote(p, Uc, Bc, dx, False, True)
                    Uc -= Q; Bc += dx; pos -= dx; usdc += Q
            if pos > 0: _, Q = c.quote(p, Uc, Bc, pos, False, True); usdc += Q
            elif pos < 0: Q, _ = c.quote(p, Uc, Bc, -pos, True, False); usdc -= Q
        except Revert: rev += 1; continue
        g = usdc / (U + p * B); worst = max(worst, g)
        if usdc > 1e-9 * (U + p * B): fails += 1
    return fails, worst, rev

def t_impact(c, p=5.0, U=1e6, B=2e5):
    """balanced book. effective premium buying x% of BRL, and marginal after (from a tiny follow-up trade)."""
    c.begin(p, U, B); row = []
    for x in [0.01, 0.05, 0.10, 0.25, 0.50]:
        try:
            Q, _ = c.quote(p, U, B, x * B, True, False)
            eff = Q / (p * x * B) - 1
            q2, _ = c.quote(p, U + Q, B * (1 - x), B * 1e-7, True, False)
            marg = q2 / (p * B * 1e-7) - 1
            row.append((eff, marg))
        except Revert as e: row.append((float("nan"), float("nan")))
    return row

def t_imbalance(c, p=5.0, V=2e6):
    """marginal buy price / p and sell price / p as BRL share of the book goes 5% .. 95%."""
    row = []
    for share in [0.05, 0.15, 0.30, 0.50, 0.70, 0.85, 0.95]:
        B = share * V / p; U = V - share * V; c.begin(p, U, B)
        try: qb, _ = c.quote(p, U, B, B * 1e-7, True, False); buy = qb / (p * B * 1e-7)
        except Revert: buy = float("nan")
        try: _, qs = c.quote(p, U, B, B * 1e-7, False, True); sell = qs / (p * B * 1e-7)
        except Revert: sell = float("nan")
        row.append((share, buy, sell))
    return row

def arb_to_oracle(c, p, U, B, iters=40):
    """arb trades against the curve at oracle p until marginal ~ p (bisection on trade size, both directions)."""
    def marg_buy(U, B):
        try: q, _ = c.quote(p, U, B, B * 1e-8, True, False); return q / (p * B * 1e-8)
        except Revert: return float("inf")
    def marg_sell(U, B):
        try: _, q = c.quote(p, U, B, B * 1e-8, False, True); return q / (p * B * 1e-8)
        except Revert: return 0.0
    if marg_buy(U, B) < 1:          # BRL cheap: arb buys BRL
        lo, hi = 0.0, B * 0.999
        for _ in range(iters):
            mid = (lo + hi) / 2
            try:
                Q, _ = c.quote(p, U, B, mid, True, False)
                if marg_buy(U + Q, B - mid) < 1: lo = mid
                else: hi = mid
            except Revert: hi = mid
        Q, _ = c.quote(p, U, B, lo, True, False) if lo > 0 else (0.0, 0.0)
        return U + Q, B - lo
    if marg_sell(U, B) > 1:         # BRL dear: arb sells BRL
        lo, hi = 0.0, B * 10
        for _ in range(iters):
            mid = (lo + hi) / 2
            try:
                _, Q = c.quote(p, U, B, mid, False, True)
                if marg_sell(U - Q, B + mid) > 1: lo = mid
                else: hi = mid
            except Revert: hi = mid
        _, Q = c.quote(p, U, B, lo, False, True) if lo > 0 else (0.0, 0.0)
        return U - Q, B + lo
    return U, B

def t_oracle_jump(c, p=5.0, U=1e6, B=2e5):
    c.begin(p, U, B); row = []
    for mv in [0.001, 0.01, 0.05, 0.10, 0.20]:
        pn = p * (1 + mv)
        U2, B2 = arb_to_oracle(c, pn, U, B)
        loss = (U + pn * B) - (U2 + pn * B2)
        row.append((mv, loss / (U + pn * B)))
    return row

def t_oracle_error(c, p_real=5.0, U=1e6, B=2e5):
    """oracle too high by err. attacker sells BRL, best profit over trade size (grid), and share of U taken."""
    c.begin(p_real, U, B); row = []
    for err in [0.0005, 0.001, 0.005, 0.01, 0.02, 0.05]:
        p_or = p_real * (1 + err); best = (0.0, 0.0, 0.0)
        for dx in [B * 10 ** e for e in [x / 10 for x in range(-30, 21)]]:
            try: _, Q = c.quote(p_or, U, B, dx, False, True)
            except Revert: continue
            pr = Q - dx * p_real
            if pr > best[0]: best = (pr, dx, Q / U)
        row.append((err, best[0] / (U + p_real * B), best[2]))
    return row

def t_edges(c, p=5.0):
    out = []
    def run(name, fn):
        try: out.append((name, fn()))
        except Revert as e: out.append((name, f"revert: {e}"))
        except Exception as e: out.append((name, f"EXC {type(e).__name__}: {e}"))
    U, B = 1e6, 2e5; c.begin(p, U, B)
    run("buy 99.9% BRL",        lambda: f"Q/(p dy)={c.quote(p,U,B,B*0.999,True,False)[0]/(p*B*0.999):.4g}")
    run("buy 100% BRL",         lambda: c.quote(p,U,B,B,True,False))
    run("Q = 1000x book",       lambda: f"dy/B={c.quote(p,U,B,1e3*(U+p*B),True,True)[1]/B:.6f}")
    run("sell 10x B",           lambda: f"Q/U={c.quote(p,U,B,10*B,False,True)[1]/U:.4g}")
    run("sell to drain U",      lambda: c.quote(p,U,B,U/p*0.999,False,False))
    run("dust B=1e-9",          lambda: f"buy px/p={c.quote(p,U,1e-9,5e-10,True,False)[0]/(p*5e-10):.4g}")
    run("dust U=1e-9 sell",     lambda: c.quote(p,1e-9,B,1.0,False,True))
    run("book 1% BRL buy 1%",   lambda: f"px/p={c.quote(p,U,U/p*0.01,U/p*1e-4,True,False)[0]/(p*U/p*1e-4):.4g}")
    run("book 1% BRL sell 1%",  lambda: f"px/p={c.quote(p,U,U/p*0.01,U/p*1e-4,False,True)[1]/(p*U/p*1e-4):.4g}")
    run("amount 0",             lambda: c.quote(p,U,B,0.0,True,True))
    run("p=1e-12",              lambda: f"px/p={c.quote(1e-12,U*1e-12,B,B*0.1,True,False)[0]/(1e-12*B*0.1):.4g}")
    run("p=1e12",               lambda: f"px/p={c.quote(1e12,U*1e12,B,B*0.1,True,False)[0]/(1e12*B*0.1):.4g}")
    return out

def t_float_vs_decimal(n=300):
    cf, cd = StableSwapFX(A=100), StableSwapFX(A=100, dec=True); worst = 0
    for _ in range(n):
        p, U, B = rnd_state(); Q = p * B * 10 ** random.uniform(-6, -0.7)
        try:
            _, a = cf.quote(p, U, B, Q, True, True); _, b = cd.quote(p, U, B, Q, True, True)
            worst = max(worst, rel(a, float(b)))
            dx = B * 10 ** random.uniform(-6, -0.7)
            _, a = cf.quote(p, U, B, dx, False, True); _, b = cd.quote(p, U, B, dx, False, True)
            worst = max(worst, rel(a, float(b)))
        except Revert: pass
    return worst

def run_all(curves):
    random.seed(3)
    for c in curves:
        print(f"\n===== {c.name}")
        w, r = t_inverse(c);      print(f"inverse exactIn/exactOut     worst rel err {w:.2e}   reverts {r}")
        f, w, r = t_roundtrip(c); print(f"roundtrip (both directions)  taker gain > 0: {f}   worst {w:+.2e}   reverts {r}")
        f, w, r = t_split(c);     print(f"split vs single              split beats: {f}   worst {w:+.2e}   reverts {r}")
        f, w, r = t_sequences(c); print(f"random closed sequences      taker net > 0: {f}   worst net/book {w:+.2e}   reverts {r}")
        print("impact, balanced book, buy x% of BRL (eff premium / marginal after):")
        print("   " + "".join(f"  {x:>3.0%}: {e*100:6.3f}%/{m*100:7.3f}%" for x, (e, m) in zip([.01,.05,.1,.25,.5], t_impact(c))))
        print("imbalance: BRL share -> marginal buy/p, sell/p:")
        print("   " + "".join(f"  {s:.0%}: {b:.4f}/{sl:.4f}" for s, b, sl in t_imbalance(c)))
        print("oracle jump, balanced book, maker loss to arb / book:")
        print("   " + "".join(f"  {mv:+.1%}: {l*100:.4f}%" for mv, l in t_oracle_jump(c)))
        print("oracle too high by err: attacker best profit / book, share of U taken:")
        print("   " + "".join(f"  {e:.2%}: {pr*100:.3f}% ({sh:.0%}U)" for e, pr, sh in t_oracle_error(c)))
        print("edges:"); [print(f"   {a:22s} -> {b}") for a, b in t_edges(c)]

if __name__ == "__main__":
    run_all([StableSwapFX(A=100), StableSwapFX(A=100, fee=0.0005, offpeg=5),
             ShellFX(), ShellFX(eps=0.0005), DodoFX(k=0.05)])
    print("\nB float vs Decimal worst rel err:", f"{t_float_vs_decimal():.2e}")
