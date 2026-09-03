/**
 * The scripted demonstration.
 *
 * It drives the same services the HTTP routes drive - no shortcut, no seeded
 * "already settled" state - so what the dashboards render is the real result of
 * the real workflow, including the corridor decision, the FX quote, the ledger
 * postings and the settlement transaction references.
 */

import type { AppContext } from '../context.js';
import { MarketplaceService } from '../marketplace/service.js';
import { PaymentService } from '../payments/service.js';
import { SubmissionService } from '../submissions/service.js';
import { money } from '../money.js';
import { seedDemo, type SeedResult } from './seed.js';
import {
  applications,
  contractApprovals,
  escrowBindings,
  fiatAccounts,
  fxQuotes,
  complianceResults,
  jobs,
  paymentInstructions,
  reconciliationRecords,
  workContracts,
  workSubmissions,
} from '../db/schema.js';

const encode = (text: string): Buffer => Buffer.from(text, 'utf8');

export interface JourneyResult {
  readonly journey: 'PL_IN_INWARD' | 'IN_GB_OUTWARD';
  readonly contractId: string;
  readonly paymentId: string;
  readonly dealId: string;
  readonly settlementTransactionId: string;
  readonly fabricTxId: string;
}

export interface WalkthroughResult {
  readonly seed: SeedResult;
  readonly journeys: readonly JourneyResult[];
}

/**
 * Poland to India: a company pays a freelancer for approved work.
 */
async function inwardJourney(context: AppContext, seed: SeedResult): Promise<JourneyResult> {
  const marketplace = new MarketplaceService(context);
  const submissions = new SubmissionService(context);
  const payments = new PaymentService(context);
  const buyer = seed.polishCompany.principal;
  const provider = seed.indianFreelancer.principal;

  const job = await marketplace.createJob(buyer, {
    title: 'Cross-border reconciliation service',
    description:
      'Build a reconciliation service that compares settlement evidence against the business ledger, '
      + 'with a complete test suite and an operational runbook.',
    skills: ['typescript', 'postgres', 'reconciliation'],
    destinationCountry: 'IN',
    budget: money('1200000', 'PLN', 2),
  });
  const application = await marketplace.apply(provider, job.id, {
    coverLetter:
      'I have delivered typescript and postgres reconciliation services for two licensed payment providers, '
      + 'including ledger-to-settlement comparison and exception handling.',
  });
  await marketplace.evaluateApplication(buyer, application.id);
  const contract = await marketplace.selectApplicant(buyer, application.id, money('1200000', 'PLN', 2));

  await marketplace.approveContract(buyer, contract.id, { party: 'BUYER', acceptedTermsHash: contract.contractHash });
  await marketplace.approveContract(provider, contract.id, { party: 'PROVIDER', acceptedTermsHash: contract.contractHash });

  for (const code of ['INVOICE', 'SERVICE_EXPORT_DECLARATION']) {
    await submissions.recordDocument(buyer, contract.id, code, 'application/pdf', encode(`${code} (demonstration only)`));
  }

  const created = await payments.create(buyer, {
    contractId: contract.id,
    fundingAmount: money('1200000', 'PLN', 2),
  });
  await payments.fund(buyer, created.payment.id, `demo-inward-fund-${created.payment.id}`);

  const submitted = await submissions.submit(provider, contract.id, {
    fileName: 'reconciliation-service.zip',
    contentType: 'application/zip',
    contentBase64: Buffer.from('demonstration deliverable bytes', 'utf8').toString('base64'),
    note: 'Service, tests and runbook delivered.',
  });
  await submissions.access(buyer, submitted.submission.id);
  const decided = await submissions.decide(buyer, submitted.submission.id, {
    decision: 'APPROVED',
    comment: 'Reviewed against the milestone and accepted.',
  });
  await payments.release(buyer, created.payment.id, `demo-inward-release-${created.payment.id}`);

  const binding = await payments.requireBinding(created.payment.id);
  const escrow = await context.escrow.get(binding.dealId);
  return {
    journey: 'PL_IN_INWARD',
    contractId: contract.id,
    paymentId: created.payment.id,
    dealId: binding.dealId,
    settlementTransactionId: Object.values(escrow?.releases ?? {})[0]?.transactionId ?? '',
    fabricTxId: decided.fabricTxId,
  };
}

/**
 * India to the United Kingdom: a company pays a supplier from a separate
 * OUTWARD book, with Form A2, tax-review and import-evidence commitments.
 */
async function outwardJourney(context: AppContext, seed: SeedResult): Promise<JourneyResult> {
  const marketplace = new MarketplaceService(context);
  const submissions = new SubmissionService(context);
  const payments = new PaymentService(context);
  const buyer = seed.indianCompany.principal;
  const supplier = seed.ukSupplier.principal;

  const job = await marketplace.createJob(buyer, {
    title: 'Calibrated optical assemblies',
    description:
      'Supply calibrated optical assemblies against the attached specification, with certificates of '
      + 'calibration and shipping documentation.',
    skills: ['optics', 'manufacturing'],
    destinationCountry: 'GB',
    budget: money('80000000', 'INR', 2),
  });
  const application = await marketplace.apply(supplier, job.id, {
    coverLetter:
      'Pennine Optics manufactures calibrated optical assemblies to specification and ships with full '
      + 'calibration certificates and customs documentation.',
  });
  await marketplace.evaluateApplication(buyer, application.id);
  const contract = await marketplace.selectApplicant(buyer, application.id, money('80000000', 'INR', 2));
  await marketplace.approveContract(buyer, contract.id, { party: 'BUYER', acceptedTermsHash: contract.contractHash });
  await marketplace.approveContract(supplier, contract.id, { party: 'PROVIDER', acceptedTermsHash: contract.contractHash });

  // Outward payments demand more: Form A2 and a tax review simulation, import
  // evidence, and buyer due diligence above the Indian import threshold.
  for (const code of ['INVOICE', 'FORM_A2_DEMO', 'TAX_REVIEW_DEMO', 'IMPORT_EVIDENCE', 'BUYER_DUE_DILIGENCE']) {
    await submissions.recordDocument(buyer, contract.id, code, 'application/pdf', encode(`${code} (demonstration only)`));
  }

  const created = await payments.create(buyer, {
    contractId: contract.id,
    fundingAmount: money('80000000', 'INR', 2),
  });
  await payments.fund(buyer, created.payment.id, `demo-outward-fund-${created.payment.id}`);

  const submitted = await submissions.submit(supplier, contract.id, {
    fileName: 'shipment-manifest.pdf',
    contentType: 'application/pdf',
    contentBase64: Buffer.from('demonstration shipment manifest', 'utf8').toString('base64'),
    note: 'Assemblies shipped with calibration certificates.',
  });
  const decided = await submissions.decide(buyer, submitted.submission.id, {
    decision: 'APPROVED',
    comment: 'Goods received and inspected.',
  });
  await payments.release(buyer, created.payment.id, `demo-outward-release-${created.payment.id}`);

  const binding = await payments.requireBinding(created.payment.id);
  const escrow = await context.escrow.get(binding.dealId);
  return {
    journey: 'IN_GB_OUTWARD',
    contractId: contract.id,
    paymentId: created.payment.id,
    dealId: binding.dealId,
    settlementTransactionId: Object.values(escrow?.releases ?? {})[0]?.transactionId ?? '',
    fabricTxId: decided.fabricTxId,
  };
}

export async function runWalkthrough(context: AppContext): Promise<WalkthroughResult> {
  const seed = await seedDemo(context);
  const existing = await context.store.findMany(paymentInstructions, {}, { limit: 1 });
  if (existing.length > 0) {
    // The walkthrough has already run; re-running it would create a second
    // marketplace rather than a second demonstration.
    return { seed, journeys: await existingJourneys(context) };
  }
  const inward = await inwardJourney(context, seed);
  const outward = await outwardJourney(context, seed);
  return { seed, journeys: [inward, outward] };
}

async function existingJourneys(context: AppContext): Promise<JourneyResult[]> {
  const found = await context.store.findMany(paymentInstructions, {}, { orderBy: 'createdAt' });
  const results: JourneyResult[] = [];
  for (const payment of found) {
    const binding = await context.store.findOne(escrowBindings, { paymentId: payment.id });
    const escrow = binding ? await context.escrow.get(binding.dealId) : null;
    const submission = (await context.store.findMany(
      workSubmissions,
      { contractId: payment.contractId, buyerDecision: 'APPROVED' },
      { orderBy: 'version', direction: 'desc', limit: 1 },
    ))[0];
    results.push({
      journey: payment.direction === 'INWARD' ? 'PL_IN_INWARD' : 'IN_GB_OUTWARD',
      contractId: payment.contractId,
      paymentId: payment.id,
      dealId: binding?.dealId ?? '',
      settlementTransactionId: Object.values(escrow?.releases ?? {})[0]?.transactionId ?? '',
      fabricTxId: submission?.fabricTxId ?? '',
    });
  }
  return results;
}

/**
 * The complete read model the dashboards render.
 *
 * It is assembled from PostgreSQL and from the settlement ledger, and it
 * deliberately contains no signing material, no storage key and no bearer
 * token: everything here is safe to render in a browser.
 */
export async function demoState(context: AppContext) {
  const [
    allJobs, allApplications, contracts, approvals, quotes, decisions,
    allPayments, bindings, submissions, reconciliations, accounts,
  ] = await Promise.all([
    context.store.findMany(jobs, {}, { orderBy: 'createdAt' }),
    context.store.findMany(applications, {}, { orderBy: 'createdAt' }),
    context.store.findMany(workContracts, {}, { orderBy: 'createdAt' }),
    context.store.findMany(contractApprovals, {}, { orderBy: 'approvedAt' }),
    context.store.findMany(fxQuotes, {}, { orderBy: 'quotedAt' }),
    context.store.findMany(complianceResults, {}, { orderBy: 'evaluatedAt' }),
    context.store.findMany(paymentInstructions, {}, { orderBy: 'createdAt' }),
    context.store.findMany(escrowBindings, {}, { orderBy: 'createdAt' }),
    context.store.findMany(workSubmissions, {}, { orderBy: 'submittedAt' }),
    context.store.findMany(reconciliationRecords, {}, { orderBy: 'checkedAt' }),
    context.store.findMany(fiatAccounts, {}, { orderBy: 'createdAt' }),
  ]);

  const balances = [];
  for (const account of accounts) {
    const balance = await context.ledger.balance(account.id);
    balances.push({
      accountId: account.id,
      bookId: account.bookId,
      direction: account.direction,
      ownerKind: account.ownerKind,
      ownerId: account.ownerId,
      accountType: account.accountType,
      currency: account.currency,
      scale: account.scale,
      signedMinor: balance.signedMinor,
    });
  }

  const timelines: Record<string, unknown[]> = {};
  for (const payment of allPayments) {
    const [contractEvents, paymentEvents] = await Promise.all([
      context.timeline.forContract(payment.contractId),
      context.timeline.forPayment(payment.id),
    ]);
    timelines[payment.id] = [...contractEvents, ...paymentEvents]
      .filter((event, index, all) => all.findIndex((other) => other.id === event.id) === index)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.sequence - right.sequence);
  }

  const books = ['PL-IN-INWARD', 'IN-GB-OUTWARD'];
  const bookSummaries = [];
  for (const bookId of books) {
    bookSummaries.push({ bookId, balanced: await context.ledger.bookIsBalanced(bookId) });
  }

  return {
    profile: context.config.profile,
    network: context.config.algorand.network,
    explorerBaseUrl: context.config.algorand.explorerBaseUrl,
    adapters: {
      storage: context.objects.mode,
      ai: context.ai.mode,
      fx: context.config.fx.mode,
      algorand: context.escrow.mode,
      fabric: context.fabric.mode,
    },
    jobs: allJobs,
    applications: allApplications,
    contracts,
    approvals,
    quotes: quotes.map((quote) => ({ ...quote, quote: quote.quote })),
    compliance: decisions,
    payments: allPayments,
    bindings,
    submissions,
    reconciliations,
    balances,
    books: bookSummaries,
    timelines,
  };
}
