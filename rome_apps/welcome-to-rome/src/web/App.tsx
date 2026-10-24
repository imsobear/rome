import "./styles.css";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Circle, CircleDot, Minus } from "lucide-react";
import { fetchAppApi, navigateRome, startChat, type RomeAppBootstrap } from "@rome-os/app-web-sdk";
import { Button } from "@rome-os/ui/button";
import { cn } from "@/lib/utils";
import { fireBurst, fireWelcome } from "@/lib/confetti";
import { getWelcomeCopy, type WelcomeStep } from "@/lib/copy";

// Side-effect imports: each module's top-level `defineComponent(...)` registers
// an inline chat component into the SDK registry at bundle load, so the host can
// mount them when the welcome-to-rome turn-middleware renders them in the
// transcript during the conversation this screen kicks off.
import "@/name-card";
import "@/idea-picker";
import "@/scout-suggestions";

// The animated Rome brand mark. Resolved relative to this module so it works
// from the app's asset base at runtime; Rslib emits it to
// `dist/web/static/media/rome-logo-2.mp4`, and it's tracked via Git LFS
// (.gitattributes `*.mp4`).
const ROME_LOGO_VIDEO = new URL("./assets/rome-logo-2.mp4", import.meta.url).href;
const FALLBACK_AGENT_NAME = "Rome";
// The host qualifies the agent name with the app id when it creates the chat.
const WELCOME_AGENT_NAMES = new Set(["welcome-to-rome:welcome-to-rome", "welcome-to-rome"]);

const STEPS: readonly WelcomeStep[] = ["names", "ai", "question", "ideas"];

// How far each state-machine cursor (db/repositories/progress.ts) has got
// through STEPS. `done` is past the last one. The briefing-scout offer is part
// of the last step, since it comes right before the first-app ideas.
const STEP_INDEX_BY_NODE: Record<string, number> = {
  await_names: 0,
  await_ai: 1,
  await_question: 2,
  await_scouts: 3,
  await_idea: 3,
  done: STEPS.length,
};

interface WelcomeProgress {
  node: string;
  aiConnected: boolean | null;
  sessionId: string | null;
}

/** What the landing screen shows: a first run, a run to pick up, or a finished one. */
type Landing =
  | { kind: "fresh" }
  | { kind: "resume"; stepIndex: number; chatId: string | null; aiConnected: boolean | null }
  | { kind: "done"; chatId: string | null; aiConnected: boolean | null };

// The agent's opening line — written to read like a person saying hello, not a
// product tagline. The active locale supplies it via `copy.landing.greeting`;
// it is typed out word by word below.
// Typewriter pacing — deliberately gentle (a greeting, not a loading bar); a
// longer beat trails sentence-ending punctuation for a natural cadence. Mirrors
// the in-chat typeOut feel (hooks/turn-middleware/index.ts).
const TYPE_START_MS = 650;
const TYPE_WORD_MS = 46;
const TYPE_SENTENCE_PAUSE_MS = 260;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
  );
}

/** Reveal `text` token by token. Under reduced motion it appears at once. */
function useTypewriter(text: string): { shown: string; done: boolean } {
  const [shown, setShown] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    setShown("");
    setDone(false);
    if (!text) return;
    if (prefersReducedMotion()) {
      setShown(text);
      setDone(true);
      return;
    }
    // "word + its trailing whitespace" tokens; concatenated they reproduce text.
    const tokens = text.match(/\S+\s*/g) ?? [text];
    let i = 0;
    let acc = "";
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (i >= tokens.length) {
        setDone(true);
        return;
      }
      const token = tokens[i];
      acc += token;
      i += 1;
      setShown(acc);
      const pause = /[.!?:…\n]\s*$/.test(token) ? TYPE_SENTENCE_PAUSE_MS : TYPE_WORD_MS;
      timer = setTimeout(tick, pause);
    };
    timer = setTimeout(tick, TYPE_START_MS);
    return () => clearTimeout(timer);
  }, [text]);

  return { shown, done };
}

function readAgentName(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : FALLBACK_AGENT_NAME;
}

function readProgress(value: unknown): WelcomeProgress | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.node !== "string") return null;
  return {
    node: v.node,
    aiConnected: typeof v.aiConnected === "boolean" ? v.aiConnected : null,
    sessionId: typeof v.sessionId === "string" && v.sessionId ? v.sessionId : null,
  };
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

/**
 * Find the chat the welcome run lives in, or null when it is gone. A run that
 * started before the progress row recorded its chat has no id, so it falls back
 * to the newest welcome chat: every start from this screen resets the run, so
 * the newest one is the run's own.
 */
async function findWelcomeChat(sessionId: string | null): Promise<string | null> {
  if (sessionId) {
    const session = await getJson(`/api/chat/sessions/${encodeURIComponent(sessionId)}`);
    return session ? sessionId : null;
  }
  const sessions = await getJson("/api/chat/sessions");
  if (!Array.isArray(sessions)) return null;
  const newest = sessions
    .filter(
      (s): s is { id: string; agentName: string; createdAt: string } =>
        !!s &&
        typeof s.id === "string" &&
        typeof s.agentName === "string" &&
        WELCOME_AGENT_NAMES.has(s.agentName) &&
        typeof s.createdAt === "string",
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return newest?.id ?? null;
}

async function loadLanding(progress: WelcomeProgress | null): Promise<Landing> {
  const stepIndex = progress ? STEP_INDEX_BY_NODE[progress.node] : undefined;
  if (!progress || stepIndex === undefined) return { kind: "fresh" };
  const chatId = await findWelcomeChat(progress.sessionId).catch(() => null);
  if (stepIndex >= STEPS.length) {
    return { kind: "done", chatId, aiConnected: progress.aiConnected };
  }
  return { kind: "resume", stepIndex, chatId, aiConnected: progress.aiConnected };
}

type Copy = ReturnType<typeof getWelcomeCopy>;

function greetingFor(landing: Landing, agentName: string, copy: Copy): string {
  switch (landing.kind) {
    case "fresh":
      return copy.landing.greeting(agentName);
    case "resume":
      return landing.chatId
        ? copy.landing.resumeGreeting(copy.landing.steps[STEPS[landing.stepIndex]])
        : copy.landing.resumeGreetingNoChat;
    case "done":
      return copy.landing.doneGreeting;
  }
}

/** The four setup steps, each marked done, current, still to come, or skipped. */
function StepList({
  stepIndex,
  aiConnected,
  copy,
}: {
  stepIndex: number;
  aiConnected: boolean | null;
  copy: Copy;
}) {
  return (
    <ol className="flex w-full max-w-xs flex-col gap-2 text-left text-sm">
      {STEPS.map((step, i) => {
        const past = i < stepIndex;
        const current = i === stepIndex;
        const skipped = past && step === "ai" && aiConnected === false;
        const Icon = skipped ? Minus : past ? Check : current ? CircleDot : Circle;
        return (
          <li
            key={step}
            className={cn(
              "flex items-center gap-2.5",
              current ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            <Icon
              aria-hidden
              className={cn("size-4 shrink-0", past && !skipped && "text-primary")}
            />
            <span className="flex-1">{copy.landing.steps[step]}</span>
            {skipped ? <span className="text-xs">{copy.landing.stepSkipped}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

export default function App({ bootstrap }: { bootstrap: RomeAppBootstrap }) {
  const copy = getWelcomeCopy(bootstrap.shell.locale);
  const [screen, setScreen] = useState<{ agentName: string; landing: Landing } | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { shown, done } = useTypewriter(
    screen ? greetingFor(screen.landing, screen.agentName, copy) : "",
  );

  useEffect(() => {
    let cancelled = false;
    void fetchAppApi("")
      .then(async (res) => {
        if (!res.ok) return {};
        return (await res.json().catch(() => ({}))) as { agentName?: unknown; progress?: unknown };
      })
      .catch(() => ({}) as { agentName?: unknown; progress?: unknown })
      .then(async (data) => {
        const landing = await loadLanding(readProgress(data.progress));
        if (!cancelled) setScreen({ agentName: readAgentName(data.agentName), landing });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fire the welcome burst on a first run — the guardian's first moment in
  // Rome. A guardian coming back to a run already had it. Honours
  // prefers-reduced-motion internally.
  const landingKind = screen?.landing.kind;
  useEffect(() => {
    if (landingKind !== "fresh") return;
    const t = setTimeout(() => void fireWelcome(), 450);
    return () => clearTimeout(t);
  }, [landingKind]);

  // Under reduced-motion, hold the brand mark on its first frame instead of
  // looping it.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (prefersReducedMotion()) {
      v.pause();
      v.currentTime = 0;
    }
  }, []);

  // Start a new welcome run in a new chat. The kickoff message becomes the
  // guardian's first chat turn. The turn-middleware state machine ignores its
  // text and greets (script.ts `greet` node), but it still shows in the
  // transcript — so it reads like something the guardian said.
  async function handleStart() {
    if (starting) return;
    setStarting(true);
    setError(null);

    // A focused burst from the button before we hand off to the chat. The
    // confetti canvas lives on document.body, so it lingers as the soft
    // navigation swaps this screen for the chat.
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      void fireBurst({
        x: (rect.left + rect.width / 2) / window.innerWidth,
        y: (rect.top + rect.height / 2) / window.innerHeight,
      });
    }

    try {
      // Reset the welcome progress so the new chat replays from a clean slate.
      // This full-mode page is outside RomeShellLayout, so include its
      // bootstrap locale for the server-side middleware before opening the
      // chat. A reset failure shouldn't block the chat, so this remains
      // best-effort.
      await fetchAppApi("reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: bootstrap.shell.locale }),
      }).catch(() => {});
      // startChat creates the session with the welcome-to-rome agent, posts the
      // kickoff turn, and soft-navigates to /chat/<id> — where the conversational
      // onboarding takes over.
      await startChat({ message: copy.landing.kickoff, agentName: "welcome-to-rome" });
    } catch {
      setError(copy.landing.openError);
      setStarting(false);
    }
  }

  function openChat(sessionId: string) {
    navigateRome({ path: "chat", sessionId });
  }

  const landing = screen?.landing ?? { kind: "fresh" };
  const chatId = landing.kind === "fresh" ? null : landing.chatId;
  const startLabel = starting ? copy.landing.opening : copy.landing.start;
  const restartLabel = starting ? copy.landing.opening : copy.landing.restart;

  return (
    <div className="relative flex min-h-dvh w-full flex-col items-center justify-center overflow-hidden p-8 text-center">
      {/* Rome's avatar: the animated brand video, floating over a soft glow. */}
      <div className="relative mb-6">
        <div
          aria-hidden
          className="wtr-glow absolute inset-0 -z-10 rounded-16 bg-primary/30 blur-2xl"
        />
        <div className="wtr-float">
          <video
            ref={videoRef}
            src={ROME_LOGO_VIDEO}
            className="wtr-pop size-24 rounded-16 bg-card object-cover shadow-10"
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            aria-hidden
          />
        </div>
      </div>

      {/* The agent speaking — typed out like a real hello. The min-height reserves the
          two-line block so the button below doesn't jump as text streams in. */}
      <p className="min-h-[5.5rem] max-w-md text-pretty text-lg font-medium leading-relaxed text-foreground sm:text-xl">
        {shown}
        {!done ? (
          <span
            aria-hidden
            className="wtr-caret ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[0.15em] bg-primary"
          />
        ) : null}
      </p>

      {/* Where the run stands and what to do next only appear once the agent
          has finished speaking — fading and rising in rather than popping. */}
      <div
        className={cn(
          "mt-7 flex flex-col items-center gap-6 transition-all duration-500 ease-out",
          done ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0",
        )}
      >
        {landing.kind === "resume" ? (
          <StepList stepIndex={landing.stepIndex} aiConnected={landing.aiConnected} copy={copy} />
        ) : landing.kind === "done" ? (
          <StepList stepIndex={STEPS.length} aiConnected={landing.aiConnected} copy={copy} />
        ) : null}

        <div className="flex flex-col items-center gap-3">
          {landing.kind === "fresh" || (landing.kind === "resume" && !chatId) ? (
            <Button
              ref={buttonRef}
              size="md"
              onClick={handleStart}
              disabled={starting || !done}
              className={cn("group", starting && "opacity-80")}
            >
              {landing.kind === "fresh" ? startLabel : restartLabel}
              <ArrowRight
                data-icon="inline-end"
                className="transition-transform group-hover:translate-x-0.5"
              />
            </Button>
          ) : landing.kind === "resume" && chatId ? (
            <Button
              size="md"
              onClick={() => openChat(chatId)}
              disabled={starting || !done}
              className="group"
            >
              {copy.landing.resume}
              <ArrowRight
                data-icon="inline-end"
                className="transition-transform group-hover:translate-x-0.5"
              />
            </Button>
          ) : (
            <Button
              size="md"
              onClick={() => navigateRome({ path: "chat/new" })}
              disabled={starting || !done}
              className="group"
            >
              {copy.landing.newChat}
              <ArrowRight
                data-icon="inline-end"
                className="transition-transform group-hover:translate-x-0.5"
              />
            </Button>
          )}

          {landing.kind === "done" && chatId ? (
            <Button
              variant="outline"
              size="md"
              onClick={() => openChat(chatId)}
              disabled={starting || !done}
            >
              {copy.landing.openWelcomeChat}
            </Button>
          ) : null}

          {(landing.kind === "resume" && chatId) || landing.kind === "done" ? (
            <Button
              ref={buttonRef}
              variant="ghost"
              size="sm"
              onClick={handleStart}
              disabled={starting || !done}
            >
              {restartLabel}
            </Button>
          ) : null}

          {error ? <span className="text-xs text-destructive">{error}</span> : null}
        </div>
      </div>
    </div>
  );
}
