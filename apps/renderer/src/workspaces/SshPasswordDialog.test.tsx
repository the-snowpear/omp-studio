/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { RemoteConnectionProfile } from "../../../desktop/src/remote/shared";
import { SshPasswordDialog } from "./SshPasswordDialog";

// jsdom has no modal dialog implementation; the component only needs open/close.
beforeAll(() => {
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); },
    close(this: HTMLDialogElement) { this.removeAttribute("open"); },
  });
});
afterEach(cleanup);

const profile: RemoteConnectionProfile = { id: "p", name: "dev", host: "10.0.0.5", user: "ubuntu", platform: "linux", authMode: "password" };

function open(onSubmit = vi.fn(), onCancel = vi.fn()) {
  render(<SshPasswordDialog profile={profile} onSubmit={onSubmit} onCancel={onCancel} />);
  const input = screen.getByLabelText("SSH 密码") as HTMLInputElement;
  return { input, form: input.closest("form")!, onSubmit, onCancel };
}

it("names the target account and never prefills a password", () => {
  const { input } = open();
  expect(screen.getByText("ubuntu@10.0.0.5")).toBeTruthy();
  expect(input.value).toBe("");
  expect(input.getAttribute("type")).toBe("password");
});

it("does not submit an empty password and clears the field after submitting", () => {
  const { form, input, onSubmit } = open();
  fireEvent.submit(form);
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "s3cret with space" } });
  fireEvent.submit(form);
  expect(onSubmit).toHaveBeenCalledWith("s3cret with space");
  expect(input.value).toBe("");
});

it("cancelling clears whatever was typed and reports cancellation", () => {
  const { input, onCancel, onSubmit } = open();
  fireEvent.change(input, { target: { value: "typed-but-cancelled" } });
  fireEvent.click(screen.getByText("取消"));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(input.value).toBe("");
});
