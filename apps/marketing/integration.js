// Bridges the OptiWork landing page to the running @optiwork/web dashboards.
// Additive only: the in-page prototype flow in script.js is left untouched.
//
// No live status probing here on purpose. apps/web is a single Next.js app
// (default dev port 3000) serving every role from its own route, so a page
// served from apps/marketing cannot tell "running" from "refused" across
// origins — a dot that guesses wrong is worse than no dot.
const LIVE_APPS = Object.freeze({
  company: { app: "COMPANY DASHBOARD", note: "Jobs, contracts, corridor decisions, remittance advice", url: "http://127.0.0.1:3000/company" },
  freelancer: { app: "FREELANCER DASHBOARD", note: "Contract terms, submitted versions, wallet credit", url: "http://127.0.0.1:3000/freelancer" },
  admin: { app: "ADMIN & AUDIT", note: "Every book, every compliance decision, full event record", url: "http://127.0.0.1:3000/admin" }
});

function currentRoleKey() {
  const name = document.querySelector("#selectedRoleName")?.textContent?.trim().toUpperCase();
  return name === "FREELANCER" ? "freelancer" : "company";
}

function openLive(key) {
  window.open(LIVE_APPS[key].url, "_blank", "noopener");
}

// Launcher — reachable at any point on the page, so the running stack can be
// opened without stepping through the whole prototype login sequence first.
const launcher = document.createElement("div");
launcher.className = "live-launcher";
launcher.innerHTML = `
  <button class="live-toggle" type="button" aria-expanded="false" aria-controls="livePanel">
    <i></i><span>LIVE APPS</span><b>▲</b>
  </button>
  <div class="live-panel" id="livePanel" hidden>
    <header><span>RUNNING LOCALLY</span><small>DEMO MODE · MOCK LEDGER · NO REAL MONEY</small></header>
    <div class="live-apps">
      ${Object.entries(LIVE_APPS).map(([key, app]) => `
        <a href="${app.url}" target="_blank" rel="noopener" data-live-app="${key}">
          <span><b>${app.app}</b><small>${app.note}</small></span>
          <em>↗</em>
        </a>`).join("")}
    </div>
    <footer>Everything above this panel is the design prototype.</footer>
  </div>`;
document.body.appendChild(launcher);

const toggle = launcher.querySelector(".live-toggle");
const panel = launcher.querySelector(".live-panel");
toggle.addEventListener("click", () => {
  const open = panel.hidden;
  panel.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.querySelector("b").textContent = open ? "▼" : "▲";
});

// Real entry point out of the prototype portal, beside the existing log-out control.
const portalTop = document.querySelector(".portal-top");
if (portalTop) {
  const enter = document.createElement("button");
  enter.id = "enterLivePortal";
  enter.className = "enter-live";
  enter.type = "button";
  enter.innerHTML = "<span></span><b>↗</b>";
  enter.addEventListener("click", () => openLive(currentRoleKey()));
  portalTop.querySelector(".portal-user")?.prepend(enter);

  // Keep the label honest about which portal the button will actually open.
  const sync = () => { enter.querySelector("span").textContent = `OPEN LIVE ${LIVE_APPS[currentRoleKey()].app}`; };
  const roleName = document.querySelector("#selectedRoleName");
  if (roleName) new MutationObserver(sync).observe(roleName, { childList: true, characterData: true, subtree: true });
  sync();
}
