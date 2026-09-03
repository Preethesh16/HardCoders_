import { describe, expect, it } from 'vitest';
import { asAppError } from '../src/errors.js';

describe('Fabric error mapping', () => {
  it('maps authorization failures reported in Fabric peer details to forbidden', () => {
    const error = Object.assign(new Error('failed to endorse transaction, see attached details'), {
      details: [{
        address: 'peer0.buyer.optiwork.local:7051',
        message: 'chaincode response 500, buyer organization is not authorized for this evidence',
        mspId: 'BuyerOrgMSP',
      }],
    });

    const mapped = asAppError(error);

    expect(mapped.code).toBe('FORBIDDEN');
    expect(mapped.statusCode).toBe(403);
    expect(mapped.message).toBe('The authenticated actor is not authorized.');
  });

  it('maps state conflicts reported in Fabric peer details to conflict', () => {
    const error = Object.assign(new Error('failed to endorse transaction, see attached details'), {
      details: [{
        address: 'peer0.seller.optiwork.local:7051',
        message: 'chaincode response 500, a new version is required after a decision',
        mspId: 'SellerOrgMSP',
      }],
    });

    expect(asAppError(error).code).toBe('STATE_CONFLICT');
  });
});
