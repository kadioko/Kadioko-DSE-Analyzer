import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Kadioko DSE Analyzer',
    template: '%s · Kadioko DSE Analyzer',
  },
  description:
    'Equity analytics for securities listed on the Dar es Salaam Stock Exchange: order-book pressure, liquidity, momentum, fundamentals and market reports.',
  applicationName: 'Kadioko DSE Analyzer',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#060b18',
  width: 'device-width',
  initialScale: 1,
};

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/market', label: 'Market' },
  { href: '/sentiment', label: 'Sentiment' },
  { href: '/momentum', label: 'Momentum' },
  { href: '/compare', label: 'Compare' },
  { href: '/reports', label: 'Reports' },
  { href: '/methodology', label: 'Methodology' },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-navy-950 text-ink-200 antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-navy-700 focus:px-4 focus:py-2 focus:text-ink-100"
        >
          Skip to content
        </a>

        <header className="sticky top-0 z-40 border-b border-navy-700 bg-navy-900/95 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-4 sm:px-6">
            <Link href="/" className="flex shrink-0 items-baseline gap-2">
              <span className="text-sm font-semibold tracking-tight text-ink-100">
                KADIOKO
              </span>
              <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-accent-400">
                DSE Analyzer
              </span>
            </Link>

            <nav
              aria-label="Primary"
              className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
            >
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="shrink-0 rounded px-2.5 py-1.5 text-[13px] text-ink-300 transition-colors hover:bg-navy-800 hover:text-ink-100"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>

        <main id="main" className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
          {children}
        </main>

        <footer className="mt-16 border-t border-navy-800 py-6">
          <div className="mx-auto max-w-[1600px] space-y-2 px-4 text-xs text-ink-500 sm:px-6">
            <p>
              Kadioko DSE Analyzer — analytics for Dar es Salaam Stock Exchange
              listed securities.
            </p>
            <p>
              All scores are derived from stored market observations using the
              published formulas on{' '}
              <Link href="/methodology" className="text-accent-500 hover:text-accent-400">
                the methodology page
              </Link>
              . Order-book pressure describes supply and demand balance; it is not
              investment advice and is not a buy signal on its own.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
