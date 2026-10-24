import type { RomeAppApiHandler, RomeAppApiRequest, RomeAppContext } from "@rome-os/app-runtime";
import { createProgressRepository } from "../db/repositories/progress.js";
import { welcomeLocaleFromCode, type WelcomeLocale } from "../locale.js";

function requestLocale(request: RomeAppApiRequest): WelcomeLocale | undefined {
  if (!request.body || request.body.byteLength === 0) return undefined;
  try {
    const body = JSON.parse(new TextDecoder().decode(request.body));
    if (!body || typeof body !== "object" || !("locale" in body)) return undefined;
    return welcomeLocaleFromCode((body as { locale?: unknown }).locale);
  } catch {
    return undefined;
  }
}

/**
 * welcome-to-rome app API, called by the landing screen (src/web/App.tsx).
 *
 * - `GET /` returns the agent name and where the welcome run stands, so the
 *   landing screen can offer to continue a run instead of starting a new one.
 * - `POST /reset` clears the run before the landing screen opens a new chat.
 *   When supplied, the locale is persisted as the guardian's language before
 *   the chat starts. No memory or transcript is touched.
 */
class WelcomeApiHandler implements RomeAppApiHandler {
  constructor(private readonly ctx: RomeAppContext) {}

  async handle(request: RomeAppApiRequest): Promise<Response> {
    const route = request.path.join("/");

    if (request.method === "GET" && request.path.length === 0) {
      const { node, aiConnected, completedAt, sessionId } = createProgressRepository(
        this.ctx.db,
      ).get();
      return Response.json({
        appId: this.ctx.app.id,
        version: this.ctx.app.version,
        agentName: await this.getAgentName(),
        progress: { node, aiConnected, completedAt, sessionId },
        status: "ok",
      });
    }

    if (request.method === "POST" && route === "reset") {
      const locale = requestLocale(request);
      if (locale) await this.ctx.repositories.settings.set("guardianLanguage", locale);
      createProgressRepository(this.ctx.db).reset();
      return Response.json({ ok: true });
    }

    return Response.json(
      {
        error: "not_found",
        appId: this.ctx.app.id,
        message: `Unknown welcome-to-rome API route: /${route}`,
      },
      { status: 404 },
    );
  }

  private async getAgentName(): Promise<string> {
    try {
      const value = await this.ctx.repositories.settings.get<string>("agentName");
      return (typeof value === "string" && value.trim()) || "Rome";
    } catch {
      return "Rome";
    }
  }
}

export function createApiHandler(ctx: RomeAppContext): RomeAppApiHandler {
  return new WelcomeApiHandler(ctx);
}
