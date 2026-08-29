import http from "k6/http";
import { check, fail } from "k6";

const readVus = Number(__ENV.READ_VUS ?? 1000);
const crudVus = Number(__ENV.CRUD_VUS ?? 25);
const commentVus = Number(__ENV.COMMENT_VUS ?? 50);
const fileVus = Number(__ENV.FILE_VUS ?? 10);
const distinctSourceIps = __ENV.DISTINCT_SOURCE_IPS === "true";

const scenarios = {
  ...(readVus > 0 ? { readers: {
      executor: "per-vu-iterations",
      vus: readVus,
      iterations: 1,
      maxDuration: "2m",
      exec: "readers",
    } } : {}),
    ...(crudVus > 0 ? { crud: {
      executor: "per-vu-iterations",
      vus: crudVus,
      iterations: 1,
      maxDuration: "2m",
      exec: "crud",
    } } : {}),
    ...(commentVus > 0 ? { comments: {
      executor: "per-vu-iterations",
      vus: commentVus,
      iterations: 1,
      maxDuration: "2m",
      exec: "comments",
    } } : {}),
    ...(fileVus > 0 ? { files: {
      executor: "per-vu-iterations",
      vus: fileVus,
      iterations: 1,
      maxDuration: "2m",
      exec: "files",
    } } : {}),
};

export const options = { scenarios };

const baseUrl = __ENV.BASE_URL || "http://127.0.0.1:8080";
const heavyProjectId = __ENV.PROJECT_ID || "02000000-0000-7000-8000-000000000001";
const crudProjectId = __ENV.CRUD_PROJECT_ID || "02000000-0000-7000-8000-000000000002";
const password = __ENV.LOAD_PASSWORD || "password";
const users = (__ENV.LOAD_USERS ||
  "maya@example.test,noah@example.test,priya@example.test,mateo@example.test,aisha@example.test,kenji@example.test,sofia@example.test,omar@example.test")
  .split(",")
  .map((email) => email.trim())
  .filter(Boolean);
const heavyDescription = "Large task description payload for CRUD and search projection checks. ".repeat(650);
const updatedDescription = "Updated collaborative-sized task payload for mutation checks. ".repeat(650);
const commentBody = "Heavy hot-thread comment payload. ".repeat(120);
const fileBytes = Number(__ENV.FILE_BYTES || 3 * 1024 * 1024);
const filePayload = "x".repeat(fileBytes);

function key(prefix) {
  const iteration = typeof __ITER === "undefined" ? "setup" : __ITER;
  const vu = typeof __VU === "undefined" ? "setup" : __VU;
  return `${prefix}-${vu}-${iteration}-${Date.now()}-${Math.random()}`;
}

function json(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    return {};
  }
}

function params(session, headers = {}) {
  const sourceHeaders = distinctSourceIps && typeof __VU === "number" && __VU > 0
    ? { "X-Forwarded-For": `2001:db8::${__VU}` }
    : {};
  return { cookies: { happy_tasks_session: session }, headers: { ...sourceHeaders, ...headers } };
}

function mutationParams(session, prefix, headers = {}) {
  return params(session, { "Idempotency-Key": key(prefix), ...headers });
}

function mark(response, label, expected) {
  check(response, { [`${label} returns ${expected}`]: (result) => result.status === expected });
  return response.status === expected;
}

export function setup() {
  const sessions = users.map((email) => {
    const response = http.post(
      `${baseUrl}/v1/auth/login`,
      JSON.stringify({ email, password }),
      { headers: { "Content-Type": "application/json" }, tags: { name: "POST login" } },
    );
    const session = response.cookies.happy_tasks_session?.[0]?.value;
    if (response.status !== 200 || !session) fail(`Could not authenticate ${email}: status ${response.status}`);
    return session;
  });

  if (__ENV.HOT_TASK_ID) return { sessions, hotTaskId: __ENV.HOT_TASK_ID, hotTaskVersion: Number(__ENV.HOT_TASK_VERSION || 1), cleanupHotTask: false };

  const hotTaskResponse = http.post(
    `${baseUrl}/v1/projects/${crudProjectId}/tasks`,
    JSON.stringify({ title: `Load hot thread ${Date.now()}`, description: "Disposable hot-thread task", status: "TODO", priority: "MEDIUM" }),
    mutationParams(sessions[0], "hot-task", { "Content-Type": "application/json" }),
  );
  if (!mark(hotTaskResponse, "hot task create", 201)) fail(`Could not create hot task: ${hotTaskResponse.body}`);
  const hotTask = json(hotTaskResponse);
  return { sessions, hotTaskId: hotTask.id, hotTaskVersion: hotTask.version, cleanupHotTask: true };
}

export function teardown(data) {
  if (!data?.cleanupHotTask || !data.hotTaskId) return;
  const response = http.del(
    `${baseUrl}/v1/projects/${crudProjectId}/tasks/${data.hotTaskId}`,
    null,
    mutationParams(data.sessions[0], "hot-task-delete", { "If-Match": `"${data.hotTaskVersion}"` }),
  );
  mark(response, "hot task cleanup", 200);
}

export function readers(data) {
  const session = data.sessions[(__VU - 1) % data.sessions.length];
  const response = http.get(`${baseUrl}/v1/projects/${heavyProjectId}/tasks?limit=100`, { ...params(session), tags: { name: "GET heavy task page" } });
  mark(response, "heavy task page", 200);
  check(response, { "heavy task page is compact": (result) => result.body.length < 256 * 1024 });
}

export function crud(data) {
  const session = data.sessions[(__VU - 1) % data.sessions.length];
  const create = http.post(
    `${baseUrl}/v1/projects/${crudProjectId}/tasks`,
    JSON.stringify({ title: `Load CRUD task ${__VU}`, description: heavyDescription, status: "TODO", priority: "MEDIUM", customFields: { load: "crud", payload: heavyDescription.slice(0, 4000) }, tags: ["load-test"] }),
    mutationParams(session, "crud-create", { "Content-Type": "application/json" }),
  );
  if (!mark(create, "task create", 201)) return;
  const task = json(create);

  const read = http.get(`${baseUrl}/v1/projects/${crudProjectId}/tasks/${task.id}`, params(session));
  if (!mark(read, "task read", 200)) return;
  const current = json(read);
  const update = http.patch(
    `${baseUrl}/v1/projects/${crudProjectId}/tasks/${task.id}`,
    JSON.stringify({ title: `Updated CRUD task ${__VU}`, description: updatedDescription, status: "IN_PROGRESS", priority: "HIGH", customFields: { load: "updated" }, tags: ["load-test", "updated"] }),
    mutationParams(session, "crud-update", { "Content-Type": "application/json", "If-Match": `"${current.version}"` }),
  );
  if (!mark(update, "task update", 200)) return;
  const updated = json(update);

  const comment = http.post(
    `${baseUrl}/v1/projects/${crudProjectId}/tasks/${task.id}/comments`,
    JSON.stringify({ body: commentBody }),
    mutationParams(session, "crud-comment", { "Content-Type": "application/json" }),
  );
  mark(comment, "task comment", 201);

  const deleted = http.del(
    `${baseUrl}/v1/projects/${crudProjectId}/tasks/${task.id}`,
    null,
    mutationParams(session, "crud-delete", { "If-Match": `"${updated.version}"` }),
  );
  mark(deleted, "task delete", 200);
}

export function comments(data) {
  const session = data.sessions[(__VU - 1) % data.sessions.length];
  const response = http.post(
    `${baseUrl}/v1/projects/${crudProjectId}/tasks/${data.hotTaskId}/comments`,
    JSON.stringify({ body: commentBody }),
    mutationParams(session, "hot-comment", { "Content-Type": "application/json" }),
  );
  mark(response, "hot-thread comment", 201);
}

export function files(data) {
  const session = data.sessions[(__VU - 1) % data.sessions.length];
  const create = http.post(
    `${baseUrl}/v1/projects/${crudProjectId}/tasks`,
    JSON.stringify({ title: `Load file task ${__VU}`, description: heavyDescription, status: "TODO", priority: "MEDIUM" }),
    mutationParams(session, "file-task-create", { "Content-Type": "application/json" }),
  );
  if (!mark(create, "file task create", 201)) return;
  const task = json(create);
  const upload = http.post(
    `${baseUrl}/v1/projects/${crudProjectId}/tasks/${task.id}/attachments`,
    { file: http.file(filePayload, `load-${__VU}.txt`, "text/plain") },
    mutationParams(session, "file-upload"),
  );
  if (!mark(upload, "file upload", 201)) return;
  const attachment = json(upload);

  const list = http.get(`${baseUrl}/v1/projects/${crudProjectId}/tasks/${task.id}/attachments`, params(session));
  mark(list, "file list", 200);
  const download = http.get(`${baseUrl}/v1/projects/${crudProjectId}/tasks/${task.id}/attachments/${attachment.id}`, params(session));
  mark(download, "file download", 200);
  const remove = http.del(`${baseUrl}/v1/projects/${crudProjectId}/tasks/${task.id}/attachments/${attachment.id}`, null, mutationParams(session, "file-delete"));
  mark(remove, "file delete", 200);
  const deleted = http.del(`${baseUrl}/v1/projects/${crudProjectId}/tasks/${task.id}`, null, mutationParams(session, "file-task-delete", { "If-Match": `"${task.version}"` }));
  mark(deleted, "file task delete", 200);
}

export default function () {}
