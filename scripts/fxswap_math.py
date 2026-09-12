"""
fxswap reference math, four cases, plus tests 1-7.

conventions
  p      oracle price, USDC per 1 BRL
  U      strategy USDC balance
  B      strategy BRL balance
  k      inventory sensitivity, 0 < k < 1
  t      target_ratio, fraction of book (at oracle) held in BRL
  B0     target BRL inventory = t * (U + p*B) / p
  P(B)   = p * (1 - k + k * (B0/B)^2)      marginal price of BRL in USDC

integral of P from Ba to Bb (Bb > Ba):
  I(Ba,Bb) = p * [ (1-k)*(Bb-Ba) + k*B0^2*(1/Ba - 1/Bb) ]

case A  taker gives Q USDC, gets dy BRL.   B1 -> B2 = B1 - dy,   Q = I(B2, B1)
case B  taker gives dx BRL, gets Q USDC.   B1 -> B2 = B1 + dx,   Q = I(B1, B2)
"""
from decimal import Decimal, getcontext
import math, random

getcontext().prec = 60
D = Decimal

# ---------------------------------------------------------------- reference (Decimal, direct form)

def target(U, B, p, t):
    return t * (U + p * B) / p

def integral(p, k, B0, Ba, Bb):
    return p * ((1 - k) * (Bb - Ba) + k * B0 * B0 * (1 / Ba - 1 / Bb))

def solve_B2_direct(p, k, B0, B1, Q, buy):
    """direct quadratic in B2. buy=True is case A (Q>0 consumes BRL), buy=False is case B."""
    s = Q if buy else -Q
    a = p * (1 - k)
    b = -p * (1 - k) * B1 + p * k * B0 * B0 / B1 + s
    c = -p * k * B0 * B0
    disc = b * b - 4 * a * c
    return (-b + disc.sqrt()) / (2 * a)

# ---------------------------------------------------------------- normalized (float, what solidity implements)

def solve_dy_frac(k, r, q):
    """case A exactIn. returns v = dy/B1 = 1-u, solving directly for v (no u-1 cancellation):
    (1-k)v^2 - [1-k + k r^2 + q]v + q = 0, small root.
    v = 2q / (S + sqrt(S^2 - 4(1-k)q)),  S = 1-k + k r^2 + q.  disc >= (1-k-q)^2 >= 0."""
    S = 1.0 - k + k * r * r + q
    disc = S * S - 4.0 * (1.0 - k) * q
    assert disc >= 0
    return 2.0 * q / (S + math.sqrt(disc))

def solve_dx_frac(k, r, q):
    """case B exactOut. returns w = dx/B1 = u-1, solving directly for w:
    (1-k)w^2 + [1-k + k r^2 - q]w - q = 0, positive root.
    S = 1-k + k r^2 - q. if S >= 0 use w = 2q/(S+sqrt(D)), else w = (-S+sqrt(D))/(2(1-k)). both stable."""
    A = 1.0 - k
    S = A + k * r * r - q
    disc = S * S + 4.0 * A * q
    root = math.sqrt(disc)
    if S >= 0:
        return 2.0 * q / (S + root)
    return (-S + root) / (2.0 * A)

def integral_f(p, k, B0, Ba, d):
    """integral of P from Ba to Ba+d. (1/Ba - 1/Bb) written as d/(Ba*Bb): no cancellation. same for solidity."""
    return p * d * ((1 - k) + k * B0 * B0 / (Ba * (Ba + d)))

def quote(p, k, t, U, B1, amount, brl_out, exact_in, B0=None):
    """returns (amountIn, amountOut) with fee excluded.
    brl_out=True: tokenIn USDC, tokenOut BRL (case A). brl_out=False: case B.
    B0=None -> dynamic target from the book (doc proposal). B0 given -> fixed target (DODO)."""
    if B1 <= 0:
        raise ValueError("no BRL inventory")
    if k >= 1 or k <= 0:
        raise ValueError("k out of range")
    if B0 is None:
        B0 = t * (U + p * B1) / p
    r = B0 / B1
    if brl_out:
        if exact_in:                      # A / exactIn: given Q, quadratic
            Q = amount
            q = Q / (p * B1)
            dy = B1 * solve_dy_frac(k, r, q)
            return Q, dy
        else:                             # A / exactOut: given dy, integral
            dy = amount
            if dy >= B1:
                raise ValueError("drains BRL")
            Q = integral_f(p, k, B0, B1 - dy, dy)
            return Q, dy
    else:
        if exact_in:                      # B / exactIn: given dx, integral
            dx = amount
            Q = integral_f(p, k, B0, B1, dx)
            if Q > U:
                raise ValueError("drains USDC")
            return dx, Q
        else:                             # B / exactOut: given Q, quadratic with q<0
            Q = amount
            if Q > U:
                raise ValueError("drains USDC")
            q = Q / (p * B1)
            dx = B1 * solve_dx_frac(k, r, q)
            return dx, Q

# ---------------------------------------------------------------- tests

def rnd_state():
    p = 10 ** random.uniform(-2, 2)                 # 0.01 .. 100
    B1 = 10 ** random.uniform(2, 7)                 # 100 .. 10M BRL
    U = p * B1 * 10 ** random.uniform(-1.5, 1.5)    # book between 3% and 97% BRL
    k = 10 ** random.uniform(-4, math.log10(0.9))
    t = random.uniform(0.05, 0.95)
    return p, k, t, U, B1

def rel(a, b):
    return abs(a - b) / max(abs(b), 1e-30)

def test1_direct_vs_normalized(n=20000):
    worst = 0
    for _ in range(n):
        p, k, t, U, B1 = rnd_state()
        B0 = t * (U + p * B1) / p
        # A exactIn
        Q = p * B1 * 10 ** random.uniform(-6, 0)
        B2ref = solve_B2_direct(D(p), D(k), D(B0), D(B1), D(Q), True)
        _, dy = quote(p, k, t, U, B1, Q, True, True)
        worst = max(worst, rel(dy, float(D(B1) - B2ref)))
        # B exactOut
        Q = min(U, p * B1) * 10 ** random.uniform(-6, 0)
        B2ref = solve_B2_direct(D(p), D(k), D(B0), D(B1), D(Q), False)
        dx, _ = quote(p, k, t, U, B1, Q, False, False)
        worst = max(worst, rel(dx, float(B2ref - D(B1))))
    return worst

def test2_roundtrip(n=20000, dynamic=True):
    """buy dy with Q, then sell dy back. maker must not lose: Q_back <= Q."""
    fails = 0; worst = 0; drains = 0
    for _ in range(n):
        p, k, t, U, B1 = rnd_state()
        Q = p * B1 * 10 ** random.uniform(-6, 0)
        B0 = None if dynamic else t * (U + p * B1) / p
        _, dy = quote(p, k, t, U, B1, Q, True, True, B0)
        U2, B2 = U + Q, B1 - dy
        try:
            _, Qback = quote(p, k, t, U2, B2, dy, False, True, B0)
        except ValueError:
            drains += 1; fails += 1; continue
        gain = (Qback - Q) / Q
        worst = max(worst, gain)
        if Qback > Q * (1 + 1e-12): fails += 1
    return fails, drains, worst

def test3_inverse(n=20000):
    worst = 0
    for _ in range(n):
        p, k, t, U, B1 = rnd_state()
        Q = p * B1 * 10 ** random.uniform(-6, 0)
        _, dy = quote(p, k, t, U, B1, Q, True, True)
        Q2, _ = quote(p, k, t, U, B1, dy, True, False)
        worst = max(worst, rel(Q2, Q))
        dx = B1 * 10 ** random.uniform(-6, 1)
        try: _, Qb = quote(p, k, t, U, B1, dx, False, True)
        except ValueError: continue
        dx2, _ = quote(p, k, t, U, B1, Qb, False, False)
        worst = max(worst, rel(dx2, dx))
    return worst

def test4_monotone_and_split(n=5000, dynamic=True):
    """more Q -> more dy; effective price worse than marginal; splitting never beats one swap."""
    mono_f = split_f = 0; worst_split = 0
    for _ in range(n):
        p, k, t, U, B1 = rnd_state()
        Q = p * B1 * 10 ** random.uniform(-3, 0)
        B0 = None if dynamic else t * (U + p * B1) / p
        _, dy1 = quote(p, k, t, U, B1, Q, True, True, B0)
        _, dy2 = quote(p, k, t, U, B1, Q * 1.01, True, True, B0)
        B0v = t * (U + p * B1) / p
        P_marg = p * (1 - k + k * (B0v / B1) ** 2)
        if not (dy2 > dy1 and Q / dy1 >= P_marg * (1 - 1e-12)): mono_f += 1
        m = random.randint(2, 20)
        Uc, Bc, tot = U, B1, 0
        for _ in range(m):
            _, d = quote(p, k, t, Uc, Bc, Q / m, True, True, B0)
            Uc += Q / m; Bc -= d; tot += d
        g = (tot - dy1) / dy1
        worst_split = max(worst_split, g)
        if tot > dy1 * (1 + 1e-12): split_f += 1
    return mono_f, split_f, worst_split

def test5_arb_convergence(n=2000):
    """oracle fixed at p, external market at p. arbitrageur trades until marginal price = p.
    with target recomputed per swap the fixed point is B = t*(U+pB)/p. check it converges."""
    worst_iters = 0; fails = 0
    for _ in range(n):
        p, k, t, U, B = rnd_state()
        B *= 10 ** random.uniform(-1, 1)   # start off target
        for it in range(1, 60):
            B0 = t * (U + p * B) / p
            if abs(B / B0 - 1) < 1e-9: break
            if B > B0:   # too much BRL, quoted cheap, arb buys BRL until B = B0
                dy = B - B0
                Q, _ = quote(p, k, t, U, B, dy, True, False)
                U += Q; B -= dy
            else:
                dx = B0 - B
                try: _, Q = quote(p, k, t, U, B, dx, False, True)
                except ValueError: break
                U -= Q; B += dx
        worst_iters = max(worst_iters, it)
        if abs(B / B0 - 1) > 1e-6: fails += 1
    return fails, worst_iters

def test6_edges():
    out = []
    for name, fn in [
        ("k=1",        lambda: quote(5, 1.0, 0.3, 1e6, 1e5, 100, True, True)),
        ("k=0",        lambda: quote(5, 0.0, 0.3, 1e6, 1e5, 100, True, True)),
        ("B1=0",       lambda: quote(5, 0.1, 0.3, 1e6, 0, 100, True, True)),
        ("dy>=B1",     lambda: quote(5, 0.1, 0.3, 1e6, 1e5, 1e5, True, False)),
        ("Q>U sell",   lambda: quote(5, 0.1, 0.3, 1e3, 1e5, 1e5, False, True)),
    ]:
        try: fn(); out.append((name, "no revert"))
        except (ValueError, ZeroDivisionError, AssertionError) as e: out.append((name, f"revert: {e}"))
    # huge Q: u -> 0, dy -> B1 but never reaches it
    _, dy = quote(5, 0.1, 0.3, 1e6, 1e5, 1e12, True, True)
    out.append(("Q huge", f"dy/B1 = {dy/1e5:.6f}"))
    # tiny r (target far below inventory) and huge r
    _, dy = quote(5, 0.1, 0.001, 1e6, 1e5, 1e4, True, True); out.append(("t=0.001", f"dy={dy:.4f}"))
    _, dy = quote(5, 0.1, 0.999, 1e2, 1e5, 1e4, True, True); out.append(("t=0.999", f"dy={dy:.4f}"))
    return out

def test7_oracle_manipulation():
    """real price 5.00. attacker feeds a wrong oracle, trades 100k USDC (or equivalent), unwinds at 5.00."""
    p_real = 5.0; k = 0.05; t = 0.5
    U, B1 = 1e6, 2e5   # balanced at 5.00, book 2M
    rows = []
    for p_fake in [2.5, 4.0, 4.75, 5.0, 5.25, 6.0, 7.5]:
        # buy BRL with 100k USDC at fake price, sell at real
        _, dy = quote(p_fake, k, t, U, B1, 1e5, True, True)
        prof_buy = dy * p_real - 1e5
        # sell 20k BRL (=100k USDC) at fake price, rebuy at real
        _, Q = quote(p_fake, k, t, U, B1, 2e4, False, True)
        prof_sell = Q - 2e4 * p_real
        rows.append((p_fake, prof_buy, prof_sell))
    return rows

if __name__ == "__main__":
    random.seed(7)
    print("1 direct vs normalized, worst rel err:", f"{test1_direct_vs_normalized():.2e}")
    for dyn in (True, False):
        f, d, w = test2_roundtrip(dynamic=dyn)
        print(f"2 roundtrip target={'dynamic' if dyn else 'fixed  '}: fails {f:5d}/20000  drains {d}  worst taker gain {w:+.2e}")
    print("3 exactIn/exactOut inverse, worst rel err:", f"{test3_inverse():.2e}")
    for dyn in (True, False):
        mf, sf, ws = test4_monotone_and_split(dynamic=dyn)
        print(f"4 target={'dynamic' if dyn else 'fixed  '}: monotone fails {mf} | split beats single {sf}/5000 worst gain {ws:+.2e}")
    f, it = test5_arb_convergence()
    print("5 arb convergence (dynamic target) fails", f, "max iters", it)
    print("6 edges:"); [print("   ", a, "->", b) for a, b in test6_edges()]
    print("7 oracle manipulation, book 2M balanced, k=0.05, t=0.5, 100k notional:")
    print("    oracle   buy-side profit   sell-side profit")
    for pf, pb, ps in test7_oracle_manipulation():
        print(f"    {pf:5.2f}   {pb:+14,.0f}   {ps:+14,.0f}")
