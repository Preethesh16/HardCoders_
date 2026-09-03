/**
 * HTTP surface.
 *
 * Every mutation requires an `Idempotency-Key`, enforces role and ownership
 * authorization, produces timeline events, and returns an exact replay for a
 * repeated key. Reads are authorized the same way but never mutate.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Static } from '@sinclair/typebox';
import type { AppContext } from '../context.js';
import { badRequest, unauthorized, unprocessable } from '../errors.js';
import { MarketplaceService } from '../marketplace/service.js';
import { PaymentService } from '../payments/service.js';
import { SubmissionService } from '../submissions/service.js';
import { IdentityService } from '../identity/service.js';
import { listCorridors, resolve } from '../corridor/service.js';
import { buildQuote } from '../fx/quote.js';
import { money } from '../money.js';
import { requireReadAccess, requireRole, type Principal } from '../auth/authorization.js';
import {
  APPROVED_REGULATION_SOURCES,
  approvedCorpusHash,
  explainRegulationRefresh,
  refreshOfficialRegulations,
  retrieveRegulations,
} from '../regulations/index.js';
import { mutate } from './mutation.js';
import { demoState, runWalkthrough } from '../demo/walkthrough.js';
import {
  ApproveContractBody,
  CreateApplicationBody,
  CreateJobBody,
  CreatePaymentBody,
  CreateQuoteBody,
  CreateSubmissionBody,
  DecideSubmissionBody,
  ErrorSchema,
  EvaluateApplicationBody,
  HealthSchema,
  IdParams,
  PrepareAgreementBody,
  RecordDocumentBody,
  RefundPaymentBody,
  ResolveCorridorBody,
  SelectApplicationBody,
  SupplierPaymentBody,
  VerifyCredentialBody,
} from './schemas.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

function principalOf(request: FastifyRequest): Principal {
  if (!request.principal) throw unauthorized();
  return request.principal;
}

const errorResponses = { 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 422: ErrorSchema };

export async function registerRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const marketplace = new MarketplaceService(context);
  const payments = new PaymentService(context);
  const submissions = new SubmissionService(context);
  const identity = new IdentityService(context);

  app.get('/health/live', { schema: { response: { 200: HealthSchema } } }, async () => ({
    name: 'optiwork-api' as const,
    status: 'ok' as const,
    version: context.config.version,
    profile: context.config.profile,
    adapters: {
      storage: context.objects.mode,
      ai: context.ai.mode,
      regulations: context.config.regulations.refreshMode,
      fx: context.config.fx.mode,
      algorand: context.escrow.mode,
      fabric: context.fabric.mode,
      auth: context.config.auth.mode,
      database: context.config.databaseUrl === undefined ? 'memory' : 'postgres',
    },
  }));

  // ---- marketplace -------------------------------------------------------

  app.post('/v1/jobs', {
    schema: { body: CreateJobBody, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    const body = request.body as Static<typeof CreateJobBody>;
    return mutate(context, request, reply, principal, {
      scope: 'jobs.create',
      statusCode: 201,
      run: async () => marketplace.createJob(principal, {
        title: body.title,
        description: body.description,
        skills: body.skills,
        ...(body.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: body.acceptanceCriteria }),
        ...(body.targetDeliveryDate === undefined ? {} : { targetDeliveryDate: body.targetDeliveryDate }),
        destinationCountry: body.destinationCountry,
        budget: money(body.budget.amountMinor, body.budget.currency, body.budget.scale),
      }),
    });
  });

  app.get('/v1/jobs', async (request) => ({ jobs: await marketplace.listJobs(principalOf(request)) }));

  app.get<{ Params: { id: string } }>('/v1/jobs/:id/applications', {
    schema: { params: IdParams },
  }, async (request) => ({
    applications: await marketplace.applicationViews(principalOf(request), request.params.id),
  }));

  app.get('/v1/applications', async (request) => ({
    applications: await marketplace.myApplications(principalOf(request)),
  }));

  app.post<{ Params: { id: string } }>('/v1/jobs/:id/applications', {
    schema: { params: IdParams, body: CreateApplicationBody, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    const body = request.body as Static<typeof CreateApplicationBody>;
    return mutate(context, request, reply, principal, {
      scope: 'applications.create',
      statusCode: 201,
      run: async () => marketplace.apply(principal, request.params.id, {
        coverLetter: body.coverLetter,
        ...(body.approach === undefined ? {} : { approach: body.approach }),
        ...(body.proposedSkills === undefined ? {} : { proposedSkills: body.proposedSkills }),
        ...(body.proposedPrice === undefined ? {} : {
          proposedPrice: money(
            body.proposedPrice.amountMinor,
            body.proposedPrice.currency,
            body.proposedPrice.scale,
          ),
        }),
        ...(body.deliveryDays === undefined ? {} : { deliveryDays: body.deliveryDays }),
        ...(body.deliveryDate === undefined ? {} : { deliveryDate: body.deliveryDate }),
        ...(body.availability === undefined ? {} : { availability: body.availability }),
        ...(body.resumeObjectId === undefined ? {} : { resumeObjectId: body.resumeObjectId }),
      }),
    });
  });

  app.post<{ Params: { id: string } }>('/v1/jobs/:id/applications/rank', {
    schema: { params: IdParams, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    return mutate(context, request, reply, principal, {
      scope: 'applications.rank',
      run: async () => ({ ranking: await marketplace.rankApplications(principal, request.params.id) }),
    });
  });

  /**
   * Advisory evaluation. Passing `select: true` also performs the human act of
   * choosing the applicant and drafting the contract; the AI result never does.
   */
  app.post<{ Params: { id: string } }>('/v1/applications/:id/evaluate', {
    schema: { params: IdParams, body: EvaluateApplicationBody, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    const body = request.body as Static<typeof EvaluateApplicationBody>;
    return mutate(context, request, reply, principal, {
      scope: 'applications.evaluate',
      run: async () => {
        const evaluated = await marketplace.evaluateApplication(principal, request.params.id);
        if (!body.select) return { ...evaluated, contract: null };
        if (!body.amount) throw unprocessable('Selecting an applicant requires the agreed contract amount.');
        const contract = await marketplace.selectApplicant(
          principal,
          request.params.id,
          money(body.amount.amountMinor, body.amount.currency, body.amount.scale),
        );
        return { ...evaluated, contract };
      },
    });
  });

  /** Human assignment is deliberately separate from advisory shortlisting. */
  app.post<{ Params: { id: string } }>('/v1/applications/:id/select', {
    schema: { params: IdParams, body: SelectApplicationBody, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    const body = request.body as Static<typeof SelectApplicationBody>;
    return mutate(context, request, reply, principal, {
      scope: 'applications.select',
      run: async () => marketplace.selectApplicant(
        principal,
        request.params.id,
        money(body.amount.amountMinor, body.amount.currency, body.amount.scale),
      ),
    });
  });

  app.post<{ Params: { id: string } }>('/v1/contracts/:id/approve', {
    schema: { params: IdParams, body: ApproveContractBody, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    const body = request.body as Static<typeof ApproveContractBody>;
    return mutate(context, request, reply, principal, {
      scope: 'contracts.approve',
      run: async () => marketplace.approveContract(principal, request.params.id, body),
    });
  });

  app.post<{ Params: { id: string } }>('/v1/contracts/:id/agreement', {
    schema: { params: IdParams, body: PrepareAgreementBody, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    const body = request.body as Static<typeof PrepareAgreementBody>;
    return mutate(context, request, reply, principal, {
      scope: 'contracts.agreement.prepare',
      run: async () => marketplace.prepareAgreement(principal, request.params.id, body),
    });
  });

  app.get<{ Params: { id: string } }>('/v1/contracts/:id/agreement/access', {
    schema: { params: IdParams, response: errorResponses },
  }, async (request) => marketplace.agreementAccess(principalOf(request), request.params.id));

  app.get<{ Params: { id: string } }>('/v1/contracts/:id', {
    schema: { params: IdParams },
  }, async (request) => {
    const principal = principalOf(request);
    const contract = await marketplace.requireContract(request.params.id);
    requireReadAccess(principal, contract.buyerOrganizationId, contract.providerOrganizationId);
    const isParty = [contract.buyerOrganizationId, contract.providerOrganizationId]
      .includes(principal.organizationId);
    return {
      contract: isParty ? contract : { ...contract, terms: '[PRIVATE AGREEMENT]', agreementTerms: null },
      agreement: marketplace.agreementMetadata(contract),
      approvals: await marketplace.approvals(contract.id),
      submissions: await submissions.list(contract.id),
      timeline: await context.timeline.forContract(contract.id),
    };
  });

  // ---- identity ----------------------------------------------------------

  app.post('/v1/credentials/verify', {
    schema: { body: VerifyCredentialBody, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    const body = request.body as Static<typeof VerifyCredentialBody>;
    return mutate(context, request, reply, principal, {
      scope: 'credentials.verify',
      run: async () => identity.verifyCredential(principal, body),
    });
  });

  // ---- corridor, FX ------------------------------------------------------

  app.get('/v1/corridors', async (request) => {
    requireRole(
      principalOf(request),
      'company_member', 'freelancer', 'supplier', 'provider_operator',
      'platform_admin', 'compliance_service', 'payments_service', 'audit_service',
    );
    return { corridors: listCorridors() };
  });

  app.post('/v1/corridors/resolve', {
    schema: { body: ResolveCorridorBody, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    const body = request.body as Static<typeof ResolveCorridorBody>;
    return mutate(context, request, reply, principal, {
      scope: 'corridors.resolve',
      run: async () => resolve(body.originCountry, body.destinationCountry),
    });
  });

  /**
   * An indicative quote. It is never executable and never moves money; a
   * payment stores its own quote at creation time.
   */
  app.post('/v1/fx/quotes', {
    schema: { body: CreateQuoteBody, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    const body = request.body as Static<typeof CreateQuoteBody>;
    return mutate(context, request, reply, principal, {
      scope: 'fx.quotes',
      run: async () => {
        const corridor = resolve(body.originCountry, body.destinationCountry);
        const now = context.clock.now();
        return buildQuote({
          id: context.ids.next('FXQ'),
          policy: corridor.policy,
          fundingAmount: money(body.fundingAmount.amountMinor, body.fundingAmount.currency, body.fundingAmount.scale),
          rates: await context.rates.rates(corridor.policy, now),
          quotedAt: now,
          ttlSeconds: context.config.fx.quoteTtlSeconds,
        });
      },
    });
  });

  /**
   * Compare the reviewed regulation corpus with its official publishers.
   *
   * A refresh can raise a human-review flag, but it can never rewrite the
   * executable corridor rules. The optional AI step explains the observation
   * only; payment compliance remains deterministic and source-versioned.
   */
  app.post<{ Params: { id: string } }>('/v1/contracts/:id/regulations/refresh', {
    schema: { params: IdParams, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    const contract = await marketplace.requireContract(request.params.id);
    requireReadAccess(principal, contract.buyerOrganizationId, contract.providerOrganizationId);
    return mutate(context, request, reply, principal, {
      scope: 'regulations.refresh',
      run: async () => {
        const report = context.config.regulations.refreshMode === 'live'
          ? await refreshOfficialRegulations()
          : {
              schemaVersion: '1.0' as const,
              checkedAt: context.clock.now().toISOString(),
              approvedCorpusHash: approvedCorpusHash(APPROVED_REGULATION_SOURCES),
              observations: APPROVED_REGULATION_SOURCES.map((source) => ({
                sourceId: source.id,
                approvedVersion: source.approvedVersion,
                sourceUri: source.sourceUri,
                checkedAt: context.clock.now().toISOString(),
                status: 'UNCHANGED' as const,
                missingMarkers: [],
                note: 'Deterministic offline acceptance used the reviewed local source record.',
                advisoryOnly: true as const,
              })),
              requiresHumanReview: false,
              rulesChanged: false as const,
            };
        const retrieval = retrieveRegulations({
          query: 'Poland India cross-border freelancer payment export receipt due diligence value cap separate inward account',
          bookId: 'PL-IN-INWARD',
          limit: 5,
        });
        const explanation = await explainRegulationRefresh(report, async () => {
          const unchanged = report.observations.filter((item) => item.status === 'UNCHANGED').length;
          const review = report.observations.filter((item) => item.status === 'REVIEW_REQUIRED').length;
          const unavailable = report.observations.filter((item) => item.status === 'UNAVAILABLE').length;
          const result = await context.ai.evaluate({
            purpose: 'REGULATORY_EXPLANATION',
            instruction:
              'Explain this official-source refresh concisely. Do not invent rules, legal advice, or change the deterministic compliance outcome.',
            facts: {
              bookId: 'PL-IN-INWARD',
              outcome: report.requiresHumanReview ? 'HUMAN_REVIEW_REQUIRED' : 'APPROVED_CORPUS_ACTIVE',
              unchangedSources: unchanged,
              reviewRequiredSources: review,
              unavailableSources: unavailable,
              approvedCorpusHash: report.approvedCorpusHash,
            },
          });
          return result.summary;
        });
        await context.timeline.append({
          kind: 'REGULATIONS_REFRESHED',
          actor: { subject: principal.subject, role: principal.roles[0] ?? 'unknown' },
          contractId: contract.id,
          detail: {
            approvedCorpusHash: report.approvedCorpusHash,
            reportHash: explanation.reportHash,
            requiresHumanReview: report.requiresHumanReview,
            rulesChanged: report.rulesChanged,
            checkedAt: report.checkedAt,
          },
        });
        return { refreshMode: context.config.regulations.refreshMode, report, explanation, retrieval };
      },
    });
  });

  // ---- work submission ---------------------------------------------------

  app.post<{ Params: { id: string } }>('/v1/contracts/:id/submissions', {
    schema: { params: IdParams, body: CreateSubmissionBody, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    const body = request.body as Static<typeof CreateSubmissionBody>;
    return mutate(context, request, reply, principal, {
      scope: 'submissions.create',
      statusCode: 201,
      run: async () => submissions.submit(principal, request.params.id, body),
    });
  });

  app.post<{ Params: { id: string } }>('/v1/contracts/:id/documents', {
    schema: { params: IdParams, body: RecordDocumentBody, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    const body = request.body as Static<typeof RecordDocumentBody>;
    return mutate(context, request, reply, principal, {
      scope: 'documents.record',
      statusCode: 201,
      run: async () => submissions.recordDocument(
        principal,
        request.params.id,
        body.code,
        body.contentType,
        Buffer.from(body.contentBase64, 'base64'),
      ),
    });
  });

  app.post<{ Params: { id: string } }>('/v1/submissions/:id/approve', {
    schema: { params: IdParams, body: DecideSubmissionBody, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    const body = request.body as Static<typeof DecideSubmissionBody>;
    return mutate(context, request, reply, principal, {
      scope: 'submissions.decide',
      run: async () => submissions.decide(principal, request.params.id, body),
    });
  });

  app.post<{ Params: { id: string } }>('/v1/submissions/:id/evaluate', {
    schema: { params: IdParams, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    return mutate(context, request, reply, principal, {
      scope: 'submissions.evaluate',
      run: async () => submissions.evaluate(principal, request.params.id),
    });
  });

  app.get<{ Params: { id: string } }>('/v1/submissions/:id/access', {
    schema: { params: IdParams, response: errorResponses },
  }, async (request) => submissions.access(principalOf(request), request.params.id));

  // ---- payments ----------------------------------------------------------

  app.post('/v1/payments', {
    schema: { body: CreatePaymentBody, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    const body = request.body as Static<typeof CreatePaymentBody>;
    return mutate(context, request, reply, principal, {
      scope: 'payments.create',
      statusCode: 201,
      run: async () => payments.create(principal, {
        contractId: body.contractId,
        fundingAmount: money(body.fundingAmount.amountMinor, body.fundingAmount.currency, body.fundingAmount.scale),
        ...(body.purposeCode === undefined ? {} : { purposeCode: body.purposeCode }),
      }),
    });
  });

  app.post<{ Params: { id: string } }>('/v1/payments/:id/fund', {
    schema: { params: IdParams, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    return mutate(context, request, reply, principal, {
      scope: 'payments.fund',
      run: async (key) => payments.fund(principal, request.params.id, key),
    });
  });

  app.post<{ Params: { id: string } }>('/v1/payments/:id/release', {
    schema: { params: IdParams, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    return mutate(context, request, reply, principal, {
      scope: 'payments.release',
      run: async (key) => payments.release(principal, request.params.id, key),
    });
  });

  app.post<{ Params: { id: string } }>('/v1/payments/:id/refund', {
    schema: { params: IdParams, body: RefundPaymentBody, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    const body = request.body as Static<typeof RefundPaymentBody>;
    return mutate(context, request, reply, principal, {
      scope: 'payments.refund',
      run: async (key) => payments.refund(principal, request.params.id, key, body.reason),
    });
  });

  app.get<{ Params: { id: string } }>('/v1/payments/:id/timeline', {
    schema: { params: IdParams, response: errorResponses },
  }, async (request) => payments.timeline(principalOf(request), request.params.id));

  app.post<{ Params: { id: string } }>('/v1/payments/:id/reconcile', {
    schema: { params: IdParams, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    requireRole(principal, 'provider_operator', 'platform_admin', 'audit_service', 'payments_service');
    return mutate(context, request, reply, principal, {
      scope: 'payments.reconcile',
      run: async () => payments.reconcile(request.params.id),
    });
  });

  /**
   * The India to United Kingdom supplier journey.
   *
   * Same machinery, different book. Import documents are recorded first so the
   * outward rules can see them, and the resulting payment lands in the OUTWARD
   * book, which shares no account with any inward payment.
   */
  app.post('/v1/supplier-payments', {
    schema: { body: SupplierPaymentBody, response: errorResponses },
  }, async (request, reply) => {
    const principal = principalOf(request);
    const body = request.body as Static<typeof SupplierPaymentBody>;
    requireRole(principal, 'company_member', 'platform_admin', 'payments_service');
    return mutate(context, request, reply, principal, {
      scope: 'supplier-payments.create',
      statusCode: 201,
      run: async () => {
        for (const document of body.documents) {
          await submissions.recordDocument(
            principal,
            body.contractId,
            document.code,
            document.contentType,
            Buffer.from(document.contentBase64, 'base64'),
          );
        }
        const created = await payments.create(principal, {
          contractId: body.contractId,
          fundingAmount: money(
            body.fundingAmount.amountMinor,
            body.fundingAmount.currency,
            body.fundingAmount.scale,
          ),
        });
        if (created.payment.direction !== 'OUTWARD') {
          throw badRequest('This endpoint serves outward supplier payments only.');
        }
        return { ...created, invoiceReference: body.invoiceReference };
      },
    });
  });

  // ---- demonstration -----------------------------------------------------

  /**
   * Runs the two journeys end to end through the same services the HTTP routes
   * use, then exposes the resulting read model. Both are available only in the
   * demo profile: a hosted deployment must never be able to script a payment.
   */
  if (context.config.profile === 'demo') {
    app.post('/v1/demo/walkthrough', async (request, reply) => {
      const principal = principalOf(request);
      requireRole(principal, 'platform_admin');
      return mutate(context, request, reply, principal, {
        scope: 'demo.walkthrough',
        run: async () => {
          const result = await runWalkthrough(context);
          return { journeys: result.journeys, issuerDid: result.seed.issuerDid };
        },
      });
    });

    app.get('/v1/demo/state', async (request) => {
      const principal = principalOf(request);
      requireRole(principal, 'platform_admin', 'audit_service', 'provider_operator');
      return demoState(context);
    });

    /**
     * The demonstration principals, so a reviewer can act as each party without
     * an identity provider. These are local principal tokens, not credentials,
     * and the route does not exist outside the demo profile.
     */
    app.get('/v1/demo/principals', async (request) => {
      const principal = principalOf(request);
      requireRole(principal, 'platform_admin');
      const { seedDemo } = await import('../demo/seed.js');
      const seed = await seedDemo(context);
      return {
        parties: [
          { key: 'polishCompany', ...seed.polishCompany },
          ...seed.indianFreelancers.map((party, index) => ({
            key: index === 0 ? 'indianFreelancer' : `indianFreelancer${index + 1}`,
            ...party,
          })),
          { key: 'indianCompany', ...seed.indianCompany },
          { key: 'ukSupplier', ...seed.ukSupplier },
          { key: 'providerOperator', ...seed.providerOperator },
          { key: 'platformAdmin', ...seed.platformAdmin },
        ],
      };
    });
  }

  // ---- audit -------------------------------------------------------------

  app.get('/v1/audit/books', async (request) => {
    const principal = principalOf(request);
    requireRole(principal, 'platform_admin', 'audit_service', 'provider_operator');
    const books = ['PL-IN-INWARD', 'IN-GB-OUTWARD'];
    const summaries = [];
    for (const bookId of books) {
      summaries.push({ bookId, balanced: await context.ledger.bookIsBalanced(bookId) });
    }
    return { books: summaries };
  });
}
