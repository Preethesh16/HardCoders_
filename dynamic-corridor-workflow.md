# Dynamic deal-derived corridor workflow

## Objective

Replace the standalone country-scenario tester with a corridor derived from
the actual payer company and selected freelancer proposal. The ordered payment
route is always `company payer country → freelancer payout country`.

## Required changes

1. Persist company country/funding currency on the job brief and freelancer
   residence/payout country and currency on the proposal.
2. Resolve the ordered corridor only after a freelancer is selected; reject
   incompatible country/currency choices.
3. Compose the applicable jurisdiction, direction, sanctions, payment-control,
   tax, invoicing/reporting and purpose obligations for those transaction facts.
4. Refresh the relevant reviewed official sources and hold unknown, stale,
   changed or incomplete coverage for human review.
5. Fetch a live, expiring two-leg FX quote only after the compliance decision
   passes; derive the fiat payout and six-decimal USD escrow amount from it.
6. Create/fund Algorand escrow only when a provider rail exists and every gate
   remains valid at signing time.
7. Show the actual corridor, obligation trace, source observations, FX legs,
   fees, tax/document responsibilities and payout plan inside the deal stage.
8. Preserve deterministic fixture mode for automated tests and explicit
   unsupported/manual-review outcomes for undeployed rails.

## Ownership

- Domain/API: participant facts, corridor resolution, compliance plan, quote
  and escrow gates.
- Regulation engine: composable jurisdiction obligations and reviewed coverage.
- Marketing UI: country/currency fields and deal-derived decision trace.

## Acceptance

- UK company + India freelancer resolves `GB → IN`.
- India company + UK freelancer resolves `IN → GB`.
- UI cannot reverse the payment direction silently.
- Changing either participant changes the resolved compliance plan and quote.
- Unsupported/unknown obligations never pass or sign.
- Blocked/review outcomes create no FX quote and no Algorand command.
- Passed, deployed routes use live FX in interactive mode and exact quote-fixed
  USD escrow amounts.
- Existing real Poland → India browser workflow still completes.
- No commit or push until the user manually approves.
