import { fetchDemoState, journeyFor } from '@/lib/api';
import { Badge, Card, CardBody, CardHeader, DemoNotice, Field, Stat, stateTone } from '@/components/ui';
import { EscrowPanel, FabricPanel, NotRunYet, TimelinePanel } from '@/components/shared';
import { formatInstant, formatMoney, shortHash, titleCase } from '@/lib/util';

export const dynamic = 'force-dynamic';

/**
 * The freelancer's view: what was agreed, what was delivered, what the company
 * decided, and the simulated INR credit that resulted. No token, no wallet.
 */
export default async function FreelancerDashboard() {
  const state = await fetchDemoState();
  if (!state.ok) return <NotRunYet reason={state.reason} />;
  const journey = journeyFor(state.data, 'INWARD');
  if (!journey) return <NotRunYet />;

  const providerOrganizationId = journey.contract['providerOrganizationId'] as string;
  const wallet = state.data.balances.find((balance) =>
    balance.ownerId === providerOrganizationId
    && balance.accountType === 'BENEFICIARY_WALLET'
    && balance.bookId === 'PL-IN-INWARD');
  const payoutEvent = journey.events.find((event) => event.kind === 'PAYOUT_CREDITED');

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-400">Indian freelancer</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-800">Bengaluru contract engineer</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-600">
          Paid in INR into a simulated wallet. Never receives cryptocurrency, never manages a blockchain key, and
          never sees a private key or mnemonic in this browser.
        </p>
      </header>

      <Card>
        <CardHeader title="Simulated INR payout" description="The credit produced by the destination provider's conversion." />
        <CardBody>
          <dl className="grid gap-6 sm:grid-cols-3">
            <Stat
              label="Wallet balance"
              value={wallet ? formatMoney(wallet.signedMinor, wallet.currency, wallet.scale) : '—'}
              hint={wallet ? `${wallet.bookId} · ${wallet.direction}` : undefined}
            />
            <Stat
              label="Quoted payout"
              value={formatMoney(
                journey.payment['payoutAmountMinor'] as string,
                journey.payment['payoutCurrency'] as string,
                journey.payment['payoutScale'] as number,
              )}
              hint="Net of the destination off-ramp fee"
            />
            <Stat
              label="Credited"
              value={payoutEvent ? formatInstant(payoutEvent.occurredAt) : 'Pending'}
              hint={payoutEvent ? 'Posted as a balanced double entry' : undefined}
            />
          </dl>
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Contract" description={journey.contract['id'] as string} />
          <CardBody>
            <Field label="State">
              <Badge tone={stateTone(journey.contract['state'] as string)}>
                {titleCase(journey.contract['state'] as string)}
              </Badge>
            </Field>
            <Field label="Agreed amount">
              {formatMoney(
                journey.contract['amountMinor'] as string,
                journey.contract['amountCurrency'] as string,
                journey.contract['amountScale'] as number,
              )}
            </Field>
            <Field label="Milestone">{journey.contract['milestoneId'] as string}</Field>
            <Field label="Terms hash">{shortHash(journey.contract['contractHash'] as string, 14)}</Field>
            <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-50 p-3 text-xs leading-relaxed text-ink-600">
              {journey.contract['terms'] as string}
            </pre>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Escrow backing this contract" description="Held between provider treasuries until approval." />
          <CardBody><EscrowPanel state={state.data} journey={journey} /></CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Submissions and decisions" description="Each submission is a new immutable version." />
        <CardBody><FabricPanel submissions={journey.submissions} /></CardBody>
      </Card>

      <Card>
        <CardHeader title="Complete timeline" />
        <CardBody><TimelinePanel events={journey.events} /></CardBody>
      </Card>

      <DemoNotice />
    </div>
  );
}
