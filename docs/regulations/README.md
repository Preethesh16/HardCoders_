# Anchor official-regulation corpus

This corpus is a hackathon compliance aid, not legal advice or a licensed
compliance service. It deliberately separates **approved rules** from **live
observations**:

1. `apps/api/src/regulations/catalog.ts` contains compact, reviewed extracts
   from official primary sources. Only these extracts are eligible for RAG.
2. `refreshOfficialRegulations()` fetches official pages through a strict HTTPS
   host allowlist and checks reviewed legal/version markers.
3. A missing marker produces `REVIEW_REQUIRED`. An unreachable or unsafe
   source produces `UNAVAILABLE`. In both cases the approved local extract
   remains active.
4. The optional AI explainer can summarize the immutable observation report.
   It cannot write the corpus, update a threshold, approve compliance, or
   authorize payment.

Run a read-only observation from the repository root:

```bash
pnpm --filter @optiwork/api exec tsx ../../scripts/sync-regulations.ts
```

To retain an owner-only observation artifact for human review:

```bash
pnpm --filter @optiwork/api exec tsx ../../scripts/sync-regulations.ts \
  --output ./regulation-observation.json
```

Exit code `2` means at least one reviewed marker changed or disappeared. The
command never edits the approved corpus or compliance rules.

## Approved official sources

Reviewed on 4 September 2026:

| Source | Official version/date | Used for |
|---|---|---|
| [RBI PA-CB circular](https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=12561&Mode=0) | RBI/2023-24/80, 31 October 2023 | ₹25 lakh per-unit cap (8.2), import buyer CDD above ₹2.5 lakh (4.4), separate ICA/ECA (6.1) |
| [RBI Import of Goods and Services](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=10201) | updated 29 August 2024 | FEMA/AD-bank context for India-origin supplier payments |
| [RBI Other Remittance Facilities](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=10193) | updated 6 September 2024 | Form A2 scope and its imports/intermediary-trade distinction |
| [Income Tax Form 15CA FAQs](https://www.incometax.gov.in/iec/foportal/help/statutory-forms/popular-forms/form-15ca-faq) | observed 4 September 2026 | 15CA/15CB tax-review explanation; applicability requires human/tax review |
| [EU Regulation 2023/1113](https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX%3A32023R1113) | 31 May 2023; applicable 30 December 2024 | payer/payee traceability, AML data protection and retention; refresh uses the official Publications Office RDF record |
| [Polish Ministry of Finance AML/CFT legislation](https://www.gov.pl/web/finance/legislation-aml-ctf) | page updated 17 April 2025 | Polish AML Act baseline and binding-language warning |
| [Polish cross-border PSP/CESOP guidance](https://www.gov.pl/web/national-revenue-administration/payment-services-providers) | obligations from 1 January 2024 | 25-payment quarterly trigger and three-year PSP record retention |

## Integration contract

```ts
const observation = await refreshOfficialRegulations();
// observation.rulesChanged is always false.

const context = retrieveRegulations({
  query: 'buyer due diligence for an Indian import',
  bookId: 'IN-GB-OUTWARD',
  limit: 4,
});
// context contains reviewed citations plus a stable corpusHash.
```

The orchestration layer should display refresh progress and the observation
status. It may pass `context.results` to the regulatory-explanation AI. It must
continue to call the deterministic compliance engine for the decision and must
never treat AI text or `REVIEW_REQUIRED` content as an approved rule.

## Review procedure for a detected change

- Save the observation report and independently open the official source.
- Have a qualified reviewer compare the changed source with the approved
  extract and determine its effective date and corridor scope.
- Add a new source/ruleset version; do not edit historical versions in place.
- Add boundary tests for new thresholds/documents before activating it.
- Record reviewer identity and approval outside public ledgers. Never send PII
  or source documents to the AI explainer.
