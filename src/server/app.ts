import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import type {
  CollectionSortOrder,
  HealthResponse,
  JobInfo,
  PlexConfigPayload,
  PlexConnectionOption,
  SeerrSettingsPatch,
  SeerrSettingsView,
  SettingsResponse,
  SessionUser,
  SetupStatusResponse,
  VisibilityConfig
} from "../shared/types.js";
import { createSessionId } from "./auth.js";
import type { RuntimeConfig } from "./config.js";
import { HubarrDatabase } from "./db/index.js";
import { PlexIntegration } from "./integrations/plex.js";
import { JobScheduler } from "./job-scheduler.js";
import { Logger } from "./logger.js";
import { ImageCacheService } from "./image-cache.js";
import { HubarrServices } from "./services.js";
import { APP_VERSION, BUILD_CHANNEL, BUILD_COMMIT } from "./version.js";

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

function isVisibilityConfig(value: unknown): value is VisibilityConfig {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["recommended"] === "boolean" &&
    typeof candidate["home"] === "boolean" &&
    typeof candidate["shared"] === "boolean"
  );
}

function summarizeSettingsPatch(patch: Record<string, unknown>) {
  const changedSections = Object.keys(patch).sort();
  const fieldKeys = changedSections.flatMap((section) => {
    const value = patch[section];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [section];
    }

    return Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${section}.${key}`);
  });

  return {
    changedSections,
    fieldKeys,
    fieldCount: fieldKeys.length
  };
}

export function createApp(config: RuntimeConfig, scheduler?: JobScheduler) {
  const logger = new Logger(config.dataDir);
  const db = new HubarrDatabase(config, logger);
  const sessionSecret = db.getSessionSecret();
  const imageCache = new ImageCacheService(config.dataDir, db, logger);
  const services = new HubarrServices(db, logger, imageCache);
  const app = express();

  // Enable trust proxy if configured — required for express-rate-limit to
  // correctly identify clients by their real IP when Hubarr runs behind a
  // reverse proxy that injects X-Forwarded-For headers. Trust only a single
  // proxy hop so forwarded headers are honored without accepting arbitrary
  // client-supplied proxy chains.
  if (db.getAppSettings().trustProxy) {
    app.set("trust proxy", 1);
    logger.info("Trust proxy enabled — using one trusted proxy hop for client IP identification");
  }

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

  async function handlePlexConnectionTest(payload: PlexConfigPayload, res: Response) {
    const owner = db.getPlexOwner();
    if (!owner) {
      res.status(400).json({ ok: false, error: "No Plex account configured. Please sign in with Plex first." });
      return;
    }
    try {
      const input = buildPlexInputFromPayload(owner.plexToken, payload);
      const result = await services.validatePlexSettings(input);
      logger.info("Plex connection test succeeded", { serverUrl: input.serverUrl, libraryCount: result.libraries.length });
      res.json({ ok: true, serverUrl: input.serverUrl, libraryCount: result.libraries.length });
    } catch (err) {
      logger.warn("Plex connection test failed", { error: err instanceof Error ? err.message : String(err) });
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
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

    logger.info("Plex configuration saved", {
      serverUrl: baseInput.serverUrl,
      machineIdentifier: validation.machineIdentifier || baseInput.machineIdentifier,
      librariesDiscovered: validation.libraries.length
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
      logger.warn("Plex authentication failed", {
        error: error instanceof Error ? error.message : String(error)
      });
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
      logger.info("Plex owner account registered", { plexId: account.plexId, username: account.username });

      // Upsert self user record for watchlist tracking
      services.upsertSelfUser().catch((err) => {
        logger.warn("Could not upsert self user after Plex auth", {
          error: err instanceof Error ? err.message : String(err)
        });
      });
    } else if (existingOwner.plexId !== account.plexId) {
      // Different Plex account — not the owner
      logger.warn("Plex login rejected: account does not match server owner", { attemptedPlexId: account.plexId });
      res.status(403).json({
        error: "unauthorized_account",
        message: "This Hubarr instance belongs to a different Plex account."
      });
      return;
    } else {
      // Owner re-authenticating — update their stored token and refresh email
      db.savePlexOwner({ ...existingOwner, plexToken: account.plexToken, email: account.email });
      db.updatePlexSettingsToken(account.plexToken);
      logger.info("Plex owner re-authenticated", { plexId: account.plexId, username: account.username });
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
      logger.warn("Plex server discovery failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/setup/plex/save", requireAuth, async (req, res) => {
    try {
      const result = await validateAndSavePlexConfiguration(req.body as PlexConfigPayload);
      res.json(result);
    } catch (error) {
      logger.warn("Plex setup configuration save failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Test Plex connectivity during onboarding with the provided configuration without saving */
  app.post("/api/setup/plex/test", requireAuth, async (req, res) => {
    await handlePlexConnectionTest(req.body as PlexConfigPayload, res);
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
      logger.warn("Failed to fetch Plex libraries during setup", { error: error instanceof Error ? error.message : String(error) });
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Persist completion of the user-selection step before preload begins. */
  app.post("/api/setup/users/complete", requireAuth, (_req, res) => {
    db.updateAppSettings({ usersStepComplete: true });
    logger.info("Onboarding users step marked complete");
    res.json({ ok: true });
  });

  /**
   * Final onboarding step: streams preload progress via Server-Sent Events.
   * The client connects once the users step is confirmed and listens until a
   * "complete" phase event signals that all remaining preload phases have
   * finished. Reconnecting during preload resumes the same in-flight session.
   *
   * Phases emitted:
   * activity-cache → graphql-sync → publish-collections → complete
   */
  app.get("/api/setup/preload", requireAuth, async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    let clientDisconnected = false;
    req.on("close", () => {
      clientDisconnected = true;
    });

    try {
      await services.runOnboardingPreload((event) => {
        if (clientDisconnected) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
    } catch (err) {
      // Top-level guard — runOnboardingPreload handles per-phase errors
      // internally, so this only fires on truly unexpected failures.
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Onboarding preload aborted with unexpected error", { message });
      if (!clientDisconnected) {
        res.write(`data: ${JSON.stringify({ phase: "complete", status: "error", message })}\n\n`);
      }
    }

    res.end();
  });

  /** Mark onboarding as fully complete so the main app becomes accessible. */
  app.post("/api/setup/complete", requireAuth, (_req, res) => {
    if (!services.isPreloadComplete()) {
      res.status(400).json({ error: "Preload has not completed successfully." });
      return;
    }
    db.updateAppSettings({ usersStepComplete: true, onboardingComplete: true });
    services.clearOnboardingPreloadSession();
    logger.info("Onboarding marked complete");
    res.json({ ok: true });
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
    logger.info("Bulk user update applied", {
      requestedIds: ids.length,
      enabled: body.enabled,
      updated
    });
    res.json({ updated });
  });

  app.get("/api/users/managed", requireAuth, (_req, res) => {
    res.json(services.getManagedUsers());
  });

  app.patch("/api/users/:id", requireAuth, (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const allowedUserPatchFields = new Set([
        "enabled",
        "collectionNameOverride",
        "movieLibraryId",
        "showLibraryId",
        "visibilityOverride",
        "displayNameOverride",
        "collectionSortOrderOverride"
      ]);
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

      const invalidFields = Object.keys(body).filter((key) => !allowedUserPatchFields.has(key));
      if (invalidFields.length > 0) {
        res.status(400).json({ error: `Unsupported fields: ${invalidFields.join(", ")}` });
        return;
      }

      const updatePayload: Partial<{
        enabled: boolean;
        movieLibraryId: string | null;
        showLibraryId: string | null;
        visibilityOverride: VisibilityConfig | null;
        displayNameOverride: string | null;
        collectionNameOverride: string | null;
        collectionSortOrderOverride: CollectionSortOrder | null;
      }> = {};

      if ("enabled" in body) {
        if (typeof body.enabled !== "boolean") {
          res.status(400).json({ error: "enabled must be a boolean." });
          return;
        }
        updatePayload.enabled = body.enabled;
      }
      if ("movieLibraryId" in body) {
        if (body.movieLibraryId !== null && typeof body.movieLibraryId !== "string") {
          res.status(400).json({ error: "movieLibraryId must be a string or null." });
          return;
        }
        updatePayload.movieLibraryId = body.movieLibraryId as string | null;
      }
      if ("showLibraryId" in body) {
        if (body.showLibraryId !== null && typeof body.showLibraryId !== "string") {
          res.status(400).json({ error: "showLibraryId must be a string or null." });
          return;
        }
        updatePayload.showLibraryId = body.showLibraryId as string | null;
      }
      if ("visibilityOverride" in body) {
        if (body.visibilityOverride !== null && !isVisibilityConfig(body.visibilityOverride)) {
          res.status(400).json({ error: "visibilityOverride is invalid." });
          return;
        }
        updatePayload.visibilityOverride = body.visibilityOverride as VisibilityConfig | null;
      }
      if ("displayNameOverride" in body) {
        if (body.displayNameOverride !== null && typeof body.displayNameOverride !== "string") {
          res.status(400).json({ error: "displayNameOverride must be a string or null." });
          return;
        }
        updatePayload.displayNameOverride = body.displayNameOverride as string | null;
      }
      if ("collectionNameOverride" in body) {
        if (body.collectionNameOverride !== null && typeof body.collectionNameOverride !== "string") {
          res.status(400).json({ error: "collectionNameOverride must be a string or null." });
          return;
        }
        updatePayload.collectionNameOverride = body.collectionNameOverride as string | null;
      }
      if ("collectionSortOrderOverride" in body) {
        updatePayload.collectionSortOrderOverride = (body.collectionSortOrderOverride ?? null) as CollectionSortOrder | null;
      }

      const updatedFields = Object.keys(body).filter((key) => allowedUserPatchFields.has(key));
      const user = db.updateUser(Number(req.params.id), updatePayload);
      logger.info("User settings updated", {
        userId: user.id,
        displayName: user.displayName,
        updatedFields,
        fieldCount: updatedFields.length
      });
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
      availabilityParam === "available" || availabilityParam === "missing" || availabilityParam === "requested"
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
      logger.warn("Manual watchlist refresh failed", { error: error instanceof Error ? error.message : String(error) });
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
    const seerrStored = db.getSeerrSettings();

    const seerrView: SeerrSettingsView = {
      enabled: seerrStored.enabled,
      baseUrl: seerrStored.baseUrl,
      apiKeyConfigured: Boolean(seerrStored.apiKey),
      autoRequestEnabled: seerrStored.autoRequestEnabled,
      useServiceAccount: seerrStored.useServiceAccount,
      serviceAccountSeerrUserId: seerrStored.serviceAccountSeerrUserId
    };

    const payload: SettingsResponse = {
      general: {
        fullSyncOnStartup: app.fullSyncOnStartup,
        historyRetentionDays: app.historyRetentionDays,
        trackAllUsers: app.trackAllUsers,
        trustProxy: app.trustProxy
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
      },
      seerr: seerrView
    };
    res.json(payload);
  });

  app.patch("/api/settings", requireAuth, (req, res) => {
    const body = req.body as {
      general?: { fullSyncOnStartup?: boolean; historyRetentionDays?: number; trackAllUsers?: boolean; trustProxy?: boolean };
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
      if (typeof body.general.trackAllUsers === "boolean") {
        patch.trackAllUsers = body.general.trackAllUsers;
      }
      if (typeof body.general.trustProxy === "boolean") {
        patch.trustProxy = body.general.trustProxy;
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
      if ("visibilityDefaults" in body.collections) {
        if (!isVisibilityConfig(body.collections.visibilityDefaults)) {
          res.status(400).json({ error: "visibilityDefaults is invalid." });
          return;
        }
        patch.visibilityDefaults = body.collections.visibilityDefaults;
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

    const updated = services.updateSettings(patch);

    scheduler?.updateJob("full-sync", {
      intervalMs: updated.reconciliationIntervalMinutes * 60 * 1000,
      enabled: true
    });
    scheduler?.updateJob("rss-sync", {
      intervalMs: updated.rssPollIntervalSeconds * 1000,
      enabled: updated.rssEnabled
    });

    logger.info("Application settings updated", {
      summary: summarizeSettingsPatch(patch as Record<string, unknown>)
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
      logger.warn("Failed to fetch Plex libraries for settings", { error: error instanceof Error ? error.message : String(error) });
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/settings/plex/save", requireAuth, async (req, res) => {
    try {
      const result = await validateAndSavePlexConfiguration(req.body as PlexConfigPayload);
      res.json(result);
    } catch (error) {
      logger.warn("Plex settings save failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Test Plex connectivity with the provided configuration without saving */
  app.post("/api/settings/plex/test", requireAuth, async (req, res) => {
    await handlePlexConnectionTest(req.body as PlexConfigPayload, res);
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
      logger.warn("Collection reset failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Job status */
  app.get("/api/settings/jobs", requireAuth, (_req, res) => {
    const settings = db.getAppSettings();
    const seerrSettings = db.getSeerrSettings();
    const recentRuns = db.listSyncRuns(20);

    // Keep the "last run" fields anchored to the most recent completed run so
    // active jobs can still show consistent previous-run context while running.
    const lastFull = recentRuns.find((r) => r.kind === "full" && r.completedAt);
    const lastPublish = recentRuns.find((r) => r.kind === "publish" && r.completedAt);
    const lastRss = recentRuns.find((r) => r.kind === "rss" && r.completedAt);
    const lastSeerr = recentRuns.find((r) => r.kind === "seerr" && r.completedAt);
    const seerrJobState = db.getJobRunState("seerr-request-sync");

    const jobs: JobInfo[] = [
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
        id: "maintenance-tasks",
        name: "Maintenance Tasks",
        intervalDescription: "Daily at 5:30 AM",
        isRunning: scheduler?.isRunning("maintenance-tasks") ?? false,
        nextRunAt: scheduler?.getNextRunAt("maintenance-tasks") ?? null,
        lastRunAt: scheduler?.getLastRunAt("maintenance-tasks") ?? null,
        lastRunStatus: scheduler?.getLastRunStatus("maintenance-tasks") ?? null
      },
      {
        id: "rss-sync",
        name: "Watchlist RSS Sync",
        intervalDescription: settings.rssEnabled
          ? `Every ${settings.rssPollIntervalSeconds / 60} minute${settings.rssPollIntervalSeconds / 60 !== 1 ? "s" : ""}`
          : "Disabled",
        isRunning: scheduler?.isRunning("rss-sync") ?? false,
        nextRunAt: scheduler?.getNextRunAt("rss-sync") ?? null,
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

    if (seerrSettings.enabled) {
      jobs.push({
        id: "seerr-request-sync",
        name: "Seerr Request Sync",
        intervalDescription: "Manual",
        isRunning: services.isSeerrRequestSyncRunning(),
        nextRunAt: null,
        nextRunLabel: "Manual",
        lastRunAt: seerrJobState?.lastRunAt ?? lastSeerr?.completedAt ?? null,
        lastRunStatus: seerrJobState?.lastRunStatus ?? (
          lastSeerr?.status === "success" || lastSeerr?.status === "error" ? lastSeerr.status : null
        )
      });
    }

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
      } else if (jobId === "maintenance-tasks") {
        const triggered = scheduler?.runNow("maintenance-tasks") ?? false;
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
        logger.info("Manual job run requested", { jobId });
        services.syncActivityCache().catch((err) => {
          logger.warn("Manual activity cache fetch failed", { error: err instanceof Error ? err.message : String(err) });
        });
        res.json({ triggered: true });
      } else if (jobId === "seerr-request-sync") {
        services.runSeerrRequestSync({ mode: "all", triggeredBy: "manual" }).catch((err) => {
          logger.warn("Manual Seerr request sync failed", { error: err instanceof Error ? err.message : String(err) });
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
      buildChannel: BUILD_CHANNEL,
      commitSha: BUILD_COMMIT,
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
  // Seerr settings
  // ---------------------------------------------------------------------------

  app.patch("/api/settings/seerr", requireAuth, async (req, res) => {
    const body = req.body as SeerrSettingsPatch;
    const current = db.getSeerrSettings();
    const serviceAccountAvatarUrl = "https://raw.githubusercontent.com/Migz93/hubarr/refs/heads/main/public/logo.png";

    const patch: Parameters<typeof db.updateSeerrSettings>[0] = {};

    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.baseUrl === "string") patch.baseUrl = body.baseUrl.trim();
    if (typeof body.apiKey === "string" && body.apiKey) patch.apiKey = body.apiKey;
    if (typeof body.autoRequestEnabled === "boolean") patch.autoRequestEnabled = body.autoRequestEnabled;

    if (typeof body.useServiceAccount === "boolean") {
      patch.useServiceAccount = body.useServiceAccount;

      // When enabling service account mode, always reconcile the Hubarr Seerr account.
      // This runs on every save (not just first enable) so permissions are corrected
      // if they were changed in Seerr after initial setup.
      if (body.useServiceAccount) {
        const baseUrl = patch.baseUrl ?? current.baseUrl;
        const apiKey = patch.apiKey ?? current.apiKey;
        if (!baseUrl || !apiKey) {
          res.status(400).json({ error: "Base URL and API key are required to enable service account mode." });
          return;
        }
        try {
          const seerr = services.buildSeerrIntegration(baseUrl, apiKey);
          const seerrUserId = await seerr.createOrReconcileServiceAccount(serviceAccountAvatarUrl);
          patch.serviceAccountSeerrUserId = seerrUserId;
          logger.info("Seerr service account reconciled on settings save", {
            seerrUserId,
            avatarUrl: serviceAccountAvatarUrl
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error("Failed to create Seerr service account", { message });
          res.status(400).json({ error: `Could not create Seerr service account: ${message}` });
          return;
        }
      }

      if (!body.useServiceAccount) {
        // Disabling service account mode — stop using the account but do not delete it from Seerr.
        // Deleting causes Seerr user IDs to increment each time the option is toggled, which is
        // surprising and hard to recover from. The account will be found and reused by email if
        // the option is enabled again later.
        if (current.useServiceAccount) {
          logger.info("Seerr service account usage disabled — account retained in Seerr", {
            seerrUserId: current.serviceAccountSeerrUserId
          });
        }
        patch.serviceAccountSeerrUserId = null;
      }
    }

    const candidate = { ...current, ...patch };
    let validatedSeerr = null as ReturnType<typeof services.buildSeerrIntegration> | null;
    if (candidate.enabled && (!candidate.baseUrl || !candidate.apiKey)) {
      res.status(400).json({ error: "Base URL and API key are required to enable Seerr." });
      return;
    }
    if (candidate.baseUrl && candidate.apiKey) {
      try {
        validatedSeerr = services.buildSeerrIntegration(candidate.baseUrl, candidate.apiKey);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("Rejected invalid Seerr settings", { message });
        res.status(400).json({ error: message });
        return;
      }
    }

    const updated = db.updateSeerrSettings(patch);

    // Kick off auto-matching whenever Seerr settings change and integration is enabled
    if (updated.enabled && updated.baseUrl && updated.apiKey && validatedSeerr) {
      validatedSeerr.getUsers()
        .then((seerrUsers) => services.syncSeerrUserMappings(seerrUsers))
        .catch((err) => {
          logger.warn("Seerr auto-match sync failed after settings update", {
            message: err instanceof Error ? err.message : String(err)
          });
        });

      // Run the Seerr Request Sync job so newly-missing items get their state
      // refreshed immediately without the user needing to trigger it manually.
      services.runSeerrRequestSync({ mode: "all", triggeredBy: "manual" }).catch((err) => {
        logger.warn("Seerr request sync failed after settings save", {
          message: err instanceof Error ? err.message : String(err)
        });
      });
    }

    res.json({
      enabled: updated.enabled,
      baseUrl: updated.baseUrl,
      apiKeyConfigured: Boolean(updated.apiKey),
      autoRequestEnabled: updated.autoRequestEnabled,
      useServiceAccount: updated.useServiceAccount,
      serviceAccountSeerrUserId: updated.serviceAccountSeerrUserId
    });
  });

  /** Test Seerr connectivity with provided or stored credentials */
  app.post("/api/settings/seerr/test", requireAuth, async (req, res) => {
    const body = req.body as { baseUrl?: string; apiKey?: string };
    const stored = db.getSeerrSettings();
    const baseUrl = (body.baseUrl ?? stored.baseUrl ?? "").trim();
    const apiKey = body.apiKey ?? stored.apiKey ?? "";

    if (!baseUrl) {
      res.status(400).json({ error: "Base URL is required." });
      return;
    }
    if (!apiKey) {
      res.status(400).json({ error: "API key is required." });
      return;
    }

    try {
      const seerr = services.buildSeerrIntegration(baseUrl, apiKey);
      const result = await seerr.validate();
      res.json({ ok: true, version: result.version, userCount: result.userCount });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** List Seerr users for the mapping dropdown */
  app.get("/api/settings/seerr/users", requireAuth, async (_req, res) => {
    const stored = db.getSeerrSettings();
    if (!stored.baseUrl || !stored.apiKey) {
      res.status(400).json({ error: "Seerr is not configured." });
      return;
    }
    try {
      const seerr = services.buildSeerrIntegration(stored.baseUrl, stored.apiKey);
      const users = await seerr.getUsers();
      res.json(users);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---------------------------------------------------------------------------
  // Seerr user links
  // ---------------------------------------------------------------------------

  /** Get Seerr link for a specific user */
  app.get("/api/users/:id/seerr", requireAuth, (req, res) => {
    const userId = Number(req.params.id);
    const link = db.getSeerrUserLink(userId);
    const globalAutoRequestEnabled = db.getSeerrSettings().autoRequestEnabled;
    const response = link
      ? {
          ...link,
          autoRequestEnabled: link.autoRequestEnabledOverride ?? globalAutoRequestEnabled
        }
      : {
          userId,
          manualSeerrUserId: null,
          autoMatchedSeerrUserId: null,
          effectiveSeerrUserId: null,
          mappingStatus: "unlinked" as const,
          autoRequestEnabledOverride: null,
          autoRequestEnabled: globalAutoRequestEnabled
        };
    res.json(response);
  });

  /** Update Seerr link for a user (manual override or auto-request toggle) */
  app.patch("/api/users/:id/seerr", requireAuth, (req, res) => {
    const userId = Number(req.params.id);
    const body = req.body as {
      manualSeerrUserId?: unknown;
      autoRequestEnabledOverride?: unknown;
    };

    // Validate autoRequestEnabledOverride — must be boolean or null, not a string/number coercible value
    if ("autoRequestEnabledOverride" in body) {
      const v = body.autoRequestEnabledOverride;
      if (v !== null && v !== true && v !== false) {
        res.status(400).json({ error: "autoRequestEnabledOverride must be true, false, or null." });
        return;
      }
    }

    // Normalise manualSeerrUserId — the client sends -1 as a sentinel for "no user selected";
    // any non-positive number is treated as null.
    let manualSeerrUserId: number | null | undefined = undefined;
    if ("manualSeerrUserId" in body) {
      const v = body.manualSeerrUserId;
      if (v === null || v === undefined) {
        manualSeerrUserId = null;
      } else if (typeof v === "number" && v > 0) {
        manualSeerrUserId = v;
      } else {
        manualSeerrUserId = null;
      }
    }

    // Verify user exists
    const user = db.getUser(userId);
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return;
    }

    const updated = db.upsertSeerrUserLink({
      userId,
      ...("manualSeerrUserId" in body && { manualSeerrUserId: manualSeerrUserId ?? null }),
      ...("autoRequestEnabledOverride" in body && {
        autoRequestEnabledOverride: (body.autoRequestEnabledOverride as boolean | null) ?? null
      })
    });
    if (updated.effectiveSeerrUserId !== null) {
      const cleared = db.deleteSkippedUnlinkedSeerrRequestStatesForUser(userId);
      if (cleared > 0) {
        logger.info("Cleared stale Seerr unlinked request states after user mapping save", {
          userId,
          displayName: user.displayName,
          cleared
        });
      }
    }
    const globalAutoRequestEnabled = db.getSeerrSettings().autoRequestEnabled;
    res.json({
      ...updated,
      autoRequestEnabled: updated.autoRequestEnabledOverride ?? globalAutoRequestEnabled
    });
  });

  // ---------------------------------------------------------------------------
  // Seerr request state
  // ---------------------------------------------------------------------------

  /** Get Seerr request state for a watchlist item across all users */
  app.get("/api/watchlists/seerr-state", requireAuth, (req, res) => {
    const plexItemId = req.query["plexItemId"];
    if (typeof plexItemId !== "string" || !plexItemId) {
      res.status(400).json({ error: "plexItemId is required." });
      return;
    }
    res.json(db.listSeerrRequestStatesForItem(plexItemId));
  });

  /** Manually trigger a Seerr request for a watchlist item */
  app.post("/api/watchlists/request", requireAuth, async (req, res) => {
    const body = req.body as { userId?: number; plexItemId?: string };
    if (typeof body.userId !== "number" || typeof body.plexItemId !== "string" || !body.plexItemId) {
      res.status(400).json({ error: "userId and plexItemId are required." });
      return;
    }
    try {
      const result = await services.triggerManualSeerrRequest(body.userId, body.plexItemId);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
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
