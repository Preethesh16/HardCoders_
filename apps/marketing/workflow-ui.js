// Anchor's role-specific deal workspace. The browser never receives party
// credentials or signing material: every command crosses the same-origin
// workflow boundary and is authorized server-side.
(() => {
  "use strict";

  let role = "COMPANY";
  let model = { steps: [], run: null };
  let busy = false;
  let initialized = false;
  let inspectedStage = null;
  let automationFocus = null;
  let transferAnimationUntil = 0;
  let transferAnimationTimer = null;

  const $ = selector => document.querySelector(selector);
  const escape = value => String(value ?? "—").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  const results = () => model.run?.results ?? {};
  const stepState = id => model.run?.actions?.[id];
  const isDone = id => stepState(id)?.status === "DONE";
  const isFailed = id => stepState(id)?.status === "FAILED";
  const firstStep = (...ids) => model.steps.find(step => ids.includes(step.id));
  const hasDone = (...ids) => ids.some(isDone);

  function money(minor, scale = 2, currency = "PLN") {
    if (minor === undefined || minor === null || minor === "") return "—";
    const amount = Number(minor) / 10 ** Number(scale);
    if (!Number.isFinite(amount)) return "—";
    return `${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  }

  function rate(units, scale = 10) {
    const value = Number(units) / 10 ** Number(scale);
    return Number.isFinite(value) ? value.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 }) : "—";
  }

  function shortRef(value, size = 12) {
    const text = String(value ?? "—");
    return text.length > size * 2 + 3 ? `${text.slice(0, size)}…${text.slice(-size)}` : text;
  }

  function proposalPrice(application) {
    const proposed = application?.proposedPrice;
    return proposed && typeof proposed === "object"
      ? money(proposed.amountMinor, proposed.scale, proposed.currency)
      : money(application?.proposedPriceMinor, application?.proposedPriceScale, application?.proposedPriceCurrency);
  }

  function lines(value) {
    return String(value ?? "").split(/\n+/u).map(item => item.replace(/^[-*]\s*/u, "").trim()).filter(Boolean);
  }

  async function request(path, options = {}) {
    const { headers = {}, ...requestOptions } = options;
    const response = await fetch(path, {
      ...requestOptions,
      headers: { accept: "application/json", "x-anchor-role": role, ...(options.body ? { "content-type": "application/json" } : {}), ...headers }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : body?.error?.message ?? `Request failed (${response.status})`);
    return body;
  }

  function setStatus(message, tone = "live") {
    const element = $("#workflowStatus");
    element.textContent = message;
    element.dataset.tone = tone;
  }

  function applications() {
    const list = results().applications;
    if (Array.isArray(list)) return list;
    const legacy = results().application;
    if (legacy) return [legacy];
    if (results().applicationId) return [{
      id: results().applicationId,
      applicantDisplayName: "Arjun Studio",
      evaluation: results().evaluation,
      coverLetter: "Proposal received through the authenticated freelancer account."
    }];
    return [];
  }

  function selectedApplication() {
    const id = results().selectedApplicationId ?? (results().contract ? results().applicationId : null);
    return applications().find(application => application.id === id) ?? (id ? { id } : null);
  }

  function agreement() {
    const value = results().agreement;
    if (value) return value;
    const contract = results().contract;
    return contract ? {
      contractHash: contract.contractHash,
      documentHash: contract.documentHash,
      fileName: contract.fileName,
      terms: contract.terms,
      policies: contract.policies,
      legalClauses: contract.legalClauses,
      acceptanceCriteria: contract.acceptanceCriteria,
      commercialTerms: contract.commercialTerms
    } : null;
  }

  function phaseStatus(ids, activeWhen = false) {
    if (ids.some(isFailed)) return "failed";
    if (ids.includes("automation") && results().binding) return "done";
    const existing = ids.filter(id => model.steps.some(step => step.id === id));
    if (existing.length && existing.every(isDone)) return "done";
    if (activeWhen) return "current";
    return "pending";
  }

  function renderRail() {
    const r = results();
    const phase = model.run?.phase ?? "JOB_DRAFT";
    const proposalDetail = applications().length ? `${applications().length} proposals · agent ranked` : "Waiting for proposals";
    const agreementDetail = agreement() ? `Hash ${shortRef(agreement().contractHash ?? agreement().artifactHash, 6)}` : "Set policy and legal terms";
    const escrowDetail = r.binding ? `${money(r.binding.amountUsdcMinor, r.binding.scale ?? 6, "USDC")} · ${r.binding.network}` : "Rules, FX and funding";
    const evidenceDetail = r.submission ? `Fabric ${shortRef(r.submission.evidenceId, 7)}` : "Validate evidence, decide, release";
    const companyPhases = [
      ["01", "Publish brief", "Define scope and budget", ["job"], phase === "JOB_DRAFT"],
      ["02", "Choose talent", proposalDetail, ["apply", "select"], ["APPLICATIONS_OPEN", "SCREENING", "COMPANY_SELECTION"].includes(phase)],
      ["03", "Lock agreement", agreementDetail, ["terms", "agreement-approve"], ["AGREEMENT_DRAFT", "AWAITING_FREELANCER_AGREEMENT"].includes(phase)],
      ["04", "Secure escrow", escrowDetail, ["automation"], ["AUTOMATING_ESCROW", "AUTOMATION_FAILED"].includes(phase)],
      ["05", "Review delivery", evidenceDetail, ["submit", "approve-work"], ["AWAITING_DELIVERY", "VALIDATING_DELIVERY", "VALIDATION_FAILED", "AWAITING_WORK_APPROVAL", "RELEASING", "RELEASE_FAILED", "COMPLETED"].includes(phase)]
    ];
    const freelancerPhases = [
      ["01", "Find opportunity", "Review the company brief", ["job"], phase === "JOB_DRAFT"],
      ["02", "Send proposal", "Price, timing and approach", ["apply"], phase === "APPLICATIONS_OPEN"],
      ["03", "Selection", r.selectedApplicationId ? "Company selection recorded" : "Agent screening in progress", ["select"], ["SCREENING", "COMPANY_SELECTION"].includes(phase)],
      ["04", "Review agreement", agreementDetail, ["terms", "agreement-approve"], ["AGREEMENT_DRAFT", "AWAITING_FREELANCER_AGREEMENT"].includes(phase)],
      ["05", "Escrow secured", escrowDetail, ["automation"], ["AUTOMATING_ESCROW", "AUTOMATION_FAILED"].includes(phase)],
      ["06", "Deliver & receive", evidenceDetail, ["submit", "approve-work"], ["AWAITING_DELIVERY", "VALIDATING_DELIVERY", "VALIDATION_FAILED", "AWAITING_WORK_APPROVAL", "RELEASING", "RELEASE_FAILED", "COMPLETED"].includes(phase)]
    ];
    const phases = role === "COMPANY" ? companyPhases : freelancerPhases;
    const completed = phases.filter(([, , , ids]) => phaseStatus(ids) === "done").length;
    $("#stageCount").textContent = `${String(completed).padStart(2, "0")} / ${String(phases.length).padStart(2, "0")}`;
    $("#workspaceStages").innerHTML = phases.map(([number, label, detail, ids, active]) => {
      const state = phaseStatus(ids, active);
      const selected = inspectedStage === number;
      const content = `<i>${state === "done" ? "✓" : number}</i><span><b>${escape(label)}</b><small>${escape(detail)}</small></span><em>${selected ? "VIEWING" : state === "current" ? "LIVE" : state.toUpperCase()}</em>`;
      return state === "done"
        ? `<button type="button" class="role-stage-item ${selected ? "selected" : ""}" data-state="${state}" data-inspect-stage="${number}">${content}</button>`
        : `<div class="role-stage-item" data-state="${state}" ${active ? 'aria-current="step"' : ""}>${content}</div>`;
    }).join("");
  }

  function documentAutofill(purpose) {
    const brief = purpose === "JOB_BRIEF";
    const agreementTerms = purpose === "AGREEMENT_TERMS";
    const documentName = brief ? "A JOB BRIEF" : agreementTerms ? "COMMERCIAL / LEGAL TERMS" : "YOUR PROPOSAL";
    const accessibleName = brief ? "company brief" : agreementTerms ? "commercial and legal terms" : "freelancer proposal";
    return `<div class="document-autofill">
      <input class="document-autofill-input" type="file" data-draft-file data-extract-purpose="${purpose}" accept=".pdf,.txt,.md,.doc,.docx,.rtf,.odt" aria-label="Upload ${accessibleName} to autofill the form">
      <div class="document-autofill-icon">↥</div>
      <div><small>AI DOCUMENT INTAKE · OPTIONAL</small><strong>DROP ${documentName} TO AUTOFILL</strong><p>PDF, DOCX, TXT or MD · maximum 8 MB. Review every extracted field before you submit.</p></div>
      <span data-draft-file-name>CHOOSE FILE</span>
      <output data-extraction-status aria-live="polite">Nothing is uploaded or published automatically.</output>
    </div>`;
  }

  function jobForm() {
    return `<section class="workspace-card action-card"><header><span>COMPANY INPUT · REQUIRED</span><b>NEW BRIEF</b></header><form class="workspace-form" data-workspace-form="job">
      ${documentAutofill("JOB_BRIEF")}
      <label><span>WORK TITLE</span><input name="title" required minlength="4" autocomplete="off" placeholder="e.g. Build a settlement reconciliation service"></label>
      <label><span>SCOPE OF WORK</span><textarea name="description" required minlength="20" placeholder="Explain the problem, expected outcome and what must be delivered"></textarea></label>
      <label><span>ACCEPTANCE CRITERIA</span><textarea name="acceptanceCriteria" required minlength="10" placeholder="List the objective checks used to accept the final work"></textarea></label>
      <div class="field-grid"><label><span>REQUIRED SKILLS</span><input name="skills" required placeholder="TypeScript, PostgreSQL, reconciliation"></label><label><span>BUDGET · PLN</span><input name="budget" type="number" min="1" step="0.01" required placeholder="12000.00"></label></div>
      <div class="field-grid"><label><span>TARGET DELIVERY DATE</span><input name="deliveryDate" type="date" required></label><label><span>DESTINATION</span><select name="destinationCountry" required><option value="IN">India · INR payout</option></select></label></div>
      <button type="submit">PUBLISH OPPORTUNITY <b>→</b></button><p class="form-hint">Nothing is prefilled. The published brief becomes the shared source of truth.</p>
    </form></section>`;
  }

  function applicationForm(job) {
    return `<section class="workspace-card action-card"><header><span>YOUR PROPOSAL</span><b>PRIVATE UNTIL SUBMITTED</b></header><form class="workspace-form" data-workspace-form="apply">
      ${documentAutofill("FREELANCER_PROPOSAL")}
      <div class="field-grid"><label><span>PROPOSED PRICE · PLN</span><input name="proposedPrice" type="number" min="1" step="0.01" required placeholder="10800.00"></label><label><span>DELIVERY · DAYS</span><input name="deliveryDays" type="number" min="1" max="365" required placeholder="21"></label></div>
      <label><span>AVAILABILITY</span><input name="availability" required minlength="3" placeholder="e.g. Available from Monday, 30 hours/week"></label>
      <label><span>DELIVERY APPROACH</span><textarea name="approach" required minlength="20" placeholder="Describe your milestones, technical approach and how you will prove completion"></textarea></label>
      <label><span>COVER LETTER</span><textarea name="coverLetter" required minlength="20" placeholder="Explain the experience that makes you a strong fit for this work"></textarea></label>
      <button type="submit">SUBMIT PROPOSAL <b>→</b></button><p class="form-hint">The screening agent can rank fit; only the company can award the work.</p>
      <input type="hidden" name="jobId" value="${escape(job?.id)}">
    </form></section>`;
  }

  function termsForm(application) {
    const proposed = proposalPrice(application);
    return `<section class="workspace-card action-card"><header><span>COMPANY TERMS</span><b>GENERATE PRIVATE AGREEMENT</b></header><div class="selected-talent"><small>SELECTED FREELANCER</small><strong>${escape(application?.applicantDisplayName ?? "Selected freelancer")}</strong><span>${escape(proposed)} · ${escape(application?.deliveryDays ? `${application.deliveryDays} days` : "delivery to be agreed")}</span></div><form class="workspace-form" data-workspace-form="terms">
      ${documentAutofill("AGREEMENT_TERMS")}
      <label><span>COMMERCIAL TERMS</span><textarea name="commercialTerms" required minlength="20" placeholder="Payment amount, delivery schedule, revision limits and invoicing terms"></textarea></label>
      <label><span>ACCEPTANCE CRITERIA</span><textarea name="acceptanceCriteria" required minlength="20" placeholder="Exact tests and evidence the company will use to approve the milestone"></textarea></label>
      <label><span>COMPANY POLICIES</span><textarea name="policies" required minlength="20" placeholder="Security, confidentiality, IP, data handling and communication policies"></textarea></label>
      <label><span>LEGAL CLAUSES</span><textarea name="legalClauses" required minlength="20" placeholder="Governing law, IP transfer, warranties, termination and dispute procedure"></textarea></label>
      <button type="submit">GENERATE + APPROVE AGREEMENT <b>→</b></button><p class="form-hint">The agreement agent formalizes these inputs. Both parties must accept the same SHA-256 hash.</p>
    </form></section>`;
  }

  function submissionForm() {
    return `<section class="workspace-card action-card"><header><span>PRIVATE DELIVERY</span><b>ANY FILE TYPE</b></header><form class="workspace-form" data-workspace-form="submit">
      <label class="workspace-file"><span>DELIVERABLE / SOURCE / PROOF</span><input name="file" type="file" required><b>SELECT THE ACTUAL FILE</b><small>No extension restriction. Bytes go to MinIO; SHA-256 evidence goes to Fabric.</small></label>
      <label><span>DELIVERY NOTE</span><textarea name="note" maxlength="2000" required placeholder="Explain what is included and how the company should validate it"></textarea></label>
      <button type="submit">UPLOAD + COMMIT EVIDENCE <b>→</b></button>
    </form></section>`;
  }

  function opportunity(job) {
    if (!job) return `<section class="workspace-card empty-state"><span>⌁</span><h2>WAITING FOR A VERIFIED OPPORTUNITY</h2><p>A company brief will appear here when it is published. You will never see company-only creation controls.</p></section>`;
    const skills = Array.isArray(job.skills) ? job.skills : [];
    return `<section class="workspace-card opportunity-card"><header><span>OPEN OPPORTUNITY</span><b>${escape(job.status ?? "OPEN")}</b></header><div><p class="mini-label">${escape(job.destinationCountry ?? "IN")} CORRIDOR · VERIFIED COMPANY</p><h2>${escape(job.title)}</h2><p>${escape(job.description)}</p><div class="opportunity-meta"><span><small>BUDGET</small><b>${escape(money(job.budgetAmountMinor, job.budgetScale, job.budgetCurrency))}</b></span><span><small>SKILLS</small><b>${escape(skills.join(" · ") || "See brief")}</b></span></div></div></section>`;
  }

  function applicantCards() {
    const list = applications().slice().sort((a, b) => Number(a.rank ?? 999) - Number(b.rank ?? 999) || Number(b.evaluation?.score ?? 0) - Number(a.evaluation?.score ?? 0));
    if (!list.length) return `<section class="workspace-card empty-state"><span>⌛</span><h2>WAITING FOR PROPOSALS</h2><p>Freelancers submit their own pricing, delivery timing, availability and approach. Applicant data is never fabricated in this view.</p></section>`;
    const selectStep = firstStep("select");
    const selectedId = results().selectedApplicationId ?? (results().contract ? results().applicationId : null);
    const screeningReady = model.run?.screening?.status === "COMPLETED";
    return `<section class="workspace-card applicants-card"><header><span>SCREENING DESK</span><b>${escape(model.run?.screening?.status ?? "WAITING")} · ${list.length} PROPOSALS</b></header><div class="applicant-grid">${list.map((application, index) => {
      const evaluation = application.evaluation ?? application.aiEvaluation;
      const chosen = selectedId === application.id;
      return `<article class="applicant-card ${chosen ? "selected" : ""}"><div class="applicant-rank"><i>${escape(application.rank ?? index + 1)}</i><span><small>${chosen ? "SELECTED" : "AGENT RANK"}</small><b>${evaluation?.score !== undefined ? `${escape(evaluation.score)}/100` : "SCREENING"}</b></span></div><h3>${escape(application.applicantDisplayName ?? application.applicantName ?? `Freelancer ${index + 1}`)}</h3><p>${escape(evaluation?.summary ?? application.coverLetter ?? "Proposal received and awaiting advisory screening.")}</p><dl><div><dt>PRICE</dt><dd>${escape(proposalPrice(application))}</dd></div><div><dt>DELIVERY</dt><dd>${escape(application.deliveryDays ? `${application.deliveryDays} days` : "—")}</dd></div><div><dt>AVAILABILITY</dt><dd>${escape(application.availability)}</dd></div></dl><details><summary>READ APPROACH</summary><p>${escape(application.approach ?? application.coverLetter)}</p></details>${!selectedId && selectStep && screeningReady ? `<button type="button" data-select-application="${escape(application.id)}">SELECT THIS FREELANCER <b>→</b></button>` : ""}</article>`;
    }).join("")}</div><p class="advisory-note">AI ranking is advisory. The company remains accountable for the final selection.</p></section>`;
  }

  function agreementCard(canApprove = false) {
    const item = agreement();
    if (!item) return `<section class="workspace-card empty-state"><span>▤</span><h2>AGREEMENT NOT GENERATED YET</h2><p>The selected freelancer will receive the exact document after company terms are formalized.</p></section>`;
    const terms = item.terms ?? {};
    const rows = [["COMMERCIAL TERMS", item.commercialTerms ?? terms.commercialTerms], ["ACCEPTANCE", item.acceptanceCriteria ?? terms.acceptanceCriteria], ["COMPANY POLICIES", item.policies ?? terms.policies], ["LEGAL CLAUSES", item.legalClauses ?? terms.legalClauses]].filter(([, value]) => value);
    const downloadUrl = `/api/workflow/agreement/download?role=${role === "FREELANCER" ? "freelancer" : "company"}`;
    return `<section class="workspace-card agreement-card"><header><span>PRIVATE LEGAL AGREEMENT</span><b>PARTIES ONLY</b></header><div class="agreement-document"><div class="document-icon">DOC<br><b>✓</b></div><div><small>${escape(item.fileName ?? "anchor-work-agreement.pdf")}</small><h2>SHARED BETWEEN COMPANY + SELECTED FREELANCER</h2><p>${escape(item.byteLength ? `${item.byteLength} encrypted bytes in MinIO` : "Encrypted source document stored in MinIO")}</p></div></div><div class="hash-panel"><small>AGREEMENT SHA-256</small><code>${escape(item.artifactHash ?? item.documentHash ?? item.sha256 ?? item.contractHash)}</code></div>${rows.length ? `<dl class="agreement-terms">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl>` : ""}<div class="document-actions"><a href="${downloadUrl}" target="_blank" rel="noopener">DOWNLOAD AUTHORIZED DOCUMENT ↗</a>${canApprove ? `<button type="button" data-approve-agreement>I REVIEWED THIS HASH · ACCEPT <b>→</b></button>` : ""}</div></section>`;
  }

  function automationCard() {
    const r = results();
    const automation = model.run?.automation;
    const stages = automation?.stages ?? {};
    const quote = r.quote;
    const compliance = r.compliance;
    const regulation = r.regulation;
    const binding = r.binding;
    const observations = regulation?.report?.observations ?? [];
    const retrieval = regulation?.retrieval?.results ?? [];
    const fxFacts = quote ? [
      [quote.legs?.[0]?.pair ?? "PLN/USD", rate(quote.legs?.[0]?.rateUnits, quote.legs?.[0]?.rateScale)],
      [quote.legs?.[1]?.pair ?? "USD/INR", rate(quote.legs?.[1]?.rateUnits, quote.legs?.[1]?.rateScale)],
      ["LOCKED VALUE", money(quote.settlementAmount?.amountMinor, quote.settlementAmount?.scale, "USDC")],
      ["PAYOUT", money(quote.payoutAmount?.amountMinor, quote.payoutAmount?.scale, quote.payoutAmount?.currency)]
    ] : [];
    const items = [
      {
        key: "rules", label: "Regulatory intelligence", status: stages.rules?.status ?? (regulation ? "COMPLETED" : "PENDING"),
        detail: stages.rules?.detail ?? "Checking the approved official-source corpus for changes.",
        facts: regulation ? [["OFFICIAL SOURCES", `${observations.length} checked`], ["CHANGES", regulation.report?.rulesChanged ? "Detected" : "None detected"], ["CORPUS", shortRef(regulation.retrieval?.corpusHash, 10)]] : []
      },
      {
        key: "documents", label: "Private documents", status: stages.documents?.status ?? (r.agreement ? "COMPLETED" : "PENDING"),
        detail: stages.documents?.detail ?? "Keeping private bytes in MinIO and committing only hashes.",
        facts: r.agreement ? [["AGREEMENT", shortRef(r.agreement.artifactHash, 10)], ["STORAGE", "Private MinIO object"], ["ACCESS", "Two contracting parties"]] : []
      },
      {
        key: "compliance", label: "Corridor compliance", status: compliance ? "COMPLETED" : quote ? "RUNNING" : "PENDING",
        detail: compliance?.reasons?.[0] ?? "Evaluating corridor, credentials, documents and value limits.",
        facts: compliance ? [["OUTCOME", compliance.outcome], ["BOOK", compliance.bookId], ["RULES", compliance.appliedRules?.join(" · ")], ["DOCUMENTS", compliance.requiredDocuments?.map(item => `${item.code}: ${item.satisfied ? "OK" : "MISSING"}`).join(" · ")]] : []
      },
      {
        key: "fx", label: "FX quote and value lock", status: stages.fx?.status ?? (quote ? "COMPLETED" : "PENDING"),
        detail: quote ? `${money(quote.fundingAmount?.amountMinor, quote.fundingAmount?.scale, quote.fundingAmount?.currency)} is converted across two quoted legs. Fees are deducted before the USDC settlement value is fixed.` : "Fetching the reference rates and calculating both conversion legs.",
        facts: quote ? [...fxFacts, ["SOURCE", quote.rateSource], ["EXPIRES", new Date(quote.expiresAt).toLocaleString()]] : []
      },
      {
        key: "escrow", label: "Algorand escrow", status: stages.escrow?.status ?? (binding ? "COMPLETED" : "PENDING"),
        detail: binding ? "The provider treasury funded an ARC-4 escrow for the exact quoted settlement amount. End users never receive crypto or signing keys." : "Waiting for the approved compliance and FX commitments before funding.",
        facts: binding ? [["NETWORK", binding.network], ["APPLICATION", binding.applicationId], ["ASSET", binding.assetId], ["DEAL", shortRef(binding.dealId, 10)], ["BINDING", shortRef(binding.bindingHash, 10)]] : []
      }
    ];
    const focus = items.find(item => item.key === automationFocus) ?? items.find(item => ["RUNNING", "FAILED"].includes(String(item.status))) ?? items.find(item => String(item.status) === "PENDING") ?? items.at(-1);
    const citations = focus?.key === "rules" ? retrieval.slice(0, 3) : focus?.key === "compliance" ? (compliance?.citations ?? []).slice(0, 3).map(citation => ({ summary: `${citation.section} · ${citation.sourceVersion}`, citation })) : [];
    return `<section class="automation-workspace"><header><div><small>LIVE ORCHESTRATION</small><h3>Why the escrow is being created</h3><p>Each result below comes from the active workflow state. Completed outputs are persisted before the next operation begins.</p></div><span data-state="${escape(String(automation?.status ?? "RUNNING").toLowerCase())}">${escape(automation?.status ?? "RUNNING")}</span></header><div class="automation-grid"><div class="automation-stream">${items.map((item, index) => {
      const state = String(item.status ?? "PENDING").toLowerCase();
      return `<button type="button" data-automation-focus="${escape(item.key)}" data-state="${escape(state)}" class="${focus?.key === item.key ? "focused" : ""}"><i>${state === "completed" ? "✓" : String(index + 1).padStart(2, "0")}</i><div><span><b>${escape(item.label)}</b><em>${escape(item.status)}</em></span><p>${escape(item.detail)}</p></div></button>`;
    }).join("")}</div><aside class="reasoning-card"><small>ACTIVE DECISION EVIDENCE</small><h4>${escape(focus?.label ?? "Preparing workflow")}</h4><p>${escape(focus?.detail ?? "Waiting for persisted evidence.")}</p>${focus?.facts?.length ? `<dl>${focus.facts.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl>` : `<div class="evidence-wait">Waiting for the service response…</div>`}${citations.length ? `<div class="source-list"><small>RETRIEVED OFFICIAL SOURCES</small>${citations.map(item => `<a href="${escape(item.citation?.sourceUri)}" target="_blank" rel="noopener"><b>${escape(item.citation?.authority ?? item.citation?.sourceVersion ?? "OFFICIAL SOURCE")}</b><span>${escape(item.summary)}</span></a>`).join("")}</div>` : ""}</aside></div>${quote ? `<footer class="value-lock"><div><small>COMPANY FUNDS</small><b>${escape(money(quote.fundingAmount?.amountMinor, quote.fundingAmount?.scale, quote.fundingAmount?.currency))}</b></div><i>→</i><div><small>FIXED ESCROW</small><b>${escape(money(quote.settlementAmount?.amountMinor, quote.settlementAmount?.scale, "USDC"))}</b></div><i>→</i><div><small>LOCAL PAYOUT</small><b>${escape(money(quote.payoutAmount?.amountMinor, quote.payoutAmount?.scale, quote.payoutAmount?.currency))}</b></div></footer>` : ""}</section>`;
  }

  function submissionReview() {
    const submission = results().submission;
    if (!submission) return `<section class="workspace-card empty-state"><span>⇧</span><h2>WAITING FOR PRIVATE DELIVERY</h2><p>The selected freelancer uploads the actual deliverable. You receive authorized access while Fabric receives only its hash.</p></section>`;
    const advisory = results().workValidation;
    const delivery = model.run?.deliveryAutomation;
    const approveStep = firstStep("approve-work");
    const ready = model.run?.phase === "AWAITING_WORK_APPROVAL";
    return `<section class="workspace-card review-card"><header><span>DELIVERY REVIEW</span><b>${escape(delivery?.status ?? submission.status ?? "SUBMITTED")}</b></header><div class="review-file"><i>FILE</i><span><small>${escape(submission.fileName ?? "Private deliverable")}</small><b>${escape(submission.byteLength ? `${submission.byteLength} bytes` : "Stored in MinIO")}</b></span><a href="/api/workflow/submission/download" target="_blank" rel="noopener">DOWNLOAD ↗</a></div><div class="hash-panel"><small>FABRIC EVIDENCE · SHA-256</small><code>${escape(submission.fileHash)}</code></div><div class="agent-verdict"><span><small>ADVISORY VALIDATION</small><b>${escape(advisory?.score !== undefined ? `${advisory.score}/100` : delivery?.status ?? "RUNNING")}</b></span><p>${escape(advisory?.summary ?? delivery?.stages?.validation?.detail ?? "The validation agent is checking the deliverable against the accepted criteria.")}</p></div>${approveStep && !isDone(approveStep.id) && ready ? `<button class="primary-command" type="button" data-approve-work>APPROVE WORK + RELEASE PAYOUT <b>→</b></button>` : ""}<p class="advisory-note">The agent recommends. A company human approves. Release then proceeds automatically against Fabric evidence.</p></section>`;
  }

  function submissionReceipt() {
    const submission = results().submission;
    if (!submission) return waiting("DELIVERY NOT RECORDED", "Upload the private deliverable from the live delivery stage.");
    const advisory = results().workValidation;
    const delivery = model.run?.deliveryAutomation;
    return `<section class="workspace-card review-card"><header><span>YOUR DELIVERY RECORD</span><b>${escape(delivery?.status ?? submission.status ?? "SUBMITTED")}</b></header><div class="review-file"><i>FILE</i><span><small>${escape(submission.fileName ?? "Private deliverable")}</small><b>${escape(submission.byteLength ? `${submission.byteLength} bytes` : "Stored in MinIO")}</b></span><a href="/api/workflow/submission/download" target="_blank" rel="noopener">DOWNLOAD ↗</a></div><div class="hash-panel"><small>FABRIC EVIDENCE · SHA-256</small><code>${escape(submission.fileHash)}</code></div><div class="agent-verdict"><span><small>ADVISORY VALIDATION</small><b>${escape(advisory?.score !== undefined ? `${advisory.score}/100` : delivery?.status ?? "RUNNING")}</b></span><p>${escape(advisory?.summary ?? delivery?.stages?.validation?.detail ?? "The validation agent is checking the deliverable against the accepted criteria.")}</p></div><p class="advisory-note">Your private file remains in MinIO. Its Fabric evidence and the company decision are linked to the settlement release.</p></section>`;
  }

  function payoutCard() {
    const payment = results().payment;
    const binding = results().binding;
    const agreedFunding = results().quote?.fundingAmount ?? results().contractAmount ?? (results().job ? {
      amountMinor: results().job.budgetAmountMinor,
      currency: results().job.budgetCurrency,
      scale: results().job.budgetScale
    } : null);
    const completed = model.run?.phase === "COMPLETED" || payment?.state === "COMPLETED" || binding?.state === "COMPLETED";
    const quote = results().quote;
    const compliance = results().compliance;
    return `<section class="workspace-card payout-card ${completed ? "complete" : ""}"><header><span>SECURED PAYOUT</span><b>${completed ? "COMPLETED" : escape(payment?.state ?? binding?.state ?? "PENDING")}</b></header><div class="payout-route"><span><small>AGREED PRICE</small><b>${escape(agreedFunding ? money(agreedFunding.amountMinor, agreedFunding.scale, agreedFunding.currency) : "PLN")}</b></span><i>→</i><span><small>ESCROW LOCKS</small><b>${escape(binding ? money(binding.amountUsdcMinor, binding.scale ?? 6, "USDC") : "USDC")}</b></span><i>→</i><span><small>YOU RECEIVE</small><b>${escape(payment?.payoutAmountMinor ? money(payment.payoutAmountMinor, payment.payoutScale, payment.payoutCurrency ?? "INR") : "INR")}</b></span></div>${quote || compliance || binding ? `<div class="payout-reasoning"><span><small>WHY THIS AMOUNT</small><b>${escape(quote ? `Two live FX legs · ${quote.rateSource}` : "Waiting for FX quote")}</b></span><span><small>WHY IT CAN SETTLE</small><b>${escape(compliance ? `${compliance.outcome} · ${compliance.appliedRules?.length ?? 0} rules` : "Compliance pending")}</b></span><span><small>WHERE IT IS LOCKED</small><b>${escape(binding ? `${binding.network} · app ${binding.applicationId} · asset ${binding.assetId}` : "Escrow pending")}</b></span></div>` : ""}<p>${completed ? "The local INR credit is linked to the approved Fabric evidence and the confirmed provider escrow release." : "The quoted USDC amount is fixed when funded, so later FX movement cannot change this escrow."}</p></section>`;
  }

  function moneyTransferScreen() {
    const payment = results().payment;
    const binding = results().binding;
    const quote = results().quote;
    const completed = model.run?.phase === "COMPLETED" || payment?.state === "COMPLETED";
    const companyAmount = quote?.fundingAmount ?? (payment ? { amountMinor: payment.fundingAmountMinor, scale: payment.fundingScale, currency: payment.fundingCurrency } : null);
    const payoutAmount = quote?.payoutAmount ?? (payment ? { amountMinor: payment.payoutAmountMinor, scale: payment.payoutScale, currency: payment.payoutCurrency } : null);
    return `<section class="money-transfer-screen" data-transfer-screen data-state="${completed ? "completed" : "releasing"}" aria-live="polite">
      <header><div><small>REAL SETTLEMENT EVENT</small><h3>${completed ? "PAYMENT LANDED." : "PAYMENT IS MOVING."}</h3><p>${completed ? "Algorand confirmed the provider release and the destination ledger recorded the local INR credit." : "The approved Fabric evidence is authorizing the Algorand escrow release now."}</p></div><span>${completed ? "CONFIRMED" : "RELEASING"}</span></header>
      <div class="money-transfer-stage">
        <figure><div><img src="assets/optiwork-company-pixel.png" alt="Company representative"></div><figcaption><small>COMPANY · POLAND</small><b>WORK APPROVED</b><em>${escape(companyAmount ? money(companyAmount.amountMinor, companyAmount.scale, companyAmount.currency) : "PLN")}</em></figcaption></figure>
        <div class="transfer-lane" aria-hidden="true"><small>FABRIC APPROVAL → ALGORAND ESCROW → INR CREDIT</small><div>${Array.from({ length: 9 }, (_, index) => `<i style="--packet:${index}">${index < 3 ? "✓" : index < 7 ? "$" : "₹"}</i>`).join("")}</div><b>${completed ? "TRANSFER CONFIRMED" : "RELEASING SECURED VALUE"}</b></div>
        <figure><div><img src="assets/optiwork-freelancer-pixel.png" alt="Freelancer"></div><figcaption><small>FREELANCER · INDIA</small><b>${completed ? "MONEY RECEIVED" : "AWAITING CREDIT"}</b><em>${escape(payoutAmount ? money(payoutAmount.amountMinor, payoutAmount.scale, payoutAmount.currency) : "INR")}</em></figcaption></figure>
      </div>
      <dl class="transfer-proof"><div><dt>FABRIC DECISION</dt><dd>${escape(shortRef(results().fabricDecisionTxId, 10))}</dd></div><div><dt>ESCROW DEAL</dt><dd>${escape(shortRef(binding?.dealId, 10))}</dd></div><div><dt>NETWORK</dt><dd>${escape(binding?.network ?? "LOCALNET")}</dd></div></dl>
      <p class="transfer-explainer">The characters visualize the real provider-mediated flow. The company and freelancer remain fiat-only; neither user receives cryptocurrency or signs a blockchain transaction.</p>
    </section>`;
  }

  function showTransferScreen(phase) {
    return phase === "RELEASING" || Date.now() < transferAnimationUntil;
  }

  function waiting(title, copy) {
    return `<section class="workspace-card empty-state"><span>⌛</span><h2>${escape(title)}</h2><p>${escape(copy)}</p></section>`;
  }

  function jobBrief(job) {
    if (!job) return "";
    const skills = Array.isArray(job.skills) ? job.skills.join(" · ") : "See published brief";
    return `<section class="stage-brief"><span><small>LIVE OPPORTUNITY</small><b>${escape(job.title)}</b></span><span><small>BUDGET</small><b>${escape(money(job.budgetAmountMinor, job.budgetScale, job.budgetCurrency))}</b></span><span><small>SKILLS</small><b>${escape(skills)}</b></span></section>`;
  }

  function stageScreen(number, eyebrow, title, copy, content, status = "ACTION REQUIRED") {
    return `<section class="stage-screen"><header class="stage-screen-head"><div class="stage-number"><small>STAGE</small><b>${escape(number)}</b></div><div class="stage-title"><small>${escape(eyebrow)}</small><h2>${escape(title)}</h2><p>${escape(copy)}</p></div><span class="stage-state"><i></i>${escape(status)}</span></header><div class="stage-screen-body">${content}</div></section>`;
  }

  function pairedStage(primary, secondary) {
    return `<div class="stage-content-grid">${primary}${secondary}</div>`;
  }

  function renderCompany() {
    const r = results();
    const phase = model.run?.phase;
    if (!r.job) return stageScreen("01", "PUBLISH THE MISSION", "Create the work brief", "Define the outcome, proof criteria, skills, budget and delivery date. Nothing is prefilled.", jobForm());
    if (!r.selectedApplicationId && !r.contract) return stageScreen("02", "SCREENING DESK", "Choose the right freelancer", "Live proposals are ranked by the advisory agent. You remain responsible for the final award.", `${jobBrief(r.job)}${applicantCards()}`, applications().length ? "HUMAN DECISION" : "WAITING FOR TALENT");
    if (phase === "AGREEMENT_DRAFT" || !agreement()) return stageScreen("03", "PRIVATE AGREEMENT", "Lock the exact terms", "Turn the selected proposal into a bilateral agreement with commercial, acceptance, policy and legal terms.", termsForm(selectedApplication()));
    if (phase === "AWAITING_FREELANCER_AGREEMENT") return stageScreen("03", "COUNTERPARTY REVIEW", "Agreement sent for acceptance", "The freelancer receives the same private document and must accept its exact SHA-256 hash.", agreementCard(false), "WAITING FOR FREELANCER");
    if (!r.binding && phase !== "AWAITING_DELIVERY") return stageScreen("04", "ANCHOR AUTOPILOT", "Secure the cross-border escrow", "Official-source policy checks, live FX, compliance evidence and Algorand funding advance automatically.", automationCard(), "AGENTS WORKING");
    if (!r.submission) return stageScreen("05", "DELIVERY DESK", "Escrow is secured", "The agreed settlement value is locked. The selected freelancer can now upload the private deliverable.", payoutCard(), "WAITING FOR DELIVERY");
    if (showTransferScreen(phase)) return stageScreen("05", "SETTLEMENT RAIL", phase === "COMPLETED" ? "The payout has arrived" : "Approved value is moving", "This screen follows the actual release state after the company approval was recorded on Fabric.", moneyTransferScreen(), phase === "COMPLETED" ? "TRANSFER COMPLETE" : "LIVE TRANSFER");
    return stageScreen("05", "EVIDENCE + RELEASE", phase === "COMPLETED" ? "Work approved. Payout complete." : "Review the private delivery", "Download the file, inspect the validation evidence, and authorize release only when the agreed criteria are met.", pairedStage(submissionReview(), payoutCard()), phase === "COMPLETED" ? "COMPLETED" : "HUMAN DECISION");
  }

  function renderFreelancer() {
    const r = results();
    const phase = model.run?.phase;
    if (!r.job) return stageScreen("01", "OPPORTUNITY DESK", "Waiting for verified work", "A published company brief will appear here. Company-only creation controls never appear in your portal.", opportunity(null), "LISTENING FOR BRIEFS");
    if (!hasDone("apply")) return stageScreen("02", "YOUR PROPOSAL", "Price and plan the work", "Review the live brief, then enter your own price, delivery timing, availability and technical approach.", `${jobBrief(r.job)}${applicationForm(r.job)}`);
    const selected = Boolean(r.selectedApplicationId || r.contract);
    if (!selected) return stageScreen("03", "SELECTION STATUS", "Your proposal is in review", "The screening agent ranks every real proposal; only the company can award the work.", `${jobBrief(r.job)}${waiting("PROPOSAL SUBMITTED", "Stay on this screen. The shared workflow updates automatically when the company chooses a freelancer.")}`, "SCREENING IN PROGRESS");
    if (!agreement()) return stageScreen("04", "AGREEMENT PREPARATION", "You were selected", "The company is entering the commercial, acceptance, policy and legal terms for your private review.", waiting("TERMS ARE BEING PREPARED", "You will be asked to accept the exact agreement hash before any escrow can be funded."), "WAITING FOR COMPANY");
    if (phase === "AWAITING_FREELANCER_AGREEMENT" && !hasDone("agreement-approve")) return stageScreen("04", "BILATERAL APPROVAL", "Review the private agreement", "Download the document, verify every term, and accept the exact hash only when you agree.", agreementCard(true));
    if (!r.binding && phase !== "AWAITING_DELIVERY") return stageScreen("05", "ANCHOR AUTOPILOT", "Watch escrow become secured", "Anchor checks the corridor, locks the FX quote, records compliance evidence and funds the provider escrow.", automationCard(), "AGENTS WORKING");
    if (!r.submission) return stageScreen("06", "PRIVATE DELIVERY", "Submit the finished work", "Your bytes go to private object storage. Only the evidence hash and buyer decision go to Hyperledger Fabric.", pairedStage(submissionForm(), payoutCard()));
    if (showTransferScreen(phase)) return stageScreen("06", "SETTLEMENT RAIL", phase === "COMPLETED" ? "Your local payout has arrived" : "Your payout is moving", "The release follows the approved Fabric evidence and confirmed Algorand escrow state.", moneyTransferScreen(), phase === "COMPLETED" ? "MONEY RECEIVED" : "LIVE TRANSFER");
    return stageScreen("06", "DELIVERY + PAYOUT", phase === "COMPLETED" ? "Local payout complete" : "Delivery submitted", phase === "COMPLETED" ? "The company approved the Fabric evidence and the destination provider credited your local INR balance." : "The company is reviewing your private file. The advisory agent cannot release funds.", pairedStage(submissionReceipt(), payoutCard()), phase === "COMPLETED" ? "COMPLETED" : "WAITING FOR COMPANY");
  }

  function proposalReceipt() {
    const application = applications().find(item => item.id === results().primaryApplicationId) ?? applications()[0];
    if (!application) return waiting("PROPOSAL NOT RECORDED", "Submit your price, timing and approach from the live stage.");
    return `<section class="workspace-card proposal-receipt"><header><span>YOUR RECORDED PROPOSAL</span><b>${escape(application.status ?? "SUBMITTED")}</b></header><div><span><small>PRICE</small><b>${escape(proposalPrice(application))}</b></span><span><small>DELIVERY</small><b>${escape(application.deliveryDays ? `${application.deliveryDays} days` : "—")}</b></span><span><small>AGENT SCORE</small><b>${escape(application.evaluation?.score !== undefined ? `${application.evaluation.score}/100` : "Pending")}</b></span></div><p>${escape(application.evaluation?.summary ?? application.approach)}</p></section>`;
  }

  function renderInspection(number) {
    const r = results();
    let content;
    if (role === "COMPANY") {
      if (number === "01") content = stageScreen("01", "PUBLISHED RECORD", "The opportunity that started this deal", "This is the persisted brief shared with eligible freelancers.", opportunity(r.job), "COMPLETED");
      if (number === "02") content = stageScreen("02", "SCREENING RESULT", "How the company chose talent", "Scores and summaries are advisory outputs produced from the submitted proposal data.", `${jobBrief(r.job)}${applicantCards()}`, "COMPLETED");
      if (number === "03") content = stageScreen("03", "BILATERAL RECORD", "The exact agreement both parties accepted", "The document stays private in MinIO; the shared hash proves both parties reviewed the same bytes.", agreementCard(false), "COMPLETED");
      if (number === "04") content = stageScreen("04", "DECISION TRACE", "How compliance, FX and escrow were resolved", "Inspect the actual official-source, quote, policy and Algorand outputs used for this deal.", automationCard(), "COMPLETED");
      if (number === "05") content = stageScreen("05", "EVIDENCE + RELEASE", "How the work unlocked settlement", "Fabric evidence, advisory validation and the confirmed payout remain linked in one record.", pairedStage(submissionReview(), payoutCard()), model.run?.phase === "COMPLETED" ? "COMPLETED" : "RECORDED");
    } else {
      if (number === "01") content = stageScreen("01", "PUBLISHED OPPORTUNITY", "The company brief you reviewed", "This is the real opportunity record that your proposal references.", opportunity(r.job), "COMPLETED");
      if (number === "02") content = stageScreen("02", "PROPOSAL RECORD", "What you offered", "Your price, timing and approach were persisted before the company made its decision.", proposalReceipt(), "COMPLETED");
      if (number === "03") content = stageScreen("03", "SELECTION RESULT", "Why this proposal was selected", "The agent supplied advisory reasoning; the company remained responsible for selection.", proposalReceipt(), "COMPLETED");
      if (number === "04") content = stageScreen("04", "BILATERAL RECORD", "The agreement you accepted", "The exact artifact hash is shared only between the two contracting parties.", agreementCard(false), "COMPLETED");
      if (number === "05") content = stageScreen("05", "DECISION TRACE", "How your escrow amount was secured", "Inspect the actual regulation, compliance, FX and Algorand results behind the payout.", automationCard(), "COMPLETED");
      if (number === "06") content = stageScreen("06", "DELIVERY + PAYOUT", "How your evidence became local money", "The payout is tied to the company decision over the Fabric work-evidence record.", pairedStage(submissionReceipt(), payoutCard()), model.run?.phase === "COMPLETED" ? "COMPLETED" : "RECORDED");
    }
    return `<div class="history-banner"><span>Viewing persisted stage ${escape(number)}</span><button type="button" data-return-live>Return to live stage</button></div>${content ?? (role === "COMPANY" ? renderCompany() : renderFreelancer())}`;
  }

  function renderSnapshot() {
    const r = results();
    const item = agreement();
    const rows = [];
    if (r.job) rows.push(["OPPORTUNITY", r.job.title], ["BUDGET", money(r.job.budgetAmountMinor, r.job.budgetScale, r.job.budgetCurrency)]);
    if (applications().length) rows.push(["PROPOSALS", String(applications().length)]);
    if (selectedApplication()) rows.push(["SELECTED", selectedApplication().applicantDisplayName ?? selectedApplication().id]);
    if (item) rows.push(["AGREEMENT HASH", item.artifactHash ?? item.documentHash ?? item.contractHash]);
    if (r.regulation) rows.push([
      "RULE SOURCE",
      r.regulation.report?.requiresHumanReview
        ? "HUMAN REVIEW REQUIRED"
        : `${r.regulation.report?.observations?.length ?? 0} OFFICIAL SOURCES CHECKED`
    ]);
    if (r.compliance) rows.push(["COMPLIANCE", `${r.compliance.outcome} · ${r.compliance.rulesVersion}`]);
    if (r.quote) rows.push(["FX LOCK", `${r.quote.rateSource} · ${r.quote.rateObservedAt}`]);
    if (r.binding) rows.push(["ARC-4 APP", r.binding.applicationId], ["ASA", r.binding.assetId], ["ESCROW", r.binding.dealId]);
    if (r.submission) rows.push(["FABRIC EVIDENCE", r.submission.evidenceId], ["FILE HASH", r.submission.fileHash]);
    $("#workspaceSnapshot").innerHTML = `<header>PRIVATE DEAL RECORD</header>${rows.length ? rows.map(([label, value]) => `<div><span>${escape(label)}</span><b>${escape(value)}</b></div>`).join("") : "<p>No deal record yet.</p>"}`;
  }

  function render() {
    const company = role === "COMPANY";
    $("#portalWorkflow").dataset.role = role.toLowerCase();
    $("#workspaceEyebrow").textContent = company ? "COMPANY / HIRING COMMAND" : "FREELANCER / OPPORTUNITY DESK";
    $("#workspaceTitle").textContent = company ? "HIRE WITH PROOF BUILT IN." : "FIND WORK. GET PAID LOCALLY.";
    $("#workspaceIntro").textContent = company ? "Publish a real brief, compare multiple proposals, define the agreement and release only against approved evidence." : "Discover verified work, submit your own terms, review the private agreement and deliver into secured escrow.";
    $("#workspaceRailTitle").textContent = company ? "COMPANY JOURNEY" : "YOUR JOURNEY";
    $("#railRoleHint").textContent = company ? "YOU CONTROL COMPANY DECISIONS" : "YOU CONTROL FREELANCER ACTIONS";
    const resetButton = $("#workflowReset");
    resetButton.hidden = !company || !model.run;
    resetButton.textContent = model.run?.phase === "COMPLETED" ? "START NEW DEAL" : "RESET CURRENT DEAL";
    $("#workspaceAction").innerHTML = inspectedStage ? renderInspection(inspectedStage) : company ? renderCompany() : renderFreelancer();
    renderRail();
    renderSnapshot();
    bindActions();
  }

  function bindActions() {
    document.querySelectorAll("[data-inspect-stage]").forEach(button => button.addEventListener("click", () => { inspectedStage = button.dataset.inspectStage; render(); document.querySelector(".portal-main")?.scrollTo({ top: 0, behavior: "smooth" }); }));
    $("[data-return-live]")?.addEventListener("click", () => { inspectedStage = null; render(); document.querySelector(".portal-main")?.scrollTo({ top: 0, behavior: "smooth" }); });
    document.querySelectorAll("[data-automation-focus]").forEach(button => button.addEventListener("click", () => { automationFocus = button.dataset.automationFocus; render(); }));
    document.querySelectorAll("[data-select-application]").forEach(button => button.addEventListener("click", () => executeByIds(["select", "assign"], { applicationId: button.dataset.selectApplication })));
    $("[data-approve-agreement]")?.addEventListener("click", () => executeByIds(["agreement-approve"], { acceptedTermsHash: agreement()?.contractHash }));
    $("[data-approve-work]")?.addEventListener("click", () => executeByIds(["approve-work"], { decision: "APPROVED", comment: "Reviewed against the agreed acceptance criteria and accepted." }));
    document.querySelectorAll("[data-draft-file]").forEach(input => input.addEventListener("change", () => extractDraft(input)));
    document.querySelectorAll("[data-workspace-form]").forEach(form => {
      form.addEventListener("input", () => { form.dataset.dirty = "true"; });
      form.addEventListener("change", () => { form.dataset.dirty = "true"; });
      form.addEventListener("submit", submitForm);
    });
  }

  function inferredContentType(file) {
    if (file.type) return file.type;
    const extension = file.name.split(".").pop()?.toLowerCase();
    return ({ pdf: "application/pdf", txt: "text/plain", md: "text/markdown", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", rtf: "application/rtf", odt: "application/vnd.oasis.opendocument.text" })[extension] ?? "application/octet-stream";
  }

  async function filePayload(file) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    return { fileName: file.name, contentType: inferredContentType(file), contentBase64: String(dataUrl).split(",")[1] };
  }

  function populate(form, name, value) {
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return;
    const control = form.elements.namedItem(name);
    if (!control) return;
    control.value = Array.isArray(value) ? value.join(name === "skills" ? ", " : "\n") : String(value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function extractDraft(input) {
    if (busy) return;
    const file = input.files?.[0];
    if (!file) return;
    const form = input.closest("form");
    const status = form?.querySelector("[data-extraction-status]");
    const fileName = form?.querySelector("[data-draft-file-name]");
    if (!form || !status) return;
    if (fileName) fileName.textContent = file.name;
    if (file.size > 8 * 1024 * 1024) {
      status.dataset.tone = "error";
      status.textContent = "FILE TOO LARGE · USE A DOCUMENT UNDER 8 MB";
      input.value = "";
      return;
    }
    busy = true;
    input.disabled = true;
    status.dataset.tone = "working";
    status.textContent = `READING ${file.name.toUpperCase()} · EXTRACTING A REVIEWABLE DRAFT…`;
    try {
      const result = await request("/api/workflow/extract", {
        method: "POST",
        body: JSON.stringify({ purpose: input.dataset.extractPurpose, ...(await filePayload(file)) })
      });
      const fields = result.fields ?? {};
      if (input.dataset.extractPurpose === "JOB_BRIEF") {
        populate(form, "title", fields.title);
        populate(form, "description", fields.description);
        populate(form, "acceptanceCriteria", fields.acceptanceCriteria);
        populate(form, "skills", fields.skills);
        populate(form, "budget", fields.budgetPln);
        populate(form, "deliveryDate", fields.deliveryDate);
        populate(form, "destinationCountry", fields.destinationCountry ?? "IN");
      } else if (input.dataset.extractPurpose === "FREELANCER_PROPOSAL") {
        populate(form, "proposedPrice", fields.proposedPricePln);
        populate(form, "deliveryDays", fields.deliveryDays);
        populate(form, "availability", fields.availability);
        populate(form, "approach", fields.approach);
        populate(form, "coverLetter", fields.coverLetter);
      } else {
        populate(form, "commercialTerms", fields.commercialTerms);
        populate(form, "acceptanceCriteria", fields.acceptanceCriteria);
        populate(form, "policies", fields.policies);
        populate(form, "legalClauses", fields.legalClauses);
      }
      const warning = result.warnings?.[0];
      status.dataset.tone = warning ? "warning" : "success";
      status.textContent = warning
        ? `${file.name.toUpperCase()} · DRAFT PARTIALLY EXTRACTED · ${warning}`
        : `${file.name.toUpperCase()} · DRAFT FILLED BY ${result.source} · REVIEW EACH FIELD, THEN SUBMIT MANUALLY`;
    } catch (error) {
      status.dataset.tone = "error";
      status.textContent = `EXTRACTION FAILED · ${error.message} · MANUAL ENTRY STILL WORKS`;
    } finally {
      input.disabled = false;
      busy = false;
    }
  }

  async function submitForm(event) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const kind = event.currentTarget.dataset.workspaceForm;
    const data = new FormData(event.currentTarget);
    if (kind === "job") return executeByIds(["job"], { title: data.get("title"), description: data.get("description"), acceptanceCriteria: data.get("acceptanceCriteria"), skills: String(data.get("skills")).split(",").map(value => value.trim()).filter(Boolean), deliveryDate: data.get("deliveryDate"), destinationCountry: data.get("destinationCountry"), budget: { amountMinor: String(Math.round(Number(data.get("budget")) * 100)), currency: "PLN", scale: 2 } });
    if (kind === "apply") return executeByIds(["apply"], { jobId: data.get("jobId"), coverLetter: data.get("coverLetter"), approach: data.get("approach"), availability: data.get("availability"), deliveryDays: Number(data.get("deliveryDays")), proposedPrice: { amountMinor: String(Math.round(Number(data.get("proposedPrice")) * 100)), currency: "PLN", scale: 2 } });
    if (kind === "terms") return executeByIds(["terms"], { commercialTerms: lines(data.get("commercialTerms")), acceptanceCriteria: lines(data.get("acceptanceCriteria")), policies: lines(data.get("policies")), legalClauses: lines(data.get("legalClauses")) });
    if (kind === "submit") return executeByIds(["submit"], { ...(await filePayload(data.get("file"))), note: data.get("note") });
  }

  async function executeByIds(ids, payload = {}) {
    if (busy) return;
    const step = firstStep(...ids);
    if (!step) return setStatus(`WORKFLOW UPDATE REQUIRED · NO ${ids.join("/").toUpperCase()} COMMAND`, "error");
    inspectedStage = null;
    automationFocus = null;
    busy = true;
    setStatus(`${step.actor} · ${step.label} · WORKING_`, "working");
    try {
      await request(`/api/workflow/action/${step.id}`, { method: "POST", body: JSON.stringify(payload) });
      if (step.id === "approve-work") {
        transferAnimationUntil = Date.now() + 6_000;
        clearTimeout(transferAnimationTimer);
        transferAnimationTimer = setTimeout(() => { if (!busy) render(); }, 6_100);
      }
      await refresh({ follow: true });
      setStatus(`${step.label} COMPLETE · RESULT PERSISTED_`, "success");
    } catch (error) {
      setStatus(`ACTION FAILED · ${error.message}`, "error");
      await refresh();
    } finally { busy = false; }
  }

  async function refresh({ follow = false } = {}) {
    model = await request("/api/workspace/state");
    if (!follow && (document.activeElement?.closest("[data-workspace-form]") || document.querySelector('[data-workspace-form][data-dirty="true"]'))) return;
    render();
  }

  async function reset() {
    if (role !== "COMPANY" || busy || !confirm("Start a new deal? This clears the shared live workspace for both Company and Freelancer. Existing ledger records remain auditable.")) return;
    inspectedStage = null;
    automationFocus = null;
    await request("/api/workflow/reset", { method: "POST" });
    await refresh({ follow: true });
    setStatus("FRESH WORKSPACE READY · NO BLOCKCHAIN ACTIONS YET_", "success");
  }

  async function init() {
    if (!initialized) {
      initialized = true;
      $("#workflowReset")?.addEventListener("click", reset);
      setInterval(() => { if (!busy && $("#portalWorld")?.classList.contains("open")) refresh().catch(() => {}); }, 3000);
    }
    try {
      await refresh({ follow: true });
      setStatus(`${role === "COMPANY" ? "HIRING WORKSPACE" : "FREELANCER WORKSPACE"} READY · REAL SERVICES CONNECTED_`);
    } catch (error) { setStatus(`WORKSPACE UNAVAILABLE · ${error.message}`, "error"); }
  }

  window.OptiWorkWorkflow = { init, setRole(nextRole) { role = nextRole === "FREELANCER" ? "FREELANCER" : "COMPANY"; inspectedStage = null; automationFocus = null; if (initialized) render(); } };
})();
