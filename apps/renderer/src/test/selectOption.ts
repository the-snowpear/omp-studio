import { fireEvent, within } from "@testing-library/react";

/** Exercise the same trigger / option interaction a user performs. */
export function selectOption(trigger: HTMLElement, label: string | RegExp) {
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  const list = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
  if (!list) throw new Error("The select popup did not open");
  fireEvent.click(within(list).getByRole("option", { name: label }));
}
