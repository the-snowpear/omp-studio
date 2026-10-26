import { Fragment, useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AppSelect, type AppSelectProps } from "./AppSelect";
import { I18nProvider } from "./i18n";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const ordinary = <><option value="">Choose…</option><option value="alpha">Alpha</option><option value="beta" disabled>Beta</option><option value="gamma">Gamma</option></>;
function mount(props: Partial<AppSelectProps> = {}) {
  function Harness() {
    const [value, setValue] = useState<string | number | undefined>(props.value ?? "alpha");
    return <AppSelect aria-label="Engine" {...props} value={value} onChange={event => { setValue(event.target.value); props.onChange?.(event); }}>{props.children === undefined ? ordinary : props.children}</AppSelect>;
  }
  return render(<I18nProvider forcedLanguage="en"><Harness /><button>Outside</button></I18nProvider>);
}

it("opens a themed listbox, commits a selection once and returns focus to the field", () => {
  const onChange = vi.fn();
  mount({ onChange });
  const trigger = screen.getByRole("combobox", { name: "Engine" });
  expect(trigger.textContent).toBe("Alpha");
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.click(trigger);
  expect(screen.getByRole("option", { name: "Alpha" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("option", { name: "Gamma" }));
  expect(trigger.textContent).toBe("Gamma");
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ target: { value: "gamma" } });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("option", { name: "Gamma" }));
  expect(onChange).toHaveBeenCalledTimes(1);
});

it("supports Arrow, Home, End and commit while skipping disabled options", () => {
  mount();
  const trigger = screen.getByRole("combobox");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(trigger.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "Gamma" }).id);
  fireEvent.keyDown(trigger, { key: "Home" });
  expect(trigger.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "Choose…" }).id);
  fireEvent.keyDown(trigger, { key: "End" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  expect(trigger.textContent).toBe("Gamma");
  fireEvent.keyDown(trigger, { key: " " });
  expect(screen.getByRole("listbox")).toBeTruthy();
});

it("supports first-character matching and outside pointer dismissal", () => {
  const onChange = vi.fn();
  mount({ onChange });
  const trigger = screen.getByRole("combobox");
  fireEvent.keyDown(trigger, { key: "g" });
  expect(trigger.textContent).toBe("Gamma");
  fireEvent.keyDown(trigger, { key: "g" });
  expect(onChange).toHaveBeenCalledTimes(1);
  fireEvent.click(trigger);
  fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("preserves groups, fragments, numeric values, placeholders and disabled options", () => {
  mount({ value: 2, children: <Fragment><option value="" disabled>Choose…</option><optgroup label="Local"><option value={2}>Two</option></optgroup><optgroup label="Remote" disabled><option value="three">Three</option></optgroup></Fragment> });
  const trigger = screen.getByRole("combobox");
  expect(trigger.textContent).toBe("Two");
  fireEvent.click(trigger);
  expect(within(screen.getByRole("group", { name: "Local" })).getByRole("option", { name: "Two" })).toBeTruthy();
  expect((screen.getByRole("option", { name: "Three" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("option", { name: "Three" }));
  expect(trigger.textContent).toBe("Two");
  expect((screen.getByRole("option", { name: "Choose…" }) as HTMLButtonElement).disabled).toBe(true);
});

it("keeps disabled fields inert and preserves label association", () => {
  render(<I18nProvider forcedLanguage="en"><label htmlFor="engine">Engine</label><AppSelect id="engine" value="alpha" disabled>{ordinary}</AppSelect></I18nProvider>);
  const trigger = screen.getByRole("combobox", { name: "Engine" });
  fireEvent.click(trigger);
  expect(screen.queryByRole("listbox")).toBeNull();
  expect((trigger as HTMLButtonElement).disabled).toBe(true);
});

it("names the popup from an implicit form label", () => {
  render(<I18nProvider forcedLanguage="en"><label>Engine<AppSelect value="alpha">{ordinary}</AppSelect></label></I18nProvider>);
  fireEvent.click(screen.getByRole("combobox", { name: "Engine" }));
  expect(screen.getByRole("listbox", { name: "Engine" })).toBeTruthy();
});

it("adds search only above ten items, filters labels and values, and resets on dismissal", () => {
  const children = Array.from({ length: 11 }, (_, i) => <option key={i} value={`value-${i}`}>Engine {i}</option>);
  mount({ value: "value-3", children });
  const trigger = screen.getByRole("combobox");
  fireEvent.click(trigger);
  const search = screen.getByRole("searchbox", { name: "Search options" });
  expect(document.activeElement).toBe(search);
  fireEvent.change(search, { target: { value: "VALUE-10" } });
  expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual(["Engine 10"]);
  fireEvent.keyDown(search, { key: "Enter" });
  expect(trigger.textContent).toBe("Engine 10");
  fireEvent.click(trigger);
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing" } });
  expect(screen.getByRole("status").textContent).toBe("No matching options");
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
  expect(document.activeElement).toBe(trigger);
});

it("keeps short lists simple and displays a placeholder for empty inventories", () => {
  mount({ value: "", placeholder: "No engines", children: null });
  fireEvent.click(screen.getByRole("combobox"));
  expect(screen.queryByRole("searchbox")).toBeNull();
  expect(screen.getByRole("combobox").textContent).toBe("No engines");
  expect(screen.getByRole("status")).toBeTruthy();
});

it("consumes Escape before a parent dialog and removes popup options before Tab trapping", () => {
  const closeDialog = vi.fn();
  const children = Array.from({ length: 11 }, (_, i) => <option key={i}>{`Engine ${i}`}</option>);
  render(<I18nProvider forcedLanguage="en"><section role="dialog" aria-label="Settings" onKeyDown={event => { if (event.key === "Escape") closeDialog(); }}><AppSelect aria-label="Engine" value="Engine 0">{children}</AppSelect><button>Next</button></section></I18nProvider>);
  const trigger = screen.getByRole("combobox");
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog").contains(screen.getByRole("searchbox"))).toBe(true);
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
  expect(closeDialog).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Tab" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("flips near the lower edge and repositions on scroll and resize", () => {
  let top = 700;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ top, bottom: top + 32, left: 900, right: 1100, width: 200, height: 32, x: 900, y: top, toJSON() {} }));
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(200);
  mount();
  fireEvent.click(screen.getByRole("combobox"));
  const popup = screen.getByRole("listbox").parentElement!;
  expect(popup.dataset.side).toBe("top");
  expect(Number.parseFloat(popup.style.left)).toBeLessThanOrEqual(window.innerWidth - 220 - 8);
  top = 50;
  fireEvent.scroll(window);
  expect(popup.dataset.side).toBe("bottom");
  expect(popup.style.top).toBe("88px");
  top = 100;
  fireEvent.resize(window);
  expect(popup.style.top).toBe("138px");
});
