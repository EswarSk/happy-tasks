import * as Y from "../../apps/web/node_modules/yjs/dist/yjs.mjs";
import { randomUUID } from "node:crypto";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:8080";
const projectId = process.env.PROJECT_ID || "02000000-0000-7000-8000-000000000002";
const taskId = process.env.TASK_ID;
const clientCount = Number(process.env.CLIENTS || 100);
const distinctSourceIps = process.env.DISTINCT_SOURCE_IPS === "true";
const durationMs = Number(process.env.DURATION_MS || 0);
const editIntervalMs = Number(process.env.EDIT_INTERVAL_MS || 5_000);
const editTimeoutMs = Number(process.env.EDIT_TIMEOUT_MS || 10_000);
const password = process.env.LOAD_PASSWORD || "password";
const defaultUsers = (process.env.LOAD_USERS ||
  "maya@example.test,noah@example.test,priya@example.test,mateo@example.test,aisha@example.test,kenji@example.test,sofia@example.test,omar@example.test")
  .split(",")
  .map((email) => email.trim())
  .filter(Boolean);
const userCount = Number(process.env.USER_COUNT || 0);
const users = userCount > 0
  ? Array.from({ length: userCount }, (_, index) => `load-user-${String(index + 1).padStart(4, "0")}@example.test`)
  : defaultUsers;

if (!taskId) throw new Error("TASK_ID is required");

const encode = (value) => Buffer.from(value).toString("base64");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function login(email, index) {
  const headers = { "Content-Type": "application/json" };
  if (distinctSourceIps) headers["X-Forwarded-For"] = `2001:db8::${index + 1}`;
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password }),
  });
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  const session = cookies.map((value) => value.match(/happy_tasks_session=([^;]+)/)?.[1]).find(Boolean);
  if (!session || response.status !== 200) throw new Error(`Could not authenticate ${email}: ${response.status}`);
  return session;
}

async function sessions() {
  return Promise.all(users.map((email, index) => login(email, index)));
}

function connect(session, index, retry = 0) {
  return new Promise((resolve) => {
    const headers = { Cookie: `happy_tasks_session=${session}`, Origin: "http://127.0.0.1:3000" };
    if (distinctSourceIps) headers["X-Forwarded-For"] = `2001:db8::${index + 1}`;
    const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/v1/projects/${projectId}/tasks/${taskId}/description/live`, { headers });
    const doc = new Y.Doc();
    const text = doc.getText("description");
    let initialized = false;
    let retrying = false;
    let initMessageId = "";
    let editMessageId = "";
    let editResolve;
    let settled = false;
    const timeout = setTimeout(() => finish({ ok: false, reason: "timeout" }), 20_000);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ...result, socket, doc, text, index });
    };

    const sendInit = () => {
      initMessageId = randomUUID();
      socket.send(JSON.stringify({ type: "init", messageId: initMessageId, update: encode(Y.encodeStateAsUpdate(doc)), text: text.toString() }));
    };

    socket.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (frame.type === "bootstrap") {
        try {
          if (frame.initialized && frame.snapshot) Y.applyUpdate(doc, Buffer.from(frame.snapshot, "base64"), "bootstrap");
          else if (!text.length) text.insert(0, frame.text || "");
          for (const update of frame.updates || []) Y.applyUpdate(doc, Buffer.from(update, "base64"), "bootstrap");
        } catch {
          finish({ ok: false, reason: "invalid-bootstrap" });
          return;
        }
        initialized = Boolean(frame.initialized);
        if (!initialized) sendInit();
        else finish({ ok: true, edit() { return edit(this); } });
      } else if (frame.type === "ack" && frame.messageId === initMessageId) {
        initialized = true;
        finish({ ok: true, edit() { return edit(this); } });
      } else if (frame.type === "ack" && frame.messageId === editMessageId) {
        editResolve?.(true);
        editResolve = undefined;
      } else if (frame.type === "update" && frame.update) {
        try { Y.applyUpdate(doc, Buffer.from(frame.update, "base64"), "remote"); } catch { finish({ ok: false, reason: "invalid-update" }); }
      } else if (frame.type === "error") {
        if (frame.error === "DESCRIPTION_ALREADY_INITIALIZED" && retry < 3) {
          retrying = true;
          clearTimeout(timeout);
          socket.close();
          setTimeout(() => connect(session, index, retry + 1).then(resolve), 20 * (retry + 1));
        } else finish({ ok: false, reason: frame.error || "server-error" });
      }
    };
    socket.onerror = () => finish({ ok: false, reason: "socket-error" });
    socket.onclose = () => { if (!retrying) finish({ ok: false, reason: "closed" }); };

    function edit(client) {
      if (!client.ok || !initialized || socket.readyState !== WebSocket.OPEN) return Promise.resolve(false);
      return new Promise((resolveEdit) => {
        editMessageId = randomUUID();
        const resolveWithCleanup = (value) => { clearTimeout(editTimeout); editResolve = undefined; resolveEdit(value); };
        const editTimeout = setTimeout(() => resolveWithCleanup(false), editTimeoutMs);
        editResolve = resolveWithCleanup;
        const onUpdate = (update, origin) => {
          if (origin === "remote" || origin === "bootstrap") return;
          socket.send(JSON.stringify({ type: "update", messageId: editMessageId, update: encode(update), text: text.toString() }));
          doc.off("update", onUpdate);
        };
        doc.on("update", onUpdate);
        doc.transact(() => text.insert(text.length, ` editor-${index}-${Date.now()}`), "local");
      });
    }
  });
}

const authenticated = await sessions();
const clients = await Promise.all(Array.from({ length: clientCount }, (_, index) => connect(authenticated[index % authenticated.length], index)));
const ready = clients.filter((client) => client.ok);
let editSummary;
if (durationMs > 0) {
  const deadline = Date.now() + durationMs;
  const workers = await Promise.all(ready.map(async (client) => {
    let attempted = 0;
    let acked = 0;
    await sleep((client.index / Math.max(ready.length, 1)) * editIntervalMs);
    while (Date.now() < deadline) {
      attempted += 1;
      if (await client.edit(client)) acked += 1;
      if (Date.now() >= deadline) break;
      await sleep(Math.min(editIntervalMs, deadline - Date.now()));
    }
    return { attempted, acked };
  }));
  editSummary = {
    durationMs,
    editIntervalMs,
    editsAttempted: workers.reduce((total, result) => total + result.attempted, 0),
    editsAcked: workers.reduce((total, result) => total + result.acked, 0),
  };
} else {
  const editResults = await Promise.all(ready.map((client) => client.edit(client)));
  editSummary = {
    editsAttempted: editResults.length,
    editsAcked: editResults.filter(Boolean).length,
  };
}
await new Promise((resolve) => setTimeout(resolve, 3_000));
for (const client of clients) client.socket.close();

console.log(JSON.stringify({
  clients: clientCount,
  ready: ready.length,
  rejected: clients.length - ready.length,
  ...editSummary,
  editsFailed: editSummary.editsAttempted - editSummary.editsAcked,
}, null, 2));
