import "./styles.css";
import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { BRUSHES, LIMITS, SHAPES, type AgentAction, type BrushName, type BudgetStatus, type ShapeKind, type TurnResponse } from "../shared/protocol.ts";
import { createWall, type WallRenderer } from "./wall/wall.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- the wall comes up first, behind everything ----------

let wall: WallRenderer | null = null;
try {
  wall = createWall($<HTMLCanvasElement>("wall"));
  wall.ready.then(
    () => $("wall").classList.add("ready"),
    // No WebGPU: the CSS wall on <html> is the whole design, still on-style.
    (error: unknown) => console.info("wall renderer unavailable, using the CSS wall:", error),
  );
} catch (error) {
  console.info("wall renderer unavailable:", error);
}

// ---------- auth: passkeys, same ceremony as mythosengine ----------

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(humanError(json.error ?? `HTTP ${res.status}`));
  return json;
}

function humanError(code: string): string {
  const map: Record<string, string> = {
    invalid_token: "That enrollment token isn't right.",
    enrollment_closed: "Enrollment is closed — every passkey slot is taken.",
    enrollment_not_configured: "Enrollment isn't configured on this deployment yet.",
    unknown_credential: "This passkey isn't registered here. Each host enrols its own passkey.",
    invalid_challenge: "The sign-in challenge expired. Try again.",
  };
  return map[code] ?? code;
}

const gateStatus = $("gate-status");
const say = (message: string, error = false) => {
  gateStatus.textContent = message;
  gateStatus.classList.toggle("error", error);
};

$("signin").addEventListener("click", async () => {
  try {
    say("Requesting a challenge…");
    const begin = await postJson<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }>("/auth/passkey/authenticate/begin");
    say("Waiting for your authenticator…");
    const response = await startAuthentication({ optionsJSON: begin.options });
    say("Verifying…");
    await postJson("/auth/passkey/authenticate/finish", { challengeId: begin.challengeId, response });
    say("");
    await enterStudio();
  } catch (cause) {
    say(cause instanceof Error ? cause.message : String(cause), true);
  }
});

$("enrol-toggle").addEventListener("click", () => {
  $("enrol").hidden = false;
  $("signin").hidden = $("enrol-toggle").hidden = true;
  $<HTMLInputElement>("token").focus();
});
$("enrol-cancel").addEventListener("click", () => {
  $("enrol").hidden = true;
  $("signin").hidden = $("enrol-toggle").hidden = false;
});
$("enrol").addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = $<HTMLInputElement>("token").value.trim();
  if (!token) return;
  try {
    say("Requesting registration options…");
    const begin = await postJson<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }>("/auth/passkey/register/begin", { token });
    say("Waiting for your authenticator…");
    const response = await startRegistration({ optionsJSON: begin.options });
    say("Verifying…");
    await postJson("/auth/passkey/register/finish", { challengeId: begin.challengeId, response, label: location.hostname });
    $<HTMLInputElement>("token").value = "";
    $("enrol").hidden = true;
    $("signin").hidden = $("enrol-toggle").hidden = false;
    say("Passkey registered — sign in now.");
  } catch (cause) {
    say(cause instanceof Error ? cause.message : String(cause), true);
  }
});

$("signout").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
  location.reload();
});

// ---------- the studio ----------

const BRUSH_KEYS: Record<BrushName, string> = { draw: "X", clay: "C", inflate: "I", smooth: "S", flatten: "T", pinch: "P", crease: "E", grab: "G" };

async function enterStudio() {
  const [{ Studio }, { AgentLoop }] = await Promise.all([import("./sculpt/studio.ts"), import("./agent/loop.ts")]);
  $("gate").hidden = true;
  $("studio").hidden = false;
  $("session-rail").hidden = false;
  const viewport = $<HTMLCanvasElement>("viewport");
  viewport.hidden = false;

  const studio = new Studio(viewport);
  studio.onFrame = ({ center, radius }) => wall?.setObject({ objectCenter: center, objectRadius: radius });
  studio.onGesture = (name) => showToast(name);
  // First touch on the canvas: say what the fingers do, once.
  viewport.addEventListener(
    "pointerdown",
    (e) => e.pointerType === "touch" && showToast("Touch: 1 finger sculpts on the clay / orbits off it · 2 fingers zoom & pan · 2-finger tap undo · 3-finger tap redo"),
    { once: true, capture: true }, // capture: the studio stops touch events from reaching later listeners
  );
  // Safari's own pinch-to-zoom must not fire over the canvas.
  for (const type of ["gesturestart", "gesturechange"]) viewport.addEventListener(type, (e) => e.preventDefault());

  // Brushes
  const brushRail = $("brushes");
  const selectBrush = (brush: BrushName) => {
    studio.settings.brush = brush;
    for (const b of brushRail.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.brush === brush));
  };
  for (const brush of BRUSHES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "clicky";
    button.dataset.brush = brush;
    button.innerHTML = `<span>${brush[0].toUpperCase()}${brush.slice(1)}</span><kbd>${BRUSH_KEYS[brush]}</kbd>`;
    button.addEventListener("click", () => selectBrush(brush));
    brushRail.append(button);
  }
  selectBrush("draw");

  const radius = $<HTMLInputElement>("radius"), strength = $<HTMLInputElement>("strength");
  const syncSliders = () => {
    studio.settings.radius = Number(radius.value);
    studio.settings.strength = Number(strength.value);
    $("radius-out").textContent = Number(radius.value).toFixed(2);
    $("strength-out").textContent = Number(strength.value).toFixed(2);
  };
  radius.addEventListener("input", syncSliders);
  strength.addEventListener("input", syncSliders);
  // Touchscreen Macs turn a finger drag into scrolling, which a range input ignores — so a
  // swipe (or trackpad scroll, or wheel) over a slider moves it: right/up = more.
  for (const slider of [radius, strength]) {
    slider.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const min = Number(slider.min), max = Number(slider.max);
        const unit = e.deltaMode === 1 ? 16 : 1;
        const delta = (-e.deltaX + e.deltaY) * unit;
        slider.value = String(Math.min(max, Math.max(min, Number(slider.value) + (delta * (max - min)) / 300)));
        syncSliders();
      },
      { passive: false },
    );
  }
  $<HTMLInputElement>("swipe-sculpts").addEventListener("change", (e) => (studio.settings.swipeSculpts = (e.target as HTMLInputElement).checked));
  $<HTMLInputElement>("symmetry").addEventListener("change", (e) => (studio.settings.symmetry = (e.target as HTMLInputElement).checked));

  const undo = $<HTMLButtonElement>("undo"), redo = $<HTMLButtonElement>("redo");
  studio.onHistory = (canUndo, canRedo) => {
    undo.disabled = !canUndo;
    redo.disabled = !canRedo;
  };
  undo.addEventListener("click", () => studio.undoStep());
  redo.addEventListener("click", () => studio.redoStep());
  $("reset").addEventListener("click", () => studio.resetCube());

  // Shapes: pick one, then click the clay where it should grow (or be carved).
  let shapeMode: "add" | "subtract" = "add";
  const setShapeMode = (mode: "add" | "subtract") => {
    shapeMode = mode;
    $("shape-add").setAttribute("aria-pressed", String(mode === "add"));
    $("shape-carve").setAttribute("aria-pressed", String(mode === "subtract"));
  };
  $("shape-add").addEventListener("click", () => setShapeMode("add"));
  $("shape-carve").addEventListener("click", () => setShapeMode("subtract"));
  const shapeRail = $("shapes");
  for (const shape of SHAPES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "clicky";
    button.textContent = shape[0].toUpperCase() + shape.slice(1);
    button.addEventListener("click", () => {
      for (const b of shapeRail.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === button));
      showToast(`Click the clay to ${shapeMode === "add" ? "add" : "carve"} a ${shape} (size follows Radius).`);
      studio.armShape(shape as ShapeKind, shapeMode, (ms) => {
        button.setAttribute("aria-pressed", "false");
        showToast(`${shapeMode === "add" ? "Added" : "Carved"} a ${shape} — remeshed in ${ms} ms.`);
      });
    });
    shapeRail.append(button);
  }
  $("remesh").addEventListener("click", () => {
    showToast("Remeshing…");
    requestAnimationFrame(() => setTimeout(() => showToast(`Remeshed in ${studio.remeshWith([])} ms.`), 0));
  });

  window.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "z") {
      e.preventDefault();
      if (e.shiftKey) studio.redoStep();
      else studio.undoStep();
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    const brush = (Object.keys(BRUSH_KEYS) as BrushName[]).find((b) => BRUSH_KEYS[b].toLowerCase() === key);
    if (brush) selectBrush(brush);
    if (key === "[" || key === "]") {
      radius.value = String(Math.min(0.7, Math.max(0.03, Number(radius.value) * (key === "]" ? 1.15 : 1 / 1.15))));
      syncSliders();
    }
  });

  // Export: generated in the browser and handed straight to the user. Nothing is uploaded.
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-export]")) {
    button.addEventListener("click", async () => {
      const format = button.dataset.export as "glb" | "obj" | "stl";
      const blob = await studio.export(format);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `prometheus-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5_000);
    });
  }
  window.addEventListener("beforeunload", (e) => {
    if (studio.mesh.positions.some((v, i) => Math.abs(v - studio.mesh.rest[i]) > 1e-3)) e.preventDefault();
  });

  // Agent
  const chat = $("chat");
  const post = (kind: "human" | "agent" | "system" | "error", text: string) => {
    const li = document.createElement("li");
    li.className = kind;
    li.textContent = text;
    chat.append(li);
    while (chat.children.length > 60) chat.firstElementChild?.remove();
    chat.scrollTop = chat.scrollHeight;
  };
  const pip = $("pip"), state = $("agent-state");
  const setState = (kind: "idle" | "thinking" | "sculpting" | "off") => {
    pip.className = `pip ${kind === "idle" ? "live" : kind === "off" ? "" : kind}`;
    state.textContent = { idle: "Agent watching", thinking: "Agent looking…", sculpting: "Agent sculpting", off: "Agent off" }[kind];
    wall?.setEmber(kind === "sculpting" ? 1 : kind === "thinking" ? 0.5 : 0);
  };
  const frames: string[] = [];
  const toast = $("toast");
  let toastTimer = 0;
  const showToast = (text: string, error = false) => {
    toast.textContent = text;
    toast.classList.toggle("error", error);
    toast.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("on"), 5000);
  };

  const loop = new AgentLoop(studio, {
    onThinking: (thinking) => setState(thinking ? "thinking" : loop.mode === "off" ? "off" : "idle"),
    onSculpting: (active) => setState(active ? "sculpting" : "idle"),
    onError: (message) => {
      post("error", message);
      showToast(message, true);
    },
    onBudget: renderBudget,
    onTurn: (response: TurnResponse, frameUrl: string) => {
      if (response.say) post("agent", response.say);
      if (response.intent) $("intent").textContent = `${response.intent.summary} (${Math.round(response.intent.confidence * 100)}%)`;
      if (response.plan?.length) $("plan").textContent = response.plan.join(" → ");
      if (response.target) $("target").textContent = response.target;
      if (response.assessment) $("assessment").textContent = response.assessment;
      const ms = response.milestones ?? [];
      $("milestones").hidden = ms.length === 0;
      $("milestones").replaceChildren(...ms.map((m) => Object.assign(document.createElement("li"), { textContent: m.text, className: m.done ? "done" : "" })));
      if (response.done) post("system", "Prometheus considers this finished. Sculpt or send a message and it picks up again.");
      if (response.actions.length) post("system", `${response.actions.length} action${response.actions.length > 1 ? "s" : ""}: ${response.actions.map(describeAction).join(", ")}`);
      frames.push(frameUrl);
      // Mirror the server's window for this mode (lead keeps more frames).
      while (frames.length > LIMITS.recentFramesByMode[loop.mode === "off" ? "follow" : loop.mode]) frames.shift();
      $("frames").replaceChildren(...frames.map((src) => Object.assign(document.createElement("img"), { src, alt: "Recent frame the agent remembers" })));
    },
  });
  loop.start();
  setState("idle");

  for (const button of $("modes").querySelectorAll<HTMLButtonElement>("button")) {
    button.addEventListener("click", () => {
      loop.mode = button.dataset.mode as typeof loop.mode;
      for (const b of $("modes").querySelectorAll("button")) b.setAttribute("aria-checked", String(b === button));
      setState(loop.mode === "off" ? "off" : "idle");
    });
  }

  $("ask").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $<HTMLInputElement>("message");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    post("human", text);
    await loop.ask(text);
  });

  post("system", "Drag on the clay to sculpt. The agent watches your strokes and joins in — tell it what you're making.");
}

function describeAction(a: AgentAction): string {
  if (a.why) return a.why;
  switch (a.kind) {
    case "stroke": return a.brush;
    case "form": return a.op;
    case "global": return `${a.op} all`;
    case "shape": return `${a.mode} ${a.shape}`;
    case "remesh": return "remesh";
  }
}

function renderBudget(b: BudgetStatus) {
  const el = $("budget");
  el.textContent = `${b.usedLastMinute}/${b.rpmTarget} rpm · ${b.usedToday}/${b.rpdLimit} today`;
  el.title = `${b.model} · paced at ${b.rpmTarget} of ${b.rpmLimit} rpm (one call every ${Math.round(60 / b.rpmTarget)}s) · ${Math.round(b.tokensLastMinute / 1000)}K of ${b.tpmLimit / 1000}K tpm · ${b.reserve} requests/day reserved for when you ask · resets ${new Date(b.resetsAt).toLocaleTimeString()}`;
}

// ---------- input diagnostics (?debug=input) ----------
// Shows exactly what the browser receives from fingers, trackpad and mouse —
// the quickest way to see how a new device translates touch.
if (new URLSearchParams(location.search).get("debug") === "input") {
  const panel = document.createElement("pre");
  panel.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:99;margin:0;padding:8px 10px;max-width:46ch;font:11px/1.4 ui-monospace,monospace;background:rgb(255 255 255/.85);border-radius:10px;pointer-events:none;white-space:pre-wrap";
  document.body.append(panel);
  const lines: string[] = [];
  const log = (text: string) => {
    lines.push(text);
    while (lines.length > 14) lines.shift();
    panel.textContent = `maxTouchPoints=${navigator.maxTouchPoints} coarse=${matchMedia("(any-pointer: coarse)").matches} touchEvents=${"ontouchstart" in window}\n` + lines.join("\n");
  };
  let lastMove = 0;
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const) {
    window.addEventListener(type, (e) => {
      if (type === "pointermove" && performance.now() - lastMove < 120) return;
      if (type === "pointermove") lastMove = performance.now();
      log(`${type} ${e.pointerType} id=${e.pointerId} btn=${e.buttons} (${Math.round(e.clientX)},${Math.round(e.clientY)})`);
    }, { capture: true });
  }
  window.addEventListener("wheel", (e) => log(`wheel dx=${e.deltaX.toFixed(1)} dy=${e.deltaY.toFixed(1)} mode=${e.deltaMode} ctrl=${e.ctrlKey}`), { capture: true, passive: true });
  for (const type of ["touchstart", "touchmove", "touchend", "gesturestart", "click"]) window.addEventListener(type, () => log(type), { capture: true, passive: true });
  log("ready — touch, swipe and pinch to see events");
}

// ---------- boot ----------

(async () => {
  try {
    const status = await fetch("/auth/status", { credentials: "same-origin" }).then((r) => r.json() as Promise<{ signedIn: boolean; enrollmentOpen: boolean; credentialCount: number }>);
    if (status.signedIn) return void (await enterStudio());
    if (!status.enrollmentOpen) $("enrol-toggle").hidden = true;
    if (status.credentialCount === 0) say("No passkey is enrolled here yet — enrol one with the token.");
  } catch {
    say("The studio API is not reachable.", true);
  }
})();
