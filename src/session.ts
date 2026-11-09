import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";

const AUTH_URL = "https://tonal.auth0.com/oauth/token";
const CLIENT_ID = "ERCyexW-xoVG_Yy3RDe-eV4xsOnRHP6L";
const API_BASE = "https://api.tonal.com/v6";

type TokenSet = { idToken: string; refreshToken: string; expiresAt: number };
type Cached<T> = { value: T; expiresAt: number };

export type Movement = {
  id: string;
  name: string;
  shortName?: string;
  muscleGroups?: string[];
  bodyRegion?: string;
  pushPull?: string;
  family?: string;
  onMachine?: boolean;
  inFreeLift?: boolean;
  skillLevel?: number;
  isGeneric?: boolean;
};

/** Decode JWT exp (ms) without Node Buffer — Workers-safe. */
function jwtExpiresAt(idToken: string, expiresInDeadline: number): number {
  const expiresInUsable = Number.isFinite(expiresInDeadline);
  const fallback = expiresInUsable ? expiresInDeadline : Date.now() + 10 * 60_000;
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return fallback;
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(json) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= 0) return fallback;
    const expDeadline = payload.exp * 1000;
    if (expDeadline > Date.now() + 10 * 365 * 24 * 60 * 60_000) return fallback;
    return expiresInUsable ? Math.min(expDeadline, expiresInDeadline) : expDeadline;
  } catch {
    return fallback;
  }
}

/**
 * Owns Tonal Auth0 tokens (password grant + refresh) and small caches.
 * Tonal APIs expect the Auth0 **id_token** as Bearer, not access_token.
 */
export class TonalSession extends DurableObject<Env> {
  private inflight?: Promise<string>;

  async getIdToken(): Promise<string> {
    const tokens = await this.ctx.storage.get<TokenSet>("tokens");
    if (tokens && tokens.expiresAt - Date.now() > 60_000) return tokens.idToken;
    if (!this.inflight) this.inflight = this.authorize(tokens).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  async invalidate(): Promise<void> {
    await this.ctx.storage.delete("tokens");
  }

  async status(): Promise<{ authorized: boolean; expiresAt: string | null; userId: string | null }> {
    const [tokens, userId] = await Promise.all([
      this.ctx.storage.get<TokenSet>("tokens"),
      this.ctx.storage.get<string>("userId"),
    ]);
    return {
      authorized: !!tokens,
      expiresAt: tokens ? new Date(tokens.expiresAt).toISOString() : null,
      userId: userId ?? null,
    };
  }

  async getUserId(): Promise<string> {
    const cached = await this.ctx.storage.get<string>("userId");
    if (cached) return cached;
    const info = await this.api("/users/userinfo") as { id: string };
    if (!info?.id) throw new Error("Tonal userinfo response was missing id.");
    await this.ctx.storage.put("userId", info.id);
    return info.id;
  }

  async getMovements(): Promise<Movement[]> {
    const cached = await this.ctx.storage.get<Cached<Movement[]>>("movements2");
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await this.api("/movements") as Array<Record<string, unknown>>;
    const slim: Movement[] = (Array.isArray(value) ? value : []).map((m) => ({
      id: String(m.id),
      name: String(m.name ?? ""),
      shortName: typeof m.shortName === "string" ? m.shortName
        : typeof m.short_name === "string" ? String(m.short_name) : undefined,
      muscleGroups: Array.isArray(m.muscleGroups) ? m.muscleGroups.map(String)
        : Array.isArray(m.muscle_groups) ? (m.muscle_groups as unknown[]).map(String) : undefined,
      bodyRegion: typeof m.bodyRegion === "string" ? m.bodyRegion
        : typeof m.body_region === "string" ? String(m.body_region) : undefined,
      pushPull: typeof m.pushPull === "string" ? m.pushPull : undefined,
      family: typeof m.family === "string" ? m.family : undefined,
      onMachine: typeof m.onMachine === "boolean" ? m.onMachine : undefined,
      inFreeLift: typeof m.inFreeLift === "boolean" ? m.inFreeLift : undefined,
      skillLevel: typeof m.skillLevel === "number" ? m.skillLevel : undefined,
      isGeneric: typeof m.isGeneric === "boolean" ? m.isGeneric : undefined,
    }));
    await this.ctx.storage.put("movements2", { value: slim, expiresAt: Date.now() + 24 * 60 * 60_000 });
    return slim;
  }

  async api(path: string, init: RequestInit = {}): Promise<unknown> {
    const request = async (token: string) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
      return fetch(`${API_BASE}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
    };

    let response = await request(await this.getIdToken());
    if (response.status === 401) {
      await this.invalidate();
      response = await request(await this.getIdToken());
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Tonal API ${path} failed: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`);
    }
    if (response.status === 204) return undefined;
    return await response.json();
  }

  private async authorize(tokens?: TokenSet): Promise<string> {
    if (tokens?.refreshToken) {
      try {
        return await this.request({ grant_type: "refresh_token", refresh_token: tokens.refreshToken }, tokens.refreshToken);
      } catch (error) {
        if (!(error instanceof RejectedRefresh)) throw error;
        const stored = await this.ctx.storage.get<TokenSet>("tokens");
        if (stored?.refreshToken === tokens.refreshToken) await this.ctx.storage.delete("tokens");
      }
    }
    return this.request({
      grant_type: "password",
      username: this.env.TONAL_USERNAME,
      password: this.env.TONAL_PASSWORD,
      scope: "offline_access",
    });
  }

  private async request(grant: Record<string, string>, refreshToken?: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(AUTH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ ...grant, client_id: CLIENT_ID }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new Error(`Tonal token request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const message = typeof body?.error_description === "string" ? body.error_description : `HTTP ${response.status}`;
    if (!response.ok) {
      if (refreshToken && response.status >= 400 && response.status < 500) throw new RejectedRefresh(message);
      throw new Error(`Tonal authentication failed: ${message}`);
    }
    if (typeof body?.id_token !== "string") throw new Error("Tonal token response was missing id_token.");
    const stored = await this.ctx.storage.get<TokenSet>("tokens");
    const nextRefresh = typeof body.refresh_token === "string" ? body.refresh_token : refreshToken ?? stored?.refreshToken;
    if (!nextRefresh) throw new Error("Tonal token response was missing refresh_token.");
    const expiresInDeadline = Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000;
    const tokens: TokenSet = {
      idToken: body.id_token,
      refreshToken: nextRefresh,
      expiresAt: jwtExpiresAt(body.id_token, expiresInDeadline),
    };
    await this.ctx.storage.put("tokens", tokens);
    return tokens.idToken;
  }
}

class RejectedRefresh extends Error {}
