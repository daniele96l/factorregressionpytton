import { GUIDELINE, REGION_CONFIG, REPLICATION_CAVEATS } from "./replicationConfig";

export function buildMethodologyMarkdown(region = "eur", meta = {}) {
  const cfg = REGION_CONFIG[region] ?? REGION_CONFIG.eur;
  const portfolioStart = meta.portfolioStart ?? "—";
  const inceptionCash = meta.inceptionCash ?? "—";
  const volLb = cfg.volLookback ?? GUIDELINE.volLookback;

  return `# Replication methodology — formulas & process

Step-by-step recreation of the Solactive Defensive Put Write index (guideline v1.2).

**Region:** ${cfg.name} (${cfg.indexIsin})

---

## 1. Portfolio & published index level

The index is a cash-and-options portfolio. Each business day the **index portfolio (IP)** is:

\`\`\`
IP_t = Cash_t + Σᵢ Unitsᵢ,ₜ · Markᵢ,ₜ

IndexLevel_t = 100 × IP_t / IP_inception

IP_inception = IP on first simulated day (portfolio start)
\`\`\`

- **Inception cash** = official opening level from parquet: \`${inceptionCash}\` on \`${portfolioStart}\`.
- **Unitsᵢ,ₜ** are negative (short puts). Premium received increases \`Cash\`; liability increases when marks rise.
- At most ~4 overlapping tranches (weekly rolls, ~28 calendar-day target maturity).

## 2. Guideline parameters (this implementation)

| Symbol | Value | Meaning |
|--------|-------|---------|
| Target strike | ${GUIDELINE.targetStrikePct * 100}% × UI | UI = prior-day opening settlement (SPXSET proxy) |
| Target maturity | ${GUIDELINE.targetMaturityCalendarDays} cal. days | Snapped to listed Friday on/after target |
| Allocation | ${GUIDELINE.allocation} | Short 25% of IP per leg (notional / underlying) |
| Strike tick | ${cfg.strikeInterval} | Nearest exchange strike interval |
| Near-expiry rule | ${GUIDELINE.nearExpiryMinCalendarDays} days | If near leg < 7d, roll 100% into far leg |
| Fee (pre/post amend.) | ${(GUIDELINE.feeRatePreAmend * 100).toFixed(2)}% / ${(GUIDELINE.feeRatePostAmend * 100).toFixed(2)}% | Annual on IP; switch ${GUIDELINE.amendmentDate} |
| IV bounds | ${(GUIDELINE.ivMin * 100).toFixed(1)}% – ${(GUIDELINE.ivMax * 100).toFixed(0)}% | Solactive BS fallback limits |
| Vol lookback | ${volLb} days | Realized underlying return vol (${region === "usd" ? "US" : "EUR"} config) |

## 3. Market data inputs

- **Underlying close** (\`${cfg.underlyingTicker}\`): daily close for marks & prior-day reference.
- **Opening settlement proxy**: Yahoo open when available, else prior close — stands in for SPXSET / EURO STOXX 50 opening settlement.
- **Risk-free**: FRED \`${cfg.fredId}\` (3-month), aligned to trading days.
- **Vol for rolls & marks**: ${volLb}-day realized vol of underlying daily returns (annualized √252). VIX/V2TX are not used.
- **Official benchmark**: raw index level for \`${cfg.indexIsin}\` from \`solactive.parquet\`.

## 4. Daily simulation loop (each trading day t)

Executed in this exact order for every business day on or after portfolio start:

1. **Expire options** — for each tranche with scheduled expiry ≤ t, remove from book and settle cash:

\`\`\`
Cash += Units · max(0, Strike − USI_t)

USI_t = opening settlement on expiry day (Yahoo open proxy)
\`\`\`

If the scheduled Friday is a holiday, settlement occurs on the *first trading day on or after* that Friday.

2. **Accrue cash & fees** (from t−1):

\`\`\`
Cash *= (1 + r_{t−1} / 365)          // risk-free on cash balance
Cash -= IP_{t−1} · feeRate / 365     // index fee on prior IP
\`\`\`

3. **Mark live puts** at underlying *close* (see §8).

4. **Friday roll** — if t is Friday and IP_{t−1} > 0:
   - Pick near/far expiries around 28-day target (§5).
   - Strike from prior-day opening settlement: K = round_to_tick(97% × USI_{t−1}).
   - Price new shorts at *today's open* (USI_t), not close.
   - Size with prior-day IP and close: Units = −0.25 × w × IP_{t−1} / UI_{t−1}.

5. **Update IP**: IP_t = Cash + option MTM; store normalized index 100 × IP_t / IP_inception.

## 5. Expiry date interpolation (near / far legs)

On each roll Friday, target expiry T* = Friday on or before (roll date + 28 calendar days).

\`\`\`
Listed Fridays F = {Fridays in (roll, T* + 28d]}

If exact match:        sell 100% into expiry = T*
Else let N = max Friday < T*, H = min Friday ≥ T*:

  w_far  = (τ(roll,T*) − τ(roll,N)) / (τ(roll,H) − τ(roll,N))
  w_near = (τ(roll,H) − τ(roll,T*)) / (τ(roll,H) − τ(roll,N))

  τ(a,b) = count of underlying trading days in (a, b]

If calendar days(roll, N) < 7:  w_near = 0, w_far = 1
\`\`\`

Scheduled expiry is snapped to the next date in our trading calendar (handles holiday Fridays).

## 6. Black–Scholes put (European, q = 0)

\`\`\`
τ_std = days / 252        // variance time
τ_cd  = days / 365        // discount time
F = S · exp((r − q) · τ_cd)

d₁ = [ln(F/K) + ½σ²τ_std] / (σ√τ_std)
d₂ = d₁ − σ√τ_std

Put_mid(S,K,σ) = e^{−r·τ_cd} · [K·N(−d₂) − F·N(−d₁)]

Vega = S · e^{−q·τ_cd} · N′(d₁) · √τ_std
\`\`\`

## 7. Bid–ask spread & roll premium (short at bid)

\`\`\`
ρ = max(ρ_min, ρ_scale · σ / σ_barrier)     // ρ_min=0.6, scale=0.6, barrier=16%

Spread = S · max(ε_floor, (ρ · Vega) / (100 · S))   // ε_floor = 0.025% of S

Premium_bid = Put_mid − Spread

On roll:  Cash -= Units · Premium_bid    (Units < 0 → cash inflow)

Skip leg if Premium_bid / S < premium floor (0).
\`\`\`

## 8. Implied vol at entry & daily marking

When a tranche is opened, solve σ_entry such that Put_mid(USI_roll, K, σ_entry) = Put_mid at roll.

Daily mark vol uses a **parallel index-vol surface shift** (BS fallback when no exchange quote):

\`\`\`
σ_mark = clamp( σ_entry + (σ_index,t − σ_index,entry),  IV_min, IV_max )

σ_index,t = σ_realized,t   (${volLb}-day underlying return vol, annualized)

σ_realized,t = std(r_{t−${volLb - 1}..t}) · √252

Mark_price = max( intrinsic,  Put_mid(S_close, K, σ_mark) + Spread_mark )
intrinsic  = max(0, K − S_close)

OptionMTM = Σᵢ Unitsᵢ · Mark_price,i
\`\`\`

Short puts are marked at the **ask** (mid + spread). Rolls are priced at **open**; marks use **close**.

## 9. Strike selection

\`\`\`
K_raw = 0.97 × USI_{t−1}                    // prior opening settlement
K = nearest listed strike to K_raw

US:   tick = 5 index points
Euro: tick = 50 index points
\`\`\`

## 10. Comparison vs official

\`\`\`
Overlap from effectiveStart = max(portfolioStart, first underlying quote)

Replicated_norm_t = 100 × Replicated_t / Replicated_{start}
Official_norm_t   = 100 × Official_t   / Official_{start}

Level drift_t = Replicated_norm_t / Official_norm_t − 1

Correlation, tracking error, Sharpe, max drawdown: on daily returns of normalized series
\`\`\`

## 11. Critical implementation fixes

- **Holiday expiries** — exact-date matching left “zombie” puts alive for years when expiry fell on a non-trading Friday; settlement now triggers on the first trading day ≥ expiry.
- **Open vs close on rolls** — pricing rolls at close overstated premium in bull markets; guideline uses opening settlement.
- **Spread units** — option cost formula divides by (100 × Spot) per guideline; omitting this zeroed out rolls.
- **US vol lookback** — 63-day realized vol (vs 21-day EUR) improved US level tracking vs official parquet.

## 12. Known approximations

${REPLICATION_CAVEATS.map((c) => `- ${c}`).join("\n")}

---

**Reference:** [Solactive US Equity Defensive Put Write — Guideline v1.2](https://www.solactive.com/downloads/Guideline_SPX_Put_v12.pdf)

Euro index parameters are inferred from the same rule set.

*Generated ${new Date().toISOString().slice(0, 10)} for ${cfg.indexIsin}.*
`;
}

export function methodologyMarkdownFilename(region, meta = {}) {
  const isin = meta.indexIsin ?? region;
  return `defensive-put-methodology-${region}-${isin}.md`;
}
