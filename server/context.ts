import { AsyncLocalStorage } from "node:async_hooks";
export type Scope = {
  workspaceId: string;
  userId: string;
  role: "owner" | "admin" | "operator" | "viewer";
  admin: boolean;
};
export const scopes = new AsyncLocalStorage<Scope>();
export const localScope: Scope = {
  workspaceId: "local",
  userId: "local",
  role: "owner",
  admin: true,
};
export const scope = () => scopes.getStore() || localScope;
export const workspace = () => scope().workspaceId;
export const inWorkspace = <T>(id: string, action: () => T) =>
  scopes.run({ ...localScope, workspaceId: id || "local" }, action);
