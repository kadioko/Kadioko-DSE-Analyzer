import Link from 'next/link';

/**
 * Placeholder dashboard.
 *
 * Phase 5 replaces this with the live market dashboard. It deliberately shows
 * no numbers at all rather than sample figures, so nothing on screen can be
 * mistaken for real DSE data before ingestion has run.
 */
export default function HomePage() {
  return (
    <div className="space-y-8">
      <section className="rounded-lg border border-navy-700 bg-navy-900 p-6">
        <h1 className="text-xl font-semibold tracking-tight text-ink-100">
          Kadioko DSE Analyzer
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-300">
          Analytics platform for securities listed on the Dar es Salaam Stock
          Exchange. The database schema, ingestion validation and analytics
          engine are in place. The market dashboard arrives in Phase 5.
        </p>
        <p className="mt-4 text-sm text-ink-400">
          No market data is displayed until a DSE file has been imported through{' '}
          <span className="text-ink-200">/admin/data</span>. This page shows no
          sample figures by design.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          {
            title: 'Transparent scoring',
            body: 'Market Pressure, Opportunity and Liquidity scores each return every component, weight and contribution. No black boxes.',
            href: '/methodology',
            cta: 'Read the methodology',
          },
          {
            title: 'Separated concerns',
            body: 'Raw observations live in market_daily. Everything derived is versioned in analytics_daily and can be recomputed or rolled back.',
            href: '/methodology',
            cta: 'How the data is structured',
          },
          {
            title: 'Honest gaps',
            body: 'A value that cannot be computed is null, with the reason attached. Missing data is never replaced with a neutral placeholder.',
            href: '/methodology',
            cta: 'Confidence scoring',
          },
        ].map((card) => (
          <div
            key={card.title}
            className="rounded-lg border border-navy-700 bg-navy-900 p-5"
          >
            <h2 className="text-sm font-semibold text-ink-100">{card.title}</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-400">
              {card.body}
            </p>
            <Link
              href={card.href}
              className="mt-3 inline-block text-[13px] text-accent-500 hover:text-accent-400"
            >
              {card.cta} →
            </Link>
          </div>
        ))}
      </section>
    </div>
  );
}
