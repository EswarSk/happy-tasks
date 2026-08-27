import http from "k6/http";
import { check, sleep } from "k6";

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
const actorId =
  __ENV.ACTOR_ID || "00000000-0000-7000-8000-000000000001";

export default function () {
  const response = http.get(
    `${baseUrl}/v1/projects/${projectId}/tasks?limit=100`,
    {
      headers: { "X-Actor-ID": actorId },
      tags: { name: "GET task page" },
    },
  );

  check(response, {
    "task page returns 200": (result) => result.status === 200,
    "task page is compact": (result) => result.body.length < 256 * 1024,
  });

  sleep(0.2);
}
