import { GUIDELINE, REGION_CONFIG, REPLICATION_CAVEATS } from "./replicationConfig";

function Formula({ children }) {
  return (
    <pre className="my-2 overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 font-mono text-xs leading-relaxed text-slate-200">
      {children}
    </pre>
  );
}

function H3({ children }) {
  return <h3 className="mt-6 mb-2 text-sm font-semibold uppercase tracking-wide text-indigo-300">{children}</h3>;
}

export default function ReplicationMethodologyDoc({ region = "eur", meta }) {
  const cfg = REGION_CONFIG[region] ?? REGION_CONFIG.eur;
  const portfolioStart = meta?.portfolioStart ?? "—";
  const inceptionCash = meta?.inceptionCash ?? "—";

  return (
    <section className="mt-10 rounded-2xl border border-slate-800 bg-slate-900/40 p-6 text-sm text-slate-300">
      <h2 className="mb-1 text-xl font-bold text-white">Replication methodology — formulas &amp; process</h2>
      <p className="mb-4 text-slate-400">
        Step-by-step recreation of the Solactive Defensive Put Write index (guideline v1.2). Current region:{" "}
        <span className="text-slate-200">{cfg.name}</span> ({cfg.indexIsin}).
      </p>

      <H3>1. Portfolio &amp; published index level</H3>
      <p>
        The index is a cash-and-options portfolio. Each business day the <strong>index portfolio (IP)</strong> is:
      </p>
      <Formula>{`IP_t = Cash_t + Σᵢ  Unitsᵢ,ₜ · Markᵢ,ₜ

IndexLevel_t = 100 × IP_t / IP_inception

IP_inception = IP on first simulated day (portfolio start)`}</Formula>
      <ul className="ml-4 list-disc space-y-1 text-slate-400">
        <li>
          <strong className="text-slate-300">Inception cash</strong> = official opening level from parquet:{" "}
          <code className="text-cyan-300">{inceptionCash}</code> on{" "}
          <code className="text-cyan-300">{portfolioStart}</code>.
        </li>
        <li>
          <strong className="text-slate-300">Unitsᵢ,ₜ</strong> are negative (short puts). Premium received increases{" "}
          <code>Cash</code>; liability increases when marks rise.
        </li>
        <li>At most ~4 overlapping tranches (weekly rolls, ~28 calendar-day target maturity).</li>
      </ul>

      <H3>2. Guideline parameters (this implementation)</H3>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-slate-700 text-slate-400">
              <th className="py-2 pr-4">Symbol</th>
              <th className="py-2 pr-4">Value</th>
              <th className="py-2">Meaning</th>
            </tr>
          </thead>
          <tbody className="font-mono text-slate-200">
            <tr className="border-b border-slate-800">
              <td className="py-1.5 pr-4">Target strike</td>
              <td className="py-1.5 pr-4">{GUIDELINE.targetStrikePct * 100}% × UI</td>
              <td className="py-1.5 font-sans text-slate-400">UI = prior-day opening settlement (SPXSET proxy)</td>
            </tr>
            <tr className="border-b border-slate-800">
              <td className="py-1.5 pr-4">Target maturity</td>
              <td className="py-1.5 pr-4">{GUIDELINE.targetMaturityCalendarDays} cal. days</td>
              <td className="py-1.5 font-sans text-slate-400">Snapped to listed Friday on/after target</td>
            </tr>
            <tr className="border-b border-slate-800">
              <td className="py-1.5 pr-4">Allocation</td>
              <td className="py-1.5 pr-4">{GUIDELINE.allocation}</td>
              <td className="py-1.5 font-sans text-slate-400">Short 25% of IP per leg (notional / underlying)</td>
            </tr>
            <tr className="border-b border-slate-800">
              <td className="py-1.5 pr-4">Strike tick</td>
              <td className="py-1.5 pr-4">{cfg.strikeInterval}</td>
              <td className="py-1.5 font-sans text-slate-400">Nearest exchange strike interval</td>
            </tr>
            <tr className="border-b border-slate-800">
              <td className="py-1.5 pr-4">Near-expiry rule</td>
              <td className="py-1.5 pr-4">{GUIDELINE.nearExpiryMinCalendarDays} days</td>
              <td className="py-1.5 font-sans text-slate-400">If near leg &lt; 7d, roll 100% into far leg</td>
            </tr>
            <tr className="border-b border-slate-800">
              <td className="py-1.5 pr-4">Fee (pre/post amend.)</td>
              <td className="py-1.5 pr-4">
                {(GUIDELINE.feeRatePreAmend * 100).toFixed(2)}% / {(GUIDELINE.feeRatePostAmend * 100).toFixed(2)}%
              </td>
              <td className="py-1.5 font-sans text-slate-400">Annual on IP; switch {GUIDELINE.amendmentDate}</td>
            </tr>
            <tr className="border-b border-slate-800">
              <td className="py-1.5 pr-4">IV bounds</td>
              <td className="py-1.5 pr-4">
                {(GUIDELINE.ivMin * 100).toFixed(1)}% – {(GUIDELINE.ivMax * 100).toFixed(0)}%
              </td>
              <td className="py-1.5 font-sans text-slate-400">Solactive BS fallback limits</td>
            </tr>
          </tbody>
        </table>
      </div>

      <H3>3. Market data inputs</H3>
      <ul className="ml-4 list-disc space-y-1">
        <li>
          <strong className="text-slate-200">Underlying close</strong> ({cfg.underlyingTicker}): daily close for marks &amp;
          prior-day reference.
        </li>
        <li>
          <strong className="text-slate-200">Opening settlement proxy</strong>: Yahoo open when available, else prior close
          — stands in for SPXSET / EURO STOXX 50 opening settlement.
        </li>
        <li>
          <strong className="text-slate-200">Risk-free</strong>: FRED {cfg.fredId} (3-month), aligned to trading days.
        </li>
        <li>
          <strong className="text-slate-200">Vol for rolls &amp; marks</strong>: {cfg.volLookback}-day realized vol of
          underlying daily returns (annualized √252). VIX/V2TX are not used — realized vol aligns US replication with
          the Euro fallback and official BS premium levels more closely than index implied vol.
        </li>
        <li>
          <strong className="text-slate-200">Official benchmark</strong>: raw index level for {cfg.indexIsin} from{" "}
          <code>solactive.parquet</code>.
        </li>
      </ul>

      <H3>4. Daily simulation loop (each trading day t)</H3>
      <p>Executed in this exact order for every business day on or after portfolio start:</p>
      <ol className="ml-4 list-decimal space-y-2 text-slate-300">
        <li>
          <strong>Expire options</strong> — for each tranche with scheduled expiry ≤ t, remove from book and settle cash:
          <Formula>{`Cash += Units · max(0, Strike − USI_t)

USI_t = opening settlement on expiry day (Yahoo open proxy)`}</Formula>
          If the scheduled Friday is a holiday (no print in our calendar), settlement occurs on the{" "}
          <em>first trading day on or after</em> that Friday.
        </li>
        <li>
          <strong>Accrue cash &amp; fees</strong> (from t−1):
          <Formula>{`Cash *= (1 + r_{t−1} / 365)          // risk-free on cash balance
Cash -= IP_{t−1} · feeRate / 365     // index fee on prior IP`}</Formula>
        </li>
        <li>
          <strong>Mark live puts</strong> at underlying <em>close</em> (see §6).
        </li>
        <li>
          <strong>Friday roll</strong> — if t is Friday and IP_{`{t−1}`} &gt; 0:
          <ul className="ml-4 mt-1 list-disc text-slate-400">
            <li>Pick near/far expiries around 28-day target (§5).</li>
            <li>Strike from prior-day opening settlement: K = round_to_tick(97% × USI_{`{t−1}`}).</li>
            <li>Price new shorts at <em>today&apos;s open</em> (USI_t), not close.</li>
            <li>Size with prior-day IP and close: Units = −0.25 × w × IP_{`{t−1}`} / UI_{`{t−1}`}.</li>
          </ul>
        </li>
        <li>
          <strong>Update IP</strong>: IP_t = Cash + option MTM; store normalized index 100 × IP_t / IP_inception.
        </li>
      </ol>

      <H3>5. Expiry date interpolation (near / far legs)</H3>
      <p>On each roll Friday, target expiry T* = Friday on or before (roll date + 28 calendar days).</p>
      <Formula>{`Listed Fridays F = {Fridays in (roll, T* + 28d]}

If exact match:        sell 100% into expiry = T*
Else let N = max Friday < T*, H = min Friday ≥ T*:

  w_far  = (τ(roll,T*) − τ(roll,N)) / (τ(roll,H) − τ(roll,N))
  w_near = (τ(roll,H) − τ(roll,T*)) / (τ(roll,H) − τ(roll,N))

  τ(a,b) = count of underlying trading days in (a, b]

If calendar days(roll, N) < 7:  w_near = 0, w_far = 1`}</Formula>
      <p className="text-slate-400">
        Scheduled expiry is snapped to the next date in our trading calendar (handles holiday Fridays).
      </p>

      <H3>6. Black–Scholes put (European, q = 0)</H3>
      <Formula>{`τ_std = days / 252        // variance time
τ_cd  = days / 365        // discount time
F = S · exp((r − q) · τ_cd)

d₁ = [ln(F/K) + ½σ²τ_std] / (σ√τ_std)
d₂ = d₁ − σ√τ_std

Put_mid(S,K,σ) = e^{−r·τ_cd} · [K·N(−d₂) − F·N(−d₁)]

Vega = S · e^{−q·τ_cd} · N′(d₁) · √τ_std`}</Formula>

      <H3>7. Bid–ask spread &amp; roll premium (short at bid)</H3>
      <Formula>{`ρ = max(ρ_min, ρ_scale · σ / σ_barrier)     // ρ_min=0.6, scale=0.6, barrier=16%

Spread = S · max(ε_floor, (ρ · Vega) / (100 · S))   // ε_floor = 0.025% of S

Premium_bid = Put_mid − Spread

On roll:  Cash -= Units · Premium_bid    (Units < 0 → cash inflow)

Skip leg if Premium_bid / S < premium floor (0).`}</Formula>

      <H3>8. Implied vol at entry &amp; daily marking</H3>
      <p>When a tranche is opened, solve σ_entry such that Put_mid(USI_roll, K, σ_entry) = Put_mid at roll.</p>
      <p>Daily mark vol uses a <strong>parallel index-vol surface shift</strong> (BS fallback when no exchange quote):</p>
      <Formula>{`σ_mark = clamp( σ_entry + (σ_index,t − σ_index,entry),  IV_min, IV_max )

σ_index,t = σ_realized,t   ({cfg.volLookback}-day underlying return vol, annualized)

σ_realized,t = std(r_{t−{cfg.volLookback - 1}..t}) · √252

Mark_price = max( intrinsic,  Put_mid(S_close, K, σ_mark) + Spread_mark )
intrinsic  = max(0, K − S_close)

OptionMTM = Σᵢ Unitsᵢ · Mark_price,i`}</Formula>
      <p className="text-slate-400">
        Short puts are marked at the <strong>ask</strong> (mid + spread), conservative when CBOE/Eurex settlement
        prices are unavailable. Rolls are priced at <strong>open</strong>; marks use <strong>close</strong>.
      </p>

      <H3>9. Strike selection</H3>
      <Formula>{`K_raw = 0.97 × USI_{t−1}                    // prior opening settlement
K = nearest listed strike to K_raw

US:   tick = 5 index points
Euro: tick = 50 index points`}</Formula>

      <H3>10. Comparison vs official (charts above)</H3>
      <Formula>{`Overlap from effectiveStart = max(portfolioStart, first underlying quote)

Replicated_norm_t = 100 × Replicated_t / Replicated_{start}
Official_norm_t   = 100 × Official_t   / Official_{start}

Level drift_t = Replicated_norm_t / Official_norm_t − 1

Correlation, tracking error, Sharpe, max drawdown: on daily returns of normalized series`}</Formula>

      <H3>11. Critical implementation fixes</H3>
      <ul className="ml-4 list-disc space-y-1 text-slate-400">
        <li>
          <strong className="text-slate-200">Holiday expiries</strong> — exact-date matching left “zombie” puts alive for
          years when expiry fell on a non-trading Friday; settlement now triggers on the first trading day ≥ expiry.
        </li>
        <li>
          <strong className="text-slate-200">Open vs close on rolls</strong> — pricing rolls at close overstated
          premium in bull markets; guideline uses opening settlement.
        </li>
        <li>
          <strong className="text-slate-200">Spread units</strong> — option cost formula divides by (100 × Spot) per
          guideline; omitting this zeroed out rolls.
        </li>
      </ul>

      <H3>12. Known approximations</H3>
      <ul className="ml-4 list-disc space-y-1 text-amber-400/90">
        {REPLICATION_CAVEATS.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>

      <p className="mt-4 text-slate-500">
        Reference:{" "}
        <a
          href="https://www.solactive.com/downloads/Guideline_SPX_Put_v12.pdf"
          target="_blank"
          rel="noreferrer"
          className="text-indigo-400 hover:underline"
        >
          Solactive US Equity Defensive Put Write — Guideline v1.2
        </a>
        . Euro index parameters are inferred from the same rule set.
      </p>
    </section>
  );
}
