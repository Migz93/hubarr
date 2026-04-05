import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import type {
  HealthResponse,
  PlexConfigPayload,
  PlexConnectionOption,
  SettingsResponse,
  SessionUser,
  SetupStatusResponse
} from "../shared/types.js";
import { createSessionId } from "./auth.js";
import type { RuntimeConfig } from "./config.js";
import { HubarrDatabase } from "./db/index.js";
import { PlexIntegration } from "./integrations/plex.js";
import { JobScheduler } from "./job-scheduler.js";
import { Logger } from "./logger.js";
import { HubarrServices } from "./services.js";
import { APP_VERSION } from "./version.js";

declare module "express-serve-static-core" {
  interface Request {
    sessionUser?: SessionUser | null;
  }
}

function parseCookies(rawCookie = "") {
  return rawCookie
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Map<string, string>>((acc, pair) => {
      const index = pair.indexOf("=");
      if (index === -1) return acc;
      acc.set(pair.slice(0, index), decodeURIComponent(pair.slice(index + 1)));
      return acc;
    }, new Map());
}

function signedValue(secret: string, value: string) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

const PLEX_LIBRARY_IMAGE_PATH = /^\/library\/metadata\/([A-Za-z0-9:-]+)\/(thumb|art|clearLogo|squareArt|theme)(?:\/(\d+))?$/;
const PLEX_RESOURCE_IMAGE_PATH = /^\/:\/resources\/([A-Za-z0-9._-]+)$/;
const ALLOWED_PLEX_IMAGE_QUERY_PARAMS = new Set(["width", "height", "minSize", "upscale", "format"]);

// Matches private/loopback addresses in both bare and bracket-wrapped forms.
// Node's WHATWG URL parser returns IPv6 hostnames with brackets, e.g. [::1].
// Covers: IPv4 private ranges, IPv4 link-local, IPv6 loopback, IPv4-mapped IPv6
// (::ffff:... normalized by URL parser to [::ffff:7f00:1] etc.), IPv6 ULA
// (fc00::/7 = fc and fd prefixes), IPv6 link-local (fe80::/10).
const PRIVATE_IP_RE =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1$|\[::1\]|::ffff:|\[::ffff:|f[cd][0-9a-f]{2}:|\[f[cd][0-9a-f]{2}|fe80:|\[fe80:|localhost)/i;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_TIMEOUT_MS = 10_000;
const AVATAR_MAX_REDIRECTS = 3;

// Validates and sanitizes an avatar URL (or a redirect location resolved against
// a base URL). Returns url.href reconstructed from the parsed URL object —
// never the raw input string — so that static analysis sees a clean value
// rather than a tainted user-supplied string flowing into fetch().
function sanitizeAvatarUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    PRIVATE_IP_RE.test(url.hostname)
  ) {
    return null;
  }
  return url.href;
}

function sanitizePlexImageQuery(search: string) {
  const parsed = new URLSearchParams(search);
  const sanitized = new URLSearchParams();

  for (const [key, value] of parsed) {
    if (key.toLowerCase() === "x-plex-token") {
      continue;
    }
    if (!ALLOWED_PLEX_IMAGE_QUERY_PARAMS.has(key)) {
      throw new Error(`Unsupported Plex image query parameter: ${key}`);
    }
    if (key === "format") {
      if (!/^[a-z0-9-]+$/i.test(value)) {
        throw new Error("Invalid Plex image format parameter.");
      }
      sanitized.set(key, value.toLowerCase());
      continue;
    }
    if (!/^\d{1,4}$/.test(value)) {
      throw new Error(`Invalid Plex image query parameter value for ${key}.`);
    }
    sanitized.set(key, value);
  }

  return sanitized;
}

function buildTrustedPlexImageRequest(serverUrl: string, rawPath: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawPath) || rawPath.startsWith("//")) {
    throw new Error("Absolute Plex image URLs are not allowed.");
  }

  const [pathname, search = ""] = rawPath.split("?", 2);
  if (!pathname.startsWith("/")) {
    throw new Error("Plex image path must start with '/'.");
  }

  const serverOrigin = new URL(serverUrl).origin;
  const upstream = new URL(serverOrigin);
  const libraryMatch = pathname.match(PLEX_LIBRARY_IMAGE_PATH);
  const resourceMatch = pathname.match(PLEX_RESOURCE_IMAGE_PATH);

  if (libraryMatch) {
    const [, ratingKey, assetKind, version] = libraryMatch;
    upstream.pathname = version
      ? `/library/metadata/${ratingKey}/${assetKind}/${version}`
      : `/library/metadata/${ratingKey}/${assetKind}`;
  } else if (resourceMatch) {
    upstream.pathname = `/:/resources/${resourceMatch[1]}`;
  } else {
    throw new Error("Unsupported Plex image path.");
  }

  upstream.search = sanitizePlexImageQuery(search).toString();
  return upstream.toString();
}

export function createApp(config: RuntimeConfig, scheduler?: JobScheduler) {
  const logger = new Logger(config.dataDir);
  const db = new HubarrDatabase(config);
  const services = new HubarrServices(db, logger);
  const app = express();
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "connect-src": ["'self'", "https://plex.tv", "https://api.github.com"],
        // Disable upgrade-insecure-requests: this app runs over plain HTTP in
        // the default Docker setup, so this directive would cause browsers to
        // rewrite HTTP sub-requests to HTTPS and break the UI. Must be set to
        // null (not deleted) so Helmet's useDefaults logic doesn't re-add it.
        "upgrade-insecure-requests": null
      }
    },
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    // Disable HSTS: not appropriate for a plain-HTTP self-hosted deployment.
    hsts: false
  }));
  const clientDir = path.resolve(process.cwd(), "dist/client");
  const logsRateLimiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false
  });
  const staticRateLimiter = rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: "draft-8",
    legacyHeaders: false
  });

  app.use(express.json());

  // Session middleware
  app.use((req, _res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies.get(config.sessionCookieName);
    if (!raw) {
      req.sessionUser = null;
      return next();
    }
    const [sessionId, signature] = raw.split(".");
    if (!sessionId || !signature || signedValue(config.sessionSecret, sessionId) !== signature) {
      req.sessionUser = null;
      return next();
    }
    req.sessionUser = db.getSession(sessionId);
    next();
  });

  function requireAuth(req: Request, res: Response, next: NextFunction) {
    if (!req.sessionUser) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    next();
  }

  function setSessionCookie(res: Response, sessionId: string) {
    const signed = `${sessionId}.${signedValue(config.sessionSecret, sessionId)}`;
    res.setHeader(
      "Set-Cookie",
      `${config.sessionCookieName}=${encodeURIComponent(signed)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`
    );
  }

  function clearSessionCookie(res: Response) {
    res.setHeader(
      "Set-Cookie",
      `${config.sessionCookieName}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
    );
  }

  function buildPlexInputFromPayload(ownerToken: string, payload: PlexConfigPayload) {
    if (payload.mode === "preset") {
      if (!payload.serverUrl || !payload.machineIdentifier) {
        throw new Error("serverUrl and machineIdentifier are required for preset configuration.");
      }
      return {
        serverUrl: payload.serverUrl,
        token: ownerToken,
        machineIdentifier: payload.machineIdentifier,
        movieLibraryId: "",
        showLibraryId: ""
      };
    }

    const hostname = typeof payload.hostname === "string" ? payload.hostname.trim() : undefined;
    const port = payload.port;
    const useSsl = Boolean(payload.useSsl);

    if (!hostname || !port) {
      throw new Error("hostname and port are required for manual configuration.");
    }

    return {
      serverUrl: `${useSsl ? "https" : "http"}://${hostname}:${port}`,
      token: ownerToken,
      machineIdentifier: payload.machineIdentifier ?? "",
      movieLibraryId: "",
      showLibraryId: ""
    };
  }

  async function validateAndSavePlexConfiguration(payload: PlexConfigPayload) {
    const owner = db.getPlexOwner();
    if (!owner) {
      throw new Error("No Plex owner configured.");
    }

    const baseInput = buildPlexInputFromPayload(owner.plexToken, payload);
    const validation = await services.validatePlexSettings(baseInput);
    const appSettings = db.getAppSettings();

    db.savePlexSettings({
      serverUrl: baseInput.serverUrl,
      token: owner.plexToken,
      machineIdentifier: validation.machineIdentifier || baseInput.machineIdentifier,
      movieLibraryId: appSettings.defaultMovieLibraryId || "",
      showLibraryId: appSettings.defaultShowLibraryId || ""
    });

    services.upsertSelfUser().catch((err) => {
      logger.warn("Self user upsert failed after Plex settings save", {
        error: err instanceof Error ? err.message : String(err)
      });
    });
    services.discoverUsers().catch((err) => {
      logger.warn("Friend discovery failed after Plex settings save", {
        error: err instanceof Error ? err.message : String(err)
      });
    });

    return {
      plex: db.getPlexSettingsView(),
      libraries: validation.libraries.map((lib) => ({
        id: lib.key,
        name: lib.title,
        type: lib.type
      }))
    };
  }

  // ---------------------------------------------------------------------------
  // Bootstrap / public
  // ---------------------------------------------------------------------------

  app.get("/api/bootstrap/status", (req, res) => {
    res.json(db.getBootstrapStatus(Boolean(req.sessionUser)));
  });

  // ---------------------------------------------------------------------------
  // Plex OAuth auth
  // ---------------------------------------------------------------------------

  app.post("/api/auth/plex", async (req, res) => {
    const body = req.body as { authToken?: string };
    if (!body.authToken) {
      res.status(400).json({ error: "authToken is required." });
      return;
    }

    let account: Awaited<ReturnType<typeof PlexIntegration.fetchAccountByToken>>;
    try {
      account = await PlexIntegration.fetchAccountByToken(body.authToken);
    } catch (error) {
      res
        .status(401)
        .json({ error: "Failed to authenticate with Plex.", detail: error instanceof Error ? error.message : String(error) });
      return;
    }

    const existingOwner = db.getPlexOwner();

    if (!existingOwner) {
      // First user — becomes the owner
      db.savePlexOwner({
        plexId: account.plexId,
        plexToken: account.plexToken,
        username: account.username,
        displayName: account.displayName,
        email: account.email,
        avatarUrl: account.avatarUrl
      });

      // Upsert self user record for watchlist tracking
      services.upsertSelfUser().catch((err) => {
        logger.warn("Could not upsert self user after Plex auth", {
          error: err instanceof Error ? err.message : String(err)
        });
      });
    } else if (existingOwner.plexId !== account.plexId) {
      // Different Plex account — not the owner
      res.status(403).json({
        error: "unauthorized_account",
        message: "This Hubarr instance belongs to a different Plex account."
      });
      return;
    } else {
      // Owner re-authenticating — update their stored token and refresh email
      db.savePlexOwner({ ...existingOwner, plexToken: account.plexToken, email: account.email });
      db.updatePlexSettingsToken(account.plexToken);
    }

    const sessionId = createSessionId();
    const expiresAt = new Date(Date.now() + config.sessionTtlMs).toISOString();
    db.createSession(sessionId, account.plexId, expiresAt);
    setSessionCookie(res, sessionId);

    res.json({
      authenticated: true,
      user: {
        plexId: account.plexId,
        username: account.username,
        displayName: account.displayName,
        email: account.email,
        avatarUrl: account.avatarUrl
      }
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies.get(config.sessionCookieName);
    if (raw) {
      const [sessionId] = raw.split(".");
      if (sessionId) db.deleteSession(sessionId);
    }
    clearSessionCookie(res);
    res.status(204).end();
  });

  app.get("/api/auth/session", (req, res) => {
    res.json({
      authenticated: Boolean(req.sessionUser),
      user: req.sessionUser || null
    });
  });

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  app.get("/api/health", (_req, res) => {
    const settings = db.getAppSettings();
    const payload: HealthResponse = {
      ok: true,
      appName: "hubarr",
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      scheduler: {
        reconciliationIntervalMinutes: settings.reconciliationIntervalMinutes,
        rssPollIntervalSeconds: settings.rssPollIntervalSeconds,
        rssEnabled: settings.rssEnabled
      }
    };
    res.json(payload);
  });

  // ---------------------------------------------------------------------------
  // Setup / onboarding
  // ---------------------------------------------------------------------------

  /** Step 2: discover owned Plex servers */
  app.get("/api/setup/plex/servers", requireAuth, async (_req, res) => {
    const owner = db.getPlexOwner();
    if (!owner) {
      res.status(400).json({ error: "No Plex owner configured." });
      return;
    }
    try {
      const servers = await PlexIntegration.discoverServers(owner.plexToken);
      const options: PlexConnectionOption[] = servers.flatMap((server) =>
        server.connections.map((connection) => ({
          name: server.name,
          machineIdentifier: server.machineIdentifier,
          uri: connection.uri,
          address: connection.address,
          port: connection.port,
          protocol: connection.protocol,
          local: connection.local,
          status: connection.status,
          message: connection.message
        }))
      );
      res.json(options);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/setup/plex/save", requireAuth, async (req, res) => {
    try {
      const result = await validateAndSavePlexConfiguration(req.body as PlexConfigPayload);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/setup/status", requireAuth, (_req, res) => {
    const appSettings = db.getAppSettings();
    const payload: SetupStatusResponse = {
      configured: Boolean(db.getPlexSettings()),
      plex: db.getPlexSettingsView(),
      collectionsConfigured: Boolean(
        appSettings.defaultMovieLibraryId && appSettings.defaultShowLibraryId
      ),
      currentStep: db.getCurrentOnboardingStep()
    };
    res.json(payload);
  });

  app.get("/api/setup/plex/libraries", requireAuth, async (_req, res) => {
    try {
      const plex = services.getPlexIntegration();
      const libraries = await plex.getLibraries();
      res.json(
        libraries.map((lib) => ({
          id: lib.key,
          name: lib.title,
          type: lib.type
        }))
      );
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------

  app.get("/api/dashboard", requireAuth, (_req, res) => {
    res.json(db.buildDashboard());
  });

  // Plex image proxy (keeps token server-side)
  app.get("/api/plex/image", requireAuth, async (req, res) => {
    const plexPath = req.query["path"] as string | undefined;
    if (!plexPath) {
      res.status(400).json({ error: "path query param required." });
      return;
    }
    const plexSettings = db.getPlexSettings();
    if (!plexSettings) {
      res.status(400).json({ error: "Plex not configured." });
      return;
    }
    try {
      const imageUrl = buildTrustedPlexImageRequest(plexSettings.serverUrl, plexPath);
      const upstream = await fetch(imageUrl, {
        headers: {
          "X-Plex-Token": plexSettings.token
        }
      });
      if (!upstream.ok) {
        res.status(upstream.status).end();
        return;
      }
      const contentType = upstream.headers.get("content-type") || "image/jpeg";
      res.setHeader("content-type", contentType);
      res.setHeader("cache-control", "public, max-age=86400");
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    } catch {
      res.status(502).end();
    }
  });

  // Avatar proxy (safe passthrough for absolute Plex user avatar URLs)
  app.get("/api/avatar", requireAuth, async (req, res) => {
    const rawUrl = typeof req.query["url"] === "string" ? req.query["url"] : undefined;
    const initialUrl = rawUrl ? sanitizeAvatarUrl(rawUrl) : null;
    if (!initialUrl) {
      res.status(400).json({ error: "Invalid or disallowed avatar URL." });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AVATAR_TIMEOUT_MS);

    try {
      let currentUrl = initialUrl;
      let fetchRes: Awaited<ReturnType<typeof fetch>> | null = null;

      for (let i = 0; i <= AVATAR_MAX_REDIRECTS; i++) {
        // codeql[js/request-forgery] - currentUrl is always the return value of
        // sanitizeAvatarUrl(), which enforces https:, blocks private/loopback IPs,
        // strips credentials, and returns url.href from the parsed URL object.
        fetchRes = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal
        });

        if (fetchRes.status >= 300 && fetchRes.status < 400) {
          const location = fetchRes.headers.get("location");
          const next = location ? sanitizeAvatarUrl(location, currentUrl) : null;
          if (!next) {
            res.status(502).end();
            return;
          }
          currentUrl = next;
          continue;
        }
        break;
      }

      // Treat redirect-loop exhaustion (still 3xx after max hops) as a
      // proxy failure rather than forwarding the redirect to the client.
      if (!fetchRes || !fetchRes.ok) {
        res.status(502).end();
        return;
      }

      const contentType = fetchRes.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) {
        res.status(502).end();
        return;
      }

      // Reject based on Content-Length if the server provides it.
      const contentLength = Number(fetchRes.headers.get("content-length") ?? 0);
      if (contentLength > MAX_AVATAR_BYTES) {
        res.status(502).end();
        return;
      }

      // Stream the body with a hard byte cap so an upstream server that omits
      // or lies about Content-Length cannot force excessive memory allocation.
      const reader = fetchRes.body?.getReader();
      if (!reader) {
        res.status(502).end();
        return;
      }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.length;
        if (totalBytes > MAX_AVATAR_BYTES) {
          await reader.cancel();
          res.status(502).end();
          return;
        }
        chunks.push(Buffer.from(value));
      }
      const buf = Buffer.concat(chunks);

      res.setHeader("content-type", contentType);
      res.setHeader("cache-control", "public, max-age=86400");
      res.send(buf);
    } catch {
      res.status(502).end();
    } finally {
      clearTimeout(timeout);
    }
  });

  // ---------------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------------

  app.get("/api/users", requireAuth, (_req, res) => {
    res.json(db.listUsers());
  });

  app.post("/api/users/discover", requireAuth, async (_req, res) => {
    try {
      const users = await services.discoverUsers();
      res.json(users);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/users/bulk", requireAuth, (req, res) => {
    const body = req.body as { ids?: unknown; enabled?: unknown };
    if (!Array.isArray(body.ids) || typeof body.enabled !== "boolean") {
      res.status(400).json({ error: "ids (array) and enabled (boolean) are required." });
      return;
    }
    const ids = (body.ids as unknown[]).filter((id): id is number => typeof id === "number");
    const updated = db.bulkUpdateUsers(ids, body.enabled);
    res.json({ updated });
  });

  app.patch("/api/users/:id", requireAuth, (req, res) => {
    try {
      const user = db.updateUser(Number(req.params.id), req.body);
      res.json(user);
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/users/:id/sync", requireAuth, async (req, res) => {
    try {
      const result = await services.runUserSync(Number(req.params.id));
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // ---------------------------------------------------------------------------
  // Watchlists
  // ---------------------------------------------------------------------------

  app.get("/api/watchlists", requireAuth, (req, res) => {
    const userId = req.query["userId"] ? Number(req.query["userId"]) : undefined;
    const mediaTypeParam = req.query["mediaType"];
    const mediaType =
      mediaTypeParam === "movie" || mediaTypeParam === "show"
        ? mediaTypeParam
        : undefined;
    const availabilityParam = req.query["availability"];
    const availability =
      availabilityParam === "available" || availabilityParam === "missing"
        ? availabilityParam
        : undefined;
    const sortByParam = req.query["sortBy"];
    const sortBy =
      sortByParam === "added-desc" || sortByParam === "added-asc" ||
      sortByParam === "title-asc" || sortByParam === "title-desc" ||
      sortByParam === "year-desc" || sortByParam === "year-asc"
        ? sortByParam
        : "added-desc";
    const page = req.query["page"] ? Math.max(1, Number(req.query["page"])) : 1;
    const pageSize = req.query["pageSize"] ? Math.min(200, Math.max(1, Number(req.query["pageSize"]))) : 50;
    res.json(db.getWatchlistGrouped({ userId, mediaType, availability, sortBy, page, pageSize }));
  });

  app.get("/api/watchlists/enrich", requireAuth, async (req, res) => {
    const plexItemId = req.query["plexItemId"];
    if (typeof plexItemId !== "string" || !plexItemId) {
      res.status(400).json({ error: "plexItemId is required." });
      return;
    }
    try {
      const plex = services.getPlexIntegration();
      const discoverKey = db.getWatchlistDiscoverKey(plexItemId);
      const meta = await plex.fetchRichMetadata(plexItemId, discoverKey);
      res.json(meta ?? null);
    } catch {
      res.json(null);
    }
  });

  app.post("/api/watchlists/refresh", requireAuth, async (_req, res) => {
    try {
      const run = await services.refreshAllWatchlists();
      res.json(run);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  app.get("/api/history", requireAuth, (req, res) => {
    const page = Math.max(1, Number(req.query["page"] ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query["pageSize"] ?? 10)));
    const kind = (req.query["kind"] as string) || "all";
    const status = (req.query["status"] as string) || "all";

    const { results, total } = db.listSyncRunsPaginated({ page, pageSize, kind, status });
    const pages = Math.max(1, Math.ceil(total / pageSize));
    res.json({ results, pageInfo: { page, pageSize, pages, total } });
  });

  app.get("/api/history/:runId", requireAuth, (req, res) => {
    const runId = Number(req.params["runId"]);
    if (!runId || isNaN(runId)) {
      res.status(400).json({ error: "Invalid run ID" });
      return;
    }
    const detail = db.getSyncRunWithItems(runId);
    if (!detail) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json(detail);
  });

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  app.get("/api/settings", requireAuth, (_req, res) => {
    const app = db.getAppSettings();
    const plexView = db.getPlexSettingsView();

    const payload: SettingsResponse = {
      general: {
        fullSyncOnStartup: app.fullSyncOnStartup,
        historyRetentionDays: app.historyRetentionDays
      },
      sync: {
        reconciliationIntervalMinutes: app.reconciliationIntervalMinutes,
        rssPollIntervalSeconds: app.rssPollIntervalSeconds,
        rssEnabled: app.rssEnabled
      },
      plex: plexView,
      collections: {
        collectionNamePattern: app.collectionNamePattern,
        collectionSortOrder: app.collectionSortOrder,
        movieLibraryId: app.defaultMovieLibraryId,
        showLibraryId: app.defaultShowLibraryId,
        visibilityDefaults: app.visibilityDefaults
      }
    };
    res.json(payload);
  });

  app.patch("/api/settings", requireAuth, (req, res) => {
    const body = req.body as {
      general?: { fullSyncOnStartup?: boolean; historyRetentionDays?: number };
      collections?: {
        collectionNamePattern?: string;
        collectionSortOrder?: string;
        movieLibraryId?: string | null;
        showLibraryId?: string | null;
        visibilityDefaults?: { recommended?: boolean; home?: boolean; shared?: boolean };
      };
      sync?: {
        reconciliationIntervalMinutes?: number;
        rssPollIntervalSeconds?: number;
        rssEnabled?: boolean;
      };
    };

    const patch: Parameters<typeof db.updateAppSettings>[0] = {};

    if (body.general) {
      if (typeof body.general.fullSyncOnStartup === "boolean") {
        patch.fullSyncOnStartup = body.general.fullSyncOnStartup;
      }
      if (body.general.historyRetentionDays !== undefined) {
        patch.historyRetentionDays = Math.max(1, Math.floor(body.general.historyRetentionDays));
      }
    }

    if (body.collections) {
      if (body.collections.collectionNamePattern !== undefined) {
        patch.collectionNamePattern = body.collections.collectionNamePattern;
      }
      if (body.collections.collectionSortOrder !== undefined) {
        const valid = ["year-desc", "year-asc", "title"];
        if (valid.includes(body.collections.collectionSortOrder)) {
          patch.collectionSortOrder = body.collections.collectionSortOrder as "year-desc" | "year-asc" | "title";
        }
      }
      if ("movieLibraryId" in body.collections) {
        patch.defaultMovieLibraryId = body.collections.movieLibraryId ?? null;
      }
      if ("showLibraryId" in body.collections) {
        patch.defaultShowLibraryId = body.collections.showLibraryId ?? null;
      }
      if (body.collections.visibilityDefaults) {
        patch.visibilityDefaults = body.collections.visibilityDefaults as typeof patch.visibilityDefaults;
      }
    }

    if (body.sync) {
      if (body.sync.reconciliationIntervalMinutes !== undefined) {
        patch.reconciliationIntervalMinutes = body.sync.reconciliationIntervalMinutes;
      }
      if (body.sync.rssPollIntervalSeconds !== undefined) {
        patch.rssPollIntervalSeconds = body.sync.rssPollIntervalSeconds;
      }
      if (typeof body.sync.rssEnabled === "boolean") {
        patch.rssEnabled = body.sync.rssEnabled;
      }
    }

    const updated = db.updateAppSettings(patch);

    scheduler?.updateJob("full-sync", {
      intervalMs: updated.reconciliationIntervalMinutes * 60 * 1000,
      enabled: true
    });
    scheduler?.updateJob("rss-sync", {
      intervalMs: updated.rssPollIntervalSeconds * 1000,
      enabled: updated.rssEnabled
    });

    res.json(updated);
  });

  /** Plex library dropdown data */
  app.get("/api/settings/plex/libraries", requireAuth, async (_req, res) => {
    try {
      const plex = services.getPlexIntegration();
      const libraries = await plex.getLibraries();
      res.json(
        libraries.map((lib) => ({
          id: lib.key,
          name: lib.title,
          type: lib.type
        }))
      );
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/settings/plex/save", requireAuth, async (req, res) => {
    try {
      const result = await validateAndSavePlexConfiguration(req.body as PlexConfigPayload);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.use("/api/settings/logs", logsRateLimiter);

  /** Log viewer */
  app.get("/api/settings/logs", requireAuth, (req, res) => {
    const page = Math.max(1, Number(req.query["page"] ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query["pageSize"] ?? 25)));
    const filterParam = typeof req.query["filter"] === "string" ? req.query["filter"] : "debug";
    const search = typeof req.query["search"] === "string" ? req.query["search"] : "";

    // Cascade: debug=all, info=info+warn+error, warn=warn+error, error=error only
    const LEVEL_ORDER = ["debug", "info", "warn", "error"];
    const filterIndex = LEVEL_ORDER.indexOf(filterParam);
    const allowed = new Set(filterIndex >= 0 ? LEVEL_ORDER.slice(filterIndex) : LEVEL_ORDER);

    const LOG_FIELDS = new Set(["timestamp", "level", "message"]);
    const logFile = path.join(config.dataDir, "logs", ".machinelogs.json");
    let entries: Array<{ timestamp: string; level: string; message: string; meta?: unknown }> = [];

    try {
      const raw = fs.readFileSync(logFile, "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (!allowed.has(parsed["level"] as string)) continue;

          // Normalize extra fields (from Winston spread) into meta
          const meta: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (!LOG_FIELDS.has(k)) meta[k] = v;
          }

          const entry = {
            timestamp: parsed["timestamp"] as string,
            level: parsed["level"] as string,
            message: parsed["message"] as string,
            ...(Object.keys(meta).length > 0 ? { meta } : {})
          };

          if (search) {
            const needle = search.toLowerCase();
            const inMessage = entry.message.toLowerCase().includes(needle);
            const inMeta = entry.meta !== undefined && JSON.stringify(entry.meta).toLowerCase().includes(needle);
            if (!inMessage && !inMeta) continue;
          }

          entries.push(entry);
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // File not available — fall back to ring buffer
      entries = logger.getRecentLogs(500).filter((e) => allowed.has(e.level));
      if (search) {
        const needle = search.toLowerCase();
        entries = entries.filter(
          (e) => e.message.toLowerCase().includes(needle) || (e.meta !== undefined && JSON.stringify(e.meta).toLowerCase().includes(needle))
        );
      }
    }

    // Reverse (newest first) then paginate
    entries.reverse();
    const total = entries.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const skip = (page - 1) * pageSize;
    const results = entries.slice(skip, skip + pageSize);

    res.json({ results, pageInfo: { page, pageSize, pages, total } });
  });

  app.post("/api/settings/reset-collections", requireAuth, async (_req, res) => {
    try {
      const result = await services.resetCollections();
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Job status */
  app.get("/api/settings/jobs", requireAuth, (_req, res) => {
    const settings = db.getAppSettings();
    const recentRuns = db.listSyncRuns(20);

    const lastFull = recentRuns.find((r) => r.kind === "full");
    const lastPublish = recentRuns.find((r) => r.kind === "publish");
    const lastRss = recentRuns.find((r) => r.kind === "rss");

    const jobs = [
      {
        id: "collection-publish",
        name: "Collection Sync",
        intervalDescription: `Every ${settings.collectionPublishIntervalMinutes} minutes`,
        nextRunAt:
          scheduler?.getNextRunAt("collection-publish") ??
          (lastPublish?.completedAt
            ? new Date(
                Date.parse(lastPublish.completedAt) + settings.collectionPublishIntervalMinutes * 60 * 1000
              ).toISOString()
            : null),
        lastRunAt: lastPublish?.completedAt ?? null,
        lastRunStatus:
          lastPublish?.status === "success" || lastPublish?.status === "error" ? lastPublish.status : null
      },
      {
        id: "full-sync",
        name: "Watchlist GraphQL Sync",
        intervalDescription: `Every ${settings.reconciliationIntervalMinutes} minutes`,
        nextRunAt:
          scheduler?.getNextRunAt("full-sync") ??
          (lastFull?.completedAt
            ? new Date(
                Date.parse(lastFull.completedAt) + settings.reconciliationIntervalMinutes * 60 * 1000
              ).toISOString()
            : null),
        lastRunAt: lastFull?.completedAt ?? null,
        lastRunStatus: lastFull?.status === "success" || lastFull?.status === "error" ? lastFull.status : null
      },
      {
        id: "plex-recently-added-scan",
        name: "Plex Recently Added Scan",
        intervalDescription: `Every ${settings.plexRecentlyAddedScanIntervalMinutes} minutes`,
        nextRunAt: scheduler?.getNextRunAt("plex-recently-added-scan") ?? null,
        lastRunAt: scheduler?.getLastRunAt("plex-recently-added-scan") ?? null,
        lastRunStatus: scheduler?.getLastRunStatus("plex-recently-added-scan") ?? null
      },
      {
        id: "plex-full-library-scan",
        name: "Plex Full Library Scan",
        intervalDescription: `Every ${settings.plexFullLibraryScanIntervalMinutes / 60} hour${settings.plexFullLibraryScanIntervalMinutes / 60 !== 1 ? "s" : ""}`,
        nextRunAt: scheduler?.getNextRunAt("plex-full-library-scan") ?? null,
        lastRunAt: scheduler?.getLastRunAt("plex-full-library-scan") ?? null,
        lastRunStatus: scheduler?.getLastRunStatus("plex-full-library-scan") ?? null
      },
      {
        id: "plex-refresh-token",
        name: "Plex Refresh Token",
        intervalDescription: "Daily at 5:00 AM",
        nextRunAt: scheduler?.getNextRunAt("plex-refresh-token") ?? null,
        lastRunAt: scheduler?.getLastRunAt("plex-refresh-token") ?? null,
        lastRunStatus: scheduler?.getLastRunStatus("plex-refresh-token") ?? null
      },
      {
        id: "rss-sync",
        name: "Watchlist RSS Sync",
        intervalDescription: settings.rssEnabled
          ? `Every ${settings.rssPollIntervalSeconds / 60} minute${settings.rssPollIntervalSeconds / 60 !== 1 ? "s" : ""}`
          : "Disabled",
        nextRunAt: scheduler?.getNextRunAt("rss-sync"),
        lastRunAt: lastRss?.completedAt ?? null,
        lastRunStatus: lastRss?.status === "success" || lastRss?.status === "error" ? lastRss.status : null
      }
    ];

    jobs.sort((a, b) => a.name.localeCompare(b.name));

    res.json(jobs);
  });

  /** Trigger a job immediately */
  app.post("/api/settings/jobs/:id/run", requireAuth, async (req, res) => {
    const jobId = req.params.id;
    try {
      if (jobId === "collection-publish") {
        const triggered = scheduler?.runNow("collection-publish") ?? false;
        if (!triggered) {
          res.status(404).json({ error: "Unknown job." });
          return;
        }
        res.json({ triggered: true });
      } else if (jobId === "full-sync") {
        services.runFullSync().catch((err) => {
          logger.warn("Manual full sync failed", { error: err instanceof Error ? err.message : String(err) });
        });
        res.json({ triggered: true });
      } else if (jobId === "plex-recently-added-scan") {
        const triggered = scheduler?.runNow("plex-recently-added-scan") ?? false;
        if (!triggered) {
          res.status(404).json({ error: "Unknown job." });
          return;
        }
        res.json({ triggered: true });
      } else if (jobId === "plex-full-library-scan") {
        const triggered = scheduler?.runNow("plex-full-library-scan") ?? false;
        if (!triggered) {
          res.status(404).json({ error: "Unknown job." });
          return;
        }
        res.json({ triggered: true });
      } else if (jobId === "plex-refresh-token") {
        const triggered = scheduler?.runNow("plex-refresh-token") ?? false;
        if (!triggered) {
          res.status(404).json({ error: "Unknown job." });
          return;
        }
        res.json({ triggered: true });
      } else if (jobId === "rss-sync") {
        services.pollRss().catch((err) => {
          logger.warn("Manual RSS poll failed", { error: err instanceof Error ? err.message : String(err) });
        });
        res.json({ triggered: true });
      } else {
        res.status(404).json({ error: "Unknown job." });
      }
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Update job schedule (reconciliation interval only) */
  app.patch("/api/settings/jobs/:id", requireAuth, (req, res) => {
    const jobId = req.params.id;
    const body = req.body as { intervalMinutes?: number; intervalSeconds?: number };
    if (jobId === "collection-publish" && body.intervalMinutes) {
      const updated = db.updateAppSettings({ collectionPublishIntervalMinutes: body.intervalMinutes });
      scheduler?.updateJob("collection-publish", {
        intervalMs: updated.collectionPublishIntervalMinutes * 60 * 1000,
        enabled: true
      });
      res.json({ updated: true });
    } else if (jobId === "full-sync" && body.intervalMinutes) {
      const updated = db.updateAppSettings({ reconciliationIntervalMinutes: body.intervalMinutes });
      scheduler?.updateJob("full-sync", {
        intervalMs: updated.reconciliationIntervalMinutes * 60 * 1000,
        enabled: true
      });
      res.json({ updated: true });
    } else if (jobId === "plex-recently-added-scan" && body.intervalMinutes) {
      const updated = db.updateAppSettings({ plexRecentlyAddedScanIntervalMinutes: body.intervalMinutes });
      scheduler?.updateJob("plex-recently-added-scan", {
        intervalMs: updated.plexRecentlyAddedScanIntervalMinutes * 60 * 1000,
        enabled: true
      });
      res.json({ updated: true });
    } else if (jobId === "plex-full-library-scan" && body.intervalMinutes) {
      const updated = db.updateAppSettings({ plexFullLibraryScanIntervalMinutes: body.intervalMinutes });
      scheduler?.updateJob("plex-full-library-scan", {
        intervalMs: updated.plexFullLibraryScanIntervalMinutes * 60 * 1000,
        enabled: true
      });
      res.json({ updated: true });
    } else if (jobId === "rss-sync" && body.intervalMinutes) {
      const updated = db.updateAppSettings({ rssPollIntervalSeconds: body.intervalMinutes * 60 });
      scheduler?.updateJob("rss-sync", {
        intervalMs: updated.rssPollIntervalSeconds * 1000,
        enabled: updated.rssEnabled
      });
      res.json({ updated: true });
    } else {
      res.status(400).json({ error: "Unknown job or missing interval." });
    }
  });

  /** About */
  app.get("/api/settings/about", requireAuth, (_req, res) => {
    res.json({
      version: APP_VERSION,
      nodeVersion: process.version,
      platform: process.platform,
      dataDir: config.dataDir,
      tz: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    });
  });

  // ---------------------------------------------------------------------------
  // Static file serving
  // ---------------------------------------------------------------------------

  if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get("*", staticRateLimiter, (req, res, next) => {
      if (req.path.startsWith("/api/")) {
        next();
        return;
      }
      res.sendFile(path.join(clientDir, "index.html"));
    });
  }

  return { app, db, services, logger };
}
