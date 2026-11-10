import { expect, it } from "vitest";
import { DocumentHosts } from "./hosts";

it("releases a departed conversation's DOM and ignores late slot cleanup", () => {
  const hosts = new DocumentHosts();
  const host = hosts.get("departed");
  host.element.append(document.createElement("textarea"));
  const release = hosts.retain("departed");
  const detach = hosts.attach("departed", document.createElement("div"));
  release(); detach();
  expect(hosts.getDiagnostics(true)).toEqual({ hosts: 0, detachedHosts: 0, detachedNodes: 0 });
  expect(host.element.parentElement).toBeNull();
});

it("captures reading state before removing a conversation portal", () => {
  const hosts = new DocumentHosts(), slot = document.createElement("div");
  document.body.append(slot);
  const detach = hosts.attach("reading", slot), host = hosts.get("reading");
  let connected = false;
  const off = hosts.onBeforeDetach("reading", () => { connected = host.element.isConnected; });
  detach(); off(); slot.remove();
  expect(connected).toBe(true);
  expect(host.element.isConnected).toBe(false);
});

it("an old deferred cleanup does not release a reopened conversation", () => {
  const hosts = new DocumentHosts();
  const oldRelease = hosts.retain("reopened");
  const host = hosts.get("reopened");
  const newRelease = hosts.retain("reopened");
  const slot = document.createElement("div");
  hosts.attach("reopened", slot);
  oldRelease();
  expect(slot.firstChild).toBe(host.element);
  expect(hosts.getDiagnostics().hosts).toBe(1);
  newRelease();
  expect(slot.childElementCount).toBe(0);
  expect(hosts.getDiagnostics().hosts).toBe(0);
});
