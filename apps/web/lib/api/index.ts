import { HttpWorkspaceApi } from "./http-workspace-api";
import { MockWorkspaceApi } from "./mock-workspace-api";

export const dataSource = process.env.NEXT_PUBLIC_DATA_SOURCE === "mock" ? "mock" : "api";

export const workspaceApi =
  dataSource === "api"
    ? new HttpWorkspaceApi(process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080")
    : new MockWorkspaceApi();

export * from "./types";
export type { components, operations, paths } from "./generated/openapi";
export { demoActorId } from "./http-workspace-api";
export { demoProjectId } from "./mock-workspace-api";
