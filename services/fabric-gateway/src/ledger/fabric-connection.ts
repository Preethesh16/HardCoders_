import * as crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as grpc from '@grpc/grpc-js';
import {
  connect,
  hash,
  signers,
  type Contract,
  type Gateway,
  type ProposalOptions,
  type SubmittedTransaction,
} from '@hyperledger/fabric-gateway';
import type { FabricOperationRole } from '../types.js';

export interface SubmittedTransactionLike {
  getResult(): Uint8Array;
  getTransactionId(): string;
  getStatus(): Promise<{ readonly successful: boolean; readonly code: number; readonly transactionId: string }>;
}

export interface FabricContractLike {
  evaluate(transactionName: string, options?: ProposalOptions): Promise<Uint8Array>;
  submitAsync(transactionName: string, options?: ProposalOptions): Promise<SubmittedTransactionLike>;
}

export interface FabricContractProvider {
  getContract(role: FabricOperationRole): Promise<FabricContractLike>;
  readiness(): Promise<boolean>;
  close(): Promise<void>;
}

export interface FabricIdentityConnection {
  readonly role: FabricOperationRole;
  readonly mspId: string;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  readonly tlsRootCertificatePath: string;
  readonly peerEndpoint: string;
  readonly tlsServerName: string;
}

export interface FabricConnectionManagerOptions {
  readonly channelName: string;
  readonly chaincodeName: string;
  readonly identities: readonly FabricIdentityConnection[];
  readonly evaluateTimeoutMs?: number;
  readonly endorseTimeoutMs?: number;
  readonly submitTimeoutMs?: number;
  readonly commitTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}

interface ManagedConnection {
  readonly client: grpc.Client;
  readonly gateway: Gateway;
  readonly contract: Contract;
}

export class FabricConnectionManager implements FabricContractProvider {
  readonly #options: Required<Omit<FabricConnectionManagerOptions, 'identities'>>;
  readonly #identities: ReadonlyMap<FabricOperationRole, FabricIdentityConnection>;
  readonly #connections = new Map<FabricOperationRole, Promise<ManagedConnection>>();
  #closed = false;

  public constructor(options: FabricConnectionManagerOptions) {
    const identities = new Map(options.identities.map((identity) => [identity.role, identity]));
    if (!identities.has('seller') || !identities.has('buyer')) {
      throw new Error('Fabric seller and buyer identities are required.');
    }
    this.#identities = identities;
    this.#options = {
      channelName: options.channelName,
      chaincodeName: options.chaincodeName,
      evaluateTimeoutMs: options.evaluateTimeoutMs ?? 5_000,
      endorseTimeoutMs: options.endorseTimeoutMs ?? 10_000,
      submitTimeoutMs: options.submitTimeoutMs ?? 5_000,
      commitTimeoutMs: options.commitTimeoutMs ?? 20_000,
      connectTimeoutMs: options.connectTimeoutMs ?? 5_000,
    };
  }

  public async getContract(role: FabricOperationRole): Promise<FabricContractLike> {
    if (this.#closed) throw new Error('Fabric connection manager is closed.');
    const resolvedRole = role === 'reader' && !this.#identities.has('reader') ? 'buyer' : role;
    const existing = this.#connections.get(resolvedRole);
    if (existing !== undefined) return (await existing).contract;
    const created = this.#connect(resolvedRole);
    this.#connections.set(resolvedRole, created);
    try {
      return (await created).contract;
    } catch (error) {
      if (this.#connections.get(resolvedRole) === created) this.#connections.delete(resolvedRole);
      throw error;
    }
  }

  public async readiness(): Promise<boolean> {
    try {
      await Promise.all([...this.#identities.keys()].map(async (role) => this.getContract(role)));
      return true;
    } catch {
      return false;
    }
  }

  public async close(): Promise<void> {
    this.#closed = true;
    const connections = await Promise.allSettled(this.#connections.values());
    for (const result of connections) {
      if (result.status === 'fulfilled') {
        result.value.gateway.close();
        result.value.client.close();
      }
    }
    this.#connections.clear();
  }

  async #connect(role: FabricOperationRole): Promise<ManagedConnection> {
    const identity = this.#identities.get(role);
    if (identity === undefined) throw new Error(`No Fabric identity is configured for ${role}.`);
    const [certificate, privateKeyPem, tlsRootCertificate] = await Promise.all([
      readFile(identity.certificatePath),
      readFile(identity.privateKeyPath),
      readFile(identity.tlsRootCertificatePath),
    ]);
    const certificateObject = new crypto.X509Certificate(certificate);
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    if (!certificateObject.checkPrivateKey(privateKey)) {
      throw new Error(`Fabric certificate and private key do not match for ${role}.`);
    }
    const client = new grpc.Client(identity.peerEndpoint, grpc.credentials.createSsl(tlsRootCertificate), {
      'grpc.ssl_target_name_override': identity.tlsServerName,
      'grpc.default_authority': identity.tlsServerName,
      'grpc.keepalive_time_ms': 60_000,
      'grpc.keepalive_timeout_ms': 20_000,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        client.waitForReady(Date.now() + this.#options.connectTimeoutMs, (error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
      const deadline = (timeoutMs: number): grpc.CallOptions => ({ deadline: Date.now() + timeoutMs });
      const gateway = connect({
        client,
        identity: { mspId: identity.mspId, credentials: certificate },
        signer: signers.newPrivateKeySigner(privateKey),
        hash: hash.sha256,
        evaluateOptions: () => deadline(this.#options.evaluateTimeoutMs),
        endorseOptions: () => deadline(this.#options.endorseTimeoutMs),
        submitOptions: () => deadline(this.#options.submitTimeoutMs),
        commitStatusOptions: () => deadline(this.#options.commitTimeoutMs),
      });
      const contract = gateway.getNetwork(this.#options.channelName).getContract(this.#options.chaincodeName);
      return { client, gateway, contract };
    } catch (error) {
      client.close();
      throw error;
    }
  }
}

const _contractCompatibility: FabricContractLike | undefined = undefined as Contract | undefined;
const _submittedCompatibility: SubmittedTransactionLike | undefined = undefined as SubmittedTransaction | undefined;
void _contractCompatibility;
void _submittedCompatibility;
