# Anchor Dynamic Settlement Router

The router is the release-time decision layer between Fabric-approved work and
the Algorand escrow executor. It never signs a blockchain transaction and it
cannot move funds. Its output is an immutable, explainable authorization input.

```text
Fabric-approved evidence
        |
        v
Fresh FX oracle snapshot ----> deterministic provider adapters
        |                          | quote + eligibility + liquidity
        +--------------------------+
                                   v
                      hard constraints (fail closed)
                                   v
                 exact-integer deterministic ranking
                                   v
                persisted candidates + selected route hash
                                   v
       Fabric-signed release permit -> Algorand executor -> ARC-4 escrow
                                   v
              selected demo provider -> local fiat ledger credit
```

## Release invariants

- Compliance must already be `PASSED`.
- The provider must authorize the ordered corridor and destination currency.
- Liquidity and operational status are checked before release authorization.
- Quotes carry a creation time, expiry, FX source, observation time, collection
  time and canonical authenticity hash.
- Ineligible routes are retained with machine-readable reason codes but are
  never ranked.
- Eligible routes are sorted by exact net recipient amount, then ETA,
  reliability and provider identifier. No floating-point money arithmetic or
  opaque AI score can affect the winner.
- The selected route hash commits the transaction, destination provider
  treasury, compliance decision, FX oracle snapshot, candidate set and ranking
  rule. It is the ninth field in the Fabric-signed release binding whose
  canonical commitment is recorded by the Algorand application.
- A stale quote or empty eligible set leaves the funded escrow locked.
- Ordinary freelancer income tax is not deducted. Only a deterministic rules
  result explicitly marked as settlement-affecting can reduce payout.

## Demo-provider boundary

`RAPIDRAMP_DEMO`, `CLEARSETTLE_DEMO` and `ECONOFLOW_DEMO` implement the same
narrow provider port: quote, eligibility, liquidity, settlement execution and
status. They are deterministic zero-value adapters for the hackathon and are
not represented as bank, exchange or payment-provider partnerships.

The Algorand escrow still releases to the configured destination provider
treasury. The router selects the off-chain local-payout rail behind that
treasury. This preserves the deployed ARC-4 ABI while binding the exact selected
rail into the on-chain authorization commitment.

## Durable audit data

Migration `0009_dynamic_settlement_router.sql` adds:

- `settlement_provider_quotes`: every candidate, eligibility outcome, reason
  code, quoted amount, freshness window and authenticity hash.
- `settlement_route_decisions`: one generation, winner, full decision JSON,
  FX oracle hash and canonical route hash.
- `settlement_executions`: the selected demo adapter's terminal status and
  settlement reference.

`GET /v1/payments/:id/timeline` returns the current route, route history,
provider quotes and settlement executions. The company and freelancer analytics
views render those same persisted records.

## Acceptance coverage

The router tests prove the eligible happy path, rejection of a cheaper illegal
route, stale-quote hold, provider-unavailable rerouting before release, blocked
compliance, and settlement-affecting versus ordinary tax treatment. The inward
and outward HTTP journeys also assert the persisted route and execution.
