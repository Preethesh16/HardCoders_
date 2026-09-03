// Anchor's role-specific deal workspace. The browser never receives party
// credentials or signing material: every command crosses the same-origin
// workflow boundary and is authorized server-side.
(() => {
  "use strict";

  let role = "COMPANY";
  let model = { steps: [], run: null };
  let busy = false;
  let initialized = false;

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
    const existing = ids.filter(id => model.steps.some(step => step.id === id));
    if (existing.length && existing.every(isDone)) return "done";
    if (activeWhen) return "current";
    return "pending";
  }

  function renderRail() {
    const r = results();
    const phase = model.run?.phase ?? "JOB_DRAFT";
    const companyPhases = [
      ["01", "Publish brief", "Define scope and budget", ["job"], phase === "JOB_DRAFT"],
      ["02", "Choose talent", "Compare agent-ranked proposals", ["apply", "select"], ["APPLICATIONS_OPEN", "SCREENING", "COMPANY_SELECTION"].includes(phase)],
      ["03", "Lock agreement", "Set policy and legal terms", ["terms", "agreement-approve"], ["AGREEMENT_DRAFT", "AWAITING_FREELANCER_AGREEMENT"].includes(phase)],
      ["04", "Secure escrow", "Rules, FX and funding", ["agreement-approve"], ["AUTOMATING_ESCROW", "AUTOMATION_FAILED"].includes(phase)],
      ["05", "Review delivery", "Validate evidence, decide, release", ["submit", "approve-work"], ["AWAITING_DELIVERY", "VALIDATING_DELIVERY", "VALIDATION_FAILED", "AWAITING_WORK_APPROVAL", "RELEASING", "RELEASE_FAILED", "COMPLETED"].includes(phase)]
    ];
    const freelancerPhases = [
      ["01", "Find opportunity", "Review the company brief", ["job"], phase === "JOB_DRAFT"],
      ["02", "Send proposal", "Price, timing and approach", ["apply"], phase === "APPLICATIONS_OPEN"],
      ["03", "Selection", "Track screening and company choice", ["select"], ["SCREENING", "COMPANY_SELECTION"].includes(phase)],
      ["04", "Review agreement", "Accept the exact private document", ["terms", "agreement-approve"], ["AGREEMENT_DRAFT", "AWAITING_FREELANCER_AGREEMENT"].includes(phase)],
      ["05", "Escrow secured", "Watch the automatic funding pipeline", ["agreement-approve"], ["AUTOMATING_ESCROW", "AUTOMATION_FAILED"].includes(phase)],
      ["06", "Deliver & receive", "Upload privately and follow payout", ["submit", "approve-work"], ["AWAITING_DELIVERY", "VALIDATING_DELIVERY", "VALIDATION_FAILED", "AWAITING_WORK_APPROVAL", "RELEASING", "RELEASE_FAILED", "COMPLETED"].includes(phase)]
    ];
    const phases = role === "COMPANY" ? companyPhases : freelancerPhases;
    const completed = phases.filter(([, , , ids]) => phaseStatus(ids) === "done").length;
    $("#stageCount").textContent = `${String(completed).padStart(2, "0")} / ${String(phases.length).padStart(2, "0")}`;
    $("#workspaceStages").innerHTML = phases.map(([number, label, detail, ids, active]) => {
      const state = phaseStatus(ids, active);
      return `<article class="role-stage-item" data-state="${state}"><i>${state === "done" ? "✓" : number}</i><span><b>${label}</b><small>${detail}</small></span><em>${state === "current" ? "NOW" : state.toUpperCase()}</em></article>`;
    }).join("");
  }

  function jobForm() {
    return `<section class="workspace-card action-card"><header><span>COMPANY INPUT · REQUIRED</span><b>NEW BRIEF</b></header><form class="workspace-form" data-workspace-form="job">
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
    const automation = model.run?.automation;
    const fallbackStages = {
      rules: { status: results().regulation ? "COMPLETED" : "PENDING", detail: "Official source corpus and change detection" },
      documents: { status: results().payment ? "COMPLETED" : "PENDING", detail: "Required document commitments" },
      fx: { status: results().quote && results().compliance ? "COMPLETED" : "PENDING", detail: "Live FX quote and corridor policy" },
      escrow: { status: results().binding ? "COMPLETED" : "PENDING", detail: "Fixed-value Algorand escrow" }
    };
    const stages = automation?.stages ?? fallbackStages;
    const items = [["rules", "REGULATORY INTELLIGENCE", "Official-source refresh + RAG change check"], ["documents", "TRADE DOCUMENTS", "Private documents hashed and classified"], ["fx", "FX + COMPLIANCE", "Quote locked before settlement amount is fixed"], ["escrow", "ESCROW FUNDING", "Provider USDC locked on Algorand"]];
    return `<section class="workspace-card automation-card"><header><span>ANCHOR AUTOPILOT</span><b>${escape(automation?.status ?? (results().binding ? "COMPLETED" : "WAITING"))}</b></header><p>After both parties accept, agents coordinate the policy refresh, quote, compliance evidence and escrow without extra human buttons.</p><div class="automation-track">${items.map(([key, label, copy], index) => {
      const stage = stages[key] ?? {};
      const state = String(stage.status ?? "PENDING").toLowerCase();
      return `<article data-state="${escape(state)}"><i>${state === "done" || state === "completed" ? "✓" : String(index + 1).padStart(2, "0")}</i><span><b>${label}</b><small>${escape(stage.detail ?? copy)}</small></span><em>${escape(stage.status ?? "PENDING")}</em></article>`;
    }).join("")}</div><div class="rate-lock"><span><small>FUNDED SETTLEMENT</small><b>${escape(results().binding ? money(results().binding.amountUsdcMinor, results().binding.scale ?? 6, "USDC") : "AWAITING QUOTE")}</b></span><p>Once funded, the USDC amount is fixed. Later FX movement cannot change this escrow.</p></div></section>`;
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

  function payoutCard() {
    const payment = results().payment;
    const binding = results().binding;
    const agreedFunding = results().quote?.fundingAmount ?? results().contractAmount ?? (results().job ? {
      amountMinor: results().job.budgetAmountMinor,
      currency: results().job.budgetCurrency,
      scale: results().job.budgetScale
    } : null);
    const completed = model.run?.phase === "COMPLETED" || payment?.state === "COMPLETED" || binding?.state === "COMPLETED";
    return `<section class="workspace-card payout-card ${completed ? "complete" : ""}"><header><span>SECURED PAYOUT</span><b>${completed ? "COMPLETED" : escape(payment?.state ?? binding?.state ?? "PENDING")}</b></header><div class="payout-route"><span><small>AGREED PRICE</small><b>${escape(agreedFunding ? money(agreedFunding.amountMinor, agreedFunding.scale, agreedFunding.currency) : "PLN")}</b></span><i>→</i><span><small>ESCROW LOCKS</small><b>${escape(binding ? money(binding.amountUsdcMinor, binding.scale ?? 6, "USDC") : "USDC")}</b></span><i>→</i><span><small>YOU RECEIVE</small><b>${escape(payment?.payoutAmountMinor ? money(payment.payoutAmountMinor, payment.payoutScale, payment.payoutCurrency ?? "INR") : "INR")}</b></span></div><p>${completed ? "Your local INR credit is complete and linked to the approved Fabric evidence." : "No crypto wallet is required. Provider accounts handle settlement backstage."}</p></section>`;
  }

  function waiting(title, copy) {
    return `<section class="workspace-card empty-state"><span>⌛</span><h2>${escape(title)}</h2><p>${escape(copy)}</p></section>`;
  }

  function renderCompany() {
    const r = results();
    const phase = model.run?.phase;
    if (!r.job) return jobForm();
    if (!r.selectedApplicationId && !r.contract) return `${applicantCards()}${opportunity(r.job)}`;
    if (phase === "AGREEMENT_DRAFT" || !agreement()) return `${termsForm(selectedApplication())}${applicantCards()}`;
    if (phase === "AWAITING_FREELANCER_AGREEMENT") return `${agreementCard(false)}${waiting("WAITING FOR FREELANCER ACCEPTANCE", "The selected freelancer must review and accept the exact same agreement hash.")}`;
    if (!r.binding && phase !== "AWAITING_DELIVERY") return automationCard();
    if (!r.submission) return `${automationCard()}${waiting("ESCROW SECURED · WAITING FOR DELIVERY", "The selected freelancer can now upload the private deliverable.")}`;
    return `${submissionReview()}${payoutCard()}`;
  }

  function renderFreelancer() {
    const r = results();
    const phase = model.run?.phase;
    if (!r.job) return opportunity(null);
    if (!hasDone("apply")) return `${opportunity(r.job)}${applicationForm(r.job)}`;
    const selected = Boolean(r.selectedApplicationId || r.contract);
    if (!selected) return `${opportunity(r.job)}${waiting("PROPOSAL SUBMITTED", "The screening agent is ranking all proposals. The company—not the agent—makes the final choice.")}`;
    if (!agreement()) return waiting("YOU WERE SELECTED", "The company is entering its policy, legal, acceptance and commercial terms now.");
    if (phase === "AWAITING_FREELANCER_AGREEMENT" && !hasDone("agreement-approve")) return agreementCard(true);
    if (!r.binding && phase !== "AWAITING_DELIVERY") return automationCard();
    if (!r.submission) return `${payoutCard()}${submissionForm()}`;
    return `${payoutCard()}${agreementCard(false)}${waiting("DELIVERY SUBMITTED", "The company is reviewing your private file. The validation agent is advisory; only the company can approve release.")}`;
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
    $("#workspaceTitle").innerHTML = company ? "HIRE WITH<br>PROOF BUILT IN." : "FIND WORK.<br>GET PAID LOCALLY.";
    $("#workspaceIntro").textContent = company ? "Publish a real brief, compare multiple proposals, define the agreement and release only against approved evidence." : "Discover verified work, submit your own terms, review the private agreement and deliver into secured escrow.";
    $("#workspaceRailTitle").textContent = company ? "COMPANY JOURNEY" : "YOUR JOURNEY";
    const resetButton = $("#workflowReset");
    resetButton.hidden = !company || !model.run;
    resetButton.textContent = model.run?.phase === "COMPLETED" ? "START NEW DEAL" : "RESET CURRENT DEAL";
    $("#workspaceAction").innerHTML = company ? renderCompany() : renderFreelancer();
    renderRail();
    renderSnapshot();
    bindActions();
  }

  function bindActions() {
    document.querySelectorAll("[data-select-application]").forEach(button => button.addEventListener("click", () => executeByIds(["select", "assign"], { applicationId: button.dataset.selectApplication })));
    $("[data-approve-agreement]")?.addEventListener("click", () => executeByIds(["agreement-approve"], { acceptedTermsHash: agreement()?.contractHash }));
    $("[data-approve-work]")?.addEventListener("click", () => executeByIds(["approve-work"], { decision: "APPROVED", comment: "Reviewed against the agreed acceptance criteria and accepted." }));
    document.querySelectorAll("[data-workspace-form]").forEach(form => form.addEventListener("submit", submitForm));
  }

  async function filePayload(file) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    return { fileName: file.name, contentType: file.type || "application/octet-stream", contentBase64: String(dataUrl).split(",")[1] };
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
    busy = true;
    setStatus(`${step.actor} · ${step.label} · WORKING_`, "working");
    try {
      await request(`/api/workflow/action/${step.id}`, { method: "POST", body: JSON.stringify(payload) });
      await refresh({ follow: true });
      setStatus(`${step.label} COMPLETE · RESULT PERSISTED_`, "success");
    } catch (error) {
      setStatus(`ACTION FAILED · ${error.message}`, "error");
      await refresh();
    } finally { busy = false; }
  }

  async function refresh({ follow = false } = {}) {
    model = await request("/api/workspace/state");
    if (!follow && document.activeElement?.closest("[data-workspace-form]")) return;
    render();
  }

  async function reset() {
    if (role !== "COMPANY" || busy || !confirm("Start a new deal? This clears the shared live workspace for both Company and Freelancer. Existing ledger records remain auditable.")) return;
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

  window.OptiWorkWorkflow = { init, setRole(nextRole) { role = nextRole === "FREELANCER" ? "FREELANCER" : "COMPANY"; if (initialized) render(); } };
})();
