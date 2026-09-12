#!/usr/bin/env python3
"""
Integer WAD fixture for test/ForexCurveVectors.t.sol, built from Tomás's forex curve vectors.

run (any cwd): python3 packages/contracts/test/fixtures/gen_fxforex_wad.py
  in:  scripts/fixtures/fxforex_vectors.json   (reference scripts/fxforex_math.py, floats as decimal strings)
  out: packages/contracts/test/fixtures/fxforex-vectors-wad.json

Every vector gets:
  - its inputs as integer WAD strings (decimal string x 1e18, nearest); params the same way
  - `revert` / `amountIn` / `amountOut`: the reference's float result (reverts mapped to ForexCurve error names)
  - `hpRevert` / `hpAmountIn` / `hpAmountOut`: the same quote re-solved in 100-digit Decimal from the integer inputs
    (bisection on the fixed-point residual, no quadratics), taker receives floor(exact), taker pays ceil(exact).
    The Solidity port must sit within a few wei of it, on the maker's side.
  - `absTol`: "0" for the reference's own vectors (the test applies its relative tolerance), otherwise an absolute
    tolerance in library units (used by the live DFX EURC/USDC quotes, which are 6-decimal on-chain outputs).

Notes on the mapping:
  - the reference accepts negative balances and amounts (and reverts "empty side"); the library takes unsigned values,
    so a negative U, B or amount is written as 0, which still reverts EmptySide first.
  - the live DFX entry (first vector of the source file) is expanded like fxforex_math.t0_onchain_dfx_vectors: USDC is the
    quote token with balance U = raw USDC x rate(USDC), EURC is the local token with p = rate(EURC), so y = p x raw EURC
    is DFX's numeraire EURC balance. Outputs in USDC come back from the library in numeraire and are compared as
    on-chain raw x rate(USDC).
"""
import json
import os
import sys
from decimal import ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_EVEN, Decimal as D, getcontext

getcontext().prec = 100

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
SRC = os.path.join(REPO, "scripts", "fixtures", "fxforex_vectors.json")
OUT = os.path.join(HERE, "fxforex-vectors-wad.json")
sys.path.insert(0, os.path.join(REPO, "scripts"))
import fxforex_math as ref  # noqa: E402  (float reference, used for the one DFX quote without an on-chain value)

W = D(10) ** 18
ERR = {
    "empty side": "EmptySide",
    "negative amount": "EmptySide",
    "drain": "Drain",
    "no consistent piece": "NoConsistentPiece",
    "upper halt": "UpperHalt",
    "lower halt": "LowerHalt",
    "swap invariant": "SwapInvariant",
}
MAX_DIFF = -D(0x10C6F7A0B5EE) / D(2) ** 64
PARAM_KEYS = (("alpha", "alpha"), ("beta", "beta"), ("delta", "delta"), ("maxFee", "maxf"), ("lambda", "lam"), ("epsilon", "eps"))


def wad(v):
    """decimal string / float -> integer WAD (nearest); negatives -> 0"""
    q = (D(str(v)) * W).to_integral_value(ROUND_HALF_EVEN)
    return max(int(q), 0)


# ───────────────────────────── 100-digit reference (independent of the quadratic solver) ─────────────────────────────
class HPRevert(Exception):
    pass


def psi(x, y, P):
    I = (x + y) / 2
    tot = D(0)
    for b in (x, y):
        m = I * (1 - P["beta"]) - b if b < I else b - I * (1 + P["beta"])
        if m > 0:
            tot += min(m * P["delta"] / I, P["maxf"]) * m
    return tot


def trade(x, y, i, a, P):
    """o = signed change of the other asset. R(s) = s - c(psi(s) - omega) is increasing: bisect it."""
    g = x + y
    omega = psi(x, y, P)
    known = (x if i == 0 else y) + a
    other0 = (y if i == 0 else x) - a
    fail = "drain" if abs(a) >= g else "no consistent piece"
    if known <= 0:
        raise HPRevert("drain")

    def R(s):
        o = other0 + s
        nx, ny = (known, o) if i == 0 else (o, known)
        d = psi(nx, ny, P) - omega
        return s - (d if d > 0 else P["lam"] * d)

    lo = max(-g, -other0)
    if R(lo + g * D("1e-60")) >= 0:
        raise HPRevert(fail)
    hi = max(g, abs(a))
    while R(hi) <= 0:
        hi *= 2
    for _ in range(300):
        mid = (lo + hi) / 2
        if R(mid) > 0:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2 - a


def halts(x, y, nx, ny, P):
    oI, nI = (x + y) / 2, (nx + ny) / 2
    al = P["alpha"]
    for ob, nb in ((x, nx), (y, ny)):
        if nb > nI:
            nH = nI * (1 + al)
            if nb > nH:
                oH = oI * (1 + al)
                if ob < oH or nb - nH > ob - oH:
                    raise HPRevert("upper halt")
        else:
            nH = nI * (1 - al)
            if nb < nH:
                oH = oI * (1 - al)
                if ob > oH or nH - nb > oH - ob:
                    raise HPRevert("lower halt")


def hp_quote(P, p, U, B, amount, brl_out, exact_in, conf):
    if U <= 0 or B <= 0:
        raise HPRevert("empty side")
    if amount == 0:
        return D(0), D(0)
    x, y = U, p * B
    eps = P["eps"] + conf / p

    def run(i, a):
        o = trade(x, y, i, a, P)
        nx, ny = (x + a, y + o) if i == 0 else (x + o, y + a)
        if nx <= 0 or ny <= 0:
            raise HPRevert("drain")
        halts(x, y, nx, ny, P)
        diff = (nx + ny - psi(nx, ny, P)) - (x + y - psi(x, y, P))
        if not (0 < diff or diff >= MAX_DIFF):
            raise HPRevert("swap invariant")
        return o

    if brl_out:
        if exact_in:
            return amount, -run(0, amount) * (1 - eps) / p
        return run(1, -p * amount) * (1 + eps), amount
    if exact_in:
        return amount, -run(1, p * amount) * (1 - eps)
    return run(0, -amount) * (1 + eps) / p, amount


# ───────────────────────────── fixture rows ─────────────────────────────
def row(name, set_name, Pf, p, U, B, conf, amount, local_out, exact_in, revert, amount_in, amount_out, abs_tol=0):
    """Pf: float params; p, U, B, conf, amount: decimal strings or Decimals; amount_in/out: decimal strings or None"""
    ints = dict(p=wad(p), U=wad(U), B=wad(B), conf=wad(conf), amount=wad(amount))
    Pw = {k: wad(Pf[src]) for k, src in PARAM_KEYS}
    Pd = {src: D(Pw[k]) / W for k, src in PARAM_KEYS}
    hp_revert = ""
    hp_in = hp_out = 0
    try:
        ai, ao = hp_quote(Pd, D(ints["p"]) / W, D(ints["U"]) / W, D(ints["B"]) / W, D(ints["amount"]) / W, local_out, exact_in,
                          D(ints["conf"]) / W)
        if exact_in:
            hp_in, hp_out = ints["amount"], max(int((ao * W).to_integral_value(ROUND_FLOOR)), 0)
        else:
            hp_in, hp_out = max(int((ai * W).to_integral_value(ROUND_CEILING)), 0), ints["amount"]
    except HPRevert as e:
        hp_revert = ERR[str(e)]
    r = dict(
        name=name, set=set_name,
        alpha=str(Pw["alpha"]), beta=str(Pw["beta"]), delta=str(Pw["delta"]), maxFee=str(Pw["maxFee"]),
        lambda_=str(Pw["lambda"]), epsilon=str(Pw["epsilon"]),
        p=str(ints["p"]), quoteBalance=str(ints["U"]), localBalance=str(ints["B"]), conf=str(ints["conf"]),
        amount=str(ints["amount"]), localOut=local_out, exactIn=exact_in,
        revert=revert, amountIn=str(wad(amount_in) if amount_in is not None else 0),
        amountOut=str(wad(amount_out) if amount_out is not None else 0),
        hpRevert=hp_revert, hpAmountIn=str(hp_in), hpAmountOut=str(hp_out), absTol=str(abs_tol),
    )
    r["lambda"] = r.pop("lambda_")
    return r


def dfx_rows(v):
    Pf = v["params"]
    rE, rU = D(str(v["rates"]["EURC"])), D(str(v["rates"]["USDC"]))
    rawE, rawU = D(v["raw"]["EURC"]), D(v["raw"]["USDC"])
    U = rawU * rU  # numeraire USDC balance
    tol_eurc = 2 * wad("0.000001")  # 2e-6 EURC (the float reference itself is 1.7e-6 off the live pool)
    tol_usdc = wad(D("0.000002") * rU)
    rows = []
    for usdc, out in v["originSwap_USDC_to_EURC"].items():
        rows.append(row(f"onchain_dfx_originSwap_{usdc}_USDC_to_EURC", "onchain_dfx", Pf, rE, U, rawE, 0, D(usdc) * rU, True, True,
                        "", D(usdc) * rU, D(out), tol_eurc))
    for eurc, out in v["originSwap_EURC_to_USDC"].items():
        rows.append(row(f"onchain_dfx_originSwap_{eurc}_EURC_to_USDC", "onchain_dfx", Pf, rE, U, rawE, 0, D(eurc), False, True,
                        "", D(eurc), D(out) * rU, tol_usdc))
    rows.append(row("onchain_dfx_targetSwap_want_900_EURC", "onchain_dfx", Pf, rE, U, rawE, 0, D(900), True, False,
                    "", D(v["targetSwap_want_900_EURC_usdc_in"]) * rU, D(900), tol_usdc))
    # the live pool reverts with a halt on both; the reference names the balance that breaches first (quote, then local)
    rows.append(row("onchain_dfx_originSwap_1200_USDC_halt", "onchain_dfx", Pf, rE, U, rawE, 0, D(1200) * rU, True, True,
                    "UpperHalt", None, None))
    rows.append(row("onchain_dfx_originSwap_500_EURC_halt", "onchain_dfx", Pf, rE, U, rawE, 0, D(500), False, True,
                    "LowerHalt", None, None))
    # DFX's 32-step loop fails to converge on 1000 EURC (on-chain revert); the closed form quotes it
    try:
        _, out = ref.quote(float(rE), float(U), float(rawE), 1000.0, False, True, Pf)
        rows.append(row("onchain_dfx_originSwap_1000_EURC_closed_form", "onchain_dfx", Pf, rE, U, rawE, 0, D(1000), False, True,
                        "", D(1000), repr(out)))
    except ref.Revert as e:
        rows.append(row("onchain_dfx_originSwap_1000_EURC_closed_form", "onchain_dfx", Pf, rE, U, rawE, 0, D(1000), False, True,
                        ERR[str(e)], None, None))
    return rows


def main():
    src = json.load(open(SRC))["vectors"]
    rows = []
    for v in src:
        if v["name"].startswith("onchain_dfx"):
            rows += dfx_rows(v)
            continue
        set_name = v["name"].rsplit("_", 1)[0] if v["name"][-1].isdigit() else "edge"
        rev = ERR[v["revert"]] if "revert" in v else ""
        rows.append(row(v["name"], set_name, v["params"], v["p"], v["U"], v["B"], v["conf"], v["amount"], v["brl_out"],
                        v["exact_in"], rev, v.get("amountIn"), v.get("amountOut")))

    # report: reference float vs 100-digit, per set
    stats = {}
    for r in rows:
        s = stats.setdefault(r["set"], dict(n=0, reverts=0, revert_mismatch=[], worst=0.0))
        s["n"] += 1
        if r["revert"] or r["hpRevert"]:
            s["reverts"] += 1
            if r["revert"] != r["hpRevert"]:
                s["revert_mismatch"].append((r["name"], r["revert"], r["hpRevert"]))
            continue
        field = "amountOut" if r["exactIn"] else "amountIn"
        ref_v, hp_v = int(r[field]), int(r["hp" + field[0].upper() + field[1:]])
        if r["absTol"] == "0" and hp_v:
            s["worst"] = max(s["worst"], abs(ref_v - hp_v) / hp_v)
    for k, s in stats.items():
        print(f"{k:14s} {s['n']:4d} vectors, {s['reverts']:3d} reverts, float-vs-100digit worst rel {s['worst']:.2e}, "
              f"revert mismatches {s['revert_mismatch']}")

    json.dump(dict(source="scripts/fixtures/fxforex_vectors.json", reference="scripts/fxforex_math.py",
                   generator="packages/contracts/test/fixtures/gen_fxforex_wad.py", count=len(rows), vectors=rows),
              open(OUT, "w"), indent=1)
    print(f"{len(rows)} rows -> {os.path.relpath(OUT, REPO)}")


if __name__ == "__main__":
    main()
