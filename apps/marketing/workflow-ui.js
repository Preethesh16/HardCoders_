// Role-aware, single-screen deal room. Every button calls the real OptiWork
// API through the server-side workflow driver; no principal token or signing
// material is ever exposed to this browser.
(() => {
  let role = "COMPANY";
  let model = { steps: [], run: null };
  let selected = 0;
  let busy = false;
  let initialized = false;

  const $ = (selector) => document.querySelector(selector);
  const escape = (value) => String(value ?? "—").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const completed = (id) => model.run?.steps?.[id]?.status === "DONE";
  const failed = (id) => model.run?.steps?.[id]?.status === "FAILED";
  const nextIndex = () => {
    const index = model.steps.findIndex(step => !completed(step.id));
    return index === -1 ? Math.max(0, model.steps.length - 1) : index;
  };
  const owns = (step) => role === "COMPANY" ? step.actor.includes("COMPANY") : step.actor.includes("FREELANCER");

  function money(minor, scale = 2, currency = "PLN") {
    if (minor === undefined) return "—";
    return `${(Number(minor) / 10 ** Number(scale)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  }

  async function request(path, options = {}) {
    const response = await fetch(path, { headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}) }, ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : body?.error?.message ?? `Request failed (${response.status})`);
    return body;
  }

  async function refresh({ follow = false } = {}) {
    model = await request("/api/workspace/state");
    if (!model.run) {
      await request("/api/workflow/reset", { method: "POST" });
      model = await request("/api/workspace/state");
    }
    if (follow) selected = nextIndex();
    render();
  }

  function renderRail() {
    const done = model.steps.filter(step => completed(step.id)).length;
    $("#stageCount").textContent = `${String(done).padStart(2, "0")} / ${String(model.steps.length).padStart(2, "0")}`;
    $("#workspaceStages").innerHTML = model.steps.map((step, index) => {
      const state = completed(step.id) ? "done" : failed(step.id) ? "failed" : index === nextIndex() ? "current" : "pending";
      return `<button type="button" data-workspace-step="${index}" class="${index === selected ? "selected" : ""}" data-state="${state}"><i>${state === "done" ? "✓" : String(index + 1).padStart(2, "0")}</i><span><b>${escape(step.label)}</b><small>${escape(step.actor)}</small></span><em>${state === "current" ? "NOW" : state.toUpperCase()}</em></button>`;
    }).join("");
    document.querySelectorAll("[data-workspace-step]").forEach(button => button.addEventListener("click", () => { selected = Number(button.dataset.workspaceStep); render(); }));
  }

  function renderFacts(step) {
    const state = model.run?.steps?.[step.id];
    $("#workspaceProofState").textContent = state?.status ?? "WAITING";
    if (state?.facts?.length) $("#workspaceFacts").innerHTML = state.facts.map(([label, value]) => `<p><small>${escape(label)}</small><b>${escape(value)}</b></p>`).join("");
    else if (state?.error) $("#workspaceFacts").innerHTML = `<p class="workspace-error"><small>ERROR</small><b>${escape(state.error)}</b></p>`;
    else $("#workspaceFacts").innerHTML = `<p>${selected === nextIndex() ? "This is the next real command in the deal." : "This stage is waiting for earlier ledger state."}</p>`;
  }

  function jobForm() {
    return `<form class="workspace-form" data-action-form><label><span>WORK TITLE</span><input name="title" required minlength="4" value="Cross-border reconciliation service"></label><label><span>SCOPE + ACCEPTANCE CRITERIA</span><textarea name="description" required minlength="20">Build a reconciliation service that compares settlement evidence against the business ledger, with a complete test suite and an operational runbook.</textarea></label><div><label><span>SKILLS · COMMA SEPARATED</span><input name="skills" required value="typescript, postgres, reconciliation"></label><label><span>BUDGET · PLN</span><input name="budget" type="number" min="1" step="0.01" required value="12000"></label></div><button type="submit">PUBLISH REAL JOB <b>→</b></button></form>`;
  }

  function applicationForm() {
    return `<form class="workspace-form" data-action-form><label><span>APPLICATION NOTE</span><textarea name="coverLetter" required minlength="20">I have delivered TypeScript and PostgreSQL reconciliation services for payment providers, including ledger-to-settlement comparison and exception handling.</textarea></label><button type="submit">APPLY TO THIS WORK <b>→</b></button></form>`;
  }

  function submissionForm() {
    return `<form class="workspace-form" data-action-form><label class="workspace-file"><span>PRIVATE DELIVERABLE</span><input name="file" type="file" required accept=".zip,.pdf,.png,.txt,application/zip,application/pdf,image/png,text/plain"><b>SELECT THE ACTUAL FILE TO HASH + STORE</b><small>Bytes go to MinIO. Only SHA-256 evidence goes to Fabric.</small></label><label><span>DELIVERY NOTE</span><textarea name="note" maxlength="2000">Service, tests and operational runbook delivered.</textarea></label><button type="submit">SUBMIT + COMMIT EVIDENCE <b>→</b></button></form>`;
  }

  const actionLabel = { shortlist: "RUN ADVISORY SHORTLIST", assign: "ASSIGN FREELANCER + CREATE CONTRACT", "approve-buyer": "APPROVE EXACT TERMS AS COMPANY", "approve-provider": "APPROVE EXACT TERMS AS FREELANCER", documents: "HASH REQUIRED TRADE DOCUMENTS", payment: "FETCH FX + VERIFY RULES", fund: "CREATE + FUND ALGORAND ESCROW", access: "OPEN AUTHORIZED REVIEW", validate: "RUN ADVISORY WORK VALIDATION", "approve-work": "APPROVE + COMMIT TO FABRIC", release: "AUTHORIZE RELEASE + INR PAYOUT" };

  function renderAction(step) {
    const action = $("#workspaceAction");
    const isNext = selected === nextIndex();
    if (completed(step.id)) action.innerHTML = `<div class="workspace-message success"><b>STAGE COMPLETE</b><p>This result came from the live service boundary and is now part of the audit trail.</p></div>`;
    else if (!isNext) action.innerHTML = `<div class="workspace-message"><b>LOCKED BY SEQUENCE</b><p>Complete the current ledger stage before this command becomes available.</p></div>`;
    else if (!owns(step)) {
      const other = role === "COMPANY" ? "freelancer" : "company";
      action.innerHTML = `<div class="workspace-message waiting"><b>WAITING FOR ${other.toUpperCase()}</b><p>Open the ${other} portal to perform this role-owned action. This page polls the same real workflow and advances automatically.</p></div>`;
    } else if (step.id === "job") action.innerHTML = jobForm();
    else if (step.id === "apply") action.innerHTML = applicationForm();
    else if (step.id === "submit") action.innerHTML = submissionForm();
    else action.innerHTML = `<button class="workspace-command" type="button" data-run-action><span>${escape(actionLabel[step.id] ?? step.label)}</span><b>▶</b></button><p class="workspace-command-note">${escape(step.detail)}</p>`;
    action.querySelector("[data-run-action]")?.addEventListener("click", () => execute(step, {}));
    action.querySelector("[data-action-form]")?.addEventListener("submit", event => submitForm(event, step));
  }

  async function filePayload(file) {
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
    return { fileName: file.name, contentType: file.type || "application/octet-stream", contentBase64: String(dataUrl).split(",")[1] };
  }

  async function submitForm(event, step) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const data = new FormData(event.currentTarget);
    let payload = {};
    if (step.id === "job") payload = { title: data.get("title"), description: data.get("description"), skills: String(data.get("skills")).split(",").map(x => x.trim()).filter(Boolean), budget: { amountMinor: String(Math.round(Number(data.get("budget")) * 100)), currency: "PLN", scale: 2 } };
    else if (step.id === "apply") payload = { coverLetter: data.get("coverLetter") };
    else payload = { ...(await filePayload(data.get("file"))), note: data.get("note") };
    await execute(step, payload);
  }

  async function execute(step, payload) {
    if (busy) return;
    busy = true;
    $("#workflowStatus").textContent = `${step.actor} · ${step.label} · CALLING LIVE SERVICES_`;
    try {
      await request(`/api/workflow/step/${selected}`, { method: "POST", body: JSON.stringify(payload) });
      await refresh({ follow: true });
      $("#workflowStatus").textContent = `${step.label} COMPLETE · RESULT PERSISTED_`;
    } catch (error) {
      $("#workflowStatus").textContent = `ACTION FAILED · ${error.message}`;
      await refresh();
    } finally { busy = false; }
  }

  function renderSnapshot() {
    const r = model.run?.results ?? {};
    const rows = [];
    if (r.job) rows.push(["WORK", r.job.title], ["BUDGET", money(r.job.budgetAmountMinor, r.job.budgetScale, r.job.budgetCurrency)]);
    if (r.evaluation) rows.push(["SHORTLIST", `${r.evaluation.score}/100 · ${r.evaluation.source}`]);
    if (r.contract) rows.push(["CONTRACT", r.contract.id], ["TERMS HASH", r.contract.contractHash]);
    if (r.compliance) rows.push(["COMPLIANCE", `${r.compliance.outcome} · ${r.compliance.rulesVersion}`]);
    if (r.quote) rows.push(["LIVE FX", `${r.quote.rateSource} · ${r.quote.rateObservedAt}`]);
    if (r.regulation) rows.push(["REGULATION", r.regulation.status]);
    if (r.binding) rows.push(["ARC-4 APP", r.binding.applicationId], ["ASA", r.binding.assetId], ["ESCROW DEAL", r.binding.dealId], ["ORIGIN PROVIDER", r.binding.originProviderAddress], ["DEST. PROVIDER", r.binding.destinationProviderAddress]);
    if (r.submission) rows.push(["FABRIC EVIDENCE", r.submission.evidenceId], ["FILE HASH", r.submission.fileHash]);
    if (r.workValidation) rows.push(["WORK AGENT", `${r.workValidation.score}/100 · ADVISORY`]);
    $("#workspaceSnapshot").innerHTML = `<header>ACTIVE DEAL</header>${rows.length ? rows.map(([a,b]) => `<div><span>${escape(a)}</span><b>${escape(b)}</b></div>`).join("") : "<p>Create a brief to begin.</p>"}`;
  }

  function render() {
    if (!model.steps.length) return;
    selected = Math.min(selected, model.steps.length - 1);
    const step = model.steps[selected];
    $("#workspaceEyebrow").textContent = `${role} / LIVE DEAL ROOM`;
    $("#workspaceTitle").innerHTML = role === "COMPANY" ? "ONE DEAL.<br>ONE CLEAR PATH." : "ONE JOB.<br>ONE CLEAR PAYOUT.";
    $("#workspaceIntro").textContent = role === "COMPANY" ? "Post the work, make every human decision and watch the two ledgers prove the payout." : "Apply, approve the exact terms, submit privately and follow the secured payout to INR.";
    $("#workspaceStageNumber").textContent = `STAGE ${String(selected + 1).padStart(2, "0")} / ${String(model.steps.length).padStart(2, "0")}`;
    $("#workspaceStageActor").textContent = step.actor;
    $("#workspaceStageTitle").textContent = step.label;
    $("#workspaceStageDetail").textContent = step.detail;
    renderRail(); renderAction(step); renderFacts(step); renderSnapshot();
  }

  async function reset() {
    if (busy || !confirm("Start a fresh deal? Existing ledger records remain auditable.")) return;
    await request("/api/workflow/reset", { method: "POST" });
    selected = 0;
    await refresh();
    $("#workflowStatus").textContent = "FRESH DEAL READY · NO BLOCKCHAIN ACTIONS YET_";
  }

  async function init() {
    if (!initialized) {
      initialized = true;
      $("#workflowReset")?.addEventListener("click", reset);
      setInterval(() => { if (!busy && $("#portalWorld")?.classList.contains("open")) refresh().catch(() => {}); }, 3000);
    }
    try { await refresh({ follow: true }); $("#workflowStatus").textContent = "LIVE WORKSPACE READY · ADVANCE ONE AUTHORIZED STAGE AT A TIME_"; }
    catch (error) { $("#workflowStatus").textContent = `WORKSPACE UNAVAILABLE · ${error.message}`; }
  }

  window.OptiWorkWorkflow = { init, setRole(next) { role = next === "FREELANCER" ? "FREELANCER" : "COMPANY"; if (initialized) { selected = nextIndex(); render(); } } };
})();
