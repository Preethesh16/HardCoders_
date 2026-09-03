import { fetchDemoState, explorerTransactionUrl } from '@/lib/api';
import { Badge, Card, CardBody, CardHeader, Cell, DemoNotice, Empty, Field, Mono, Stat, Table, stateTone } from '@/components/ui';
import { NotRunYet } from '@/components/shared';
import { formatInstant, formatMoney, shortHash, titleCase } from '@/lib/util';

export const dynamic = 'force-dynamic';

/**
 * Provider operations.
 *
 * The only role that sees settlement mechanics: escrow state per deal, the
 * treasury balances behind each corridor, and the reconciliation result that
 * compares the durable projection against the settlement ledger.
 */
export default async function ProviderDashboard() {
  const state = await fetchDemoState();
  if (!state.ok) return <NotRunYet reason={state.reason} />;
  if (state.data.payments.length === 0) return <NotRunYet />;

  const providerBalances = state.data.balances.filter((balance) => balance.ownerKind === 'PROVIDER');
  const controlBalances = state.data.balances.filter((balance) => balance.ownerKind === 'PLATFORM');
  const releaseEvents = Object.values(state.data.timelines)
    .flat()
    .filter((event) => event.kind === 'USDC_RELEASED');

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-400">Provider operations</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-800">Settlement and treasury</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-600">
          Provider treasuries are the only accounts that ever hold the settlement asset. Signing happens inside the
          isolated executor service; no key, mnemonic or signing control is exposed to this browser.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card><CardBody>
          <Stat label="Network" value={state.data.network} hint={state.data.adapters['algorand']} />
        </CardBody></Card>
        <Card><CardBody>
          <Stat label="Settlement asset" value={state.data.network === 'testnet' ? 'USDC · 10458941' : 'OptiUSD-DEMO'} hint="Six decimals, zero monetary value" />
        </CardBody></Card>
        <Card><CardBody>
          <Stat
            label="Books balanced"
            value={state.data.books.every((book) => book.balanced) ? 'Yes' : 'No'}
            hint={state.data.books.map((book) => book.bookId).join(' · ')}
          />
        </CardBody></Card>
      </div>

      <Card>
        <CardHeader title="Escrows" description="One deal per payment, bound to an exact application and asset." />
        <CardBody>
          <Table head={['Deal', 'Book', 'Amount', 'State', 'Binding hash']}>
            {state.data.bindings.map((binding) => {
              const payment = state.data.payments.find((candidate) => candidate['id'] === binding['paymentId']);
              return (
                <tr key={binding['id'] as string}>
                  <Cell><Mono>{binding['dealId'] as string}</Mono></Cell>
                  <Cell className="text-xs">{payment?.['bookId'] as string ?? '—'}</Cell>
                  <Cell className="tabular-nums">
                    {formatMoney(binding['amountUsdcMinor'] as string, 'USDC', binding['scale'] as number)}
                  </Cell>
                  <Cell>
                    <Badge tone={stateTone(binding['state'] as string)}>{titleCase(binding['state'] as string)}</Badge>
                  </Cell>
                  <Cell><Mono>{shortHash(binding['bindingHash'] as string, 10)}</Mono></Cell>
                </tr>
              );
            })}
          </Table>
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Provider treasury balances" description="Simulated fiat and USD positions per book." />
          <CardBody>
            <Table head={['Provider', 'Book', 'Balance']}>
              {providerBalances.map((balance) => (
                <tr key={balance.accountId}>
                  <Cell className="font-mono text-xs">{balance.ownerId}</Cell>
                  <Cell className="text-xs">{balance.bookId}</Cell>
                  <Cell className="tabular-nums">
                    {formatMoney(balance.signedMinor, balance.currency, balance.scale)}
                  </Cell>
                </tr>
              ))}
            </Table>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Escrow control and fee income" description="Platform-side control accounts." />
          <CardBody>
            <Table head={['Account', 'Book', 'Balance']}>
              {controlBalances.map((balance) => (
                <tr key={balance.accountId}>
                  <Cell className="text-xs">{titleCase(balance.accountType)}</Cell>
                  <Cell className="text-xs">{balance.bookId}</Cell>
                  <Cell className="tabular-nums">
                    {formatMoney(balance.signedMinor, balance.currency, balance.scale)}
                  </Cell>
                </tr>
              ))}
            </Table>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Confirmed settlement transactions" description="Each carries an explorer link for independent verification." />
        <CardBody>
          {releaseEvents.length === 0 ? <Empty>No release has been confirmed yet.</Empty> : (
            <Table head={['Deal', 'Released', 'Transaction', 'At']}>
              {releaseEvents.map((event) => {
                const transactionId = event.detail['transactionId'] as string;
                return (
                  <tr key={event.id}>
                    <Cell><Mono>{event.detail['dealId'] as string}</Mono></Cell>
                    <Cell className="tabular-nums">
                      {formatMoney(event.detail['releasedMinor'] as string, 'USDC', 6)}
                    </Cell>
                    <Cell>
                      <a
                        className="text-signal-600 underline underline-offset-2"
                        href={explorerTransactionUrl(state.data, transactionId)}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        <Mono className="text-signal-600">{shortHash(transactionId, 12)}</Mono>
                      </a>
                    </Cell>
                    <Cell className="tabular-nums text-xs">{formatInstant(event.occurredAt)}</Cell>
                  </tr>
                );
              })}
            </Table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Reconciliation" description="A disagreement is recorded, never silently repaired." />
        <CardBody>
          <Table head={['Payment', 'Scope', 'Status', 'Checked']}>
            {state.data.reconciliations.map((record) => (
              <tr key={record['id'] as string}>
                <Cell><Mono>{record['paymentId'] as string}</Mono></Cell>
                <Cell className="text-xs">{titleCase(record['scope'] as string)}</Cell>
                <Cell>
                  <Badge tone={stateTone(record['status'] as string)}>{titleCase(record['status'] as string)}</Badge>
                </Cell>
                <Cell className="tabular-nums text-xs">{formatInstant(record['checkedAt'] as string)}</Cell>
              </tr>
            ))}
          </Table>
        </CardBody>
      </Card>

      <DemoNotice />
    </div>
  );
}
