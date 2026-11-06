import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { EventCursor } from "@omp-studio/client-contract";
import { OmpLogsPanel } from "./OmpLogsPanel";
import { OutputPanel } from "./OutputPanel";
import type { LedgerCommandRow } from "./types";
import type { ShellEventLogEntry } from "../shellMemory";

afterEach(cleanup);

const command = (over: Partial<LedgerCommandRow>): LedgerCommandRow => ({
  requestId: "req_1",
  commandName: "core.prompt",
  status: "completed",
  ...over,
});

const event = (cursor: number, kind: ShellEventLogEntry["kind"]): ShellEventLogEntry => ({
  cursor: String(cursor) as EventCursor,
  kind,
  occurredAt: "2026-10-30T15:01:18.124Z",
});

describe("OutputPanel ledger", () => {
  it("lists each command with its status and terminal detail", () => {
    render(<OutputPanel commands={[
      command({ requestId: "req_a", commandName: "session.create", status: "completed" }),
      command({ requestId: "req_b", commandName: "loop.enable", status: "rejected", detail: "Loop rejected: maxIterations must be at least 2.", at: "2026-10-30T15:01:18.124Z" }),
    ]} />);
    expect(screen.getByRole("columnheader", { name: "状态" })).toBeTruthy();
    expect(screen.getByText("session.create")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.getByText("rejected")).toBeTruthy();
    expect(screen.getByText("· Loop rejected: maxIterations must be at least 2.")).toBeTruthy();
    // The count is the masthead's only metric and must track the ledger.
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("shows the empty state instead of an empty table", () => {
    render(<OutputPanel commands={[]} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("暂无命令")).toBeTruthy();
    expect(screen.getByText("从 Composer 或操作台发出的命令会记录在这里。")).toBeTruthy();
  });

  it("keeps operator controls behind a disclosure", () => {
    const { container } = render(<OutputPanel commands={[]} operator={<button type="button">Invoke</button>} />);
    const details = container.querySelector<HTMLDetailsElement>("details.dock-console");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toContain("操作台");
  });
});

describe("OmpLogsPanel transcript", () => {
  it("splits each event kind into domain and leaf and counts the log", () => {
    render(<OmpLogsPanel events={[event(1187, "command.receipt"), event(1188, "residents.changed")]} />);
    expect(screen.getByRole("columnheader", { name: "事件" })).toBeTruthy();
    expect(screen.getByText("command.")).toBeTruthy();
    expect(screen.getByText("receipt")).toBeTruthy();
    expect(screen.getByText("1188")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("shows the empty state before the first event", () => {
    render(<OmpLogsPanel events={[]} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("暂无事件")).toBeTruthy();
  });
});
