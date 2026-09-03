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
import { formatInstant, formatMoney, shortHash, titleCase } from '@/lib/util';

export const dynamic = 'force-dynamic';

/**
 * The buying company's view: who applied, what was agreed, what the corridor
 * rules said, what the money costs, and where the payment stands.
 */
export default async function CompanyDashboard() {
  const state = await fetchDemoState();
  if (!state.ok) return <NotRunYet reason={state.reason} />;
  const journey = journeyFor(state.data, 'INWARD');
  if (!journey) return <NotRunYet />;

  const job = state.data.jobs.find((candidate) => candidate['id'] === journey.contract['jobId']);
  const applications = state.data.applications.filter((candidate) => candidate['jobId'] === job?.['id']);
  const approvals = state.data.approvals.filter((candidate) => candidate['contractId'] === journey.contract['id']);

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-400">Polish company</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-800">Nova Systemy Sp. z o.o.</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-600">
          Warsaw. Funds in PLN, never touches a token, and never manages a blockchain wallet.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Job and applications" description={job?.['title'] as string} />
          <CardBody>
            <Table head={['Applicant organization', 'Status', 'Applied']}>
              {applications.map((application) => (
                <tr key={application['id'] as string}>
                  <Cell className="font-medium">{application['applicantOrganizationId'] as string}</Cell>
                  <Cell><Badge tone={stateTone(application['status'] as string)}>{titleCase(application['status'] as string)}</Badge></Cell>
                  <Cell className="tabular-nums">{formatInstant(application['createdAt'] as string)}</Cell>
                </tr>
              ))}
            </Table>
            <p className="mt-3 text-xs text-ink-500">
              Shortlisting is advisory: the score and its citations are recorded, and a person selects the applicant.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Bilateral contract approval" />
          <CardBody>
            <Field label="State">
              <Badge tone={stateTone(journey.contract['state'] as string)}>
                {titleCase(journey.contract['state'] as string)}
              </Badge>
            </Field>
            <Field label="Terms hash">{shortHash(journey.contract['contractHash'] as string, 14)}</Field>
            <Field label="Milestone">{journey.contract['milestoneId'] as string}</Field>
            <Field label="Agreed amount">
              {formatMoney(
                journey.contract['amountMinor'] as string,
                journey.contract['amountCurrency'] as string,
                journey.contract['amountScale'] as number,
              )}
            </Field>
            <div className="mt-3 space-y-2">
              {approvals.map((approval) => (
                <div key={approval['id'] as string} className="flex items-center justify-between text-sm">
                  <span className="text-ink-600">{titleCase(approval['party'] as string)} approved</span>
                  <span className="font-mono text-xs text-ink-500">{formatInstant(approval['approvedAt'] as string)}</span>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="FX quote and fees"
          description="Both legs, the reference rate that produced them, and an explicit expiry."
        />
        <CardBody><QuotePanel quote={journey.quote} /></CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Corridor and compliance" description={journey.payment['corridorId'] as string} />
          <CardBody><CompliancePanel compliance={journey.compliance} /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Algorand escrow" description="Provider to provider. The company never holds the asset." />
          <CardBody><EscrowPanel state={state.data} journey={journey} /></CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Submitted work and the buyer decision"
          description="Fabric holds the commitment; the bytes stay in object storage behind a short-lived signed URL."
        />
        <CardBody><FabricPanel submissions={journey.submissions} /></CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Payment"
          description="PLN funded, USDC locked and released, INR credited."
          action={
            <Link
              href={`/advice/${journey.payment['id'] as string}`}
              className="rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-100"
            >
              Remittance advice
            </Link>
          }
        />
        <CardBody className="space-y-6">
          <Field label="State">
            <Badge tone={stateTone(journey.payment['state'] as string)}>
              {titleCase(journey.payment['state'] as string)}
            </Badge>
          </Field>
          <ReconciliationPanel record={journey.reconciliation} />
          <TimelinePanel events={journey.events} />
        </CardBody>
      </Card>

      <DemoNotice />
    </div>
  );
}
