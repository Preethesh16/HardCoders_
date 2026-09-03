/**
 * Composite views shared by more than one dashboard.
 */

import Link from 'next/link';
import type { DemoState, JourneyView, Quote, TimelineEvent } from '@/lib/api';
import { explorerTransactionUrl } from '@/lib/api';
import { Badge, Card, CardBody, CardHeader, Cell, Empty, Field, Mono, Table, stateTone } from '@/components/ui';
import { formatInstant, formatMoney, formatRate, shortHash, titleCase } from '@/lib/util';

export function NotRunYet({ reason }: { reason?: string }) {
  return (
    <Card>
      <CardHeader
        title="The demonstration has not run yet"
        description="Start it from the overview to populate every dashboard with real workflow output."
      />
      <CardBody>
        {reason ? <p className="mb-4 text-sm text-stop-500">{reason}</p> : null}
        <Link
          href="/"
          className="inline-flex items-center rounded-lg bg-ink-800 px-4 py-2 text-sm font-medium text-ink-50 transition-colors hover:bg-ink-700"
        >
          Go to the overview
        </Link>
      </CardBody>
    </Card>
  );
}

export function QuotePanel({ quote }: { quote: Quote | undefined }) {
  if (!quote) return <Empty>No FX quote has been recorded for this payment.</Empty>;
  return (
    <div className="space-y-4">
      <dl className="grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">Company funds</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">
            {formatMoney(quote.fundingAmount.amountMinor, quote.fundingAmount.currency, quote.fundingAmount.scale)}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">Locked on Algorand</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">
            {formatMoney(quote.settlementAmount.amountMinor, 'USDC', quote.settlementAmount.scale)}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">Beneficiary receives</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums text-good-500">
            {formatMoney(quote.payoutAmount.amountMinor, quote.payoutAmount.currency, quote.payoutAmount.scale)}
          </dd>
        </div>
      </dl>

      <Table head={['Leg', 'Rate', 'From', 'To']}>
        {quote.legs.map((leg) => (
          <tr key={leg.ordinal}>
            <Cell className="font-medium">{leg.pair}</Cell>
            <Cell className="tabular-nums">{formatRate(leg.rateUnits, leg.rateScale)}</Cell>
            <Cell className="tabular-nums">{formatMoney(leg.from.amountMinor, leg.from.currency, leg.from.scale)}</Cell>
            <Cell className="tabular-nums">{formatMoney(leg.to.amountMinor, leg.to.currency, leg.to.scale)}</Cell>
          </tr>
        ))}
      </Table>

      <Table head={['Fee', 'Basis points', 'Amount']}>
        {quote.fees.map((fee) => (
          <tr key={fee.code}>
            <Cell className="font-medium">{titleCase(fee.code)}</Cell>
            <Cell className="tabular-nums">{fee.basisPoints}</Cell>
            <Cell className="tabular-nums">
              {formatMoney(fee.amount.amountMinor, fee.amount.currency, fee.amount.scale)}
            </Cell>
          </tr>
        ))}
      </Table>

      <div className="rounded-lg bg-ink-50 px-4 py-3">
        <Field label="Rate source">{quote.rateSource}</Field>
        <Field label="Observed at">{formatInstant(quote.rateObservedAt)}</Field>
        <Field label="Quoted at">{formatInstant(quote.quotedAt)}</Field>
        <Field label="Expires at">{formatInstant(quote.expiresAt)}</Field>
        <Field label="Quote hash"><Mono>{shortHash(quote.canonicalHash, 16)}</Mono></Field>
      </div>
      <p className="text-xs text-ink-500">
        The blockchain carries only the USD representation. It performs neither currency trade; both legs are
        simulated by the providers and recorded here with the exact reference rate that produced them.
      </p>
    </div>
  );
}

export function CompliancePanel({ compliance }: { compliance: Record<string, any> | undefined }) {
  if (!compliance) return <Empty>No compliance decision has been recorded.</Empty>;
  const reasons = (compliance['reasons'] ?? []) as string[];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={stateTone(compliance['outcome'] as string)}>{titleCase(compliance['outcome'] as string)}</Badge>
        <Badge>{compliance['rulesVersion']}</Badge>
        <Badge>{compliance['policyVersion']}</Badge>
      </div>
      <ul className="space-y-1.5 text-sm text-ink-700">
        {reasons.map((reason) => (
          <li key={reason} className="flex gap-2">
            <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ink-400" />
            <span>{reason}</span>
          </li>
        ))}
      </ul>
      <Field label="Decision hash"><Mono>{shortHash(compliance['canonicalHash'] as string, 16)}</Mono></Field>
      <p className="text-xs text-ink-500">
        Rules are versioned configuration with source citations, not conditionals inside a request handler. The
        release authorization commits to this exact decision hash.
      </p>
    </div>
  );
}

export function EscrowPanel({ state, journey }: { state: DemoState; journey: JourneyView }) {
  const binding = journey.binding;
  if (!binding) return <Empty>No escrow has been created for this payment.</Empty>;
  const releaseEvent = journey.events.find((event) => event.kind === 'USDC_RELEASED');
  const transactionId = releaseEvent?.detail['transactionId'] as string | undefined;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={stateTone(binding['state'] as string)}>{titleCase(binding['state'] as string)}</Badge>
        <Badge>{binding['network']}</Badge>
        <Badge tone="signal">
          {state.network === 'testnet' ? 'Circle test USDC · ASA 10458941' : 'OptiUSD-DEMO · 6 decimals'}
        </Badge>
      </div>
      <Field label="Deal"><Mono>{binding['dealId']}</Mono></Field>
      <Field label="Amount locked">
        {formatMoney(binding['amountUsdcMinor'] as string, 'USDC', binding['scale'] as number)}
      </Field>
      <Field label="Origin provider treasury"><Mono>{shortHash(binding['originProviderAddress'] as string, 8)}</Mono></Field>
      <Field label="Destination provider treasury"><Mono>{shortHash(binding['destinationProviderAddress'] as string, 8)}</Mono></Field>
      <Field label="Escrow binding hash"><Mono>{shortHash(binding['bindingHash'] as string, 16)}</Mono></Field>
      <Field label="Release transaction">
        {transactionId
          ? (
            <a
              className="text-signal-600 underline underline-offset-2"
              href={explorerTransactionUrl(state, transactionId)}
              target="_blank"
              rel="noreferrer noopener"
            >
              <Mono className="text-signal-600">{shortHash(transactionId, 12)}</Mono>
            </a>
          )
          : '—'}
      </Field>
      <p className="text-xs text-ink-500">
        Only provider treasuries hold this asset. No company, freelancer or supplier holds a key, and no signing
        control is exposed to this browser.
      </p>
    </div>
  );
}

export function FabricPanel({ submissions }: { submissions: readonly Record<string, any>[] }) {
  if (submissions.length === 0) return <Empty>No work has been submitted yet.</Empty>;
  return (
    <Table head={['Version', 'File commitment', 'Decision', 'Fabric transaction']}>
      {submissions.map((submission) => (
        <tr key={submission['id'] as string}>
          <Cell className="tabular-nums">{submission['version'] as number}</Cell>
          <Cell><Mono>{shortHash(submission['fileHash'] as string, 12)}</Mono></Cell>
          <Cell>
            <Badge tone={stateTone(submission['buyerDecision'] as string)}>
              {titleCase(submission['buyerDecision'] as string)}
            </Badge>
          </Cell>
          <Cell><Mono>{(submission['fabricTxId'] as string | null) ?? '—'}</Mono></Cell>
        </tr>
      ))}
    </Table>
  );
}

export function TimelinePanel({ events }: { events: readonly TimelineEvent[] }) {
  if (events.length === 0) return <Empty>No events have been recorded.</Empty>;
  return (
    <ol className="relative space-y-4 border-l border-ink-200 pl-6">
      {events.map((event) => (
        <li key={event.id} className="relative">
          <span
            aria-hidden
            className="absolute -left-[1.6875rem] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-ink-400"
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink-800">{titleCase(event.kind)}</span>
            <Badge>{event.actorRole}</Badge>
            <time className="text-xs text-ink-400">{formatInstant(event.occurredAt)}</time>
          </div>
          <dl className="mt-1.5 grid gap-x-6 gap-y-0.5 text-xs sm:grid-cols-2">
            {Object.entries(event.detail).slice(0, 8).map(([key, value]) => (
              <div key={key} className="flex gap-2 truncate">
                <dt className="shrink-0 text-ink-400">{key}</dt>
                <dd className="truncate font-mono text-ink-600">{renderDetail(value)}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ol>
  );
}

function renderDetail(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value);
  return text.startsWith('sha256:') ? shortHash(text, 10) : text;
}

export function ReconciliationPanel({ record }: { record: Record<string, any> | undefined }) {
  if (!record) return <Empty>Reconciliation has not run for this payment.</Empty>;
  const expected = record['expected'] as Record<string, unknown>;
  const observed = record['observed'] as Record<string, unknown>;
  return (
    <div className="space-y-3">
      <Badge tone={stateTone(record['status'] as string)}>{titleCase(record['status'] as string)}</Badge>
      <Table head={['Fact', 'Durable projection', 'Settlement ledger']}>
        {Object.keys(expected).map((key) => (
          <tr key={key}>
            <Cell className="font-medium">{titleCase(key)}</Cell>
            <Cell><Mono>{String(expected[key])}</Mono></Cell>
            <Cell>
              <Mono className={String(expected[key]) === String(observed[key]) ? 'text-good-500' : 'text-stop-500'}>
                {String(observed[key])}
              </Mono>
            </Cell>
          </tr>
        ))}
      </Table>
      <p className="text-xs text-ink-500">{record['detail'] as string}</p>
    </div>
  );
}
