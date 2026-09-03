import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const chrome = process.argv[2];
if (!chrome) throw new Error('usage: node scripts/verify-marketing-browser-smoke.mjs <chrome-binary>');

const origin = new URL(process.env.OPTIWORK_MARKETING_URL ?? 'http://127.0.0.1:4175');
const profile = await mkdtemp(join(tmpdir(), 'anchor-marketing-browser-smoke-'));
const processHandle = spawn(chrome, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--metrics-recording-only',
  '--no-first-run',
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function debuggingPort() {
  const path = join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error(`Chrome exited with ${processHandle.exitCode}.`);
    try {
      const [port] = (await readFile(path, 'utf8')).trim().split('\n');
      if (/^[1-9][0-9]*$/u.test(port ?? '')) return Number(port);
    } catch {
      // Chrome writes this file after its DevTools endpoint is ready.
    }
    await sleep(50);
  }
  throw new Error('Chrome did not expose a DevTools endpoint.');
}

let socket;
try {
  const port = await debuggingPort();
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const target = targets.find((candidate) => candidate.type === 'page');
  if (typeof target?.webSocketDebuggerUrl !== 'string') throw new Error('Chrome exposed no page target.');

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Chrome DevTools connection failed.')), { once: true });
  });

  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    sequence += 1;
    pending.set(sequence, { resolve, reject });
    socket.send(JSON.stringify({ id: sequence, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${result.exceptionDetails.text}`);
    return result.result?.value;
  };
  const waitFor = async (expression, message, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(message);
  };
  const click = async (selector) => {
    const clicked = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`Could not click ${selector}.`);
  };

  await command('Page.enable');
  await command('Runtime.enable');
  const url = new URL('/', origin).href;
  const navigation = await command('Page.navigate', { url });
  if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
  await waitFor(
    `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`,
    'The product experience did not load.',
  );
  const landing = await evaluate('({ title: document.title, text: document.body?.innerText ?? "" })');
  if (!/OptiWork/u.test(landing?.title ?? '') || !/WORK WITHOUT\s+BORDERS/iu.test(landing?.text ?? '')) {
    throw new Error('The product landing page did not render its primary experience.');
  }

  await click('[data-open-demo]');
  await waitFor('document.querySelector("#demoModal")?.classList.contains("open")', 'Role selection did not open.');
  await click('#continueRole');
  await waitFor('document.querySelector("#loginWorld")?.classList.contains("open")', 'Demo login did not open.');
  await click('#loginForm .login-submit');
  await waitFor('document.querySelector("#portalWorld")?.classList.contains("open")', 'The portal did not open.', 10_000);
  await waitFor('document.querySelector("#portalGuide")?.classList.contains("open")', 'The portal guide did not open.', 10_000);
  await click('#guideSkip');
  await click('[data-portal-nav="workflow"]');
  await waitFor(
    'document.querySelectorAll("#workflowSteps .workflow-step").length === 12 && /READY/u.test(document.querySelector("#workflowStatus")?.textContent ?? "")',
    'The 12-step workflow did not initialise.',
  );
  await click('#workflowRun');
  await waitFor(
    '/WORKFLOW COMPLETE/u.test(document.querySelector("#workflowStatus")?.textContent ?? "")',
    'The portal workflow did not complete.',
    300_000,
  );
  const result = await evaluate(`({
    completed: document.querySelectorAll('#workflowSteps .workflow-step[data-state="done"]').length,
    failed: document.querySelectorAll('#workflowSteps .workflow-step[data-state="failed"]').length,
    status: document.querySelector('#workflowStatus')?.textContent ?? '',
  })`);
  if (result.completed !== 12 || result.failed !== 0) {
    throw new Error(`Expected 12 completed steps and no failures, got ${JSON.stringify(result)}.`);
  }
  await click('[data-portal-nav="audit"]');
  await waitFor(
    '!/Loading/u.test(document.querySelector("#ledgerStatOneNote")?.textContent ?? "Loading")',
    'The audit view did not refresh after settlement.',
  );

  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    origin: origin.href,
    workflowSteps: result.completed,
    auditRefreshed: true,
  }, null, 2)}\n`);
} finally {
  socket?.close();
  processHandle.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => processHandle.once('exit', resolve)),
    sleep(2_000),
  ]);
  await rm(profile, { recursive: true, force: true });
}
