import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'OptiWork — cross-border work and auditable settlement',
  description:
    'A demonstration of verified cross-border work: corridor rules, FX, escrow settlement and a complete audit trail.',
};

const VIEWS = [
  ['/', 'Overview'],
  ['/company', 'Polish company'],
  ['/freelancer', 'Indian freelancer'],
  ['/supplier', 'India → UK supplier'],
  ['/provider', 'Provider operations'],
  ['/admin', 'Administrator & audit'],
] as const;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        {/* The standing, unmissable statement of what this is. */}
        <div className="no-print bg-stop-500 px-4 py-1.5 text-center text-xs font-semibold uppercase tracking-[0.18em] text-white">
          Demonstration only · zero-value test assets · not a licensed payment service
        </div>

        <header className="no-print border-b border-ink-200 bg-white">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-4">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink-800 text-sm font-bold text-ink-50">
                O
              </span>
              <span className="text-sm font-semibold tracking-tight text-ink-800">OptiWork</span>
            </Link>
            <nav className="flex flex-wrap items-center gap-x-1 gap-y-1 text-sm">
              {VIEWS.map(([href, label]) => (
                <Link
                  key={href}
                  href={href}
                  className="rounded-md px-2.5 py-1.5 text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-800"
                >
                  {label}
                </Link>
              ))}
            </nav>
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>

        <footer className="no-print mt-12 border-t border-ink-200 bg-white">
          <div className="mx-auto max-w-7xl px-6 py-6 text-xs leading-relaxed text-ink-500">
            <p className="font-medium text-ink-600">Three ledgers, one workflow.</p>
            <p className="mt-1 max-w-3xl">
              Hyperledger Fabric holds work-evidence commitments and buyer decisions. Algorand holds
              provider-to-provider escrow in zero-value test USDC. PostgreSQL is the business system of record for
              marketplace state, corridor policy, FX quotes, simulated fiat books and reconciliation. End users never
              receive cryptocurrency and never manage a blockchain wallet.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
