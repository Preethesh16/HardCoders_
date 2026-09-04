/**
 * The API's Algorand boundary.
 *
 * The API never signs, never holds a key and never talks to algod. It sends
 * durable, idempotent commands to the executor service, which owns every
 * provider signer. Two implementations exist: an HTTP client for the real
 * executor, and a simulated adapter that reproduces the executor's state
 * machine in process so the offline demo and the tests exercise the same
 * lifecycle without a chain.
 */

import { canonicalHash } from '../canonical.js';
import { conflict, unavailable, unprocessable } from '../errors.js';

export type EscrowAction = 'create' | 'fund' | 'pause' | 'resume' | 'release' | 'refund' | 'complete';

export type EscrowState =
  | 'CREATED' | 'FUNDED' | 'PAUSED' | 'PARTIALLY_RELEASED' | 'REFUNDED' | 'COMPLETED';

export interface EscrowBindingInput {
  readonly dealId: string;
  readonly agreementHash: string;
  readonly originProviderAddress: string;
  readonly destinationProviderAddress: string;
  readonly assetId: number;
  readonly amount: { readonly amountMinor: string; readonly currency: string; readonly scale: number };
  readonly network: 'localnet' | 'testnet';
  readonly genesisHash: string;
  readonly applicationId: string;
}

/**
 * The nine-field authorization a release is bound to. It is identical to the
 * executor's `releaseBinding` and to `ReleaseAuthorizationSchema` in
 * `packages/contracts`.
 */
export interface ReleaseBinding {
  readonly escrowBindingHash: string;
  readonly workEvidenceHash: string;
  readonly fabricTxHash: string;
  readonly complianceResultHash: string;
  readonly fxQuoteHash: string;
  readonly settlementRouteHash: string;
  readonly generation: number;
  readonly idempotencyKey: string;
  readonly expiresAt: string;
}

export interface ReleaseCommand {
  readonly evidenceId: string;
  readonly escrowBinding: EscrowBindingInput;
  readonly milestoneId: string;
  readonly amountMinor: string;
  readonly intentId: string;
  readonly bindingHash: string;
  readonly fenceGeneration: number;
  readonly leaseExpiresAt: string;
  readonly authorizationCommitment: string;
  readonly fabricClaimTransactionId: string;
  readonly releaseBinding: ReleaseBinding;
}

export interface Escrow extends EscrowBindingInput {
  readonly lockedMinor: string;
  readonly releasedMinor: string;
  readonly refundedMinor: string;
  readonly state: EscrowState;
  readonly createTxId: string;
  readonly fundTxId: string | null;
  readonly refundTxId: string | null;
  readonly releases: Record<string, { amountMinor: string; transactionId: string }>;
}

export interface CommandOutcome {
  readonly escrow: Escrow;
  readonly transactionId: string;
  readonly replay: boolean;
}

export interface EscrowExecutor {
  readonly mode: 'executor' | 'simulated';
  create(binding: EscrowBindingInput, idempotencyKey: string): Promise<CommandOutcome>;
  fund(dealId: string, idempotencyKey: string): Promise<CommandOutcome>;
  pause(dealId: string, idempotencyKey: string): Promise<CommandOutcome>;
  resume(dealId: string, idempotencyKey: string): Promise<CommandOutcome>;
  release(command: ReleaseCommand, idempotencyKey: string): Promise<CommandOutcome>;
  refund(dealId: string, idempotencyKey: string): Promise<CommandOutcome>;
  complete(dealId: string, idempotencyKey: string): Promise<CommandOutcome>;
  get(dealId: string): Promise<Escrow | null>;
}

/** Computes the release binding's canonical commitment, as the chain records it. */
export function releaseBindingCommitment(binding: ReleaseBinding): string {
  return canonicalHash(binding);
}

export function escrowBindingCommitment(binding: EscrowBindingInput): string {
  return canonicalHash(binding);
}

/**
 * In-process executor.
 *
 * It mirrors the real executor's rules exactly where they matter to the rest of
 * the platform: durable idempotency keyed on the command, one release per
 * milestone, conservation of the locked amount, and a deterministic transaction
 * reference derived from the command rather than from a random source.
 */
export class SimulatedEscrowExecutor implements EscrowExecutor {
  readonly mode = 'simulated' as const;
  readonly #escrows = new Map<string, Escrow>();
  readonly #commands = new Map<string, { hash: string; outcome: CommandOutcome }>();
  #sequence = 0;

  /**
   * The clock is injected so a deterministic test evaluates authorization
   * expiry against the same instant the API used to mint it.
   */
  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(binding: EscrowBindingInput, idempotencyKey: string): Promise<CommandOutcome> {
    return this.#run('create', idempotencyKey, binding, () => {
      if (this.#escrows.has(binding.dealId)) throw conflict('The escrow already exists.');
      if (binding.originProviderAddress === binding.destinationProviderAddress) {
        throw unprocessable('Origin and destination provider treasuries must differ.');
      }
      const escrow: Escrow = {
        ...binding,
        lockedMinor: '0',
        releasedMinor: '0',
        refundedMinor: '0',
        state: 'CREATED',
        createTxId: this.#transactionId('create', idempotencyKey),
        fundTxId: null,
        refundTxId: null,
        releases: {},
      };
      this.#escrows.set(binding.dealId, escrow);
      return { escrow, transactionId: escrow.createTxId };
    });
  }

  async fund(dealId: string, idempotencyKey: string): Promise<CommandOutcome> {
    return this.#run('fund', idempotencyKey, { dealId }, () => {
      const escrow = this.#require(dealId);
      if (escrow.state !== 'CREATED') throw conflict('Only a created escrow can be funded.');
      const transactionId = this.#transactionId('fund', idempotencyKey);
      const next: Escrow = {
        ...escrow,
        lockedMinor: escrow.amount.amountMinor,
        fundTxId: transactionId,
        state: 'FUNDED',
      };
      this.#escrows.set(dealId, next);
      return { escrow: next, transactionId };
    });
  }

  async pause(dealId: string, idempotencyKey: string): Promise<CommandOutcome> {
    return this.#run('pause', idempotencyKey, { dealId }, () => {
      const escrow = this.#require(dealId);
      if (escrow.state !== 'FUNDED' && escrow.state !== 'PARTIALLY_RELEASED') {
        throw conflict('The escrow cannot be paused.');
      }
      const next: Escrow = { ...escrow, state: 'PAUSED' };
      this.#escrows.set(dealId, next);
      return { escrow: next, transactionId: this.#transactionId('pause', idempotencyKey) };
    });
  }

  async resume(dealId: string, idempotencyKey: string): Promise<CommandOutcome> {
    return this.#run('resume', idempotencyKey, { dealId }, () => {
      const escrow = this.#require(dealId);
      if (escrow.state !== 'PAUSED') throw conflict('The escrow cannot be resumed.');
      const next: Escrow = {
        ...escrow,
        state: BigInt(escrow.releasedMinor) > 0n ? 'PARTIALLY_RELEASED' : 'FUNDED',
      };
      this.#escrows.set(dealId, next);
      return { escrow: next, transactionId: this.#transactionId('resume', idempotencyKey) };
    });
  }

  async release(command: ReleaseCommand, idempotencyKey: string): Promise<CommandOutcome> {
    return this.#run('release', idempotencyKey, command, () => {
      const escrow = this.#require(command.escrowBinding.dealId);
      if (escrow.state !== 'FUNDED' && escrow.state !== 'PARTIALLY_RELEASED') {
        throw conflict('The escrow cannot be released.');
      }
      if (escrow.releases[command.milestoneId]) throw conflict('The milestone was already released.');
      if (command.authorizationCommitment !== releaseBindingCommitment(command.releaseBinding)) {
        throw unprocessable('The authorization commitment is not the canonical release-binding hash.');
      }
      if (command.releaseBinding.escrowBindingHash !== escrowBindingCommitment(command.escrowBinding)) {
        throw unprocessable('The release binding does not commit to this escrow.');
      }
      if (command.releaseBinding.idempotencyKey !== idempotencyKey) {
        throw unprocessable('The release binding is bound to a different idempotency key.');
      }
      if (Date.parse(command.releaseBinding.expiresAt) <= this.now().getTime()) {
        throw conflict('The release authorization has expired.');
      }
      const amount = BigInt(command.amountMinor);
      const locked = BigInt(escrow.lockedMinor);
      if (amount <= 0n || amount > locked) throw conflict('The release amount exceeds locked funds.');
      const transactionId = this.#transactionId('release', idempotencyKey);
      const remaining = locked - amount;
      const next: Escrow = {
        ...escrow,
        lockedMinor: remaining.toString(),
        releasedMinor: (BigInt(escrow.releasedMinor) + amount).toString(),
        releases: { ...escrow.releases, [command.milestoneId]: { amountMinor: command.amountMinor, transactionId } },
        state: remaining === 0n ? 'COMPLETED' : 'PARTIALLY_RELEASED',
      };
      this.#escrows.set(escrow.dealId, next);
      return { escrow: next, transactionId };
    });
  }

  async refund(dealId: string, idempotencyKey: string): Promise<CommandOutcome> {
    return this.#run('refund', idempotencyKey, { dealId }, () => {
      const escrow = this.#require(dealId);
      if (!['FUNDED', 'PARTIALLY_RELEASED', 'PAUSED'].includes(escrow.state)) {
        throw conflict('The escrow cannot be refunded.');
      }
      const transactionId = this.#transactionId('refund', idempotencyKey);
      const next: Escrow = {
        ...escrow,
        refundedMinor: escrow.lockedMinor,
        lockedMinor: '0',
        refundTxId: transactionId,
        state: 'REFUNDED',
      };
      this.#escrows.set(dealId, next);
      return { escrow: next, transactionId };
    });
  }

  async complete(dealId: string, idempotencyKey: string): Promise<CommandOutcome> {
    return this.#run('complete', idempotencyKey, { dealId }, () => {
      const escrow = this.#require(dealId);
      if (escrow.lockedMinor !== '0' || !['COMPLETED', 'REFUNDED'].includes(escrow.state)) {
        throw conflict('The escrow is not terminal.');
      }
      return { escrow, transactionId: this.#transactionId('complete', idempotencyKey) };
    });
  }

  async get(dealId: string): Promise<Escrow | null> {
    const escrow = this.#escrows.get(dealId);
    return escrow ? structuredClone(escrow) : null;
  }

  #require(dealId: string): Escrow {
    const escrow = this.#escrows.get(dealId);
    if (!escrow) throw conflict('The escrow does not exist.');
    return escrow;
  }

  #transactionId(action: string, idempotencyKey: string): string {
    this.#sequence += 1;
    // 52 characters of the Algorand base32 alphabet, derived from the command.
    const digest = canonicalHash({ action, idempotencyKey, sequence: this.#sequence }).slice(7);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let out = '';
    for (let index = 0; index < 52; index += 1) {
      const nibble = Number.parseInt(digest[index % digest.length] ?? '0', 16);
      out += alphabet[(nibble * 2 + index) % alphabet.length];
    }
    return out;
  }

  async #run(
    action: EscrowAction,
    idempotencyKey: string,
    body: unknown,
    work: () => { escrow: Escrow; transactionId: string },
  ): Promise<CommandOutcome> {
    const hash = canonicalHash({ action, body });
    const existing = this.#commands.get(idempotencyKey);
    if (existing) {
      if (existing.hash !== hash) throw conflict('The executor idempotency key is bound to another command.');
      return { ...structuredClone(existing.outcome), replay: true };
    }
    const result = work();
    const outcome: CommandOutcome = { escrow: structuredClone(result.escrow), transactionId: result.transactionId, replay: false };
    this.#commands.set(idempotencyKey, { hash, outcome: structuredClone(outcome) });
    return outcome;
  }
}

interface ExecutorEnvelope {
  readonly success: boolean;
  readonly data: unknown;
  readonly error: { code: string; message: string } | null;
}

interface FabricPermitEnvelope {
  readonly success: boolean;
  readonly data: { readonly permit?: unknown } | null;
  readonly error: { readonly code?: string; readonly message?: string } | null;
}

export interface FabricPermitProviderOptions {
  readonly baseUrl: string;
  readonly bearerToken?: string;
  readonly timeoutMs?: number;
}

/**
 * Requests the exact command authorization the executor will verify.
 *
 * Release commands are bound to one approved evidence projection; lifecycle
 * commands receive a short-lived, zero-read permit. In local demo mode the
 * Gateway accepts the explicit payments-service headers below. Hosted modes
 * provide a workload bearer token instead.
 */
export class HttpFabricPermitProvider {
  readonly #baseUrl: string;
  readonly #bearerToken: string | undefined;
  readonly #timeoutMs: number;

  constructor(options: FabricPermitProviderOptions) {
    this.#baseUrl = options.baseUrl;
    this.#bearerToken = options.bearerToken;
    this.#timeoutMs = options.timeoutMs ?? 4_000;
  }

  async issue(
    action: EscrowAction,
    path: string,
    idempotencyKey: string,
    body: unknown,
  ): Promise<string> {
    const release = action === 'release' ? body as Partial<ReleaseCommand> | null : null;
    if (action === 'release' && (release === null || typeof release.evidenceId !== 'string')) {
      throw unprocessable('A release permit requires an evidence identifier.');
    }
    const permitPath = action === 'release'
      ? `/v1/evidence/${encodeURIComponent(release!.evidenceId!)}/release-permits`
      : '/v1/command-permits';
    let response: Response;
    try {
      response = await fetch(new URL(permitPath, this.#baseUrl), {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': `PERMIT:${idempotencyKey}`,
          'x-correlation-id': idempotencyKey,
          ...(this.#bearerToken === undefined ? {
            'x-demo-subject': 'optiwork-api',
            'x-demo-organization': 'optiwork-platform',
            'x-demo-role': 'payments_service',
          } : { authorization: `Bearer ${this.#bearerToken}` }),
        },
        body: JSON.stringify({
          command: { action, method: 'POST', path, idempotencyKey, body: body ?? null },
        }),
      });
    } catch {
      throw unavailable('The Fabric Gateway is unreachable; no settlement permit was issued.');
    }
    const envelope = await response.json().catch(() => null) as FabricPermitEnvelope | null;
    const permit = envelope?.data?.permit;
    if (!response.ok || envelope?.success !== true || typeof permit !== 'string' || permit.length < 32) {
      const message = envelope?.error?.message ?? 'The Fabric Gateway rejected the settlement permit.';
      if (response.status === 409) throw conflict(message);
      if (response.status === 422) throw unprocessable(message);
      throw unavailable(message);
    }
    return permit;
  }
}

/**
 * HTTP client for the real executor.
 *
 * The executor also requires a signed Fabric permit for every mutation. That
 * permit is minted by the Fabric Gateway workstream, so this client forwards
 * whatever permit the caller supplies and never fabricates one.
 */
export class HttpEscrowExecutor implements EscrowExecutor {
  readonly mode = 'executor' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly bearerToken: string,
    private readonly permitProvider: (action: EscrowAction, path: string, idempotencyKey: string, body: unknown) => Promise<string>,
    private readonly timeoutMs = 20_000,
  ) {}

  create(binding: EscrowBindingInput, idempotencyKey: string): Promise<CommandOutcome> {
    // The executor owns and pins the deployment coordinates. Its create
    // command accepts only the escrow expectation and adds the configured
    // network, genesis hash and application ID to the returned binding.
    const {
      network: _network,
      genesisHash: _genesisHash,
      applicationId: _applicationId,
      ...expectation
    } = binding;
    return this.#mutate('create', '/escrows', idempotencyKey, expectation);
  }
  fund(dealId: string, idempotencyKey: string): Promise<CommandOutcome> {
    return this.#mutate('fund', `/escrows/${encodeURIComponent(dealId)}/fund`, idempotencyKey, null);
  }
  pause(dealId: string, idempotencyKey: string): Promise<CommandOutcome> {
    return this.#mutate('pause', `/escrows/${encodeURIComponent(dealId)}/pause`, idempotencyKey, null);
  }
  resume(dealId: string, idempotencyKey: string): Promise<CommandOutcome> {
    return this.#mutate('resume', `/escrows/${encodeURIComponent(dealId)}/resume`, idempotencyKey, null);
  }
  release(command: ReleaseCommand, idempotencyKey: string): Promise<CommandOutcome> {
    const path = `/escrows/${encodeURIComponent(command.escrowBinding.dealId)}/releases`;
    return this.#mutate('release', path, idempotencyKey, command);
  }
  refund(dealId: string, idempotencyKey: string): Promise<CommandOutcome> {
    return this.#mutate('refund', `/escrows/${encodeURIComponent(dealId)}/refund`, idempotencyKey, null);
  }
  complete(dealId: string, idempotencyKey: string): Promise<CommandOutcome> {
    return this.#mutate('complete', `/escrows/${encodeURIComponent(dealId)}/complete`, idempotencyKey, null);
  }

  async get(dealId: string): Promise<Escrow | null> {
    const response = await this.#send('GET', `/escrows/${encodeURIComponent(dealId)}`);
    if (response === null) return null;
    return response as Escrow;
  }

  async #mutate(action: EscrowAction, path: string, idempotencyKey: string, body: unknown): Promise<CommandOutcome> {
    const permit = await this.permitProvider(action, path, idempotencyKey, body);
    const data = await this.#send('POST', path, {
      'idempotency-key': idempotencyKey,
      'x-correlation-id': idempotencyKey,
      'x-optiwork-fabric-permit': permit,
    }, body);
    if (data === null) throw unavailable('The executor returned no command result.');
    // Lifecycle mutations return the escrow; release and refund wrap it.
    const record = data as Record<string, unknown>;
    if ('escrow' in record) return record as unknown as CommandOutcome;
    const escrow = record as unknown as Escrow;
    const transactionId = escrow.state === 'CREATED' ? escrow.createTxId : escrow.fundTxId ?? escrow.createTxId;
    return { escrow, transactionId, replay: false };
  }

  async #send(
    method: 'GET' | 'POST',
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.bearerToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw unavailable('The Algorand executor is unreachable; the command remains reconcilable.');
    }
    if (response.status === 404 && method === 'GET') return null;
    const envelope = await response.json().catch(() => null) as ExecutorEnvelope | null;
    if (!response.ok || !envelope?.success) {
      const message = envelope?.error?.message ?? 'The Algorand executor rejected the command.';
      if (response.status === 409) throw conflict(message);
      if (response.status === 422) throw unprocessable(message);
      throw unavailable(message);
    }
    return envelope.data;
  }
}
