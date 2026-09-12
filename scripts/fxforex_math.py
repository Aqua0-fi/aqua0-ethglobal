"""
forex opcode reference math: Shell v1 curve + oracle (as in DFX v2), 2 assets, closed form per piece.

numeraire: x = USDC balance, y = p * BRL balance (p = oracle, USDC per BRL). g = x + y, ideal I = g/2.
micro fee of one asset (DFX CurveMath.calculateMicroFee):
    below band: m = I(1-beta) - b, if m > 0: mu = min(delta*m/I, MAX) * m
    above band: m = b - I(1+beta), if m > 0: mu = min(delta*m/I, MAX) * m
    inside:     mu = 0
psi(state) = mu_x + mu_y.  omega = psi(old state).
trade (DFX calculateTrade): input a into asset i (signed), output o from asset j (signed):
    o = -(a + omega - psi')            if omega < psi'   (fee grew: taker pays it)
    o = -(a + lambda*(omega - psi'))   otherwise         (fee shrank: taker gets lambda of it)
with psi' evaluated at the NEW state, so it is a fixed point. DFX iterates 32 times.

closed form: let s = a + o (numeraire retained by the pool). then s = c*(psi'(s) - omega), c = 1 or lambda.
new ideal I' = (g+s)/2, m_i(s) linear in s, mu_i*(g+s) quadratic in s  =>  multiply by (g+s): quadratic in s.
solve per regime (each asset: inside / below-quad / below-cap / above-quad / above-cap), keep the root
consistent with its regime and with |s| << g (the other root is ~ -g, spurious).

halts (DFX enforceHalts): revert if a balance ends above I'(1+alpha) having increased, or below I'(1-alpha)
having decreased.  epsilon: proportional fee on the output (exactIn) or input (exactOut).
"""
import math, random
from decimal import Decimal, getcontext
getcontext().prec = 50

class Revert(Exception): pass

DEF = dict(alpha=0.5, beta=0.35, delta=0.15, maxf=0.25, lam=0.3, eps=0.0)

# ----------------------------------------------------------------- fee pieces
def micro(b, I, P):
    if b < I:
        m = I * (1 - P["beta"]) - b
        if m > 0: return min(m * P["delta"] / I, P["maxf"]) * m
    else:
        m = b - I * (1 + P["beta"])
        if m > 0: return min(m * P["delta"] / I, P["maxf"]) * m
    return 0 * b

def psi(x, y, P):
    I = (x + y) / 2
    return micro(x, I, P) + micro(y, I, P)

# ----------------------------------------------------------------- DFX iterative (reference for the closed form)
def trade_iter(x, y, i, a, P, iters=64):
    bals = [x, y]; j = 1 - i
    g0 = x + y; omega = psi(x, y, P)
    o = -a
    for _ in range(iters):
        nb = list(bals); nb[i] += a; nb[j] += o
        ps = psi(nb[0], nb[1], P)
        prev = o
        o = -(a + omega - ps) if omega < ps else -(a + P["lam"] * (omega - ps))
        if abs(o - prev) <= 1e-15 * max(1.0, abs(o)): return o
    return o

def trade_iter_dfx(x, y, i, a, P):
    """DFX calculateTrade verbatim (getOriginSwapData starts with the output balance reduced by the
    full input, i.e. o = -a). stops when output changes by less than 1e13 in 64.64 (5.4e-7 numeraire),
    max 32 iterations, else reverts Curve/swap-convergence-failed."""
    j = 1 - i; g0 = x + y; ob = [x, y]
    omega = psi(x, y, P)
    nb = list(ob); nb[i] += a; nb[j] -= a; ng = g0
    o = -a
    step = 1e13 / 2 ** 64
    for _ in range(32):
        ps = psi(nb[0], nb[1], P)
        prev = o
        o = -(a + omega - ps) if omega < ps else -(a + P["lam"] * (omega - ps))
        if math.floor(o / step) == math.floor(prev / step): return o
        ng = g0 + a + o; nb[j] = ob[j] + o
    raise Revert("convergence failed")

def trade_bisect_decimal(x, y, i, a, P, digits=40):
    """independent solver: residual R(s) = s - c(psi(s) - omega) is increasing in s (slope of psi < 1),
    so bisect it in Decimal. no quadratics, no fixed-point iteration."""
    D = Decimal
    Pd = {k: D(str(v)) for k, v in P.items()}
    x, y, a = D(str(x)), D(str(y)), D(str(a))
    def psid(nx, ny):
        I = (nx + ny) / 2; tot = D(0)
        for b in (nx, ny):
            if b < I:
                m = I * (1 - Pd["beta"]) - b
                if m > 0: tot += min(m * Pd["delta"] / I, Pd["maxf"]) * m
            else:
                m = b - I * (1 + Pd["beta"])
                if m > 0: tot += min(m * Pd["delta"] / I, Pd["maxf"]) * m
        return tot
    omega = psid(x, y)
    def R(s):
        nx = x + a if i == 0 else x - a + s
        ny = y - a + s if i == 0 else y + a
        if nx <= 0 or ny <= 0: return None
        ps = psid(nx, ny); c = D(1) if omega < ps else Pd["lam"]
        return s - c * (ps - omega)
    # R(lo) <= 0 at lo = -omega (psi >= 0, c <= 1); also s must keep the output balance positive: s > a - b_out
    b_out = y if i == 0 else x
    lo = max(-omega * D("1.0001") - D("1e-30"), a - b_out + (x + y) * D("1e-30"))
    hi = 2 * (x + y)
    for _ in range(digits * 4):
        mid = (lo + hi) / 2
        r = R(mid)
        if r is None: lo = mid           # infeasible (negative balance) only happens below the root
        elif r > 0: hi = mid
        else: lo = mid
        if hi - lo < D(10) ** (-digits): break
    s = (lo + hi) / 2
    return float(s - a)

# ----------------------------------------------------------------- closed form
def _regime_coeffs(m0, k, reg, g, P):
    """coefficients (A,B,C) of T(s) = mu(s)*(g+s) for one asset in a given regime. m(s) = m0 + k s."""
    if reg == "in": return (0.0, 0.0, 0.0)
    if reg.endswith("quad"):
        d2 = 2 * P["delta"]
        return (d2 * k * k, d2 * 2 * m0 * k, d2 * m0 * m0)
    M = P["maxf"]
    return (M * k, M * (m0 + k * g), M * m0 * g)

def _piece(b_fixed_part, k_bal, g, side, P):
    """for an asset whose new balance is b(s) = b_fixed_part + k_bal*s, return (m0, k) for side below/above."""
    if side == "below":   # m = (1-beta)(g+s)/2 - b(s)
        return (1 - P["beta"]) * g / 2 - b_fixed_part, (1 - P["beta"]) / 2 - k_bal
    return b_fixed_part - (1 + P["beta"]) * g / 2, k_bal - (1 + P["beta"]) / 2   # above

def _check_regime(b, I, reg, P):
    if reg == "in":
        return I * (1 - P["beta"]) <= b <= I * (1 + P["beta"])
    side, kind = reg.split("-")
    m = I * (1 - P["beta"]) - b if side == "below" else b - I * (1 + P["beta"])
    if m <= 0: return False
    capped = m * P["delta"] / I >= P["maxf"]
    return capped == (kind == "cap")

REGS = ["in", "below-quad", "below-cap", "above-quad", "above-cap"]

def trade_closed(x, y, i, a, P):
    """returns o (signed change of asset j) solving the DFX fixed point exactly, piecewise quadratic."""
    g = x + y; omega = psi(x, y, P)
    bx, by = x, y
    # exact fast path: flat zone before and after (psi = omega = 0) => s = 0, o = -a
    nx0, ny0 = (x + a, y - a) if i == 0 else (x - a, y + a)
    if omega == 0 and nx0 > 0 and ny0 > 0 and psi(nx0, ny0, P) == 0: return -a
    # new balances as functions of s: input asset fixed at b+a, output asset b - a + s
    parts = [None, None]
    parts[i] = ((bx if i == 0 else by) + a, 0.0)
    parts[1 - i] = ((by if i == 0 else bx) - a, 1.0)
    best = None
    for c in (1.0, P["lam"]):
        for rx in REGS:
            for ry in REGS:
                A, B, C = 1.0, g + c * omega, c * omega * g       # s^2 + g s + c*omega*(g+s)
                for part, reg in ((parts[0], rx), (parts[1], ry)):
                    if reg == "in": continue
                    m0, k = _piece(part[0], part[1], g, reg.split("-")[0], P)
                    a2, b2, c2 = _regime_coeffs(m0, k, reg, g, P)
                    A -= c * a2; B -= c * b2; C -= c * c2
                disc = B * B - 4 * A * C
                if disc < 0: continue
                r = math.sqrt(disc)
                if A == 0: roots = (-C / B,)
                else:
                    # stable pair: the big root without cancellation, the small one from the product
                    r1 = (-B - r) / (2 * A) if B >= 0 else (-B + r) / (2 * A)
                    roots = (r1, C / (A * r1)) if r1 != 0 else (r1, -B / A)
                for s in roots:
                    if not (-g < s): continue
                    nx = parts[0][0] + parts[0][1] * s; ny = parts[1][0] + parts[1][1] * s
                    if nx <= 0 or ny <= 0: continue
                    I = (g + s) / 2
                    if not (_check_regime(nx, I, rx, P) and _check_regime(ny, I, ry, P)): continue
                    ps = psi(nx, ny, P)
                    cc = 1.0 if omega < ps else P["lam"]
                    if cc != c and abs(ps - omega) > 1e-12 * max(1.0, omega): continue
                    res = abs(s - c * (ps - omega))
                    if best is None or res < best[0]: best = (res, s)
    if best is None:
        nb_in = (x if i == 0 else y) + a
        raise Revert("drain" if nb_in <= 0 or abs(a) >= x + y else "no consistent piece")
    s = best[1]
    return s - a

MAX_DIFF = -0x10C6F7A0B5EE / 2 ** 64          # DFX enforceSwapInvariant tolerance in numeraire (~ -1e-6)

def enforce_halts(x, y, nx, ny, P):
    """verbatim DFX enforceHalts: a balance may sit beyond the halt only if it was already beyond and
    the excursion (distance past the halt) does not grow."""
    oI, nI = (x + y) / 2, (nx + ny) / 2; al = P["alpha"]
    for ob, nb in ((x, nx), (y, ny)):
        if nb > nI:
            nH = nI * (1 + al)
            if nb > nH:
                oH = oI * (1 + al)
                if ob < oH: raise Revert("upper halt")
                if nb - nH > ob - oH: raise Revert("upper halt")
        else:
            nH = nI * (1 - al)
            if nb < nH:
                oH = oI * (1 - al)
                if ob > oH: raise Revert("lower halt")
                if nH - nb > oH - ob: raise Revert("lower halt")

def enforce_swap_invariant(x, y, nx, ny, P):
    diff = (nx + ny - psi(nx, ny, P)) - (x + y - psi(x, y, P))
    if not (0 < diff or diff >= MAX_DIFF): raise Revert("swap invariant")

def quote(p, U, B, amount, brl_out, exact_in, P=DEF, conf=0.0, solver=trade_closed):
    """(amountIn, amountOut). eps_eff = eps + conf/p (pyth confidence as extra spread)."""
    if U <= 0 or B <= 0: raise Revert("empty side")
    if amount < 0: raise Revert("negative amount")
    x, y = U, p * B
    eps = P["eps"] + conf / p
    def run(i, a):
        o = solver(x, y, i, a, P)
        nx, ny = (x + a, y + o) if i == 0 else (x + o, y + a)
        if nx <= 0 or ny <= 0: raise Revert("drain")
        enforce_halts(x, y, nx, ny, P)
        enforce_swap_invariant(x, y, nx, ny, P)
        return o
    if brl_out:
        if exact_in:
            o = run(0, amount); return amount, -o * (1 - eps) / p
        inp = run(1, -p * amount); return inp * (1 + eps), amount
    else:
        if exact_in:
            o = run(1, p * amount); return amount, -o * (1 - eps)
        inp = run(0, -amount); return inp * (1 + eps) / p, amount

# ----------------------------------------------------------------- tests
def rel(a, b): return abs(a - b) / max(abs(b), 1e-30)

def rnd_state(P):
    p = 10 ** random.uniform(-2, 2); V = 10 ** random.uniform(3, 8)
    lo, hi = (1 - P["alpha"]) / 2, (1 + P["alpha"]) / 2          # share range inside halts
    sh = random.uniform(lo * 1.01, hi * 0.99)
    return p, V * (1 - sh), V * sh / p

def rnd_trade(P, p, U, B):
    """random signed input in numeraire on a random asset, sized to reach any piece."""
    i = random.randint(0, 1); g = U + p * B
    a = g * 10 ** random.uniform(-7, math.log10(P["alpha"]))
    if random.random() < 0.5: a = -a
    return i, a

def t1_closed_vs_iter(P, n=20000):
    worst = 0; worst_abs = 0; tried = 0; pieces = {}
    for _ in range(n):
        p, U, B = rnd_state(P); i, a = rnd_trade(P, p, U, B); x, y = U, p * B
        nb = [x, y]; nb[i] += a
        if nb[i] <= 0: continue
        try: oc = trade_closed(x, y, i, a, P)
        except Revert: continue
        oi = trade_iter(x, y, i, a, P)
        tried += 1
        worst = max(worst, abs(oc - oi) / max(abs(a), 1e-30))
        worst_abs = max(worst_abs, abs(oc - oi) / (x + y))      # vs book size: float ulp floor (1 wei in solidity)
        nx, ny = (x + a, y + oc) if i == 0 else (x + oc, y + a); I = (nx + ny) / 2
        key = tuple(next(r for r in REGS if _check_regime(b, I, r, P)) for b in (nx, ny))
        pieces[key] = pieces.get(key, 0) + 1
    return worst, worst_abs, tried, pieces

def t1b_closed_vs_decimal(P, n=1500):
    worst = (0, None)
    for _ in range(n):
        p, U, B = rnd_state(P); i, a = rnd_trade(P, p, U, B); x, y = U, p * B
        if (x if i == 0 else y) + a <= 0: continue
        try: oc = trade_closed(x, y, i, a, P)
        except Revert: continue
        od = trade_bisect_decimal(x, y, i, a, P)
        d = abs(oc - od) / (x + y)
        if d > worst[0]: worst = (d, (x, y, i, a, oc, od))
    return worst

def t1c_closed_vs_dfx_verbatim(P, n=5000):
    """faithful DFX loop (coarse stop). reports its own error vs the closed form, in numeraire units."""
    worst = 0; conv_fail = 0
    for _ in range(n):
        p, U, B = rnd_state(P); i, a = rnd_trade(P, p, U, B); x, y = U, p * B
        if (x if i == 0 else y) + a <= 0: continue
        try: oc = trade_closed(x, y, i, a, P)
        except Revert: continue
        try: od = trade_iter_dfx(x, y, i, a, P)
        except Revert: conv_fail += 1; continue
        worst = max(worst, abs(oc - od))
    return worst, conv_fail

def t2_invariants(P, n=5000):
    """utility g - psi never decreases; inside band price == oracle; taker never gains on roundtrip/split/sequences."""
    util_f = band_f = rt_f = sp_f = seq_f = 0; rev = 0; worst_rt = -1; worst_sp = -1
    for _ in range(n):
        p, U, B = rnd_state(P); x, y = U, p * B
        i, a = rnd_trade(P, p, U, B)
        try: o = trade_closed(x, y, i, a, P)
        except Revert: rev += 1; continue
        nx, ny = (x + a, y + o) if i == 0 else (x + o, y + a)
        if nx <= 0 or ny <= 0: continue
        u0 = x + y - psi(x, y, P); u1 = nx + ny - psi(nx, ny, P)
        if u1 < u0 - 1e-9 * abs(u0): util_f += 1
        I0, I1 = (x + y) / 2, (nx + ny) / 2
        inside = all(I * (1 - P["beta"]) <= b <= I * (1 + P["beta"]) for I, b in ((I0, x), (I0, y), (I1, nx), (I1, ny)))
        if inside and abs(o + a) > 1e-12 * abs(a): band_f += 1
        # roundtrip buy BRL then sell it back
        try:
            Q = p * B * 10 ** random.uniform(-6, -0.5)
            _, dy = quote(p, U, B, Q, True, True, P); _, Qb = quote(p, U + Q, B - dy, dy, False, True, P)
            worst_rt = max(worst_rt, (Qb - Q) / Q)
            if Qb > Q * (1 + 1e-9): rt_f += 1
            m = random.randint(2, 8); Uc, Bc, tot = U, B, 0.0
            for _ in range(m):
                _, d = quote(p, Uc, Bc, Q / m, True, True, P); Uc += Q / m; Bc -= d; tot += d
            worst_sp = max(worst_sp, (tot - dy) / dy)
            if tot > dy * (1 + 1e-9): sp_f += 1
            # random closed sequence
            Uc, Bc, pos, usdc = U, B, 0.0, 0.0
            for _ in range(random.randint(2, 8)):
                if random.random() < 0.5:
                    q = p * Bc * 10 ** random.uniform(-4, -1); _, d = quote(p, Uc, Bc, q, True, True, P)
                    Uc += q; Bc -= d; pos += d; usdc -= q
                else:
                    d = Bc * 10 ** random.uniform(-4, -1); _, q = quote(p, Uc, Bc, d, False, True, P)
                    Uc -= q; Bc += d; pos -= d; usdc += q
            if pos > 0: _, q = quote(p, Uc, Bc, pos, False, True, P); usdc += q
            elif pos < 0: q, _ = quote(p, Uc, Bc, -pos, True, False, P); usdc -= q
            if usdc > 1e-9 * (U + p * B): seq_f += 1
        except Revert: rev += 1
    return dict(utility_drops=util_f, band_not_oracle=band_f, roundtrip=rt_f, worst_rt=worst_rt, split=sp_f, worst_split=worst_sp, sequences=seq_f, reverts=rev)

def t3_inverse(P, n=5000):
    worst = 0; rev = 0
    for _ in range(n):
        p, U, B = rnd_state(P)
        try:
            Q = p * B * 10 ** random.uniform(-6, -0.5); _, dy = quote(p, U, B, Q, True, True, P)
            Q2, _ = quote(p, U, B, dy, True, False, P); worst = max(worst, rel(Q2, Q))
            dx = B * 10 ** random.uniform(-6, -0.5); _, Qs = quote(p, U, B, dx, False, True, P)
            dx2, _ = quote(p, U, B, Qs, False, False, P); worst = max(worst, rel(dx2, dx))
        except Revert: rev += 1
    return worst, rev

def t4_continuity(P):
    """price continuous crossing the beta boundary and the cap boundary; marginal price monotone in size."""
    p, U, B = 5.0, 1e6, 2e5; x, y = U, p * B; g = x + y
    out = []
    # beta boundary: trade that lands exactly on it, +- tiny
    a_edge = y - (1 - P["beta"]) * g / 2   # first-order (ignores s)
    prices = []
    for da in [-1e-6, -1e-9, 0, 1e-9, 1e-6]:
        a = a_edge * (1 + da)
        o = trade_closed(x, y, 0, a, P); prices.append(-o / a)
    out.append(("eff price around beta edge", [f"{v:.12f}" for v in prices]))
    # monotone marginal: effective price non-decreasing in size
    prev = 0; mono = True; last = None
    for e in [i / 20 for i in range(-120, 0)]:
        a = g * 10 ** e
        try: o = trade_closed(x, y, 0, a, P)
        except Revert: break
        pr = -o / a
        if last is not None and pr > last + 1e-12: mono = False
        last = pr
    out.append(("taker price/oracle non-increasing... i.e. cost non-decreasing with size", mono))
    return out

def t5_edges(P):
    out = []
    def run(name, fn, Pp=P):
        try: out.append((name, fn()))
        except Revert as e: out.append((name, f"revert: {e}"))
        except Exception as e: out.append((name, f"EXC {type(e).__name__}: {e}"))
    p, U, B = 5.0, 1e6, 2e5
    run("buy to exactly alpha edge",  lambda: f"px/p={quote(p,U,B,B*0.5*(1-1e-9),True,False,P)[0]/(p*B*0.5*(1-1e-9)):.6f}")
    run("buy past alpha edge",        lambda: quote(p,U,B,B*0.5*(1+1e-9),True,False,P))
    run("buy 100%",                   lambda: quote(p,U,B,B,True,False,P))
    run("Q = 1000x book",             lambda: quote(p,U,B,1e3*(U+p*B),True,True,P))
    run("sell 10x B",                 lambda: quote(p,U,B,10*B,False,True,P))
    run("dust B=1e-9 buy",            lambda: quote(p,U,1e-9,5e-10,True,False,P))
    run("dust B=1e-9 sell 1 BRL",     lambda: quote(p,U,1e-9,1.0,False,True,P))
    run("book at 26% BRL, sell 1%",   lambda: f"px/p={quote(p,U,U/p*0.26/0.74,U/p*0.0026,False,True,P)[1]/(p*U/p*0.0026):.5f}")
    run("book at 26% BRL, buy 1%",    lambda: quote(p,U,U/p*0.26/0.74,U/p*0.0026,True,False,P))
    run("book at 24% BRL (outside)",  lambda: quote(p,U,U/p*0.24/0.76,1.0,False,True,P))
    run("amount 0",                   lambda: quote(p,U,B,0.0,True,True,P))
    run("amount < 0",                 lambda: quote(p,U,B,-1.0,True,True,P))
    run("p=1e-15",                    lambda: f"px/p={quote(1e-15,U*1e-15,B,B*0.1,True,False,P)[0]/(1e-15*B*0.1):.6f}")
    run("p=1e15",                     lambda: f"px/p={quote(1e15,U*1e15,B,B*0.1,True,False,P)[0]/(1e15*B*0.1):.6f}")
    run("beta=0 (no flat zone) 10%",  lambda: f"px/p={quote(p,U,B,B*0.1,True,False,dict(P,beta=0.0))[0]/(p*B*0.1):.6f}")
    run("delta=0 (flat to alpha) 40%",lambda: f"px/p={quote(p,U,B,B*0.4,True,False,dict(P,delta=0.0))[0]/(p*B*0.4):.6f}")
    run("lam=1 rebalance 10% gain",   lambda: f"px/p={quote(p,U*0.6,U*1.4/p,U*0.1/p,True,False,dict(P,lam=1.0))[0]/(p*U*0.1/p):.6f}")
    run("lam=0 rebalance 10% gain",   lambda: f"px/p={quote(p,U*0.6,U*1.4/p,U*0.1/p,True,False,dict(P,lam=0.0))[0]/(p*U*0.1/p):.6f}")
    run("cap regime delta=3, 40%",    lambda: f"px/p={quote(p,U,B,B*0.4,True,False,dict(P,delta=3.0))[0]/(p*B*0.4):.6f}")
    run("conf=1% of p, buy 1%",       lambda: f"px/p={quote(p,U,B,B*0.01,True,False,P,conf=0.05)[0]/(p*B*0.01):.6f}")
    return out

def t6_oracle_error(P, p_real=5.0, U=1e6, B=2e5):
    """oracle too high by err, attacker sells BRL. best profit over sizes, with eps = 0 / 5bps / conf-based."""
    rows = []
    for name, Pp, conf in [("eps=0", P, 0.0), ("eps=5bps", dict(P, eps=0.0005), 0.0), ("conf=err", P, None)]:
        row = []
        for err in [0.0005, 0.001, 0.005, 0.01, 0.05]:
            p_or = p_real * (1 + err); best = (0.0, 0.0)
            cf = conf if conf is not None else p_or * err
            for dx in [B * 10 ** (e / 10) for e in range(-30, 11)]:
                try: _, Q = quote(p_or, U, B, dx, False, True, Pp, conf=cf)
                except Revert: continue
                pr = Q - dx * p_real
                if pr > best[0]: best = (pr, Q / U)
            row.append((err, best[0] / (U + p_real * B), best[1]))
        rows.append((name, row))
    return rows

def t7_impact_table(P, p=5.0, U=1e6, B=2e5):
    rows = []
    for beta in [0.0, 0.1, 0.35]:
        for delta in [0.05, 0.15, 0.5]:
            Pp = dict(P, beta=beta, delta=delta); row = []
            for x in [0.01, 0.05, 0.1, 0.2, 0.3, 0.4, 0.49]:
                try: Q, _ = quote(p, U, B, x * B, True, False, Pp); row.append(Q / (p * x * B) - 1)
                except Revert: row.append(float("nan"))
            rows.append((beta, delta, row))
    return rows

def t0_onchain_dfx_vectors():
    """DFX v2 EURC/USDC curve 0x8cd86fbC94BeBFD910CaaE7aE4CE374886132c48 on Ethereum, read 2026-09-12 with cast.
    viewCurve = (alpha .5, beta .35, delta .5, epsilon .0015, lambda 1). assimilator rates (8 dec) and raw balances (6 dec)."""
    rE, rU = 1.159545, 0.99986417
    xE, xU = 1627.848764 * rE, 1179.110189 * rU
    P = dict(alpha=0.5, beta=0.35, delta=0.5, maxf=0.25, lam=1.0, eps=0.0015)
    origin = {100: 86.099665, 500: 430.498329, 800: 688.797328, 900: 774.852549, 950: 816.093130, 1000: 854.918284, 1100: 926.406593}
    rows = []
    for usdc, oc in origin.items():                       # USDC in, EURC out
        o = trade_closed(xU, xE, 0, usdc * rU, P); out = -o * (1 - P["eps"]) / rE
        rows.append((f"originSwap {usdc} USDC->EURC", oc, out))
    o = trade_closed(xU, xE, 1, 100 * rE, P); rows.append(("originSwap 100 EURC->USDC", 115.796296, -o * (1 - P["eps"]) / rU))
    inp = trade_closed(xU, xE, 1, -900 * rE, P); rows.append(("targetSwap want 900 EURC, USDC in", 1061.500247, inp * (1 + P["eps"]) / rU))
    reverts = []
    for name, i, a in (("originSwap 1200 USDC (onchain lower-halt)", 0, 1200 * rU), ("originSwap 500 EURC (onchain upper-halt)", 1, 500 * rE)):
        try:
            o = trade_closed(xU, xE, i, a, P); nx, ny = (xU + a, xE + o) if i == 0 else (xU + o, xE + a)
            enforce_halts(xU, xE, nx, ny, P); reverts.append((name, "NO REVERT"))
        except Revert as e: reverts.append((name, f"revert: {e}"))
    try: trade_iter_dfx(xU, xE, 1, 1000 * rE, P); reverts.append(("originSwap 1000 EURC (onchain convergence-failed)", "dfx loop converged?!"))
    except Revert as e: reverts.append(("originSwap 1000 EURC (onchain convergence-failed)", f"dfx loop: {e}"))
    return rows, reverts

if __name__ == "__main__":
    print("0 on-chain DFX EURC/USDC vectors (raw token units, 6 decimals):")
    rows, reverts = t0_onchain_dfx_vectors()
    for name, oc, py in rows: print(f"    {name:38s} onchain {oc:12.6f}  python {py:12.6f}  diff {py-oc:+.1e}")
    for name, r in reverts: print(f"    {name:48s} -> {r}")
    random.seed(5)
    for P in [DEF, dict(DEF, delta=3.0, maxf=0.25), dict(DEF, beta=0.0, alpha=0.9)]:
        print(f"\n=== params {P}")
        w, wa, n, pieces = t1_closed_vs_iter(P)
        print(f"1 closed vs DFX iteration: worst |diff|/|a| {w:.2e}, |diff|/book {wa:.2e} over {n} trades; pieces hit: {pieces}")
        wb, case = t1b_closed_vs_decimal(P)
        print(f"1b closed vs Decimal bisection (40 digits): worst |diff|/book {wb:.2e}" + (f"  case {case}" if wb > 1e-12 else ""))
        w, cf = t1c_closed_vs_dfx_verbatim(P); print(f"1c DFX verbatim loop vs closed: worst |diff| {w:.2e} numeraire units, convergence failures {cf}")
        print("2 invariants:", t2_invariants(P))
        w, r = t3_inverse(P); print(f"3 exactIn/exactOut inverse worst rel err {w:.2e}, reverts {r}")
    P = DEF
    print("\n4 continuity/monotone:"); [print("   ", a, "->", b) for a, b in t4_continuity(P)]
    print("5 edges:"); [print(f"    {a:32s} -> {b}") for a, b in t5_edges(P)]
    print("6 oracle too high by err, attacker best profit / book (share of U taken):")
    for name, row in t6_oracle_error(P):
        print(f"    {name:9s}" + "".join(f"  {e:.2%}: {pr*100:.4f}% ({sh:.0%})" for e, pr, sh in row))
    print("7 effective premium buying x% of BRL, balanced book, by (beta, delta):")
    print("      x:        1%      5%     10%     20%     30%     40%     49%")
    for beta, delta, row in t7_impact_table(P):
        print(f"    b={beta:<4} d={delta:<4}" + "".join(f"  {v*100:6.3f}%" if v == v else "    halt" for v in row))
