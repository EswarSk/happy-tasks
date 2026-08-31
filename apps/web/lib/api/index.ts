import { MockWorkspaceApi } from "./mock-workspace-api";
import { OfflineHttpWorkspaceApi } from "./offline-workspace-api";
import type { WorkspaceApi } from "./types";

export const dataSource = process.env.NEXT_PUBLIC_DATA_SOURCE === "mock" ? "mock" : "api";

export const offlineWorkspaceApi = dataSource === "api"
  ? new OfflineHttpWorkspaceApi(process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080")
  : null;

export const workspaceApi: WorkspaceApi =
  dataSource === "api"
    ? offlineWorkspaceApi!
    : new MockWorkspaceApi();

export * from "./types";
export type { components, operations, paths } from "./generated/openapi";
export { demoActorId } from "./http-workspace-api";
export { demoProjectId } from "./mock-workspace-api";
export type { OfflineSyncSnapshot } from "./offline-workspace-api";
