import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import type {
  CollectionSortOrder,
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
import { ImageCacheService } from "./image-cache.js";
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

export function createApp(config: RuntimeConfig, scheduler?: JobScheduler) {
  const logger = new Logger(config.dataDir);
  const db = new HubarrDatabase(config);
  const sessionSecret = db.getSessionSecret();
  const imageCache = new ImageCacheService(config.dataDir, db, logger);
  const services = new HubarrServices(db, logger, imageCache);
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
    if (!sessionId || !signature || signedValue(sessionSecret, sessionId) !== signature) {
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
    const signed = `${sessionId}.${signedValue(sessionSecret, sessionId)}`;
    res.setHeader(
      "Set-Cookie",
      `${config.sessionCookieName}=${encodeURIComponent(signed)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`
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

  // ---------------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------------

  app.get("/api/users", requireAuth, (_req, res) => {
    res.json(db.listUsers());
  });

  app.post("/api/users/discover", requireAuth, async (_req, res) => {
    const triggered = scheduler?.runNow("users-discover") ?? false;
    if (!triggered) {
      res.status(404).json({ error: "User discovery job is not registered." });
      return;
    }
    res.json({ triggered: true });
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

  app.get("/api/users/managed", requireAuth, (_req, res) => {
    res.json(services.getManagedUsers());
  });

  app.patch("/api/users/:id", requireAuth, (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      // Validate collectionSortOrderOverride if provided — reject unknown values.
      const validSortOrders: CollectionSortOrder[] = ["date-desc", "date-asc", "title", "watchlist-date-desc", "watchlist-date-asc"];
      if (
        "collectionSortOrderOverride" in body &&
        body.collectionSortOrderOverride !== null &&
        !validSortOrders.includes(body.collectionSortOrderOverride as CollectionSortOrder)
      ) {
        res.status(400).json({ error: "Invalid collectionSortOrderOverride value." });
        return;
      }
      const user = db.updateUser(Number(req.params.id), body);
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
        // Accept new date-* values and normalize legacy year-* values on ingest.
        const legacyMap: Record<string, string> = { "year-desc": "date-desc", "year-asc": "date-asc" };
        const normalized = legacyMap[body.collections.collectionSortOrder] ?? body.collections.collectionSortOrder;
        const valid: CollectionSortOrder[] = ["date-desc", "date-asc", "title", "watchlist-date-desc", "watchlist-date-asc"];
        if (valid.includes(normalized as CollectionSortOrder)) {
          patch.collectionSortOrder = normalized as CollectionSortOrder;
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
    const rawPage = typeof req.query["page"] === "string" ? Number(req.query["page"]) : 1;
    const page = Math.max(1, Number.isFinite(rawPage) ? rawPage : 1);
    const rawPageSize = typeof req.query["pageSize"] === "string" ? Number(req.query["pageSize"]) : 25;
    const pageSize = Math.min(100, Math.max(1, Number.isFinite(rawPageSize) ? rawPageSize : 25));

    // Cascade: debug=all, info=info+warn+error, warn=warn+error, error=error only
    const LEVEL_ORDER = ["debug", "info", "warn", "error"] as const;
    type LogLevel = (typeof LEVEL_ORDER)[number];
    const isLogLevel = (v: unknown): v is LogLevel => typeof v === "string" && (LEVEL_ORDER as readonly string[]).includes(v);
    const filterParam: LogLevel = isLogLevel(req.query["filter"]) ? req.query["filter"] : "debug";
    const filterIndex = LEVEL_ORDER.indexOf(filterParam);
    const allowed = new Set<string>(LEVEL_ORDER.slice(filterIndex));

    const rawSearch = req.query["search"];
    const search: string = typeof rawSearch === "string" ? rawSearch.slice(0, 200) : "";

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

    // Keep the "last run" fields anchored to the most recent completed run so
    // active jobs can still show consistent previous-run context while running.
    const lastFull = recentRuns.find((r) => r.kind === "full" && r.completedAt);
    const lastPublish = recentRuns.find((r) => r.kind === "publish" && r.completedAt);
    const lastRss = recentRuns.find((r) => r.kind === "rss" && r.completedAt);

    const jobs = [
      {
        id: "collection-publish",
        name: "Collection Sync",
        intervalDescription: `Every ${settings.collectionPublishIntervalMinutes} minutes`,
        isRunning: scheduler?.isRunning("collection-publish") ?? false,
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
        isRunning: scheduler?.isRunning("full-sync") ?? false,
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
        isRunning: scheduler?.isRunning("plex-recently-added-scan") ?? false,
        nextRunAt: scheduler?.getNextRunAt("plex-recently-added-scan") ?? null,
        lastRunAt: scheduler?.getLastRunAt("plex-recently-added-scan") ?? null,
        lastRunStatus: scheduler?.getLastRunStatus("plex-recently-added-scan") ?? null
      },
      {
        id: "plex-full-library-scan",
        name: "Plex Full Library Scan",
        intervalDescription: `Every ${settings.plexFullLibraryScanIntervalMinutes / 60} hour${settings.plexFullLibraryScanIntervalMinutes / 60 !== 1 ? "s" : ""}`,
        isRunning: scheduler?.isRunning("plex-full-library-scan") ?? false,
        nextRunAt: scheduler?.getNextRunAt("plex-full-library-scan") ?? null,
        lastRunAt: scheduler?.getLastRunAt("plex-full-library-scan") ?? null,
        lastRunStatus: scheduler?.getLastRunStatus("plex-full-library-scan") ?? null
      },
      {
        id: "plex-refresh-token",
        name: "Plex Refresh Token",
        intervalDescription: "Daily at 5:00 AM",
        isRunning: scheduler?.isRunning("plex-refresh-token") ?? false,
        nextRunAt: scheduler?.getNextRunAt("plex-refresh-token") ?? null,
        lastRunAt: scheduler?.getLastRunAt("plex-refresh-token") ?? null,
        lastRunStatus: scheduler?.getLastRunStatus("plex-refresh-token") ?? null
      },
      {
        id: "users-discover",
        name: "Refresh Users",
        intervalDescription: "Daily at 5:00 AM",
        isRunning: scheduler?.isRunning("users-discover") ?? false,
        nextRunAt: scheduler?.getNextRunAt("users-discover") ?? null,
        lastRunAt: scheduler?.getLastRunAt("users-discover") ?? null,
        lastRunStatus: scheduler?.getLastRunStatus("users-discover") ?? null
      },
      {
        id: "rss-sync",
        name: "Watchlist RSS Sync",
        intervalDescription: settings.rssEnabled
          ? `Every ${settings.rssPollIntervalSeconds / 60} minute${settings.rssPollIntervalSeconds / 60 !== 1 ? "s" : ""}`
          : "Disabled",
        isRunning: scheduler?.isRunning("rss-sync") ?? false,
        nextRunAt: scheduler?.getNextRunAt("rss-sync"),
        lastRunAt: lastRss?.completedAt ?? null,
        lastRunStatus: lastRss?.status === "success" || lastRss?.status === "error" ? lastRss.status : null
      },
      {
        id: "activity-cache-fetch",
        name: "Watchlist Activity Cache",
        intervalDescription: `Every ${settings.activityCacheFetchIntervalMinutes} minutes`,
        isRunning: scheduler?.isRunning("activity-cache-fetch") ?? false,
        nextRunAt: scheduler?.getNextRunAt("activity-cache-fetch") ?? null,
        lastRunAt: scheduler?.getLastRunAt("activity-cache-fetch") ?? null,
        lastRunStatus: scheduler?.getLastRunStatus("activity-cache-fetch") ?? null
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
        const triggered = scheduler?.runNow("full-sync") ?? false;
        if (!triggered) {
          res.status(404).json({ error: "Unknown job." });
          return;
        }
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
      } else if (jobId === "users-discover") {
        const triggered = scheduler?.runNow("users-discover") ?? false;
        if (!triggered) {
          res.status(404).json({ error: "Unknown job." });
          return;
        }
        res.json({ triggered: true });
      } else if (jobId === "rss-sync") {
        const triggered = scheduler?.runNow("rss-sync") ?? false;
        if (!triggered) {
          res.status(404).json({ error: "Unknown job." });
          return;
        }
        res.json({ triggered: true });
      } else if (jobId === "activity-cache-fetch") {
        services.syncActivityCache().catch((err) => {
          logger.warn("Manual activity cache fetch failed", { error: err instanceof Error ? err.message : String(err) });
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
    } else if (jobId === "activity-cache-fetch" && body.intervalMinutes) {
      const updated = db.updateAppSettings({ activityCacheFetchIntervalMinutes: body.intervalMinutes });
      scheduler?.updateJob("activity-cache-fetch", {
        intervalMs: updated.activityCacheFetchIntervalMinutes * 60 * 1000,
        enabled: true
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

  /** Clear image cache — removes all files and metadata */
  app.post("/api/settings/image-cache/clear", requireAuth, (_req, res) => {
    const removed = imageCache.clearAll();
    res.json({ removed });
  });

  /** Clear activity cache — removes all watchlist activity date entries */
  app.post("/api/settings/activity-cache/clear", requireAuth, (_req, res) => {
    const removed = db.clearActivityCache();
    res.json({ removed });
  });

  /** Prune orphaned image files not referenced by any metadata row */
  app.post("/api/settings/image-cache/prune", requireAuth, (_req, res) => {
    const removed = imageCache.pruneOrphaned();
    res.json({ removed });
  });

  // ---------------------------------------------------------------------------
  // Static file serving
  // ---------------------------------------------------------------------------

  const imageCacheDir = path.join(config.dataDir, "image-cache");
  app.use("/images", requireAuth, express.static(imageCacheDir, { maxAge: "7d" }));

  if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get("/*path", staticRateLimiter, (req, res, next) => {
      if (req.path.startsWith("/api/")) {
        next();
        return;
      }
      res.sendFile(path.join(clientDir, "index.html"));
    });
  }

  return { app, db, services, logger };
}
