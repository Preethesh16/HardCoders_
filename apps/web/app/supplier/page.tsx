import Link from 'next/link';
import { fetchDemoState, journeyFor } from '@/lib/api';
import { Badge, Card, CardBody, CardHeader, Cell, DemoNotice, Field, Table, stateTone } from '@/components/ui';
import {
  CompliancePanel,
  EscrowPanel,
  FabricPanel,
  NotRunYet,
  QuotePanel,
  ReconciliationPanel,
  TimelinePanel,
} from '@/components/shared';
import { formatMoney, titleCase } from '@/lib/util';

export const dynamic = 'force-dynamic';

const OUTWARD_DOCUMENTS = [
  ['INVOICE', 'Commercial invoice for the goods supplied.'],
  ['FORM_A2_DEMO', 'Simulated Form A2 declaration for an outward remittance.'],
  ['TAX_REVIEW_DEMO', 'Simulated withholding-tax review.'],
  ['IMPORT_EVIDENCE', 'Shipping or import evidence for the goods received.'],
  ['BUYER_DUE_DILIGENCE', 'Buyer due diligence, required above the Indian import threshold.'],
] as const;

/**
 * The outward supplier journey.
 *
 * Its point is separation: a different corridor, different provider treasuries,
 * a different set of books, and a due-diligence rule that the inward freelancer
 * journey must never see.
 */
export default async function SupplierDashboard() {
  const state = await fetchDemoState();
  if (!state.ok) return <NotRunYet reason={state.reason} />;
  const outward = journeyFor(state.data, 'OUTWARD');
  const inward = journeyFor(state.data, 'INWARD');
  if (!outward) return <NotRunYet />;

  const outwardBalances = state.data.balances.filter((balance) => balance.bookId === 'IN-GB-OUTWARD');
  const inwardBook = state.data.books.find((book) => book.bookId === 'PL-IN-INWARD');
  const outwardBook = state.data.books.find((book) => book.bookId === 'IN-GB-OUTWARD');

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-400">India → United Kingdom</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-800">Supplier payment, outward book</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-600">
          Sahyadri Instruments pays Pennine Optics. Separate provider accounts, separate books, and Indian import
          rules that the Poland to India freelancer journey never triggers.
        </p>
      </header>

      <Card>
        <CardHeader
          title="Inward and outward never net"
          description="Two books, two directions. A journal line cannot reference an account in the other book."
        />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2">
            {[inwardBook, outwardBook].map((book) => book ? (
              <div key={book.bookId} className="rounded-lg border border-ink-200 px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm text-ink-700">{book.bookId}</span>
                  <Badge tone={book.balanced ? 'good' : 'stop'}>{book.balanced ? 'Balanced' : 'Unbalanced'}</Badge>
                </div>
                <p className="mt-1 text-xs text-ink-500">
                  {book.bookId.endsWith('INWARD')
                    ? 'Receipts into India for exported services.'
                    : 'Remittances out of India for imported goods.'}
                </p>
              </div>
            ) : null)}
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Corridor and compliance" description={outward.payment['corridorId'] as string} />
          <CardBody><CompliancePanel compliance={outward.compliance} /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Required import documents" description="Recorded as SHA-256 commitments; the files stay off-chain." />
          <CardBody>
            <Table head={['Code', 'Why it is required']}>
              {OUTWARD_DOCUMENTS.map(([code, why]) => (
                <tr key={code}>
                  <Cell className="font-mono text-xs">{code}</Cell>
                  <Cell className="text-xs">{why}</Cell>
                </tr>
              ))}
            </Table>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="FX quote and fees" description="INR to USD to GBP, with the reference rate that produced each leg." />
        <CardBody><QuotePanel quote={outward.quote} /></CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Algorand escrow" description="Different provider treasuries from the inward corridor." />
          <CardBody><EscrowPanel state={state.data} journey={outward} /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Outward book balances" />
          <CardBody>
            <Table head={['Account', 'Owner', 'Balance']}>
              {outwardBalances.map((balance) => (
                <tr key={balance.accountId}>
                  <Cell className="text-xs">{titleCase(balance.accountType)}</Cell>
                  <Cell className="font-mono text-xs">{balance.ownerId}</Cell>
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
        <CardHeader title="Delivery and acceptance" />
        <CardBody><FabricPanel submissions={outward.submissions} /></CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Payment"
          action={
            <Link
              href={`/advice/${outward.payment['id'] as string}`}
              className="rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-100"
            >
              Remittance advice
            </Link>
          }
        />
        <CardBody className="space-y-6">
          <Field label="State">
            <Badge tone={stateTone(outward.payment['state'] as string)}>
              {titleCase(outward.payment['state'] as string)}
            </Badge>
          </Field>
          <ReconciliationPanel record={outward.reconciliation} />
          <TimelinePanel events={outward.events} />
        </CardBody>
      </Card>

      {inward ? (
        <p className="text-xs text-ink-500">
          For comparison, the inward journey applied {(inward.compliance?.['reasons'] as string[] | undefined)?.length ?? 0}{' '}
          rule outcomes and never evaluated the import buyer due-diligence threshold, because that rule is
          configured for outward Indian payments only.
        </p>
      ) : null}

      <DemoNotice />
    </div>
  );
}
