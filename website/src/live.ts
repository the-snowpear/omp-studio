// What happens inside the desk's windows. The surfaces in shared/ui.ts are drawn once;
// this gives each of them the behaviour a visitor would try first: the conversation
// finishes its run and answers, the plan can be approved or sent back, the terminal
// takes commands, the browser changes hands, Git commits, folders open.
// Everything a visitor types is put back as text, never as markup.
import { i } from "../shared/icons";
import { a } from "../shared/app-icons";
import { WEB_PAGES, composer as composerHTML, diffRows, stepPill, toolHead, userMessage, type Kind } from "../shared/ui";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function make(tag: string, cls: string, html = ""): HTMLElement {
  const el = document.createElement(tag);
  el.className = cls;
  el.innerHTML = html;
  return el;
}

function rise(el: HTMLElement) {
  if (reduced()) return;
  el.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 420, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
}

/** Add a row to a conversation and keep its end in view. */
function post(list: HTMLElement, el: HTMLElement, before?: Element | null) {
  list.insertBefore(el, before ?? null);
  list.scrollTop = list.scrollHeight;
  rise(el);
  return el;
}

/** Type a line out, the way a model streams. */
async function stream(el: HTMLElement, text: string, list: HTMLElement) {
  if (reduced()) {
    el.textContent = text;
    return;
  }
  for (let n = 2; n < text.length + 2; n += 2) {
    el.textContent = text.slice(0, n);
    list.scrollTop = list.scrollHeight;
    await wait(26);
  }
}

// ---------------- conversation ----------------
const REPLY = "这里是网站上的演示，没有连接模型。装好 OMP Studio，同样的输入框会直接连到你自己的 Agent。";

function composer(body: HTMLElement) {
  const list = body.querySelector<HTMLElement>(".os-msgs")!;
  const input = body.querySelector<HTMLInputElement>(".os-composer-input")!;
  let busy = false;
  const send = async () => {
    const text = input.value.trim();
    if (!text || busy) return input.focus();
    busy = true;
    input.value = "";
    const mine = make("div", "os-mine", userMessage("", new Date().toTimeString().slice(0, 5)));
    mine.querySelector(".os-user")!.textContent = text;
    post(list, mine);
    await wait(reduced() ? 0 : 520);
    const say = post(list, make("p", "os-say"));
    await stream(say, REPLY, list);
    const link = make("a", "os-link", "去下载");
    (link as HTMLAnchorElement).href = "#download";
    say.append(" ", link);
    list.scrollTop = list.scrollHeight;
    busy = false;
  };
  body.querySelector(".os-send")!.addEventListener("click", () => void send());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) void send();
  });
}

/** The run that is under way when the page opens reaches its end. */
async function finishRun(body: HTMLElement) {
  const list = body.querySelector<HTMLElement>(".os-msgs")!;
  const working = list.querySelector<HTMLElement>(".os-working")!;
  const clock = working.querySelector<HTMLElement>(".os-dim")!;
  const spin = list.querySelector(".os-tool .os-spin");
  const pill = body.querySelector<HTMLElement>(".os-pill")!;
  const todo = list.querySelector<HTMLElement>(".os-todo li:last-child")!;
  let seconds = 54;
  const timer = setInterval(() => (clock.textContent = `${++seconds}s`), 1000);
  // Only play to someone who is looking: hold each beat while the desk is off screen.
  const beat = async (ms: number) => {
    await wait(ms);
    while (document.hidden || !body.isConnected || body.getBoundingClientRect().bottom < 0) await wait(400);
  };
  await beat(4200);
  spin?.replaceWith(make("span", "os-bad", a("x")));
  await beat(900);
  const say = post(list, make("p", "os-say"), working);
  await stream(say, "报错出在 resolveTheme 的返回类型，改一处就够。", list);
  await beat(700);
  post(list, make("div", "os-tool", `${toolHead("Edit", "src/index.ts", a("pencil"))}<p class="os-cwd"><span class="os-add">+1</span> <span class="os-del">−1</span></p>`), working);
  await beat(1300);
  const run = post(list, make("div", "os-tool", toolHead("Bash", "npm run typecheck", '<span class="os-spin"></span>')), working);
  await beat(2400);
  run.querySelector(".os-spin")!.replaceWith(make("span", "os-good", a("check")));
  const out = make("pre", "", '<span class="os-ok">✓</span> tsc --noEmit，0 errors');
  run.append(out);
  rise(out);
  list.scrollTop = list.scrollHeight;
  await beat(700);
  todo.dataset.done = "";
  pill.querySelector("b")!.textContent = "7 / 7 步";
  pill.querySelector(".os-files")!.textContent = "3 个文件已更改";
  pill.dataset.done = "";
  pill.querySelector(".os-add")!.textContent = "+88";
  clearInterval(timer);
  working.innerHTML = `${a("check")}已完成<i>·</i><span class="os-dim">${seconds}s</span>`;
  working.dataset.done = "";
}

function chat(body: HTMLElement) {
  composer(body);
  const list = body.querySelector<HTMLElement>(".os-msgs")!;
  // Resizing a window must not lose the end of the conversation.
  let pinned = true;
  list.addEventListener("scroll", () => (pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 24), { passive: true });
  new ResizeObserver(() => {
    if (pinned) list.scrollTop = list.scrollHeight;
  }).observe(list);
  if (!reduced()) void finishRun(body);
}

// ---------------- plan review ----------------
function plan(body: HTMLElement, status: (text: string) => void) {
  const steps = body.querySelector<HTMLElement>(".os-plan-b ol")!;
  const foot = body.querySelector<HTMLElement>(".os-plan-f")!;

  foot.addEventListener("click", async (e) => {
    const b = (e.target as Element).closest<HTMLElement>("button");
    if (b?.dataset.approve !== undefined) return approve();
    if (b?.dataset.refine === undefined) return;
    // Send the plan back with a note; it returns with the note written in.
    foot.innerHTML = '<input class="os-field" type="text" placeholder="想让 Agent 改什么？" aria-label="修改意见" autocomplete="off" maxlength="60"><button class="os-btn" type="button" data-send>发回</button>';
    const input = foot.querySelector("input")!;
    input.focus({ preventScroll: true });
    const back = () => {
      const note = input.value.trim() || "补上键盘缩放";
      const li = document.createElement("li");
      li.textContent = `${note}。`;
      steps.append(li);
      rise(li);
      li.parentElement!.parentElement!.scrollTop = 9999;
      foot.innerHTML = '<button class="os-btn" data-primary data-approve type="button">批准并执行</button><button class="os-btn" data-refine type="button">修改计划</button>';
      status("计划已更新");
    };
    foot.querySelector("[data-send]")!.addEventListener("click", back);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.isComposing) back();
    });
  });

  async function approve() {
    status("执行中");
    body.innerHTML = `<div class="os-chat"><div class="os-msgs"><p class="os-say">计划已批准，开始执行。</p><ul class="os-todo"><li>核对 pan / zoom 事件</li><li>接上拖拽惯性开关</li><li>跑一遍检查</li></ul><div class="os-working">${a("console")}<b>working</b><i>·</i><span class="os-dim">正在读取 Preview 面板</span></div></div>${stepPill("第 1 / 3 步", "执行计划", "", "")}${composerHTML()}</div>`;
    const list = body.querySelector<HTMLElement>(".os-msgs")!;
    const pill = body.querySelector<HTMLElement>(".os-pill")!;
    composer(body);
    rise(body.firstElementChild as HTMLElement);
    const items = [...list.querySelectorAll<HTMLElement>(".os-todo li")];
    const doing = ["正在接入惯性开关", "正在运行 npm run check", ""];
    for (const [n, item] of items.entries()) {
      await wait(reduced() ? 0 : 1500);
      item.dataset.done = "";
      const note = list.querySelector(".os-working .os-dim");
      if (note) note.textContent = doing[n]!;
      pill.querySelector("b")!.textContent = `第 ${Math.min(n + 2, 3)} / 3 步`;
    }
    const working = list.querySelector<HTMLElement>(".os-working")!;
    working.innerHTML = `${a("check")}已完成`;
    working.dataset.done = "";
    status("已完成");
    pill.dataset.done = "";
    pill.querySelector(".os-files")!.textContent = "2 个文件已更改";
    pill.querySelector(".os-add")!.textContent = "+46";
  }
}

// ---------------- terminal ----------------
const COMMANDS: Record<string, string> = {
  help: '可以试试：<b>npm run check</b>、<b>git status</b>、<b>ls</b>、<b>omp</b>、<b>clear</b>',
  ls: "app   components   docs   lib   package.json",
  omp: "oh-my-pi 的命令行也在这里。装好之后，这就是你本机的 Shell。",
  "git status": 'On branch <b>fix/mermaid-theme</b>\n  <span class="os-err">M</span> components/MermaidBlock.tsx\n  <span class="os-ok">A</span> components/DirectoryPicker.tsx\n  <span class="os-err">D</span> lib/legacyZoom.ts',
  "npm run check": '<span class="os-ok">✓</span> arch constraints\n<span class="os-ok">✓</span> tsc --noEmit       0 errors\n<span class="os-ok">✓</span> core tests         214 / 214',
};

function terminal(body: HTMLElement) {
  const term = body.querySelector<HTMLElement>(".os-term")!;
  const input = term.querySelector("input")!;
  const prompt = input.parentElement!;
  const line = (el: HTMLElement) => term.insertBefore(el, prompt.previousElementSibling);
  // A press anywhere takes the keyboard, unless it is selecting text.
  term.addEventListener("click", () => {
    if (!getSelection()?.toString()) input.focus({ preventScroll: true });
  });
  input.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    const text = input.value.trim();
    input.value = "";
    const echo = make("span", "os-line", '<span class="os-dim">PS D:\\Project\\omp-web&gt;</span> <b></b>\n');
    echo.querySelector("b")!.textContent = text;
    if (text === "clear") {
      for (const node of [...term.childNodes]) if (node !== prompt && node !== prompt.previousElementSibling && !(node === prompt.previousSibling)) node.remove();
      return;
    }
    line(echo);
    if (text) {
      const out = make("span", "os-line");
      const known = COMMANDS[text];
      if (known) {
        line(out);
        for (const row of known.split("\n")) {
          out.insertAdjacentHTML("beforeend", `${row}\n`);
          term.scrollTop = term.scrollHeight;
          if (text === "npm run check" && !reduced()) await wait(340);
        }
      } else {
        out.textContent = `这个演示不认识 ${text}，输入 help 看看能跑什么\n`;
        line(out);
      }
    }
    term.scrollTop = term.scrollHeight;
  });
}

// ---------------- browser ----------------
function browser(body: HTMLElement) {
  const page = body.querySelector<HTMLElement>(".os-page")!;
  const main = page.querySelector<HTMLElement>("main")!;
  const url = body.querySelector<HTMLElement>(".os-url")!.lastChild!;
  const tabs = [...page.querySelectorAll<HTMLElement>("[data-web]")];
  const hands = [...body.querySelectorAll<HTMLElement>("[data-hand]")];
  let agent = true;

  const hand = make("span", "os-agent-hand", '<svg viewBox="0 0 20 20" width="18" height="18"><path d="M3.3 2.4 16.7 8.7 10.8 10.7 8.8 16.6z"/></svg><b>Agent</b>');
  hand.setAttribute("aria-hidden", "true");
  page.append(hand);

  const show = (n: number) => {
    const p = WEB_PAGES[n]!;
    tabs.forEach((t, k) => t.toggleAttribute("data-on", k === n));
    main.innerHTML = `<h4>${p.title}</h4><p>${p.text}</p><div class="os-demo">${p.demo}</div>`;
    url.textContent = `localhost:5173/${n ? p.title.toLowerCase() : ""}`;
    rise(main);
  };
  const take = (who: "agent" | "me") => {
    agent = who === "agent";
    for (const h of hands) {
      const on = h.dataset.hand === who;
      h.toggleAttribute("data-on", on);
      h.setAttribute("aria-pressed", String(on));
    }
    hand.toggleAttribute("data-off", !agent);
  };
  hands.forEach((h) => h.addEventListener("click", () => take(h.dataset.hand as "agent" | "me")));
  page.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    const target = e.target as Element;
    // Reaching into the page takes control back from the Agent, as it does in the app.
    if (agent) take("me");
    const tab = target.closest<HTMLElement>("[data-web]");
    if (tab) return show(Number(tab.dataset.web));
    if (target.closest("[data-toast]")) {
      const note = post(main, make("div", "os-toast", `${i("check")}Saved`));
      setTimeout(() => note.remove(), 2200);
    }
  });

  if (reduced()) return hand.toggleAttribute("data-off", true);
  // While the Agent holds the page it walks through it, at reading pace.
  void (async () => {
    for (let n = 2; ; n = (n + 1) % WEB_PAGES.length) {
      await wait(3600);
      while (!agent || document.hidden || !body.isConnected || body.getBoundingClientRect().bottom < 0) await wait(500);
      const tab = tabs[n]!;
      const o = page.getBoundingClientRect();
      const r = tab.getBoundingClientRect();
      if (!r.width || !o.width) continue;
      hand.style.transform = `translate3d(${r.left - o.left + r.width * 0.55}px, ${r.top - o.top + r.height * 0.45}px, 0)`;
      hand.dataset.on = "";
      await wait(900);
      if (!agent) continue;
      hand.dataset.down = "";
      await wait(130);
      delete hand.dataset.down;
      show(n);
      await wait(500);
      hand.style.transform = `translate3d(${o.width * 0.62}px, ${o.height * 0.66}px, 0)`;
    }
  })();
}

// ---------------- git ----------------
function git(body: HTMLElement) {
  const changes = body.querySelector<HTMLElement>(".os-changes")!;
  const diff = body.querySelector<HTMLElement>(".os-diff")!;
  const field = body.querySelector<HTMLInputElement>("input.os-field")!;
  const ahead = body.querySelector<HTMLElement>(".os-ahead")!;
  const unstaged = body.querySelector<HTMLElement>(".os-git-tabs b")!;
  changes.addEventListener("click", (e) => {
    const row = (e.target as Element).closest<HTMLElement>("[data-diff]");
    if (!row) return;
    changes.querySelectorAll("[data-diff]").forEach((r) => r.toggleAttribute("data-on", r === row));
    diff.innerHTML = diffRows(Number(row.dataset.diff));
    rise(diff);
  });
  const commit = () => {
    const rows = [...changes.querySelectorAll<HTMLElement>("[data-diff]")];
    if (!rows.length) return;
    const message = field.value.trim() || "fix: resolve mermaid theme";
    field.value = "";
    const done = () => {
      const clean = make("p", "os-clean");
      clean.textContent = `已提交「${message}」，工作区是干净的。`;
      changes.replaceChildren(clean);
      diff.hidden = true;
      ahead.textContent = "↑3 ↓0";
      unstaged.textContent = "0";
      rise(clean);
      rise(ahead);
    };
    if (reduced()) return done();
    rows.forEach((row, n) => row.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(28px)" }], { duration: 240, delay: n * 60, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" }));
    setTimeout(done, 240 + rows.length * 60);
  };
  body.querySelector("[data-commit]")!.addEventListener("click", commit);
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) commit();
  });
}

// ---------------- files ----------------
function files(body: HTMLElement) {
  body.addEventListener("click", (e) => {
    const dir = (e.target as Element).closest<HTMLElement>("[data-dir]");
    if (!dir) return;
    const open = dir.getAttribute("aria-expanded") !== "true";
    dir.setAttribute("aria-expanded", String(open));
    (dir.nextElementSibling as HTMLElement).hidden = !open;
    if (open) rise(dir.nextElementSibling as HTMLElement);
  });
}

// ---------------- context ----------------
function context(body: HTMLElement) {
  const button = body.querySelector<HTMLButtonElement>("[data-compact]")!;
  const bars = body.querySelectorAll<HTMLElement>(".os-ctx-bar i");
  const row = body.querySelectorAll(".os-ctx li:first-child .mono");
  button.addEventListener("click", () => {
    if (button.dataset.done !== undefined) return;
    button.dataset.done = "";
    button.textContent = "已压缩";
    bars[0]!.style.setProperty("--v", "1.4%");
    body.querySelector(".os-ctx-h strong")!.firstChild!.textContent = "11";
    body.querySelector(".os-ctx-h b")!.textContent = "111.2k";
    row[0]!.textContent = "14.2k";
    row[1]!.textContent = "1.4%";
    const rest = body.querySelectorAll(".os-ctx li:last-child .mono");
    rest[0]!.textContent = "888.8k";
    rest[1]!.textContent = "88.9%";
  });
}

/** Bring a freshly made surface to life. `status` changes the words beside its window's title. */
export function enliven(body: HTMLElement, kind: Kind, status: (text: string) => void) {
  if (kind === "chat") chat(body);
  else if (kind === "plan") plan(body, status);
  else if (kind === "terminal") terminal(body);
  else if (kind === "browser") browser(body);
  else if (kind === "git") git(body);
  else if (kind === "files") files(body);
  else if (kind === "context") context(body);
}
