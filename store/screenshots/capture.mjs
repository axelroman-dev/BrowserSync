// Screenshots pages with a headless Chromium-based browser over the DevTools
// protocol (Brave ignores --screenshot). No dependencies: Node's built-in
// fetch and WebSocket.
//
//   node capture.mjs <browser> <profileDir> <page.html> <out.png> [<page.html> <out.png> ...]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [browser, profileDir, ...pairs] = process.argv.slice(2);
const PORT = 9333;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const child = spawn(
  browser,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--hide-scrollbars",
    "--password-store=basic",
    "--allow-file-access-from-files",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function endpoint() {
  for (let i = 0; i < 100; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((target) => target.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  throw new Error("browser did not start");
}

try {
  const ws = new WebSocket(await endpoint());
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  let nextId = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method) {
      for (const listener of listeners) listener(message);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });

  for (let i = 0; i < pairs.length; i += 2) {
    const loaded = new Promise((resolve) => listeners.push((m) => m.method === "Page.loadEventFired" && resolve()));
    await send("Page.navigate", { url: pathToFileURL(pairs[i]).href });
    await loaded;
    listeners.length = 0;
    await sleep(800); // iframes, fonts, images
    const { data } = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1280, height: 800, scale: 1 } });
    writeFileSync(pairs[i + 1], Buffer.from(data, "base64"));
  }
  ws.close();
} finally {
  child.kill();
}
