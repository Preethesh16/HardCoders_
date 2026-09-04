# ADR-004: Versioned multi-country corridor policy gates

- Status: accepted for the demonstration profile
- Date: 2026-09-04

## Context

Anchor needs to prove more than one happy-path country pair. A credible demo must show that the same payment boundary can allow a supported corridor, hold an incomplete or higher-risk transaction for human review, and reject a prohibited transaction before escrow signing. The decision cannot be delegated to an AI response or encoded only in dashboard text.

## Decision

Keep executable compliance rules as reviewed, source-controlled configuration and evaluate transaction facts dynamically with the same deterministic engine used by payment creation.

The reviewed corridor modules cover:

- Poland → India freelancer services: executable when credentials and export documents pass.
- India → United Kingdom supplier payments: RBI value limits, buyer due diligence, outward-remittance evidence and Section 195/Form 15CA/15CB path review.
- Germany → Poland B2B services: VAT identity, place-of-supply classification and reverse-charge invoice evidence.
- Poland → Russia: mandatory enhanced sanctions review; a confirmed listed-party or restricted-bank signal is a hard rejection. Country alone is not represented as a sanctions match.
- Poland → DPRK: rejected because Anchor has no provider or prior-authorisation workflow for the narrow exceptions.

Every corridor declares coverage for sanctions/AML, payment controls, tax, invoicing/reporting and transaction purpose. The declaration pins reviewed source versions and sections, plus an effective date and a mandatory review deadline. Missing, stale or changed applicable coverage yields `MANUAL_REVIEW`; this is a bounded product checklist, not a claim that software has discovered every law in a jurisdiction.

Every result includes a canonical hash, policy and ruleset versions, applied rules, document verdicts, reasons, official-source observations and an enforcement gate. `BLOCKED` and `MANUAL_REVIEW` skip FX and disable signing; `PASSED` still requires a deployed provider route and a current live quote. In `FX_MODE=frankfurter`, the external reference-rate adapter fails closed and cannot silently substitute fixture rates. Escrow uses the quote-fixed six-decimal USD amount only after the funding boundary re-verifies the quote, compliance decision, corridor, provider capabilities and deployment binding.

Regulation refresh and AI explanation remain advisory. They may flag that reviewed source material needs human attention, but cannot silently rewrite an executable rule or authorize funds. Payment creation itself reruns the relevant official-source and coverage gate, so bypassing the dashboard refresh does not bypass compliance.

## Consequences

- Judges can compare allow, hold and reject outcomes without pretending every country pair has a deployed settlement provider.
- Tax and sanctions obligations are traceable to reviewed official sources.
- Adding a corridor requires an ordered policy, rules, evidence requirements, tests and provider capability configuration before it becomes executable.
- This remains a zero-value demonstration, not tax, legal, sanctions-screening, KYC or payment advice.
