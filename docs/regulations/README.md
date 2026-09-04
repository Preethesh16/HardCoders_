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
| [Companies House public register](https://find-and-update.company-information.service.gov.uk/company/07209813) | live public record | UK legal-entity status, officers and PSC onboarding evidence |
| [GLEIF API](https://www.gleif.org/en/lei-data/gleif-api) | live public API | LEI status and legal-entity/registration-number cross-check |
| [UK Sanctions List](https://www.gov.uk/government/publications/the-uk-sanctions-list) | current official UK source | Company, officer and beneficial-owner screening at login |
| [UN consolidated list](https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list) | current official source | Company, officer and beneficial-owner screening at login |
| [OFAC Sanctions List Service](https://ofac.treasury.gov/sanctions-list-service) | current official source | Company, officer and beneficial-owner screening at login |
| [RBI PA-CB circular](https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=12561&Mode=0) | RBI/2023-24/80, 31 October 2023 | ₹25 lakh per-unit cap (8.2), import buyer CDD above ₹2.5 lakh (4.4), separate ICA/ECA (6.1) |
| [RBI Import of Goods and Services](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=10201) | updated 29 August 2024 | FEMA/AD-bank context for India-origin supplier payments |
| [RBI Other Remittance Facilities](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=10193) | updated 6 September 2024 | Form A2 scope and its imports/intermediary-trade distinction |
| [Income Tax Form 15CA FAQs](https://www.incometax.gov.in/iec/foportal/help/statutory-forms/popular-forms/form-15ca-faq) | observed 4 September 2026 | 15CA/15CB tax-review explanation; applicability requires human/tax review |
| [UK financial sanctions general guidance](https://www.gov.uk/government/publications/financial-sanctions-general-guidance) | updated 12 May 2026 | UK supplier, ownership/control and destination-account sanctions screening |
| [FCA payment-services conduct requirements](https://www.fca.org.uk/firms/payment-service-providers-conduct-business-requirements) | reviewed 4 September 2026 | destination-provider transaction amount/currency and post-contract information |
| [HMRC VAT on exports of goods](https://www.gov.uk/guidance/vat-exports-dispatches-and-supplying-goods-abroad) | updated 31 December 2020 | export VAT assessment, proof of export and record retention for the goods demo |
| [HMRC export declarations](https://www.gov.uk/guidance/make-and-manage-an-export-declaration-online) | published 4 March 2024 | EORI, commodity code, value/packaging, invoice, packing list, licence/certificate evidence |
| [HMRC VAT Notice 741A](https://www.gov.uk/guidance/vat-place-of-supply-of-services-notice-741a) | updated 29 September 2022 | separately reviewed UK-to-overseas B2B services place-of-supply path |
| [UK invoice requirements](https://www.gov.uk/invoicing-and-taking-payment-from-customers/invoices-what-they-must-include) | reviewed 4 September 2026 | supplier/customer, supply, date, amount and VAT invoice fields |
| [BaFin payment-services authorisation boundary](https://www.bafin.de/ref/19629832) | reviewed 4 September 2026 | German provider/funds-flow authorisation boundary; whether a technical service becomes regulated depends on the actual design |
| [Bank of Russia cross-border transfers and payments](https://www.cbr.ru/faq/w_fin_sector/Transgranichnie_perevodi/) | reviewed 4 September 2026 | current residency, counterparty, purpose and temporary currency-control review for every Russia-involved route |
| [EU Regulation 2023/1113](https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX%3A32023R1113) | 31 May 2023; applicable 30 December 2024 | payer/payee traceability, AML data protection and retention; refresh uses the official Publications Office RDF record |
| [Polish Ministry of Finance AML/CFT legislation](https://www.gov.pl/web/finance/legislation-aml-ctf) | page updated 17 April 2025 | Polish AML Act baseline and binding-language warning |
| [Polish cross-border PSP/CESOP guidance](https://www.gov.pl/web/national-revenue-administration/payment-services-providers) | obligations from 1 January 2024 | 25-payment quarterly trigger and three-year PSP record retention |
| [European Commission VAT place of taxation](https://taxation-customs.ec.europa.eu/where-tax_en) | reviewed 4 September 2026 | Germany → Poland B2B place-of-supply evidence |
| [European Commission VAT invoicing](https://taxation-customs.ec.europa.eu/taxation/vat/vat-businesses/invoicing_en) | reviewed 4 September 2026 | VAT identifiers and reverse-charge invoice notation |
| [EU sanctions resources](https://finance.ec.europa.eu/eu-and-world/sanctions-restrictive-measures/overview-sanctions-and-related-resources_en) | reviewed 4 September 2026 | Poland → Russia party, ownership, bank and purpose review |
| [Council of the EU: sanctions against North Korea](https://www.consilium.europa.eu/en/policies/sanctions-against-north-korea/timeline-eu-sanctions-against-north-korea/) | reviewed 4 September 2026 | Poland → DPRK rejection when no prior-authorisation path exists |
| [UN Security Council 1718 Committee](https://main.un.org/securitycouncil/en/sanctions/1718) | observed 4 September 2026 | Global DPRK asset-freeze and financial-measure baseline; Anchor blocks DPRK routes because it has no designation, licensing or exemption workflow |

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

The orchestration layer displays refresh progress and the observation status.
Payment creation calls `checkCorridorRegulations()` itself before evaluating
compliance, so a UI or client cannot bypass the gate. It may pass reviewed
retrieval results to the regulatory-explanation AI, but must never treat AI
text or `REVIEW_REQUIRED` content as an approved rule.

## Six-country corridor coverage gate

`REGULATION_CORRIDOR_MATRIX` enumerates all 30 directed, non-self pairs across
PL, IN, GB, DE, RU and KP. Every pair has exactly one profile in
`apps/api/src/regulations/coverage.ts`, and every profile declares all five
product-scope obligation categories: sanctions/AML, payment controls, tax,
invoicing/reporting and purpose.

The outcome matrix is intentionally conservative and exhaustive for the six
demo countries:

- All 12 ordered routes among PL, IN, GB and DE have narrowly reviewed B2B
  service coverage and deployed provider/Algorand rails. A deal must still
  match the reviewed parties, purpose, documents, live-source observation and
  FX scope in the fact-derived planner.
- All 8 ordered routes involving RU are explicit, source-backed
  `MANUAL_REVIEW` profiles. Each has five obligation-category records and the
  current Bank of Russia source in the approved corpus. The hold is deliberate:
  residency, party/ownership, beneficiary bank, sector, purpose and temporary
  control facts cannot safely be inferred from country and currency alone.
- All 10 pairs with DPRK as origin or destination are product-policy
  `BLOCKED`. The source record points to UN Security Council 1718 measures;
  Anchor blocks because the demo cannot establish designation status or run a
  licensing/exemption workflow. This is not a claim that international law
  prohibits every conceivable DPRK-related transaction.

```ts
const coverage = assessCorridorCoverage({
  bookId: 'PL-IN-INWARD',
  evaluatedAt: new Date(),
  refreshReport, // optional, immutable observation only
});

const outcome = applyCoverageOutcome(complianceOutcome, coverage);
```

Missing profiles/categories/sources, mismatched source versions, a future
effective date, an expired `reviewBy`, or an applicable source observation in
`REVIEW_REQUIRED` all close the hard gate. `assessment.hardGate` is executable
only for `PASSED`; manual profiles return `MANUAL_REVIEW_REQUIRED`, and DPRK
profiles return `REGULATORY_BLOCKED`. The helper never downgrades an existing
`BLOCKED` result. An unavailable live page does not by itself replace or
invalidate the reviewed extract before its review deadline.

## Deal-derived planner

`planDealRegulations()` is the API-friendly interface for new deals. It takes
the ordered payer/payee countries, declared direction, purpose code/type and
party types. Independently reviewed jurisdiction modules are matched and
composed into the same five obligation categories.

```ts
const plan = planDealRegulations({
  originCountry: 'PL',
  destinationCountry: 'IN',
  direction: 'INWARD',
  purposeCode: 'P0802',
  purposeType: 'SERVICES',
  originPartyType: 'COMPANY',
  destinationPartyType: 'FREELANCER',
  evaluatedAt: new Date(),
  refreshReport,
});

const sourcesToRefresh = regulationSourcesForPlan(plan);
```

The result includes the exact normalized deal facts, ordered route, derived book ID, category trace,
requirements, pinned official source references, source IDs, corpus hash and a
canonical plan hash. Changing a country, direction, purpose or party type
changes that commitment. It also returns structured control codes, the responsible
party, exact configured evidence/document requirements, and a hard
`canQuoteOrFund` gate. Unknown facts, missing category modules, stale/not-yet
effective modules, mismatched source pins and unreviewed source changes result
in `MANUAL_REVIEW`. A reviewed hard prohibition may return `BLOCKED`.

This is explicitly `ANCHOR_DEMO_OBLIGATIONS_ONLY`: it does not claim that every
law applicable to either participant, provider or country has been encoded.
The executable scope is deliberately narrow: B2B service payments among PL,
IN, GB and DE with the configured party types and purpose codes. Every one of
the 30 ordered routes has a deterministic outcome and source-backed RAG result,
but only those 12 standard routes can pass. A `PASSED` plan confirms reviewed
module coverage; orchestration must still verify every returned document
requirement before funding. AI retrieves and explains approved chunks only—it
cannot manufacture a rule, change an outcome or authorize settlement.

## Review procedure for a detected change

- Save the observation report and independently open the official source.
- Have a qualified reviewer compare the changed source with the approved
  extract and determine its effective date and corridor scope.
- Add a new source/ruleset version; do not edit historical versions in place.
- Add boundary tests for new thresholds/documents before activating it.
- Record reviewer identity and approval outside public ledgers. Never send PII
  or source documents to the AI explainer.
