import { TextEncoder } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type {
  FabricContractLike,
  FabricContractProvider,
  SubmittedTransactionLike,
} from '../src/ledger/fabric-connection.js';
import { FabricEvidenceLedger } from '../src/ledger/fabric-ledger.js';
import type { AuthenticatedActor, LedgerWorkEvidence } from '../src/types.js';

const encoder = new TextEncoder();
const hash = (character: string) => `sha256:${character.repeat(64)}`;

const actor: AuthenticatedActor = {
  subject: 'freelancer-001',
  organizationId: 'ORG-FREELANCER-001',
  role: 'freelancer',
  roles: ['freelancer'],
  mspId: 'SellerOrgMSP',
  fabricIdentityId: 'seller-app',
};

const evidence: LedgerWorkEvidence = {
  schemaVersion: '1.0',
  evidenceId: 'EVID-PLIN-001',
  contractHash: hash('a'),
  milestoneHash: hash('b'),
  fileHash: hash('c'),
  sellerIdentityRef: `seller:${'d'.repeat(64)}`,
  buyerOrganizationRef: `buyer:${'f'.repeat(64)}`,
  version: 1,
  submittedAt: '2026-09-03T10:00:00.000Z',
  buyerDecision: 'PENDING',
  fabricTxId: 'e'.repeat(64),
  aggregateVersion: 1,
};

function provider(contract: FabricContractLike): FabricContractProvider {
  return {
    getContract: async () => contract,
    readiness: async () => true,
    close: async () => undefined,
  };
}

function metadata() {
  return { idempotencyKey: 'CLIENT-001', ledgerIdempotencyKey: 'GW1-abc', correlationId: 'CORR-001' };
}

describe('real Fabric adapter safety', () => {
  it('retries commit status on the same submitted transaction without rebroadcasting', async () => {
    let statusReads = 0;
    const submitted: SubmittedTransactionLike = {
      getResult: () => encoder.encode(JSON.stringify(evidence)),
      getTransactionId: () => evidence.fabricTxId,
      getStatus: async () => {
        statusReads += 1;
        if (statusReads === 1) throw new Error('deadline exceeded');
        return { successful: true, code: 0, transactionId: evidence.fabricTxId };
      },
    };
    const submitAsync = vi.fn(async () => submitted);
    const contract: FabricContractLike = {
      submitAsync,
      evaluate: vi.fn(async () => encoder.encode(JSON.stringify(evidence))),
    };
    const ledger = new FabricEvidenceLedger({
      provider: provider(contract), channelName: 'channel', chaincodeName: 'chaincode', retryDelayMs: 0,
    });
    await expect(ledger.submit(actor, metadata(), {
      evidenceId: evidence.evidenceId,
      contractHash: evidence.contractHash,
      milestoneHash: evidence.milestoneHash,
      fileHash: evidence.fileHash,
      buyerOrganizationRef: evidence.buyerOrganizationRef,
      version: 1,
    })).resolves.toMatchObject({ evidenceId: evidence.evidenceId });
    expect(submitAsync).toHaveBeenCalledTimes(1);
    expect(statusReads).toBe(2);
  });

  it('reconciles an ambiguous submit using the chaincode idempotency result', async () => {
    const evaluate = vi.fn(async (name: string) => {
      expect(name).toBe('GetCommandResult');
      return encoder.encode(JSON.stringify(evidence));
    });
    const contract: FabricContractLike = {
      submitAsync: vi.fn(async () => { throw new Error('submit deadline timeout'); }),
      evaluate,
    };
    const ledger = new FabricEvidenceLedger({
      provider: provider(contract), channelName: 'channel', chaincodeName: 'chaincode',
    });
    await expect(ledger.submit(actor, metadata(), {
      evidenceId: evidence.evidenceId,
      contractHash: evidence.contractHash,
      milestoneHash: evidence.milestoneHash,
      fileHash: evidence.fileHash,
      buyerOrganizationRef: evidence.buyerOrganizationRef,
      version: 1,
    })).resolves.toEqual(evidence);
    expect(evaluate).toHaveBeenCalledWith('GetCommandResult', {
      arguments: ['submit', metadata().ledgerIdempotencyKey],
    });
  });
});
