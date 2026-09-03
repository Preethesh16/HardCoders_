// Drives the WORKFLOW tab: renders the real workflow stages and runs them
// against @optiwork/api through serve.mjs's step engine (see workflow.mjs).
// Every step here is a live call — each full run creates a brand new job,
// contract, escrow deal and payout, it does not replay a canned result.
window.OptiWorkWorkflow = (() => {
  let steps = [];
  let running = false;

  const statusEl = () => document.querySelector("#workflowStatus");
  const listEl = () => document.querySelector("#workflowSteps");

  function setStatus(text) {
    const el = statusEl();
    if (el) el.textContent = text;
  }

  function cardFor(index) {
    return listEl()?.querySelector(`[data-step-index="${index}"]`);
  }

  function renderSteps() {
    const list = listEl();
    if (!list) return;
    list.innerHTML = steps.map(s => `
      <article class="workflow-step" data-step-index="${s.index}" data-state="idle">
        <header>
          <i>${String(s.index + 1).padStart(2, "0")}</i>
          <span><b>${s.label}</b><small>${s.actor}</small></span>
          <em>PENDING</em>
        </header>
        <p>${s.detail}</p>
        <div class="workflow-facts"></div>
      </article>`).join("");
  }

  function markState(index, state, badge) {
    const card = cardFor(index);
    if (!card) return;
    card.dataset.state = state;
    const em = card.querySelector("em");
    if (em) em.textContent = badge;
  }

  function renderFacts(index, facts) {
    const card = cardFor(index);
    if (!card) return;
    card.querySelector(".workflow-facts").innerHTML = facts
      .map(([k, v]) => `<p><small>${k}</small><b>${v}</b></p>`).join("");
  }

  function renderError(index, message) {
    const card = cardFor(index);
    if (!card) return;
    card.querySelector(".workflow-facts").innerHTML = `<p class="workflow-error"><small>FAILED</small><b>${message}</b></p>`;
  }

  async function loadSteps() {
    try {
      const res = await fetch("/api/workflow/steps");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      steps = (await res.json()).steps ?? [];
      renderSteps();
      return true;
    } catch {
      setStatus("WORKFLOW ENGINE UNREACHABLE — IS THE API RUNNING?_");
      return false;
    }
  }

  async function runStep(index) {
    markState(index, "running", "RUNNING");
    setStatus(`STEP ${String(index + 1).padStart(2, "0")} / ${steps.length} — ${steps[index].label}_`);
    try {
      const res = await fetch(`/api/workflow/step/${index}`, { method: "POST" });
      const result = await res.json();
      if (!result.ok) {
        markState(index, "failed", "FAILED");
        renderError(index, result.error ?? "Unknown error");
        return false;
      }
      markState(index, "done", "DONE");
      renderFacts(index, result.facts ?? []);
      return true;
    } catch (error) {
      markState(index, "failed", "FAILED");
      renderError(index, String(error.message ?? error));
      return false;
    }
  }

  async function reset() {
    await fetch("/api/workflow/reset", { method: "POST" }).catch(() => {});
    renderSteps();
    setStatus("READY — A NEW RUN CREATES A NEW JOB, CONTRACT, ESCROW AND PAYOUT_");
  }

  async function runAll() {
    if (running) return;
    running = true;
    const runButton = document.querySelector("#workflowRun");
    if (runButton) runButton.disabled = true;
    await reset();
    for (let index = 0; index < steps.length; index += 1) {
      const ok = await runStep(index);
      if (!ok) {
        setStatus(`STOPPED AT STEP ${String(index + 1).padStart(2, "0")} — SEE THE ERROR BELOW_`);
        running = false;
        if (runButton) runButton.disabled = false;
        return;
      }
    }
    setStatus("WORKFLOW COMPLETE — PAYOUT SETTLED. CHECK THE AUDIT TAB FOR THE LEDGER_");
    running = false;
    if (runButton) runButton.disabled = false;
    // The portal's other views are now stale: this run added a new deal.
    if (typeof window.refreshPortalAfterWorkflow === "function") window.refreshPortalAfterWorkflow();
  }

  let initialised = false;
  async function init() {
    if (initialised) return;
    initialised = true;
    const ok = await loadSteps();
    if (!ok) return;
    setStatus("READY — A NEW RUN CREATES A NEW JOB, CONTRACT, ESCROW AND PAYOUT_");
    document.querySelector("#workflowRun")?.addEventListener("click", runAll);
    document.querySelector("#workflowReset")?.addEventListener("click", reset);
  }

  return { init, runAll, reset };
})();
