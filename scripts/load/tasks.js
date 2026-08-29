import http from "k6/http";
import { check, fail, sleep } from "k6";

export const options = {
  scenarios: {
    task_pages: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 20),
      duration: __ENV.DURATION || "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<250"],
    checks: ["rate>0.99"],
  },
};

const baseUrl = __ENV.BASE_URL || "http://localhost:8080";
const projectId =
  __ENV.PROJECT_ID || "02000000-0000-7000-8000-000000000001";
const password = __ENV.LOAD_PASSWORD || "password";
const users = (__ENV.LOAD_USERS ||
  "maya@example.test,noah@example.test,priya@example.test,mateo@example.test,aisha@example.test,kenji@example.test,sofia@example.test,omar@example.test")
  .split(",")
  .map((email) => email.trim())
  .filter(Boolean);

export function setup() {
  const sessions = users.map((email) => {
    const response = http.post(
      `${baseUrl}/v1/auth/login`,
      JSON.stringify({ email, password }),
      { headers: { "Content-Type": "application/json" }, tags: { name: "POST login" } },
    );
    const session = response.cookies.happy_tasks_session?.[0]?.value;
    if (response.status !== 200 || !session) {
      fail(`Could not authenticate ${email}: status ${response.status}`);
    }
    return { email, session };
  });
  return { sessions };
}

export default function ({ sessions }) {
  const session = sessions[(__VU - 1) % sessions.length];
  const response = http.get(
    `${baseUrl}/v1/projects/${projectId}/tasks?limit=100`,
    {
      cookies: { happy_tasks_session: session.session },
      tags: { name: "GET task page" },
    },
  );

  check(response, {
    "task page returns 200": (result) => result.status === 200,
    "task page is compact": (result) => result.body.length < 256 * 1024,
  });

  sleep(0.2);
}
