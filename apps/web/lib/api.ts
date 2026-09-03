/**
 * Server-side API access.
 *
 * Every call happens on the server. The browser never receives a bearer token,
 * a private key, a mnemonic, a storage key or any blockchain signing control -
 * it receives only rendered, already-authorized read models.
 */

import 'server-only';

const API_BASE_URL = process.env['OPTIWORK_API_BASE_URL'] ?? 'http://127.0.0.1:4000';

/**
 * The demonstration operator principal.
 *
 * In the demo profile the API accepts a local principal token, which is an
 * identity assertion rather than a credential: it grants nothing outside the
 * demo profile, where the verifier is not even constructed. A hosted deployment
 * uses Keycloak and this constant is unused.
 */
const DEMO_OPERATOR = Buffer.from(JSON.stringify({
  subject: 'USER-PLATFORM-ADMIN',
  organizationId: 'ORG-OPTIWORK-ADMIN',
  roles: ['platform_admin', 'audit_service', 'compliance_service'],
  displayName: 'Platform administrator',
}), 'utf8').toString('base64url');

export interface Money {
  readonly amountMinor: string;
  readonly currency: string;
  readonly scale: number;
}

export interface QuoteLeg {
  readonly ordinal: number;
  readonly pair: string;
  readonly rateUnits: string;
  readonly rateScale: number;
  readonly from: Money;
  readonly to: Money;
}

export interface Quote {
  readonly id: string;
  readonly corridorId: string;
  readonly fundingAmount: Money;
  readonly grossSettlementAmount: Money;
  readonly settlementAmount: Money;
  readonly grossPayoutAmount: Money;
  readonly payoutAmount: Money;
  readonly legs: readonly QuoteLeg[];
  readonly fees: readonly { code: string; basisPoints: number; amount: Money }[];
  readonly provider: string;
  readonly rateSource: string;
  readonly rateObservedAt: string;
  readonly quotedAt: string;
  readonly expiresAt: string;
  readonly canonicalHash: string;
}

export interface TimelineEvent {
  readonly id: string;
  readonly sequence: number;
  readonly kind: string;
  readonly actorSubject: string;
  readonly actorRole: string;
  readonly detail: Record<string, unknown>;
  readonly occurredAt: string;
}

export interface DemoState {
  readonly profile: string;
  readonly network: string;
  readonly explorerBaseUrl: string;
  readonly adapters: Record<string, string>;
  readonly jobs: readonly Record<string, any>[];
  readonly applications: readonly Record<string, any>[];
  readonly contracts: readonly Record<string, any>[];
  readonly approvals: readonly Record<string, any>[];
  readonly quotes: readonly { id: string; contractId: string; quote: Quote }[];
  readonly compliance: readonly Record<string, any>[];
  readonly payments: readonly Record<string, any>[];
  readonly bindings: readonly Record<string, any>[];
  readonly submissions: readonly Record<string, any>[];
  readonly reconciliations: readonly Record<string, any>[];
  readonly balances: readonly {
    accountId: string; bookId: string; direction: string; ownerKind: string;
    ownerId: string; accountType: string; currency: string; scale: number; signedMinor: string;
  }[];
  readonly books: readonly { bookId: string; balanced: boolean }[];
  readonly timelines: Record<string, TimelineEvent[]>;
}

export type ApiOutcome<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly reason: string };

async function request<T>(path: string, init: RequestInit = {}): Promise<ApiOutcome<T>> {
  try {
    const response = await fetch(new URL(path, API_BASE_URL), {
      ...init,
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${DEMO_OPERATOR}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      return { ok: false, reason: body?.error?.message ?? `The API responded ${response.status}.` };
    }
    return { ok: true, data: await response.json() as T };
  } catch {
    return {
      ok: false,
      reason: `The Anchor API is not reachable at ${API_BASE_URL}. Start it with "pnpm --filter @optiwork/api dev".`,
    };
  }
}

export function fetchDemoState(): Promise<ApiOutcome<DemoState>> {
  return request<DemoState>('/v1/demo/state');
}

export function runWalkthrough(): Promise<ApiOutcome<unknown>> {
  return request('/v1/demo/walkthrough', {
    method: 'POST',
    headers: { 'idempotency-key': 'optiwork-demo-walkthrough-0001' },
    body: JSON.stringify({}),
  });
}

// ---- read-model helpers ---------------------------------------------------

export interface JourneyView {
  readonly payment: Record<string, any>;
  readonly contract: Record<string, any>;
  readonly quote: Quote | undefined;
  readonly compliance: Record<string, any> | undefined;
  readonly binding: Record<string, any> | undefined;
  readonly submissions: readonly Record<string, any>[];
  readonly reconciliation: Record<string, any> | undefined;
  readonly events: readonly TimelineEvent[];
}

export function journeyFor(state: DemoState, direction: 'INWARD' | 'OUTWARD'): JourneyView | undefined {
  const payment = state.payments.find((candidate) => candidate['direction'] === direction);
  if (!payment) return undefined;
  const contract = state.contracts.find((candidate) => candidate['id'] === payment['contractId']);
  if (!contract) return undefined;
  return {
    payment,
    contract,
    quote: state.quotes.find((candidate) => candidate.id === payment['quoteId'])?.quote,
    compliance: state.compliance.find((candidate) => candidate['id'] === payment['complianceResultId']),
    binding: state.bindings.find((candidate) => candidate['paymentId'] === payment['id']),
    submissions: state.submissions.filter((candidate) => candidate['contractId'] === contract['id']),
    reconciliation: [...state.reconciliations].reverse()
      .find((candidate) => candidate['paymentId'] === payment['id']),
    events: state.timelines[payment['id'] as string] ?? [],
  };
}

export function explorerTransactionUrl(state: DemoState, transactionId: string): string {
  return `${state.explorerBaseUrl}/transaction/${transactionId}`;
}
