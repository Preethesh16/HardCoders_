import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { fetchDemoState, journeyFor, runWalkthrough } from '@/lib/api';
import { Badge, Card, CardBody, CardHeader, DemoNotice, Field, Stat, stateTone } from '@/components/ui';
import { formatMoney, titleCase } from '@/lib/util';

export const dynamic = 'force-dynamic';

/**
 * Runs the scripted demonstration on the server.
 *
 * The browser posts a form; the API performs the actual workflow. No token, key
 * or signing control ever reaches the client.
 */
async function startWalkthrough(): Promise<void> {
  'use server';
  await runWalkthrough();
  revalidatePath('/', 'layout');
}

const PILLARS = [
  [
    'Hyperledger Fabric',
    'Work evidence only',
    'Submission commitments, versions and the buyer decision. No names, no files, no payment state, no wallet address.',
  ],
  [
    'Algorand',
    'Provider-to-provider escrow',
    'Zero-value test USDC locked between two provider treasuries, released once against a single-use authorization.',
  ],
  [
    'PostgreSQL',
    'Business system of record',
    'Marketplace, corridor policy, FX quotes, compliance decisions, double-entry books and reconciliation.',
  ],
] as const;

export default async function Overview() {
  const state = await fetchDemoState();
  const ran = state.ok && state.data.payments.length > 0;
  const inward = state.ok ? journeyFor(state.data, 'INWARD') : undefined;
  const outward = state.ok ? journeyFor(state.data, 'OUTWARD') : undefined;

  return (
    <div className="space-y-8">
      <section>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-400">
          Cross-border work, with the financial logic visible
        </p>
        <h1 className="mt-3 max-w-3xl text-3xl font-semibold tracking-tight text-ink-800 sm:text-4xl">
          Hire globally. Settle with proof.
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-600">
          A Polish company pays an Indian freelancer. An Indian company pays a United Kingdom supplier from a
          completely separate set of books. Both journeys run across three ledgers, and every decision along the way
          is recorded with the rule, the rate and the hash that produced it.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <form action={startWalkthrough}>
            <button
              type="submit"
              className="inline-flex items-center rounded-lg bg-ink-800 px-4 py-2.5 text-sm font-medium text-ink-50 transition-colors hover:bg-ink-700"
            >
              {ran ? 'Re-read the demonstration state' : 'Run the demonstration'}
            </button>
          </form>
          {ran ? (
            <>
              <Link
                href="/company"
                className="inline-flex items-center rounded-lg border border-ink-300 px-4 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-100"
              >
                Open the company dashboard
              </Link>
              <Badge tone="good">Both journeys settled</Badge>
            </>
          ) : null}
        </div>
      </section>

      {!state.ok ? (
        <Card>
          <CardHeader title="The API is not reachable" />
          <CardBody>
            <p className="text-sm text-stop-500">{state.reason}</p>
            <p className="mt-3 text-sm text-ink-600">
              Start the whole stack with <code className="font-mono text-xs">pnpm demo</code>, or run the API alone
              with <code className="font-mono text-xs">pnpm --filter @optiwork/api dev</code>. No paid API key and no
              external service is required.
            </p>
          </CardBody>
        </Card>
      ) : null}

      <section className="grid gap-4 md:grid-cols-3">
        {PILLARS.map(([ledger, role, description]) => (
          <Card key={ledger}>
            <CardBody>
              <p className="text-xs font-medium uppercase tracking-wide text-ink-400">{role}</p>
              <h2 className="mt-1.5 text-base font-semibold tracking-tight text-ink-800">{ledger}</h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">{description}</p>
            </CardBody>
          </Card>
        ))}
      </section>

      {state.ok && ran ? (
        <section className="grid gap-4 lg:grid-cols-2">
          {[
            ['Poland → India', 'INWARD', inward] as const,
            ['India → United Kingdom', 'OUTWARD', outward] as const,
          ].map(([title, direction, journey]) => (
            <Card key={direction}>
              <CardHeader
                title={title}
                description={`${direction} book · ${journey?.payment['bookId'] ?? '—'}`}
                action={journey
                  ? <Badge tone={stateTone(journey.payment['state'] as string)}>{titleCase(journey.payment['state'] as string)}</Badge>
                  : undefined}
              />
              <CardBody>
                {journey ? (
                  <>
                    <dl className="grid grid-cols-3 gap-4">
                      <Stat
                        label="Funded"
                        value={formatMoney(
                          journey.payment['fundingAmountMinor'] as string,
                          journey.payment['fundingCurrency'] as string,
                          journey.payment['fundingScale'] as number,
                        )}
                      />
                      <Stat
                        label="Settled"
                        value={journey.quote
                          ? formatMoney(journey.quote.settlementAmount.amountMinor, 'USDC', 6)
                          : '—'}
                      />
                      <Stat
                        label="Paid out"
                        value={formatMoney(
                          journey.payment['payoutAmountMinor'] as string,
                          journey.payment['payoutCurrency'] as string,
                          journey.payment['payoutScale'] as number,
                        )}
                      />
                    </dl>
                    <div className="mt-4">
                      <Field label="Corridor">{journey.payment['corridorId'] as string}</Field>
                      <Field label="Compliance">
                        <Badge tone={stateTone(journey.compliance?.['outcome'] as string ?? 'PENDING')}>
                          {titleCase((journey.compliance?.['outcome'] as string) ?? 'pending')}
                        </Badge>
                      </Field>
                      <Field label="Reconciliation">
                        <Badge tone={stateTone(journey.reconciliation?.['status'] as string ?? 'PENDING')}>
                          {titleCase((journey.reconciliation?.['status'] as string) ?? 'pending')}
                        </Badge>
                      </Field>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-ink-500">This journey has not run yet.</p>
                )}
              </CardBody>
            </Card>
          ))}
        </section>
      ) : null}

      {state.ok ? (
        <Card>
          <CardHeader
            title="Runtime configuration"
            description="Every adapter has an offline implementation, so the default demonstration needs no paid key."
          />
          <CardBody>
            <div className="grid gap-x-8 sm:grid-cols-2">
              <Field label="Profile">{state.data.profile}</Field>
              <Field label="Algorand network">{state.data.network}</Field>
              {Object.entries(state.data.adapters).map(([name, mode]) => (
                <Field key={name} label={name}>{mode}</Field>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <DemoNotice />
    </div>
  );
}
