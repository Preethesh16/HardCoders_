import { fetchDemoState } from '@/lib/api';
import { Badge, Card, CardBody, CardHeader, Cell, DemoNotice, Field, Mono, Stat, Table, stateTone } from '@/components/ui';
import { NotRunYet, TimelinePanel } from '@/components/shared';
import { formatInstant, formatMoney, shortHash, titleCase } from '@/lib/util';

export const dynamic = 'force-dynamic';

/**
 * Administrator and audit.
 *
 * Read-only across tenants: the ledger position of every book, the compliance
 * decisions that were applied with their versions, and the complete ordered
 * event record for every payment.
 */
export default async function AdminDashboard() {
  const state = await fetchDemoState();
  if (!state.ok) return <NotRunYet reason={state.reason} />;
  if (state.data.payments.length === 0) return <NotRunYet />;

  const allEvents = Object.values(state.data.timelines).flat();

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-400">Administrator and audit</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-800">Platform record</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-600">
          Read access across tenants and no write access anywhere. Every figure below is derived from PostgreSQL and
          the settlement ledger, never from a cached summary.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-4">
        <Card><CardBody><Stat label="Contracts" value={state.data.contracts.length} /></CardBody></Card>
        <Card><CardBody><Stat label="Payments" value={state.data.payments.length} /></CardBody></Card>
        <Card><CardBody><Stat label="Timeline events" value={allEvents.length} /></CardBody></Card>
        <Card><CardBody>
          <Stat
            label="Books balanced"
            value={state.data.books.every((book) => book.balanced) ? 'All' : 'Attention'}
          />
        </CardBody></Card>
      </div>

      <Card>
        <CardHeader title="Books" description="Inward and outward are separate ledgers and are never netted." />
        <CardBody>
          <Table head={['Book', 'Direction', 'Accounts', 'Balanced']}>
            {state.data.books.map((book) => {
              const accounts = state.data.balances.filter((balance) => balance.bookId === book.bookId);
              return (
                <tr key={book.bookId}>
                  <Cell><Mono>{book.bookId}</Mono></Cell>
                  <Cell className="text-xs">{accounts[0]?.direction ?? '—'}</Cell>
                  <Cell className="tabular-nums">{accounts.length}</Cell>
                  <Cell><Badge tone={book.balanced ? 'good' : 'stop'}>{book.balanced ? 'Yes' : 'No'}</Badge></Cell>
                </tr>
              );
            })}
          </Table>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="All account balances" description="Signed balance: credits less debits, in the account's own denomination." />
        <CardBody>
          <Table head={['Book', 'Owner', 'Account', 'Balance']}>
            {state.data.balances.map((balance) => (
              <tr key={balance.accountId}>
                <Cell className="text-xs">{balance.bookId}</Cell>
                <Cell className="font-mono text-xs">{balance.ownerId}</Cell>
                <Cell className="text-xs">{titleCase(balance.accountType)}</Cell>
                <Cell className="tabular-nums">{formatMoney(balance.signedMinor, balance.currency, balance.scale)}</Cell>
              </tr>
            ))}
          </Table>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Compliance decisions" description="Each carries the rules version, policy version and decision hash it was made under." />
        <CardBody>
          <Table head={['Decision', 'Corridor', 'Outcome', 'Rules', 'Hash']}>
            {state.data.compliance.map((decision) => (
              <tr key={decision['id'] as string}>
                <Cell><Mono>{decision['id'] as string}</Mono></Cell>
                <Cell className="text-xs">{decision['corridorId'] as string}</Cell>
                <Cell>
                  <Badge tone={stateTone(decision['outcome'] as string)}>{titleCase(decision['outcome'] as string)}</Badge>
                </Cell>
                <Cell className="text-xs">{decision['rulesVersion'] as string}</Cell>
                <Cell><Mono>{shortHash(decision['canonicalHash'] as string, 10)}</Mono></Cell>
              </tr>
            ))}
          </Table>
        </CardBody>
      </Card>

      {state.data.payments.map((payment) => (
        <Card key={payment['id'] as string}>
          <CardHeader
            title={`Audit trail · ${payment['id'] as string}`}
            description={`${payment['corridorId'] as string} · ${payment['bookId'] as string}`}
            action={<Badge tone={stateTone(payment['state'] as string)}>{titleCase(payment['state'] as string)}</Badge>}
          />
          <CardBody>
            <div className="mb-4 grid gap-x-8 sm:grid-cols-2">
              <Field label="Created">{formatInstant(payment['createdAt'] as string)}</Field>
              <Field label="Updated">{formatInstant(payment['updatedAt'] as string)}</Field>
              <Field label="Funded">
                {formatMoney(
                  payment['fundingAmountMinor'] as string,
                  payment['fundingCurrency'] as string,
                  payment['fundingScale'] as number,
                )}
              </Field>
              <Field label="Paid out">
                {formatMoney(
                  payment['payoutAmountMinor'] as string,
                  payment['payoutCurrency'] as string,
                  payment['payoutScale'] as number,
                )}
              </Field>
            </div>
            <TimelinePanel events={state.data.timelines[payment['id'] as string] ?? []} />
          </CardBody>
        </Card>
      ))}

      <DemoNotice />
    </div>
  );
}
