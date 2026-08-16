import type { Metadata } from 'next';
import Link from 'next/link';
import {
  CONFIDENCE_PENALTIES,
  CONFIDENCE_THRESHOLDS,
  LIQUIDITY_WEIGHTS,
  MODEL_REGISTRY,
  OPPORTUNITY_THRESHOLDS,
  OPPORTUNITY_WEIGHTS,
  PRESSURE_THRESHOLDS,
  PRESSURE_WEIGHTS,
  SCANNER_THRESHOLDS,
  WINDOWS,
} from '@/lib/analytics/config';
import {
  Card,
  CardBody,
  CardHeader,
  Notice,
  TableScroll,
  Td,
  Th,
} from '@/components/ui/primitives';

export const metadata: Metadata = {
  title: 'Methodology',
  description:
    'Every formula, weight and threshold used by Kadioko DSE Analyzer, published in full.',
};

/**
 * Methodology.
 *
 * This page renders directly from src/lib/analytics/config.ts — the same module
 * the analytics engine imports. It cannot drift from the running code, because
 * there is no second copy of the numbers: change a weight and this page changes
 * with it.
 */
export default function MethodologyPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-lg font-semibold tracking-tight text-ink-100">
          Methodology
        </h1>
        <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-ink-400">
          Every formula, weight and threshold this platform uses is published
          here. The tables below are rendered from the same configuration module
          the analytics engine imports, so they cannot drift from the running
          code.
        </p>
      </header>

      <Notice tone="neutral" title="The rule behind all of it">
        A value that cannot be computed is reported as unavailable, with the
        reason attached. It is never replaced by zero, by a neutral placeholder,
        or by a sentinel number. That single decision is why several figures on
        this site show an em dash instead of a number, and it is deliberate.
      </Notice>

      {/* -- Bid / offer ---------------------------------------------------- */}
      <Card>
        <CardHeader title="1 · Bid / offer ratio" />
        <CardBody className="space-y-4 text-[13px] leading-relaxed text-ink-300">
          <Formula>B/O = outstanding bid quantity ÷ outstanding offer quantity</Formula>

          <p>
            The DSE publishes the resting order book at the close: how many
            shares buyers still want, and how many sellers still have on the
            board. The ratio is undefined when there are no offers, and this
            platform reports that rather than substituting a large number.
          </p>

          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Order book</Th>
                  <Th>State</Th>
                  <Th>Ratio</Th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <Td>bid &gt; 0, offer &gt; 0</Td>
                  <Td className="text-ink-100">NORMAL</Td>
                  <Td>bid ÷ offer</Td>
                </tr>
                <tr>
                  <Td>bid = 0, offer &gt; 0</Td>
                  <Td className="text-ink-100">NO_BID</Td>
                  <Td>0 — a real, meaningful zero</Td>
                </tr>
                <tr>
                  <Td>bid &gt; 0, offer = 0</Td>
                  <Td className="text-ink-100">NO_OFFER</Td>
                  <Td className="text-warn-400">undefined, not infinite</Td>
                </tr>
                <tr>
                  <Td>bid = 0, offer = 0</Td>
                  <Td className="text-ink-100">EMPTY_BOOK</Td>
                  <Td className="text-warn-400">undefined</Td>
                </tr>
              </tbody>
            </table>
          </TableScroll>

          <p>
            A placeholder such as 999999 for <b>NO_OFFER</b> would flow into
            trailing averages, momentum and every score downstream, and corrupt
            all of them. Undefined observations are excluded from averages
            entirely.
          </p>

          <Formula>
            Bid value = bid quantity × close{'\n'}
            Offer value = offer quantity × close{'\n'}
            Bid % market cap = bid value ÷ market cap × 100
          </Formula>

          <p>
            Normalising by market capitalisation is what makes counters
            comparable. A 435,736-share bid on a 2,600 TZS counter and an
            11,414-share bid on a 17,600 TZS counter are not comparable as
            quantities. As a share of market capitalisation they are.
          </p>
        </CardBody>
      </Card>

      {/* -- Momentum ------------------------------------------------------- */}
      <Card>
        <CardHeader title="2 · B/O momentum" />
        <CardBody className="space-y-4 text-[13px] leading-relaxed text-ink-300">
          <Formula>
            B/O momentum % = (current B/O ÷ average of previous {WINDOWS.boMomentum}{' '}
            observations − 1) × 100
          </Formula>

          <p>All of the following must hold, or the result is unavailable:</p>
          <ul className="list-inside list-disc space-y-1">
            <li>the current ratio is defined (NORMAL or NO_BID);</li>
            <li>
              at least{' '}
              <b className="text-ink-100">{WINDOWS.boMomentumMinObservations}</b>{' '}
              usable trailing observations exist;
            </li>
            <li>the trailing average is not zero.</li>
          </ul>

          <p>
            A momentum figure computed from one prior observation is not
            momentum, it is noise. Publishing it would be worse than publishing
            nothing, so the engine returns a null together with the reason.
          </p>
        </CardBody>
      </Card>

      {/* -- Volume --------------------------------------------------------- */}
      <Card>
        <CardHeader title="3 · Volume and liquidity" />
        <CardBody className="space-y-4 text-[13px] leading-relaxed text-ink-300">
          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Metric</Th>
                  <Th>Definition</Th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <Td>{WINDOWS.shortVolume}-day average volume</Td>
                  <Td>mean of the last {WINDOWS.shortVolume} sessions with data</Td>
                </tr>
                <tr>
                  <Td>{WINDOWS.longVolume}-day average volume</Td>
                  <Td>
                    mean of the last {WINDOWS.longVolume} sessions — requires at
                    least {WINDOWS.longVolumeMinObservations} observations
                  </Td>
                </tr>
                <tr>
                  <Td>{WINDOWS.longVolume}-day median volume</Td>
                  <Td>median of the same window</Td>
                </tr>
                <tr>
                  <Td>Volume ratio</Td>
                  <Td>current volume ÷ {WINDOWS.longVolume}-day average</Td>
                </tr>
                <tr>
                  <Td>Turnover ratio</Td>
                  <Td>session turnover ÷ market capitalisation</Td>
                </tr>
                <tr>
                  <Td>Average deal size</Td>
                  <Td>turnover ÷ deals</Td>
                </tr>
              </tbody>
            </table>
          </TableScroll>

          <p>
            <b className="text-ink-100">Why the median sits beside the mean.</b>{' '}
            A single negotiated block trade on the DSE can be many multiples of a
            counter&apos;s normal daily volume and will drag the mean away from a
            typical session. The median is the honest description of a normal day
            for that counter.
          </p>

          <WeightTable
            title="Liquidity score components"
            weights={LIQUIDITY_WEIGHTS}
            notes={{
              turnover: 'Session turnover in TZS, on a log scale',
              deals: 'Deal count on a log scale — many small deals indicate broader participation than one block trade',
              consistency: 'Share of recent sessions in which the counter traded at all',
              bookDepth: 'TZS value of resting orders on both sides, on a log scale',
            }}
          />

          <p className="text-ink-500">
            Log scaling is used because turnover on the DSE spans several orders
            of magnitude. A linear scale would compress every counter except the
            largest into the bottom of the range.
          </p>
        </CardBody>
      </Card>

      {/* -- Pressure ------------------------------------------------------- */}
      <Card>
        <CardHeader title="4 · Market pressure score" />
        <CardBody className="space-y-4 text-[13px] leading-relaxed text-ink-300">
          <Formula>
            0 — extreme supply-side (sell) pressure{'\n'}
            50 — balanced{'\n'}
            100 — extreme demand-side (buy) pressure
          </Formula>

          <Notice tone="warn" title="What this score is not">
            Market pressure measures order-book and flow imbalance. It says
            nothing about whether a security is a good investment, and a high
            reading is not a buy signal on its own. Investment context lives in
            the Opportunity score, which weights pressure at only{' '}
            {OPPORTUNITY_WEIGHTS.marketPressure}%.
          </Notice>

          <WeightTable
            title="Components"
            weights={PRESSURE_WEIGHTS}
            notes={{
              orderBook: `B/O ratio through log₁₀; 0.1× → 0, 1.0× → 50, 10× → 100`,
              boMomentum: `Change vs the 5-session average; ±${PRESSURE_THRESHOLDS.boMomentumSaturationPct}% saturates`,
              price: `Session price change; ±${PRESSURE_THRESHOLDS.priceSaturationPct}% saturates`,
              volume: 'Whether volume confirms the price move',
              depth: `Net resting demand − supply as % of market cap; ±${PRESSURE_THRESHOLDS.depthSaturationPctMcap}% saturates`,
              liquidity: 'Order-book reading damped toward neutral when the counter is illiquid',
            }}
          />

          <p>
            <b className="text-ink-100">Why log₁₀ for the ratio.</b> A linear
            mapping would treat &quot;twice as many offers&quot; as far milder
            than &quot;twice as many bids&quot;. In log space 0.5× and 2.0× sit
            symmetrically either side of balance, which is how an order book
            actually behaves.
          </p>

          <p>
            <b className="text-ink-100">Volume has no side of its own.</b> It is
            signed by the direction of the price move: above-average volume
            pushes the score the way price moved, below-average volume pulls it
            back toward neutral. With no price direction, the component returns
            the neutral midpoint.
          </p>

          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Score</Th>
                  <Th>Signal</Th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <Td>&lt; {PRESSURE_THRESHOLDS.signalBands.strongSupply}</Td>
                  <Td className="text-down-400">Strong supply pressure</Td>
                </tr>
                <tr>
                  <Td>
                    {PRESSURE_THRESHOLDS.signalBands.strongSupply} –{' '}
                    {PRESSURE_THRESHOLDS.signalBands.supply}
                  </Td>
                  <Td className="text-down-400">Supply pressure</Td>
                </tr>
                <tr>
                  <Td>
                    {PRESSURE_THRESHOLDS.signalBands.supply} –{' '}
                    {PRESSURE_THRESHOLDS.signalBands.demand}
                  </Td>
                  <Td>Balanced</Td>
                </tr>
                <tr>
                  <Td>
                    {PRESSURE_THRESHOLDS.signalBands.demand} –{' '}
                    {PRESSURE_THRESHOLDS.signalBands.strongDemand}
                  </Td>
                  <Td className="text-up-400">Demand pressure</Td>
                </tr>
                <tr>
                  <Td>&gt; {PRESSURE_THRESHOLDS.signalBands.strongDemand}</Td>
                  <Td className="text-up-400">Strong demand pressure</Td>
                </tr>
              </tbody>
            </table>
          </TableScroll>

          <p className="text-ink-500">
            Below {PRESSURE_THRESHOLDS.minCoverage}% component coverage the score
            is withheld entirely rather than published from a fragment of its
            inputs.
          </p>
        </CardBody>
      </Card>

      {/* -- Opportunity ---------------------------------------------------- */}
      <Card>
        <CardHeader title="5 · Opportunity score" />
        <CardBody className="space-y-4 text-[13px] leading-relaxed text-ink-300">
          <p>
            A composite investment-context score, deliberately separate from
            market pressure and displayed separately everywhere.
          </p>

          <WeightTable
            title="Pillars"
            weights={OPPORTUNITY_WEIGHTS}
            notes={{
              fundamentals: 'ROE, net margin, EPS growth from published results',
              valuation: `P/E and P/B — P/E of ${OPPORTUNITY_THRESHOLDS.peAttractive} scores 100, ${OPPORTUNITY_THRESHOLDS.peExpensive} scores 0`,
              momentum: '20-day and 5-day price returns',
              liquidity: 'The liquidity score, carried through unchanged',
              marketPressure: 'Order-book imbalance — a short-horizon signal, not an investment case',
              dividend: `Trailing dividend yield; ${OPPORTUNITY_THRESHOLDS.dividendYieldMaxPct}% saturates`,
              risk: 'Lower realised volatility and lower debt-to-equity score higher',
            }}
          />

          <Notice tone="warn" title="Missing pillars are excluded, never invented">
            A pillar with no data is removed from the denominator and reported by
            name, and the remaining pillars are renormalised over the weight that
            was available. An issuer that has published no financial results does
            not receive a neutral 30/100 — it shows{' '}
            <b>&quot;Fundamental data unavailable&quot;</b>, and its data
            confidence falls. Below {OPPORTUNITY_THRESHOLDS.minCoverage}% coverage
            no score is published at all.
          </Notice>

          <p>
            Negative earnings produce no valuation sub-score rather than a
            flattering one. A negative P/E is not &quot;cheap&quot;; it is not
            meaningful.
          </p>
        </CardBody>
      </Card>

      {/* -- Confidence ----------------------------------------------------- */}
      <Card>
        <CardHeader title="6 · Data confidence score" />
        <CardBody className="space-y-4 text-[13px] leading-relaxed text-ink-300">
          <p>
            Confidence answers a different question from every other score here:
            not <i>what does the data say</i> but{' '}
            <i>how much should you trust what it says</i>. It starts at 100 and
            subtracts named penalties.
          </p>

          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Penalty</Th>
                  <Th align="right">Points</Th>
                  <Th>Applied when</Th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['missingCoreField', 'a required market field is absent'],
                  ['missingMarketCap', 'depth cannot be normalised across counters'],
                  ['severelyInsufficientHistory', `fewer than ${CONFIDENCE_THRESHOLDS.severeHistorySessions} sessions of history`],
                  ['insufficientHistory', `fewer than ${CONFIDENCE_THRESHOLDS.adequateHistorySessions} sessions of history`],
                  ['staleData', `the observation is older than ${CONFIDENCE_THRESHOLDS.staleDays} days`],
                  ['noTradeInSession', 'the counter did not trade'],
                  ['lowLiquidity', `turnover below ${CONFIDENCE_THRESHOLDS.lowLiquidityTurnoverTzs.toLocaleString()} TZS`],
                  ['validationWarning', 'the stored row carries data-quality warnings'],
                  ['unlicensedSource', 'data came from a manual or unlicensed source'],
                  ['noFundamentals', 'no published financial results are on file'],
                  ['unverifiedFundamentals', 'results have not been checked against the filing'],
                ].map(([key, when]) => (
                  <tr key={key}>
                    <Td className="text-ink-100">{key}</Td>
                    <Td align="right" className="text-down-400">
                      −
                      {
                        CONFIDENCE_PENALTIES[
                          key as keyof typeof CONFIDENCE_PENALTIES
                        ]
                      }
                    </Td>
                    <Td className="whitespace-normal">{when}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>

          <p>
            Each applied penalty is returned with a plain-language explanation,
            so a low confidence figure always arrives with its reason attached.
            Every investment-oriented score on this platform is displayed
            together with its confidence.
          </p>
        </CardBody>
      </Card>

      {/* -- Scanner -------------------------------------------------------- */}
      <Card>
        <CardHeader title="7 · Scanner rules" />
        <CardBody className="space-y-4 text-[13px] leading-relaxed text-ink-300">
          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Signal</Th>
                  <Th>Rule</Th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <Td>Unusual volume</Td>
                  <Td>volume ratio ≥ {SCANNER_THRESHOLDS.unusualVolumeRatio}</Td>
                </tr>
                <tr>
                  <Td>B/O acceleration</Td>
                  <Td>momentum ≥ +{SCANNER_THRESHOLDS.boAccelerationPct}%</Td>
                </tr>
                <tr>
                  <Td>B/O deterioration</Td>
                  <Td>momentum ≤ {SCANNER_THRESHOLDS.boDeteriorationPct}%</Td>
                </tr>
                <tr>
                  <Td>Price momentum</Td>
                  <Td>
                    5-day return beyond ±{SCANNER_THRESHOLDS.momentumReturnPct}%
                  </Td>
                </tr>
                <tr>
                  <Td className="text-warn-400">Possible reversal</Td>
                  <Td className="whitespace-normal">
                    <b>All three:</b> price moves at least ±
                    {SCANNER_THRESHOLDS.reversalReturnPct}%, the order book moves
                    the opposite way by at least{' '}
                    {SCANNER_THRESHOLDS.reversalBoPct}%, and volume is at least{' '}
                    {SCANNER_THRESHOLDS.reversalVolumeRatio}× its 20-day average.
                  </Td>
                </tr>
              </tbody>
            </table>
          </TableScroll>

          <p>
            Nothing is labelled a reversal on price action alone. A fall followed
            by a rise is ordinary volatility, not evidence of anything.
          </p>
        </CardBody>
      </Card>

      {/* -- AI ------------------------------------------------------------- */}
      <Card>
        <CardHeader title="8 · What the AI layer may and may not do" />
        <CardBody className="space-y-3 text-[13px] leading-relaxed text-ink-300">
          <p>
            The quantitative engine calculates. The AI layer only narrates
            numbers it was handed.
          </p>
          <p className="text-ink-100">It may not:</p>
          <ul className="list-inside list-disc space-y-1">
            <li>introduce a number that is not in the fact block it received;</li>
            <li>invent fundamentals or market news;</li>
            <li>issue a recommendation.</li>
          </ul>
        </CardBody>
      </Card>

      {/* -- Model registry ------------------------------------------------- */}
      <Card>
        <CardHeader
          title="Model versions"
          description="Derived rows are stamped with these versions, so a score published in the past can be reproduced."
        />
        <TableScroll>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Version</Th>
                <Th>Family</Th>
                <Th>Description</Th>
              </tr>
            </thead>
            <tbody>
              {MODEL_REGISTRY.map((model) => (
                <tr key={model.version}>
                  <Td className="text-ink-100">{model.version}</Td>
                  <Td className="text-ink-400">{model.family}</Td>
                  <Td className="max-w-xl whitespace-normal text-ink-300">
                    {model.description}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Card>

      <p className="text-xs leading-relaxed text-ink-500">
        Source of truth:{' '}
        <code className="text-ink-400">src/lib/analytics/config.ts</code>. Full
        prose version in <code className="text-ink-400">docs/methodology.md</code>.
        Per-security component breakdowns are on each{' '}
        <Link href="/market" className="text-accent-500 hover:text-accent-400">
          security&apos;s
        </Link>{' '}
        Methodology tab.
      </p>
    </div>
  );
}

function Formula({ children }: { children: React.ReactNode }) {
  return (
    <pre className="num overflow-x-auto rounded border border-navy-700 bg-navy-950 px-4 py-3 text-[13px] leading-relaxed text-ink-200">
      {children}
    </pre>
  );
}

function WeightTable({
  title,
  weights,
  notes,
}: {
  title: string;
  weights: Record<string, number>;
  notes: Record<string, string>;
}) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);

  return (
    <div>
      <p className="mb-2 text-[13px] font-medium text-ink-100">{title}</p>
      <TableScroll>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Component</Th>
              <Th align="right">Weight</Th>
              <Th>Basis</Th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(weights).map(([name, weight]) => (
              <tr key={name}>
                <Td className="text-ink-100">
                  {name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}
                </Td>
                <Td align="right">{weight}</Td>
                <Td className="max-w-md whitespace-normal text-ink-400">
                  {notes[name] ?? ''}
                </Td>
              </tr>
            ))}
            <tr>
              <Td className="font-semibold text-ink-100">Total</Td>
              <Td align="right" className="font-semibold text-ink-100">
                {total}
              </Td>
              <Td />
            </tr>
          </tbody>
        </table>
      </TableScroll>
    </div>
  );
}
