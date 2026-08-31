import type { AuthUser, Task, UpdateTaskInput } from "@/lib/api/types";

const databaseName = "happy-tasks-offline-v1";
const databaseVersion = 1;
const activeUserKey = "active-user";

const memoryValues = new Map<string, unknown>();
const memoryOutbox = new Map<string, OfflineOperation>();
let databasePromise: Promise<IDBDatabase> | undefined;

export type OfflineOperationStatus = "pending" | "failed" | "conflict";

interface OfflineOperationBase {
  id: string;
  actorId: string;
  projectId: string;
  taskId: string;
  idempotencyKey: string;
  createdAt: string;
  status: OfflineOperationStatus;
  error?: string;
}

export type OfflineOperation =
  | (OfflineOperationBase & { kind: "task.create"; title: string })
  | (OfflineOperationBase & { kind: "task.update"; input: UpdateTaskInput })
  | (OfflineOperationBase & { kind: "task.delete"; expectedVersion: number });

function openDatabase() {
  if (typeof indexedDB === "undefined") return undefined;
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("values")) request.result.createObjectStore("values");
      if (!request.result.objectStoreNames.contains("outbox")) request.result.createObjectStore("outbox", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

const transactionDone = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error);
});

const requestValue = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export async function getOfflineValue<T>(key: string): Promise<T | undefined> {
  const database = openDatabase();
  if (!database) return structuredClone(memoryValues.get(key)) as T | undefined;
  const db = await database;
  return requestValue<T | undefined>(db.transaction("values").objectStore("values").get(key));
}

export async function setOfflineValue<T>(key: string, value: T): Promise<void> {
  const database = openDatabase();
  if (!database) {
    memoryValues.set(key, structuredClone(value));
    return;
  }
  const db = await database;
  const transaction = db.transaction("values", "readwrite");
  transaction.objectStore("values").put(value, key);
  await transactionDone(transaction);
}

export async function deleteOfflineValue(key: string): Promise<void> {
  const database = openDatabase();
  if (!database) {
    memoryValues.delete(key);
    return;
  }
  const db = await database;
  const transaction = db.transaction("values", "readwrite");
  transaction.objectStore("values").delete(key);
  await transactionDone(transaction);
}

export async function getActiveOfflineUser() {
  return getOfflineValue<AuthUser>(activeUserKey);
}

export async function setActiveOfflineUser(user?: AuthUser) {
  if (user) await setOfflineValue(activeUserKey, user);
  else await deleteOfflineValue(activeUserKey);
}

export async function putOfflineOperation(operation: OfflineOperation) {
  const database = openDatabase();
  if (!database) {
    memoryOutbox.set(operation.id, structuredClone(operation));
    return;
  }
  const db = await database;
  const transaction = db.transaction("outbox", "readwrite");
  transaction.objectStore("outbox").put(operation);
  await transactionDone(transaction);
}

export async function deleteOfflineOperation(id: string) {
  const database = openDatabase();
  if (!database) {
    memoryOutbox.delete(id);
    return;
  }
  const db = await database;
  const transaction = db.transaction("outbox", "readwrite");
  transaction.objectStore("outbox").delete(id);
  await transactionDone(transaction);
}

export async function listOfflineOperations(actorId?: string) {
  const database = openDatabase();
  const operations = database
    ? await requestValue<OfflineOperation[]>((await database).transaction("outbox").objectStore("outbox").getAll())
    : [...memoryOutbox.values()].map((operation) => structuredClone(operation));
  return operations
    .filter((operation) => !actorId || operation.actorId === actorId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function clearOfflineActor(actorId: string) {
  const prefix = `${actorId}:`;
  const database = openDatabase();
  if (!database) {
    for (const key of memoryValues.keys()) if (key.startsWith(prefix)) memoryValues.delete(key);
    for (const [key, operation] of memoryOutbox) if (operation.actorId === actorId) memoryOutbox.delete(key);
    return;
  }
  const db = await database;
  const transaction = db.transaction(["values", "outbox"], "readwrite");
  for (const storeName of ["values", "outbox"] as const) {
    const store = transaction.objectStore(storeName);
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item) return;
      const matches = storeName === "values"
        ? String(item.key).startsWith(prefix)
        : (item.value as OfflineOperation).actorId === actorId;
      if (matches) item.delete();
      item.continue();
    };
  }
  await transactionDone(transaction);
}

export function actorCacheKey(actorId: string, kind: string, id = "") {
  return `${actorId}:${kind}:${id}`;
}

export function filterCachedTasks(tasks: Task[], filters: { search?: string; status?: string; priority?: string; assigneeId?: string; tag?: string }) {
  const search = filters.search?.trim().toLowerCase();
  const tag = filters.tag?.trim().toLowerCase();
  return tasks.filter((task) =>
    (!search || `${task.key} ${task.title} ${task.description} ${task.tags.join(" ")}`.toLowerCase().includes(search))
    && (!filters.status || filters.status === "all" || task.status === filters.status)
    && (!filters.priority || filters.priority === "all" || task.priority === filters.priority)
    && (!filters.assigneeId || task.assigneeIds.includes(filters.assigneeId))
    && (!tag || task.tags.some((item) => item.toLowerCase().includes(tag)))
  );
}
