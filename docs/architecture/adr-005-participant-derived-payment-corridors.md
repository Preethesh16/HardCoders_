# ADR-005: Participant-derived payment corridors

- Status: accepted for the demonstration profile
- Date: 2026-09-04

## Context

The payer-to-payee route is a fact of a selected deal, not a dashboard scenario. A company publishes work using its verified country and funding currency. Each applicant proposes from its verified residence and chooses the supported payout country and currency. Only after the company selects one applicant does an ordered cross-border corridor exist.

Allowing a browser to submit arbitrary origin and destination values at payment time would let the payment request disagree with the parties, compliance decision, FX quote, provider route or escrow. A detached scenario tester also makes a real workflow look like a collection of unrelated demonstrations.

## Decision

Persist the company payer country and funding currency with the job. Persist the applicant residence, payout country and payout currency with the proposal. Validate both residence facts against signed credentials. When the company selects an applicant, resolve and snapshot the ordered route `company payer → selected provider payout`, including its policy, direction and accounting book.

All later regulation, compliance, FX, document, provider and escrow operations use that immutable contract snapshot. Payment creation re-resolves the policy and rechecks both current credentials. Any mismatch, missing reviewed jurisdiction module, stale source, unsupported provider route, missing evidence or unavailable live FX results in a hold or rejection before blockchain signing.

Country selectors in the local demonstration select a seeded party with a matching signed credential; they do not rewrite identity claims. The 12 ordered B2B-service routes among Poland, India, the United Kingdom and Germany have reviewed modules and provider rails. The 8 Russia-involved routes resolve to source-backed manual review, and the 10 DPRK-involved routes resolve to a source-backed product block. Country selection alone never implies permission.

The regulation planner composes a bounded set of reviewed controls for sanctions/AML, payment controls, tax, invoicing/reporting and transaction purpose. It does not claim to discover or determine every applicable law. AI may explain source observations, but it cannot add an executable rule, pass compliance or authorize escrow.

## Consequences

- The same forms drive the real route instead of selecting a prewritten scenario.
- Direction cannot be reversed by a later request.
- Regulation evidence, FX rates, fees, documents and escrow parameters are explainable from one selected contract.
- Unsupported or incompletely reviewed country pairs fail closed.
- Adding another executable pair requires matching identities, reviewed source modules, deterministic rules, provider capabilities, FX support and settlement configuration.
