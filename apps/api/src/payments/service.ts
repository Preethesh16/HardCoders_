/**
 * The cross-border payment saga.
 *
 * The order is deliberate and each step is durable:
 *
 *  1. resolve the ordered corridor and its book;
 *  2. verify both parties' credentials;
 *  3. quote both FX legs with an explicit expiry;
 *  4. evaluate the versioned compliance rules against the INR-equivalent value;
 *  5. debit the buyer's simulated fiat book and lock USDC on Algorand;
 *  6. wait for an approved work version recorded on Fabric;
 *  7. authorize a single release bound to all of the above and release USDC;
 *  8. credit the beneficiary's simulated fiat book and reconcile.
 *
 * A PostgreSQL status is never treated as proof that a ledger committed: the
 * executor's confirmed transaction evidence is, and reconciliation compares the
 * two.
 */

import type { CorridorPolicy, PaymentState } from '@optiwork/contracts';
import { assertPaymentTransition } from '@optiwork/domain';
import { canonicalHash } from '../canonical.js';
import type { AppContext } from '../context.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import {
  complianceResults,
  escrowBindings,
  fxQuoteLegs,
  fxQuotes,
  paymentInstructions,
  providerCommands,
  reconciliationRecords,
  requiredDocuments,
  workContracts,
} from '../db/schema.js';
import type { Select } from '../db/store.js';
import { requireOwnership, requireReadAccess, requireRole, type Principal } from '../auth/authorization.js';
import { bookIdFor, resolve } from '../corridor/service.js';
import { evaluate, type ComplianceDecision } from '../compliance/engine.js';
import { buildQuote, assertQuoteCurrent, SETTLEMENT_SCALE, totalFeesMinor, type FxQuoteRecord } from '../fx/quote.js';
import { convertMoney, money, parseRate, type Money } from '../money.js';
import { providersForBook, providerCapabilitiesSatisfied, type CorridorProviders } from './providers.js';
import { escrowBindingCommitment, releaseBindingCommitment, type EscrowBindingInput, type ReleaseBinding } from '../algorand/executor-client.js';
import { fabricTransactionHash, workEvidenceHash } from '../fabric/evidence-reader.js';
import { IdentityService } from '../identity/service.js';
import { SubmissionService } from '../submissions/service.js';
import { FIXTURE_RATES } from '../fx/rates.js';

export type Payment = Select<typeof paymentInstructions>;

/** How long a release authorization stays valid once minted. */
export const RELEASE_AUTHORIZATION_TTL_SECONDS = 600;

export interface CreatePaymentInput {
  readonly contractId: string;
  readonly fundingAmount: Money;
  readonly purposeCode?: string;
}

export interface SupplierPaymentInput {
  readonly contractId: string;
  readonly fundingAmount: Money;
  readonly invoiceReference: string;
}

export class PaymentService {
  private readonly identity: IdentityService;
  private readonly submissions: SubmissionService;

  constructor(private readonly context: AppContext) {
    this.identity = new IdentityService(context);
    this.submissions = new SubmissionService(context);
  }

  private actor(principal: Principal) {
    return { subject: principal.subject, role: principal.roles[0] ?? 'unknown' };
  }

  /**
   * Creates the payment instruction.
   *
   * Corridor, credentials, quote and compliance are all resolved here so that
   * the decision the release later commits to is fixed before any money moves.
   */
  async create(principal: Principal, input: CreatePaymentInput): Promise<{
    payment: Payment;
    quote: FxQuoteRecord;
    compliance: ComplianceDecision;
    corridor: CorridorPolicy;
  }> {
    requireRole(principal, 'company_member', 'supplier', 'platform_admin', 'payments_service');
    const contract = await this.requireContract(input.contractId);
    requireOwnership(principal, contract.buyerOrganizationId);
    if (!['RULES_VERIFIED', 'FX_LOCKED'].includes(contract.state)) {
      throw conflict(`Contract ${contract.id} must be approved by both parties before payment.`);
    }
    const existing = await this.context.store.findOne(paymentInstructions, { contractId: contract.id });
    if (existing) return this.hydrate(existing);

    const { origin, destination } = await this.parties(contract.buyerOrganizationId, contract.providerOrganizationId);
    const corridor = resolve(origin.country, destination.country);
    const bookId = corridor.bookId;
    const providers = providersForBook(bookId);
    const capabilities = providerCapabilitiesSatisfied(providers, corridor.policy.requiredProviderCapabilities);
    if (!capabilities.satisfied) {
      throw unprocessable('No configured provider holds the capabilities this corridor requires.', {
        missing: capabilities.missing,
      });
    }

    await this.context.timeline.append({
      kind: 'CORRIDOR_RESOLVED',
      actor: this.actor(principal),
      contractId: contract.id,
      detail: {
        corridorId: corridor.policy.id,
        bookId,
        direction: corridor.policy.direction,
        originCountry: corridor.policy.originCountry,
        destinationCountry: corridor.policy.destinationCountry,
        policyVersion: corridor.policy.sourceVersion,
      },
    });

    const quote = await this.quote(contract.id, corridor.policy, input.fundingAmount);
    const compliance = await this.evaluateCompliance(
      principal,
      contract.id,
      corridor.policy,
      quote,
      origin.credentialId,
      destination.credentialId,
    );
    if (compliance.outcome === 'BLOCKED') {
      throw unprocessable('The corridor rules block this payment.', {
        complianceResultId: compliance.id,
        reasons: compliance.reasons,
      });
    }

    const now = this.context.clock.now().toISOString();
    const payment = await this.context.store.insert(paymentInstructions, {
      id: this.context.ids.next('PAY'),
      contractId: contract.id,
      corridorId: corridor.policy.id,
      direction: corridor.policy.direction,
      bookId,
      quoteId: quote.id,
      complianceResultId: compliance.id,
      state: (compliance.outcome === 'MANUAL_REVIEW' ? 'MANUAL_REVIEW' : 'QUOTED') satisfies PaymentState,
      fundingAmountMinor: quote.fundingAmount.amountMinor,
      fundingCurrency: quote.fundingAmount.currency,
      fundingScale: quote.fundingAmount.scale,
      payoutAmountMinor: quote.payoutAmount.amountMinor,
      payoutCurrency: quote.payoutAmount.currency,
      payoutScale: quote.payoutAmount.scale,
      createdAt: now,
      updatedAt: now,
    });
    await this.context.store.update(workContracts, { id: contract.id }, { state: 'FX_LOCKED', updatedAt: now });
    await this.context.timeline.append({
      kind: 'PAYMENT_CREATED',
      actor: this.actor(principal),
      contractId: contract.id,
      paymentId: payment.id,
      detail: {
        paymentId: payment.id,
        corridorId: corridor.policy.id,
        bookId,
        state: payment.state,
        quoteId: quote.id,
        quoteHash: quote.canonicalHash,
        complianceResultId: compliance.id,
        complianceHash: compliance.canonicalHash,
        outcome: compliance.outcome,
      },
    });
    return { payment, quote, compliance, corridor: corridor.policy };
  }

  /**
   * Debits the buyer's simulated fiat book, converts to USD, creates the escrow
   * and locks USDC. Fiat and escrow move in one durable step so the books and
   * the chain cannot disagree about whether funding happened.
   */
  async fund(principal: Principal, paymentId: string, idempotencyKey: string) {
    requireRole(principal, 'company_member', 'provider_operator', 'platform_admin', 'payments_service');
    const payment = await this.requirePayment(paymentId);
    const contract = await this.requireContract(payment.contractId);
    requireOwnership(principal, contract.buyerOrganizationId);
    if (payment.state === 'USDC_LOCKED' || payment.state === 'WORK_PENDING') {
      return this.hydrate(payment);
    }
    if (payment.state !== 'QUOTED') {
      throw conflict(`Payment ${paymentId} cannot be funded from state ${payment.state}.`);
    }

    const { quote, compliance } = await this.hydrate(payment);
    assertQuoteCurrent({ id: quote.id, expiresAt: quote.expiresAt }, this.context.clock.now());
    if (compliance.outcome !== 'PASSED') {
      throw conflict('Funding requires a passed compliance decision.');
    }
    const providers = providersForBook(payment.bookId);

    const accounts = await this.accounts(payment, contract, providers, quote);
    // 1. The buyer's funding currency leaves their book.
    await this.context.ledger.post({
      bookId: payment.bookId,
      direction: payment.direction as 'INWARD' | 'OUTWARD',
      reference: `${payment.id}:FIAT_FUNDING`,
      memo: `Simulated ${quote.fundingAmount.currency} debit for ${payment.id}`,
      paymentId: payment.id,
      lines: [
        { accountId: accounts.customerFunding, side: 'DEBIT', amount: quote.fundingAmount },
        { accountId: accounts.originFunding, side: 'CREDIT', amount: quote.fundingAmount },
      ],
    });
    // 2. The origin provider converts to USD and takes its fee.
    const originFee = quote.fees.find((fee) => fee.code === 'ORIGIN_AND_PLATFORM')!.amount;
    await this.context.ledger.post({
      bookId: payment.bookId,
      direction: payment.direction as 'INWARD' | 'OUTWARD',
      reference: `${payment.id}:USD_CONVERSION`,
      memo: `Simulated ${quote.fundingAmount.currency} to USD conversion for ${payment.id}`,
      paymentId: payment.id,
      lines: [
        { accountId: accounts.originSettlementUsd, side: 'DEBIT', amount: quote.grossSettlementAmount },
        { accountId: accounts.feeIncomeUsd, side: 'CREDIT', amount: originFee },
        { accountId: accounts.escrowControlUsd, side: 'CREDIT', amount: quote.settlementAmount },
      ],
    });
    let current = await this.transition(payment, 'FIAT_FUNDED');
    await this.context.timeline.append({
      kind: 'FIAT_FUNDED',
      actor: this.actor(principal),
      contractId: contract.id,
      paymentId: payment.id,
      detail: {
        paymentId: payment.id,
        bookId: payment.bookId,
        fundingMinor: quote.fundingAmount.amountMinor,
        fundingCurrency: quote.fundingAmount.currency,
        settlementUsdMinor: quote.settlementAmount.amountMinor,
      },
    });

    // 3. Create and fund the on-chain escrow between the two provider treasuries.
    const binding = await this.binding(payment, contract, providers, quote);
    const created = await this.context.escrow.create(binding.input, `${idempotencyKey}:CREATE`);
    await this.recordCommand(payment.id, 'create', `${idempotencyKey}:CREATE`, binding.input, created);
    current = await this.transition(current, 'ESCROW_CREATED');
    await this.context.store.update(escrowBindings, { paymentId: payment.id }, {
      state: 'CREATED',
      updatedAt: this.context.clock.now().toISOString(),
    });
    await this.context.timeline.append({
      kind: 'ESCROW_CREATED',
      actor: this.actor(principal),
      contractId: contract.id,
      paymentId: payment.id,
      detail: {
        paymentId: payment.id,
        dealId: binding.input.dealId,
        network: binding.input.network,
        applicationId: binding.input.applicationId,
        assetId: binding.input.assetId,
        transactionId: created.transactionId,
        escrowBindingHash: binding.hash,
      },
    });

    const funded = await this.context.escrow.fund(binding.input.dealId, `${idempotencyKey}:FUND`);
    await this.recordCommand(payment.id, 'fund', `${idempotencyKey}:FUND`, { dealId: binding.input.dealId }, funded);
    await this.context.store.update(escrowBindings, { paymentId: payment.id }, {
      state: funded.escrow.state,
      updatedAt: this.context.clock.now().toISOString(),
    });
    current = await this.transition(current, 'USDC_LOCKED');
    await this.context.timeline.append({
      kind: 'USDC_LOCKED',
      actor: this.actor(principal),
      contractId: contract.id,
      paymentId: payment.id,
      detail: {
        paymentId: payment.id,
        dealId: binding.input.dealId,
        lockedMinor: funded.escrow.lockedMinor,
        transactionId: funded.transactionId,
      },
    });

    current = await this.transition(current, 'WORK_PENDING');
    await this.context.store.update(workContracts, { id: contract.id }, {
      state: 'ESCROW_FUNDED',
      updatedAt: this.context.clock.now().toISOString(),
    });
    return this.hydrate(current);
  }

  /**
   * Authorizes and performs the single release.
   *
   * The authorization commits to the escrow, the exact approved Fabric work
   * version, the Fabric approval transaction, the compliance decision, the FX
   * quote, a one-time generation, the idempotency key and an expiry. The
   * executor re-reads Fabric itself before it signs, so this API's view is
   * never the only thing standing between an unapproved version and a payout.
   */
  async release(principal: Principal, paymentId: string, idempotencyKey: string) {
    requireRole(principal, 'company_member', 'provider_operator', 'platform_admin', 'payments_service');
    const payment = await this.requirePayment(paymentId);
    const contract = await this.requireContract(payment.contractId);
    requireOwnership(principal, contract.buyerOrganizationId);
    if (payment.state === 'COMPLETED') return this.hydrate(payment);
    if (payment.state !== 'WORK_PENDING') {
      throw conflict(`Payment ${paymentId} cannot be released from state ${payment.state}.`);
    }

    const approved = await this.submissions.latestApproved(contract.id);
    if (!approved?.fabricTxId) {
      throw conflict('A release needs a Fabric-recorded buyer approval for the current work version.');
    }
    const evidence = await this.context.fabric.read(contract.id, contract.milestoneId);
    if (!evidence || evidence.buyerDecision !== 'APPROVED') {
      throw conflict('Fabric does not currently hold an approved version for this milestone.');
    }
    const currentEvidenceHash = workEvidenceHash(evidence);
    if (currentEvidenceHash !== approved.evidenceHash || evidence.fabricTxId !== approved.fabricTxId) {
      throw conflict('The Fabric work evidence changed after the buyer approval was recorded.');
    }

    const { quote, compliance } = await this.hydrate(payment);
    const bindingRow = await this.requireBinding(payment.id);
    const escrowInput = this.toEscrowInput(bindingRow);
    const generation = (await this.context.store.findMany(providerCommands, { paymentId: payment.id, action: 'release' })).length + 1;
    const expiresAt = new Date(this.context.clock.now().getTime() + RELEASE_AUTHORIZATION_TTL_SECONDS * 1_000).toISOString();
    const releaseIdempotencyKey = `${idempotencyKey}:RELEASE`;

    const releaseBinding: ReleaseBinding = {
      escrowBindingHash: escrowBindingCommitment(escrowInput),
      workEvidenceHash: currentEvidenceHash,
      fabricTxHash: fabricTransactionHash(evidence.fabricTxId),
      complianceResultHash: compliance.canonicalHash,
      fxQuoteHash: quote.canonicalHash,
      generation,
      idempotencyKey: releaseIdempotencyKey,
      expiresAt,
    };
    const command = {
      escrowBinding: escrowInput,
      milestoneId: contract.milestoneId,
      amountMinor: escrowInput.amount.amountMinor,
      intentId: `${payment.id}-G${generation}`,
      bindingHash: bindingRow.bindingHash,
      fenceGeneration: generation,
      leaseExpiresAt: expiresAt,
      authorizationCommitment: releaseBindingCommitment(releaseBinding),
      fabricClaimTransactionId: evidence.fabricTxId,
      releaseBinding,
    };

    let current = await this.transition(payment, 'RELEASE_AUTHORIZED');
    await this.context.store.update(workContracts, { id: contract.id }, {
      state: 'RELEASE_AUTHORIZED',
      updatedAt: this.context.clock.now().toISOString(),
    });
    await this.context.timeline.append({
      kind: 'RELEASE_AUTHORIZED',
      actor: this.actor(principal),
      contractId: contract.id,
      paymentId: payment.id,
      detail: {
        paymentId: payment.id,
        generation,
        expiresAt,
        authorizationCommitment: command.authorizationCommitment,
        workEvidenceHash: releaseBinding.workEvidenceHash,
        fabricTxHash: releaseBinding.fabricTxHash,
        complianceResultHash: releaseBinding.complianceResultHash,
        fxQuoteHash: releaseBinding.fxQuoteHash,
      },
    });

    const released = await this.context.escrow.release(command, releaseIdempotencyKey);
    await this.recordCommand(payment.id, 'release', releaseIdempotencyKey, command, released);
    await this.context.store.update(escrowBindings, { paymentId: payment.id }, {
      state: released.escrow.state,
      updatedAt: this.context.clock.now().toISOString(),
    });
    current = await this.transition(current, 'USDC_RELEASED');
    await this.context.store.update(workContracts, { id: contract.id }, {
      state: 'ESCROW_RELEASED',
      updatedAt: this.context.clock.now().toISOString(),
    });
    await this.context.timeline.append({
      kind: 'USDC_RELEASED',
      actor: this.actor(principal),
      contractId: contract.id,
      paymentId: payment.id,
      detail: {
        paymentId: payment.id,
        dealId: escrowInput.dealId,
        transactionId: released.transactionId,
        releasedMinor: released.escrow.releasedMinor,
        explorerUrl: this.explorerUrl(released.transactionId),
      },
    });

    // The destination provider converts USD to the payout currency and credits
    // the beneficiary's simulated wallet.
    const providers = providersForBook(payment.bookId);
    const accounts = await this.accounts(payment, contract, providers, quote);
    await this.context.ledger.post({
      bookId: payment.bookId,
      direction: payment.direction as 'INWARD' | 'OUTWARD',
      reference: `${payment.id}:USDC_RELEASE`,
      memo: `Escrow release to the destination provider for ${payment.id}`,
      paymentId: payment.id,
      lines: [
        { accountId: accounts.escrowControlUsd, side: 'DEBIT', amount: quote.settlementAmount },
        { accountId: accounts.destinationSettlementUsd, side: 'CREDIT', amount: quote.settlementAmount },
      ],
    });
    const destinationFee = quote.fees.find((fee) => fee.code === 'DESTINATION_OFFRAMP')!.amount;
    await this.context.ledger.post({
      bookId: payment.bookId,
      direction: payment.direction as 'INWARD' | 'OUTWARD',
      reference: `${payment.id}:PAYOUT`,
      memo: `Simulated USD to ${quote.payoutAmount.currency} payout for ${payment.id}`,
      paymentId: payment.id,
      lines: [
        { accountId: accounts.destinationPayout, side: 'DEBIT', amount: quote.grossPayoutAmount },
        { accountId: accounts.feeIncomePayout, side: 'CREDIT', amount: destinationFee },
        { accountId: accounts.beneficiaryWallet, side: 'CREDIT', amount: quote.payoutAmount },
      ],
    });
    current = await this.transition(current, 'PAYOUT_CREDITED');
    await this.context.timeline.append({
      kind: 'PAYOUT_CREDITED',
      actor: this.actor(principal),
      contractId: contract.id,
      paymentId: payment.id,
      detail: {
        paymentId: payment.id,
        payoutMinor: quote.payoutAmount.amountMinor,
        payoutCurrency: quote.payoutAmount.currency,
        beneficiaryAccountId: accounts.beneficiaryWallet,
      },
    });

    const completed = await this.context.escrow.complete(escrowInput.dealId, `${idempotencyKey}:COMPLETE`);
    await this.recordCommand(payment.id, 'complete', `${idempotencyKey}:COMPLETE`, { dealId: escrowInput.dealId }, completed);
    current = await this.transition(current, 'COMPLETED');
    await this.context.store.update(workContracts, { id: contract.id }, {
      state: 'COMPLETED',
      updatedAt: this.context.clock.now().toISOString(),
    });
    await this.reconcile(payment.id);
    await this.context.timeline.append({
      kind: 'PAYMENT_COMPLETED',
      actor: this.actor(principal),
      contractId: contract.id,
      paymentId: payment.id,
      detail: { paymentId: payment.id, dealId: escrowInput.dealId, transactionId: released.transactionId },
    });
    return this.hydrate(await this.requirePayment(paymentId));
  }

  /** Refunds locked USDC to the origin provider and the buyer's fiat book. */
  async refund(principal: Principal, paymentId: string, idempotencyKey: string, reason: string) {
    requireRole(principal, 'company_member', 'provider_operator', 'platform_admin', 'payments_service');
    const payment = await this.requirePayment(paymentId);
    const contract = await this.requireContract(payment.contractId);
    requireOwnership(principal, contract.buyerOrganizationId);
    if (payment.state === 'REFUNDED') return this.hydrate(payment);
    if (!['FIAT_FUNDED', 'ESCROW_CREATED', 'USDC_LOCKED', 'WORK_PENDING', 'MANUAL_REVIEW'].includes(payment.state)) {
      throw conflict(`Payment ${paymentId} cannot be refunded from state ${payment.state}.`);
    }

    const { quote } = await this.hydrate(payment);
    const bindingRow = await this.context.store.findOne(escrowBindings, { paymentId: payment.id });
    if (bindingRow) {
      const refunded = await this.context.escrow.refund(bindingRow.dealId, `${idempotencyKey}:REFUND`);
      await this.recordCommand(payment.id, 'refund', `${idempotencyKey}:REFUND`, { dealId: bindingRow.dealId }, refunded);
      await this.context.store.update(escrowBindings, { paymentId: payment.id }, {
        state: refunded.escrow.state,
        updatedAt: this.context.clock.now().toISOString(),
      });
      const providers = providersForBook(payment.bookId);
      const accounts = await this.accounts(payment, contract, providers, quote);
      await this.context.ledger.post({
        bookId: payment.bookId,
        direction: payment.direction as 'INWARD' | 'OUTWARD',
        reference: `${payment.id}:USDC_REFUND`,
        memo: `Escrow refund to the origin provider for ${payment.id}`,
        paymentId: payment.id,
        lines: [
          { accountId: accounts.escrowControlUsd, side: 'DEBIT', amount: quote.settlementAmount },
          { accountId: accounts.originSettlementUsd, side: 'CREDIT', amount: quote.settlementAmount },
        ],
      });
      await this.context.ledger.post({
        bookId: payment.bookId,
        direction: payment.direction as 'INWARD' | 'OUTWARD',
        reference: `${payment.id}:FIAT_REFUND`,
        memo: `Simulated ${quote.fundingAmount.currency} refund for ${payment.id}`,
        paymentId: payment.id,
        lines: [
          { accountId: accounts.originFunding, side: 'DEBIT', amount: quote.fundingAmount },
          { accountId: accounts.customerFunding, side: 'CREDIT', amount: quote.fundingAmount },
        ],
      });
    }
    const refundedPayment = await this.transition(payment, 'REFUNDED');
    await this.context.timeline.append({
      kind: 'PAYMENT_REFUNDED',
      actor: this.actor(principal),
      contractId: contract.id,
      paymentId: payment.id,
      detail: { paymentId: payment.id, reason: reason.slice(0, 240) },
    });
    return this.hydrate(refundedPayment);
  }

  /**
   * Compares the durable projection against the executor's confirmed evidence
   * and against the books. A mismatch is recorded, never silently repaired.
   */
  async reconcile(paymentId: string) {
    const payment = await this.requirePayment(paymentId);
    const bindingRow = await this.context.store.findOne(escrowBindings, { paymentId });
    const onChain = bindingRow ? await this.context.escrow.get(bindingRow.dealId) : null;
    const balanced = await this.context.ledger.bookIsBalanced(payment.bookId);

    const expected = {
      escrowState: bindingRow?.state ?? 'NONE',
      amountUsdcMinor: bindingRow?.amountUsdcMinor ?? '0',
      booksBalanced: true,
    };
    const observed = {
      escrowState: onChain?.state ?? 'NONE',
      amountUsdcMinor: onChain?.amount.amountMinor ?? '0',
      booksBalanced: balanced,
    };
    const matched = expected.escrowState === observed.escrowState
      && expected.amountUsdcMinor === observed.amountUsdcMinor
      && balanced;

    const record = await this.context.store.insert(reconciliationRecords, {
      id: this.context.ids.next('REC'),
      paymentId,
      scope: 'ESCROW_AND_BOOKS',
      status: matched ? 'MATCHED' : 'MISMATCHED',
      expected,
      observed,
      detail: matched
        ? 'The durable projection, the settlement ledger and the simulated books agree.'
        : 'The durable projection disagrees with the settlement ledger or the books.',
      checkedAt: this.context.clock.now().toISOString(),
    });
    if (!matched && payment.state !== 'FAILED_RECONCILIATION') {
      await this.context.store.update(paymentInstructions, { id: paymentId }, {
        state: 'FAILED_RECONCILIATION' satisfies PaymentState,
        updatedAt: this.context.clock.now().toISOString(),
      });
    }
    return record;
  }

  async timeline(principal: Principal, paymentId: string) {
    const payment = await this.requirePayment(paymentId);
    const contract = await this.requireContract(payment.contractId);
    requireReadAccess(principal, contract.buyerOrganizationId, contract.providerOrganizationId);
    const [contractEvents, paymentEvents] = await Promise.all([
      this.context.timeline.forContract(contract.id),
      this.context.timeline.forPayment(paymentId),
    ]);
    const merged = [...contractEvents, ...paymentEvents]
      .filter((event, index, all) => all.findIndex((other) => other.id === event.id) === index)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.sequence - right.sequence);
    const [reconciliation] = await this.context.store.findMany(
      reconciliationRecords,
      { paymentId },
      { orderBy: 'checkedAt', direction: 'desc', limit: 1 },
    );
    const commands = await this.context.store.findMany(providerCommands, { paymentId }, { orderBy: 'createdAt' });
    const binding = await this.context.store.findOne(escrowBindings, { paymentId });
    const submissions = await this.submissions.list(contract.id);
    return {
      payment,
      contract,
      events: merged,
      commands,
      binding,
      submissions,
      reconciliation: reconciliation ?? null,
      explorerBaseUrl: this.context.config.algorand.explorerBaseUrl,
    };
  }

  /**
   * Rebuilds the stored quote and compliance decision for a payment.
   *
   * Both are read back from PostgreSQL rather than recomputed, because a
   * release commits to the exact hashes that were recorded at decision time.
   */
  async hydrate(payment: Payment): Promise<{
    payment: Payment;
    quote: FxQuoteRecord;
    compliance: ComplianceDecision;
    corridor: CorridorPolicy;
  }> {
    const quoteRow = await this.context.store.findOne(fxQuotes, { id: payment.quoteId });
    if (!quoteRow) throw notFound(`Payment ${payment.id} has no stored FX quote.`);
    const complianceRow = await this.context.store.findOne(complianceResults, { id: payment.complianceResultId });
    if (!complianceRow) throw notFound(`Payment ${payment.id} has no stored compliance decision.`);
    const documents = await this.context.store.findMany(requiredDocuments, { complianceResultId: complianceRow.id }, { orderBy: 'code' });
    const [originCountry, destinationCountry] = payment.corridorId.split('-');
    const corridor = resolve(originCountry ?? '', destinationCountry ?? '');

    const compliance: ComplianceDecision = {
      id: complianceRow.id,
      corridorId: complianceRow.corridorId,
      bookId: payment.bookId,
      outcome: complianceRow.outcome as ComplianceDecision['outcome'],
      reasons: complianceRow.reasons,
      requiredDocuments: documents.map((document) => ({
        code: document.code,
        satisfied: document.satisfied,
        reason: 'Recorded at decision time.',
        citation: {
          sourceUri: corridor.policy.sourceUri,
          sourceVersion: complianceRow.policyVersion,
          section: 'Recorded at decision time.',
          quote: 'Recorded at decision time.',
        },
      })),
      appliedRules: [],
      citations: [],
      policyVersion: complianceRow.policyVersion,
      rulesVersion: complianceRow.rulesVersion,
      evaluatedAt: complianceRow.evaluatedAt,
      canonicalHash: complianceRow.canonicalHash,
    };
    return {
      payment,
      quote: quoteRow.quote as unknown as FxQuoteRecord,
      compliance,
      corridor: corridor.policy,
    };
  }

  // ---- internals ---------------------------------------------------------

  private async quote(contractId: string, policy: CorridorPolicy, fundingAmount: Money): Promise<FxQuoteRecord> {
    const now = this.context.clock.now();
    const rates = await this.context.rates.rates(policy, now);
    const quote = buildQuote({
      id: this.context.ids.next('FXQ'),
      policy,
      fundingAmount,
      rates,
      quotedAt: now,
      ttlSeconds: this.context.config.fx.quoteTtlSeconds,
    });
    await this.context.store.insert(fxQuotes, {
      id: quote.id,
      contractId,
      corridorId: policy.id,
      fundingAmountMinor: quote.fundingAmount.amountMinor,
      fundingCurrency: quote.fundingAmount.currency,
      fundingScale: quote.fundingAmount.scale,
      settlementAmountMinor: quote.settlementAmount.amountMinor,
      settlementScale: SETTLEMENT_SCALE,
      payoutAmountMinor: quote.payoutAmount.amountMinor,
      payoutCurrency: quote.payoutAmount.currency,
      payoutScale: quote.payoutAmount.scale,
      feesMinorTotal: totalFeesMinor(quote),
      provider: quote.provider,
      rateSource: quote.rateSource.slice(0, 32),
      rateObservedAt: quote.rateObservedAt,
      quotedAt: quote.quotedAt,
      expiresAt: quote.expiresAt,
      canonicalHash: quote.canonicalHash,
      quote: quote as unknown as Record<string, unknown>,
    });
    for (const leg of quote.legs) {
      await this.context.store.insert(fxQuoteLegs, {
        id: this.context.ids.next('FXL'),
        quoteId: quote.id,
        ordinal: leg.ordinal,
        pair: leg.pair,
        rateUnits: leg.rateUnits,
        rateScale: leg.rateScale,
        fromAmountMinor: leg.from.amountMinor,
        toAmountMinor: leg.to.amountMinor,
      });
    }
    await this.context.timeline.append({
      kind: 'FX_QUOTED',
      actor: { subject: 'optiwork-fx', role: 'payments_service' },
      contractId,
      detail: {
        quoteId: quote.id,
        corridorId: policy.id,
        rateSource: quote.rateSource,
        rateObservedAt: quote.rateObservedAt,
        expiresAt: quote.expiresAt,
        canonicalHash: quote.canonicalHash,
        settlementUsdMinor: quote.settlementAmount.amountMinor,
        payoutMinor: quote.payoutAmount.amountMinor,
        payoutCurrency: quote.payoutAmount.currency,
      },
    });
    return quote;
  }

  private async evaluateCompliance(
    principal: Principal,
    contractId: string,
    policy: CorridorPolicy,
    quote: FxQuoteRecord,
    originCredentialId: string,
    destinationCredentialId: string,
  ): Promise<ComplianceDecision> {
    const providedDocuments = await this.submissions.documentCodes(contractId);
    const decision = evaluate({
      id: this.context.ids.next('CMP'),
      policy,
      inrEquivalent: this.inrEquivalent(quote),
      originCredential: await this.identity.snapshot(originCredentialId),
      destinationCredential: await this.identity.snapshot(destinationCredentialId),
      providedDocuments,
      evaluatedAt: this.context.clock.now(),
    });
    await this.context.store.insert(complianceResults, {
      id: decision.id,
      contractId,
      corridorId: decision.corridorId,
      outcome: decision.outcome,
      reasons: [...decision.reasons],
      policyVersion: decision.policyVersion,
      rulesVersion: decision.rulesVersion,
      evaluatedAt: decision.evaluatedAt,
      canonicalHash: decision.canonicalHash,
    });
    for (const document of decision.requiredDocuments) {
      await this.context.store.insert(requiredDocuments, {
        id: this.context.ids.next('RQD'),
        complianceResultId: decision.id,
        code: document.code,
        satisfied: document.satisfied,
        documentHashId: null,
      });
    }
    await this.context.timeline.append({
      kind: 'COMPLIANCE_EVALUATED',
      actor: this.actor(principal),
      contractId,
      detail: {
        complianceResultId: decision.id,
        outcome: decision.outcome,
        rulesVersion: decision.rulesVersion,
        policyVersion: decision.policyVersion,
        appliedRules: [...decision.appliedRules],
        reasons: [...decision.reasons],
        canonicalHash: decision.canonicalHash,
      },
    });
    return decision;
  }

  /**
   * The Indian value rules compare against an INR amount. For an inward payment
   * that is the INR the freelancer receives; for an outward payment it is the
   * INR the Indian buyer funds. Both are exact integers.
   */
  private inrEquivalent(quote: FxQuoteRecord): Money {
    if (quote.payoutAmount.currency === 'INR') return quote.payoutAmount;
    if (quote.fundingAmount.currency === 'INR') return quote.fundingAmount;
    const usdToInr = parseRate(
      (1 / Number(FIXTURE_RATES['INR']!.toUsd)).toFixed(6),
    );
    return convertMoney(quote.settlementAmount, 'INR', 2, usdToInr);
  }

  private async parties(buyerOrganizationId: string, providerOrganizationId: string) {
    const originCredential = await this.identity.forOrganization(buyerOrganizationId);
    const destinationCredential = await this.identity.forOrganization(providerOrganizationId);
    if (!originCredential || !destinationCredential) {
      throw unprocessable('Both parties must hold a registered credential before a payment can be created.');
    }
    return {
      origin: { country: originCredential.country, credentialId: originCredential.id },
      destination: { country: destinationCredential.country, credentialId: destinationCredential.id },
    };
  }

  private async binding(
    payment: Payment,
    contract: Select<typeof workContracts>,
    providers: CorridorProviders,
    quote: FxQuoteRecord,
  ) {
    const existing = await this.context.store.findOne(escrowBindings, { paymentId: payment.id });
    if (existing) return { row: existing, input: this.toEscrowInput(existing), hash: existing.bindingHash };

    const network = this.context.config.algorand.network;
    const input: EscrowBindingInput = {
      dealId: contract.id,
      agreementHash: contract.contractHash,
      originProviderAddress: providers.origin.address,
      destinationProviderAddress: providers.destination.address,
      // LocalNet mints OptiUSD-DEMO; TestNet uses Circle's official USDC ASA.
      assetId: network === 'testnet' ? 10_458_941 : 1,
      amount: {
        amountMinor: quote.settlementAmount.amountMinor,
        currency: 'USD',
        scale: SETTLEMENT_SCALE,
      },
      network,
      genesisHash: network === 'testnet'
        ? 'SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI='
        : 'localnet-demo-genesis-hash',
      applicationId: '1',
    };
    const hash = escrowBindingCommitment(input);
    const now = this.context.clock.now().toISOString();
    const row = await this.context.store.insert(escrowBindings, {
      id: this.context.ids.next('ESC'),
      paymentId: payment.id,
      dealId: input.dealId,
      paymentKey: canonicalHash({ paymentId: payment.id, contractId: contract.id }),
      agreementHash: input.agreementHash,
      network: input.network,
      genesisHash: input.genesisHash,
      applicationId: input.applicationId,
      assetId: String(input.assetId),
      originProviderAddress: input.originProviderAddress,
      destinationProviderAddress: input.destinationProviderAddress,
      amountUsdcMinor: input.amount.amountMinor,
      scale: SETTLEMENT_SCALE,
      bindingHash: hash,
      state: 'PENDING',
      createdAt: now,
      updatedAt: now,
    });
    return { row, input, hash };
  }

  private toEscrowInput(row: Select<typeof escrowBindings>): EscrowBindingInput {
    return {
      dealId: row.dealId,
      agreementHash: row.agreementHash,
      originProviderAddress: row.originProviderAddress,
      destinationProviderAddress: row.destinationProviderAddress,
      assetId: Number(row.assetId),
      amount: { amountMinor: row.amountUsdcMinor, currency: 'USD', scale: row.scale },
      network: row.network as 'localnet' | 'testnet',
      genesisHash: row.genesisHash,
      applicationId: row.applicationId,
    };
  }

  private async accounts(
    payment: Payment,
    contract: Select<typeof workContracts>,
    providers: CorridorProviders,
    quote: FxQuoteRecord,
  ) {
    const bookId = payment.bookId;
    const direction = payment.direction as 'INWARD' | 'OUTWARD';
    const fundingCurrency = quote.fundingAmount.currency;
    const fundingScale = quote.fundingAmount.scale;
    const payoutCurrency = quote.payoutAmount.currency;
    const payoutScale = quote.payoutAmount.scale;

    const [
      customerFunding, originFunding, originSettlementUsd, escrowControlUsd,
      feeIncomeUsd, destinationSettlementUsd, destinationPayout, feeIncomePayout, beneficiaryWallet,
    ] = await Promise.all([
      this.context.ledger.account({ bookId, direction, ownerKind: 'ORGANIZATION', ownerId: contract.buyerOrganizationId, accountType: 'CUSTOMER_FUNDING', currency: fundingCurrency, scale: fundingScale }),
      this.context.ledger.account({ bookId, direction, ownerKind: 'PROVIDER', ownerId: providers.origin.id, accountType: 'PROVIDER_SETTLEMENT', currency: fundingCurrency, scale: fundingScale }),
      this.context.ledger.account({ bookId, direction, ownerKind: 'PROVIDER', ownerId: providers.origin.id, accountType: 'PROVIDER_SETTLEMENT', currency: 'USD', scale: SETTLEMENT_SCALE }),
      this.context.ledger.account({ bookId, direction, ownerKind: 'PLATFORM', ownerId: 'OPTIWORK', accountType: 'ESCROW_CONTROL', currency: 'USD', scale: SETTLEMENT_SCALE }),
      this.context.ledger.account({ bookId, direction, ownerKind: 'PLATFORM', ownerId: 'OPTIWORK', accountType: 'PROVIDER_FEE_INCOME', currency: 'USD', scale: SETTLEMENT_SCALE }),
      this.context.ledger.account({ bookId, direction, ownerKind: 'PROVIDER', ownerId: providers.destination.id, accountType: 'PROVIDER_SETTLEMENT', currency: 'USD', scale: SETTLEMENT_SCALE }),
      this.context.ledger.account({ bookId, direction, ownerKind: 'PROVIDER', ownerId: providers.destination.id, accountType: 'PROVIDER_SETTLEMENT', currency: payoutCurrency, scale: payoutScale }),
      this.context.ledger.account({ bookId, direction, ownerKind: 'PLATFORM', ownerId: 'OPTIWORK', accountType: 'PROVIDER_FEE_INCOME', currency: payoutCurrency, scale: payoutScale }),
      this.context.ledger.account({ bookId, direction, ownerKind: 'ORGANIZATION', ownerId: contract.providerOrganizationId, accountType: 'BENEFICIARY_WALLET', currency: payoutCurrency, scale: payoutScale }),
    ]);
    return {
      customerFunding, originFunding, originSettlementUsd, escrowControlUsd,
      feeIncomeUsd, destinationSettlementUsd, destinationPayout, feeIncomePayout, beneficiaryWallet,
    };
  }

  private async recordCommand(
    paymentId: string,
    action: string,
    idempotencyKey: string,
    request: unknown,
    outcome: { transactionId: string; replay: boolean; escrow: { state: string } },
  ) {
    const now = this.context.clock.now().toISOString();
    const existing = await this.context.store.findOne(providerCommands, { idempotencyKey });
    if (existing) {
      await this.context.store.update(providerCommands, { idempotencyKey }, {
        status: 'CONFIRMED',
        transactionId: outcome.transactionId,
        updatedAt: now,
      });
      return;
    }
    await this.context.store.insert(providerCommands, {
      id: this.context.ids.next('PCMD'),
      paymentId,
      action,
      idempotencyKey,
      requestHash: canonicalHash({ action, request }),
      status: 'CONFIRMED',
      transactionId: outcome.transactionId,
      confirmedRound: null,
      response: { state: outcome.escrow.state, replay: outcome.replay },
      createdAt: now,
      updatedAt: now,
    });
  }

  private async transition(payment: Payment, to: PaymentState): Promise<Payment> {
    const from = payment.state as PaymentState;
    if (from === to) return payment;
    assertPaymentTransition(from, to);
    const [updated] = await this.context.store.update(paymentInstructions, { id: payment.id }, {
      state: to,
      updatedAt: this.context.clock.now().toISOString(),
    });
    return updated ?? payment;
  }

  private explorerUrl(transactionId: string): string {
    return `${this.context.config.algorand.explorerBaseUrl}/transaction/${transactionId}`;
  }

  async requirePayment(paymentId: string): Promise<Payment> {
    const payment = await this.context.store.findOne(paymentInstructions, { id: paymentId });
    if (!payment) throw notFound(`Unknown payment ${paymentId}.`);
    return payment;
  }

  async requireBinding(paymentId: string) {
    const binding = await this.context.store.findOne(escrowBindings, { paymentId });
    if (!binding) throw conflict(`Payment ${paymentId} has no escrow binding.`);
    return binding;
  }

  async requireContract(contractId: string) {
    const contract = await this.context.store.findOne(workContracts, { id: contractId });
    if (!contract) throw notFound(`Unknown contract ${contractId}.`);
    return contract;
  }
}
