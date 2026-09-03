import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const chrome = process.argv[2];
if (!chrome) throw new Error('usage: node scripts/verify-browser-smoke.mjs <chrome-binary>');

const origin = new URL(process.env.OPTIWORK_WEB_URL ?? 'http://127.0.0.1:3000');
const profile = await mkdtemp(join(tmpdir(), 'anchor-browser-smoke-'));
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
      // Chrome creates the file only after its DevTools endpoint is ready.
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
  const navigate = async (path) => {
    const url = new URL(path, origin).href;
    const result = await command('Page.navigate', { url });
    if (result.errorText) throw new Error(`Navigation to ${path} failed: ${result.errorText}`);
    await waitFor(
      `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`,
      `Navigation to ${path} did not complete.`,
    );
    const page = await evaluate('({ title: document.title, text: document.body?.innerText ?? "" })');
    if (typeof page?.title !== 'string' || typeof page?.text !== 'string' || page.text.length < 80) {
      throw new Error(`Navigation to ${path} rendered no meaningful page.`);
    }
    if (/API is not reachable|internal server error/iu.test(page.text)) {
      throw new Error(`Navigation to ${path} rendered an application error.`);
    }
    return page;
  };

  await command('Page.enable');
  await command('Runtime.enable');
  const overview = await navigate('/');
  if (!/Run the demonstration|Re-read the demonstration state/u.test(overview.text)) {
    throw new Error('The landing page has no demonstration action.');
  }
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => /Run the demonstration|Re-read the demonstration state/u.test(candidate.textContent ?? ''));
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error('The browser could not click the demonstration action.');
  await waitFor(
    `/Both journeys settled/u.test(document.body?.innerText ?? '')`,
    'The landing-page action did not render the two completed journeys.',
    120_000,
  );

  for (const path of ['/company', '/freelancer', '/supplier', '/provider', '/admin']) {
    await navigate(path);
  }

  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    clickedDemoAction: true,
    routes: ['/', '/company', '/freelancer', '/supplier', '/provider', '/admin'],
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
