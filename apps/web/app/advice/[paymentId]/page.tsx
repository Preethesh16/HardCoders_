import { notFound } from 'next/navigation';
import { fetchDemoState, explorerTransactionUrl } from '@/lib/api';
import { formatInstant, formatMoney, formatRate, shortHash } from '@/lib/util';

export const dynamic = 'force-dynamic';

/**
 * Remittance advice.
 *
 * Watermarked, unmistakably a demonstration artefact, and deliberately printable
 * so a reviewer can see what a real advice would carry: the corridor, both FX
 * legs, every fee, the settlement reference and the compliance decision hash.
 */
export default async function RemittanceAdvice({ params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params;
  const state = await fetchDemoState();
  if (!state.ok) notFound();

  const payment = state.data.payments.find((candidate) => candidate['id'] === paymentId);
  if (!payment) notFound();
  const contract = state.data.contracts.find((candidate) => candidate['id'] === payment['contractId']);
  const quote = state.data.quotes.find((candidate) => candidate.id === payment['quoteId'])?.quote;
  const compliance = state.data.compliance.find((candidate) => candidate['id'] === payment['complianceResultId']);
  const binding = state.data.bindings.find((candidate) => candidate['paymentId'] === paymentId);
  const events = state.data.timelines[paymentId] ?? [];
  const release = events.find((event) => event.kind === 'USDC_RELEASED');
  const payout = events.find((event) => event.kind === 'PAYOUT_CREDITED');
  const transactionId = release?.detail['transactionId'] as string | undefined;

  const rows: Array<[string, string]> = [
    ['Advice reference', paymentId],
    ['Corridor', payment['corridorId'] as string],
    ['Direction', payment['direction'] as string],
    ['Book', payment['bookId'] as string],
    ['Contract', (contract?.['id'] as string) ?? '—'],
    ['Milestone', (contract?.['milestoneId'] as string) ?? '—'],
    ['Status', payment['state'] as string],
  ];

  return (
    <article className="mx-auto max-w-3xl">
      <div className="watermark rounded-xl border border-ink-300 bg-white p-8" data-watermark="DEMONSTRATION ONLY">
        <header className="flex items-start justify-between border-b border-ink-200 pb-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stop-500">Demonstration only</p>
            <h1 className="mt-2 text-xl font-semibold tracking-tight text-ink-800">Remittance advice</h1>
            <p className="mt-1 text-sm text-ink-500">
              Issued by the OptiWork simulated provider network. Not a bank document.
            </p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-ink-800 text-sm font-bold text-ink-50">
            O
          </span>
        </header>

        <dl className="mt-6 grid gap-x-8 gap-y-1 sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 border-b border-ink-100 py-1.5">
              <dt className="text-xs uppercase tracking-wide text-ink-400">{label}</dt>
              <dd className="truncate text-right font-mono text-xs text-ink-700">{value}</dd>
            </div>
          ))}
        </dl>

        {quote ? (
          <>
            <h2 className="mt-8 text-sm font-semibold tracking-tight text-ink-800">Amounts</h2>
            <table className="mt-3 w-full border-collapse text-sm">
              <tbody className="divide-y divide-ink-100">
                <tr>
                  <td className="py-2 text-ink-600">Funded by the payer</td>
                  <td className="py-2 text-right font-medium tabular-nums">
                    {formatMoney(quote.fundingAmount.amountMinor, quote.fundingAmount.currency, quote.fundingAmount.scale)}
                  </td>
                </tr>
                {quote.legs.map((leg) => (
                  <tr key={leg.ordinal}>
                    <td className="py-2 text-ink-600">
                      {leg.pair} at {formatRate(leg.rateUnits, leg.rateScale)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(leg.to.amountMinor, leg.to.currency, leg.to.scale)}
                    </td>
                  </tr>
                ))}
                {quote.fees.map((fee) => (
                  <tr key={fee.code}>
                    <td className="py-2 text-ink-600">
                      {fee.code.replaceAll('_', ' ').toLowerCase()} ({fee.basisPoints} bps)
                    </td>
                    <td className="py-2 text-right tabular-nums text-stop-500">
                      −{formatMoney(fee.amount.amountMinor, fee.amount.currency, fee.amount.scale)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-ink-300">
                  <td className="py-2.5 font-semibold text-ink-800">Credited to the beneficiary</td>
                  <td className="py-2.5 text-right text-base font-semibold tabular-nums text-good-500">
                    {formatMoney(quote.payoutAmount.amountMinor, quote.payoutAmount.currency, quote.payoutAmount.scale)}
                  </td>
                </tr>
              </tbody>
            </table>
          </>
        ) : null}

        <h2 className="mt-8 text-sm font-semibold tracking-tight text-ink-800">Evidence</h2>
        <dl className="mt-3 space-y-1">
          {[
            ['FX quote hash', shortHash(quote?.canonicalHash, 20)],
            ['Compliance decision hash', shortHash(compliance?.['canonicalHash'] as string | undefined, 20)],
            ['Escrow binding hash', shortHash(binding?.['bindingHash'] as string | undefined, 20)],
            ['Settlement network', (binding?.['network'] as string) ?? '—'],
            ['Settlement transaction', transactionId ? shortHash(transactionId, 16) : '—'],
            ['Credited at', payout ? formatInstant(payout.occurredAt) : '—'],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 border-b border-ink-100 py-1.5">
              <dt className="text-xs uppercase tracking-wide text-ink-400">{label}</dt>
              <dd className="truncate text-right font-mono text-xs text-ink-700">{value}</dd>
            </div>
          ))}
        </dl>

        {transactionId ? (
          <p className="mt-4 text-xs text-ink-500">
            Verify the settlement independently at{' '}
            <a
              className="text-signal-600 underline underline-offset-2"
              href={explorerTransactionUrl(state.data, transactionId)}
              target="_blank"
              rel="noreferrer noopener"
            >
              the Algorand explorer
            </a>
            .
          </p>
        ) : null}

        <footer className="mt-8 border-t border-ink-200 pt-4 text-xs leading-relaxed text-ink-500">
          This document is generated by a demonstration system. It is not a payment confirmation, not a bank advice,
          and not evidence of a real transfer. All balances are simulated and all settlement assets carry no monetary
          value.
        </footer>
      </div>

      <p className="no-print mt-4 text-center text-xs text-ink-400">Use your browser print dialog to export this page.</p>
    </article>
  );
}
