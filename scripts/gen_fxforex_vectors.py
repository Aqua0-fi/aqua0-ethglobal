"""
emit test vectors for the forex opcode from the python reference (fxforex_math.py).
run: python3 scripts/gen_fxforex_vectors.py  -> scripts/fixtures/fxforex_vectors.json

each vector: params, oracle price p (quote per local), balances U (quote) B (local), trade (brl_out, exact_in, amount)
and the expected (amountIn, amountOut) or a revert reason. numbers are decimal strings; the solidity port should
match to its own rounding (1 wei in 1e18 fixed point, rounding against the taker).
"""
import json, random
from fxforex_math import quote, Revert, DEF

SETS = {
    "dfx_prod":     dict(alpha=0.5, beta=0.35, delta=0.5,  maxf=0.25, lam=1.0, eps=0.0015),
    "conservative": dict(alpha=0.5, beta=0.15, delta=0.5,  maxf=0.25, lam=0.3, eps=0.0030),
    "no_flat_zone": dict(alpha=0.9, beta=0.0,  delta=0.15, maxf=0.25, lam=0.3, eps=0.0),
    "cap_regime":   dict(alpha=0.5, beta=0.35, delta=3.0,  maxf=0.25, lam=0.3, eps=0.0),
}

def vec(name, P, p, U, B, brl_out, exact_in, amount, conf=0.0):
    v = dict(name=name, params=P, p=repr(p), U=repr(U), B=repr(B), conf=repr(conf), brl_out=brl_out, exact_in=exact_in, amount=repr(amount))
    try:
        a, b = quote(p, U, B, amount, brl_out, exact_in, P, conf=conf); v["amountIn"] = repr(a); v["amountOut"] = repr(b)
    except Revert as e: v["revert"] = str(e)
    return v

def main():
    random.seed(2026); out = []
    # 1. on-chain DFX EURC/USDC vectors (raw token units, see fxforex_math.t0_onchain_dfx_vectors)
    rE, rU = 1.159545, 0.99986417; xE, xU = 1627.848764 * rE, 1179.110189 * rU
    P = dict(alpha=0.5, beta=0.35, delta=0.5, maxf=0.25, lam=1.0, eps=0.0015)
    out.append(dict(name="onchain_dfx_eurc_usdc", note="numeraire balances; expected raw outputs from the live pool 0x8cd86fbC94BeBFD910CaaE7aE4CE374886132c48, 2026-09-12",
                    params=P, rates=dict(EURC=rE, USDC=rU), raw=dict(EURC="1627.848764", USDC="1179.110189"),
                    originSwap_USDC_to_EURC={100: "86.099665", 500: "430.498329", 800: "688.797328", 900: "774.852549", 950: "816.093130", 1000: "854.918284", 1100: "926.406593"},
                    originSwap_EURC_to_USDC={100: "115.796296"}, targetSwap_want_900_EURC_usdc_in="1061.500247",
                    reverts={"originSwap_1200_USDC": "halt", "originSwap_500_EURC": "halt"}))
    # 2. random states, all four directions, all param sets
    for sname, P in SETS.items():
        for k in range(60):
            p = 10 ** random.uniform(-3, 1); V = 10 ** random.uniform(3, 7)
            lo, hi = (1 - P["alpha"]) / 2, (1 + P["alpha"]) / 2
            sh = random.uniform(lo * 0.9, hi * 1.1)          # sometimes starts outside the halts on purpose
            U = V * (1 - sh); B = V * sh / p
            conf = p * random.choice([0.0, 0.0005, 0.003])
            for brl_out in (True, False):
                for exact_in in (True, False):
                    if brl_out and exact_in:  amount = U * 10 ** random.uniform(-4, 0)
                    elif brl_out:             amount = B * 10 ** random.uniform(-4, -0.1)
                    elif exact_in:            amount = B * 10 ** random.uniform(-4, 0)
                    else:                     amount = U * 10 ** random.uniform(-4, -0.1)
                    out.append(vec(f"{sname}_{k}", P, p, U, B, brl_out, exact_in, amount, conf))
    # 3. edges
    P = SETS["dfx_prod"]; p, U, B = 5.0, 1e6, 2e5
    for name, args in [("edge_amount_zero", (True, True, 0.0)), ("edge_buy_all_brl", (True, False, B)), ("edge_huge_in", (True, True, 1e12)),
                       ("edge_sell_10x", (False, True, 10 * B)), ("edge_exact_alpha_edge", (True, False, B * 0.5 * (1 - 1e-9))),
                       ("edge_past_alpha_edge", (True, False, B * 0.5 * (1 + 1e-9))), ("edge_dust_local_sell", (False, True, 1.0))]:
        UU, BB = (U, 1e-9) if "dust" in name else (U, B)
        out.append(vec(name, P, p, UU, BB, *args))
    json.dump(dict(reference="scripts/fxforex_math.py", generated="2026-09-12", vectors=out), open("fixtures/fxforex_vectors.json", "w"), indent=1)
    n_rev = sum(1 for v in out if "revert" in v)
    print(f"{len(out)} vectors written ({n_rev} expected reverts)")

if __name__ == "__main__":
    main()
