import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageQueueBar, type QueuedMessage } from "./MessageQueueBar";

afterEach(cleanup);

function entry(id: number, text: string): QueuedMessage {
  return { id, text };
}

describe("MessageQueueBar", () => {
  it("队列为空时不渲染", () => {
    const { container } = render(
      <MessageQueueBar
        messages={[]}
        running
        sendEnabled
        onEdit={() => {}}
        onSendNow={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(container.querySelector(".queue-strip")).toBeNull();
  });

  it("渲染全部排队消息与计数", () => {
    render(
      <MessageQueueBar
        messages={[entry(1, "先修登录"), entry(2, "再补测试")]}
        running
        sendEnabled
        onEdit={() => {}}
        onSendNow={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByText("排队消息 ×2")).toBeTruthy();
    expect(screen.getByText("先修登录")).toBeTruthy();
    expect(screen.getByText("再补测试")).toBeTruthy();
    expect(screen.getByText("本轮结束后自动按序发送")).toBeTruthy();
  });

  it("空闲状态下提示自动发送时机不同", () => {
    render(
      <MessageQueueBar
        messages={[entry(1, "hi")]}
        running={false}
        sendEnabled
        onEdit={() => {}}
        onSendNow={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByText("空闲后自动发送")).toBeTruthy();
  });

  it("编辑 / 立刻发送 / 删除 回调携带对应条目", () => {
    const onEdit = vi.fn();
    const onSendNow = vi.fn();
    const onRemove = vi.fn();
    render(
      <MessageQueueBar
        messages={[entry(1, "第一条"), entry(2, "第二条")]}
        running
        sendEnabled
        onEdit={onEdit}
        onSendNow={onSendNow}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑第 2 条排队消息" }));
    expect(onEdit).toHaveBeenCalledWith(entry(2, "第二条"));
    fireEvent.click(screen.getByRole("button", { name: "立刻发送第 1 条排队消息" }));
    expect(onSendNow).toHaveBeenCalledWith(entry(1, "第一条"));
    fireEvent.click(screen.getByRole("button", { name: "删除第 2 条排队消息" }));
    expect(onRemove).toHaveBeenCalledWith(entry(2, "第二条"));
  });

  it("sendEnabled 为 false 时立刻发送禁用，编辑与删除仍可用", () => {
    render(
      <MessageQueueBar
        messages={[entry(1, "hi")]}
        running
        sendEnabled={false}
        onEdit={() => {}}
        onSendNow={() => {}}
        onRemove={() => {}}
      />,
    );
    expect((screen.getByRole("button", { name: "立刻发送第 1 条排队消息" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "编辑第 1 条排队消息" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "删除第 1 条排队消息" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("demo 模式显示「演示」标记", () => {
    render(
      <MessageQueueBar
        messages={[entry(1, "对比完 v0.8.1 的变更后同步依赖版本")]}
        running
        sendEnabled
        demo
        onEdit={() => {}}
        onSendNow={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByText("演示")).toBeTruthy();
  });

  it("头行最右侧按钮可展开/收起条目列表", () => {
    render(
      <MessageQueueBar
        messages={[entry(1, "第一条"), entry(2, "第二条")]}
        running
        sendEnabled
        onEdit={() => {}}
        onSendNow={() => {}}
        onRemove={() => {}}
      />,
    );
    const strip = document.querySelector(".queue-strip") as HTMLElement;
    const collapse = strip.querySelector(".qs-collapse") as HTMLElement;
    const toggle = screen.getByRole("button", { name: "收起排队消息" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(collapse.hasAttribute("inert")).toBe(false);
    fireEvent.click(toggle);
    expect(strip.classList.contains("collapsed")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(collapse.hasAttribute("inert")).toBe(true);
    // 收起后仍能再次展开
    fireEvent.click(screen.getByRole("button", { name: "展开排队消息" }));
    expect(strip.classList.contains("collapsed")).toBe(false);
    expect(collapse.hasAttribute("inert")).toBe(false);
  });
});
