# OptiWork / Smart Horizon

Intelligent, blockchain-enabled cross-border freelance contracting and
settlement prototype.

The source repository was initially empty. Implementation is being driven by
the OptiWork architecture specification and a selective adaptation of the local
HardCoders Hyperledger Fabric trust layer.

Start with [the architecture and implementation plan](docs/ARCHITECTURE_PLAN.md).

## Status

- Repository cloned and inspected.
- Architecture and technology stack selected.
- pnpm workspace, shared contracts/domain packages, Fastify API health boundary,
  and initial Next.js shell are scaffolded.
- The Fabric work-evidence chaincode and Gateway boundary are implemented with
  actor-scoped idempotency, bounded history, commit reconciliation, event
  checkpoints, OIDC production mode, and signed Algorand release permits.
- Algorand, PostgreSQL, object storage, identity infrastructure, and the full UI
  are developed on the parallel `claude/algorand-platform` workstream.

This project is a demonstration and decision-support prototype. It is not a
licensed remittance service and does not provide legal or tax advice.
