import { createApp } from "./app.js";
import { loadRuntimeConfig } from "./config.js";
import { JobScheduler } from "./job-scheduler.js";

const config = loadRuntimeConfig();
const scheduler = new JobScheduler();
const { app, db, logger, services } = createApp(config, scheduler);

scheduler.setPersistence({
  load: (id) => db.getJobRunState(id),
  save: (id, state) => db.saveJobRunState(id, state)
});

app.listen(config.port, () => {
  logger.info(`Hubarr listening on http://0.0.0.0:${config.port}`);
});

const appSettings = db.getAppSettings();

// Guard that skips a scheduled task when onboarding is not yet complete.
// This prevents background jobs from firing errors against an unconfigured
// instance while the user is still working through the setup wizard.
function requiresSetup(task: () => Promise<void>): () => Promise<void> {
  return async () => {
    if (!db.getBootstrapStatus(false).setupComplete) {
      logger.debug("Skipping scheduled task — setup is not complete");
      return;
    }
    await task();
  };
}

scheduler.registerRecurringJob({
  id: "collection-publish",
  intervalMs: appSettings.collectionPublishIntervalMinutes * 60 * 1000,
  task: requiresSetup(async () => {
    try {
      await services.runPublishPass();
    } catch (error) {
      logger.warn("Scheduled collection publish failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })
});

scheduler.registerRecurringJob({
  id: "full-sync",
  intervalMs: appSettings.reconciliationIntervalMinutes * 60 * 1000,
  task: requiresSetup(async () => {
    try {
      await services.runFullSync();
    } catch (error) {
      logger.warn("Scheduled full sync failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }),
});

scheduler.registerRecurringJob({
  id: "plex-recently-added-scan",
  intervalMs: appSettings.plexRecentlyAddedScanIntervalMinutes * 60 * 1000,
  task: requiresSetup(async () => {
    await services.runPlexRecentlyAddedScan(scheduler.getLastRunAt("plex-recently-added-scan"));
  }),
});

scheduler.registerRecurringJob({
  id: "plex-full-library-scan",
  intervalMs: appSettings.plexFullLibraryScanIntervalMinutes * 60 * 1000,
  task: requiresSetup(async () => {
    await services.runPlexFullLibraryScan();
  }),
});

scheduler.registerDailyJob({
  id: "plex-refresh-token",
  hour: 5,
  task: requiresSetup(async () => {
    await services.refreshPlexToken();
  })
});

scheduler.registerDailyJob({
  id: "users-discover",
  hour: 5,
  task: requiresSetup(async () => {
    await services.runUsersDiscoverJob();
  })
});

scheduler.registerDailyJob({
  id: "maintenance-tasks",
  hour: 5,
  minute: 30,
  task: requiresSetup(async () => {
    services.runMaintenanceTasks();
  })
});

const setupComplete = db.getBootstrapStatus(false).setupComplete;

// Activity cache — run on startup (full fetch on first run, incremental thereafter).
// Skipped if setup is not complete to avoid errors against an unconfigured instance.
if (setupComplete) {
  services.syncActivityCache().catch((error) => {
    logger.warn("Activity cache sync failed at startup", {
      error: error instanceof Error ? error.message : String(error)
    });
  });
} else {
  logger.info("Skipping startup activity cache sync — setup is not complete");
}

scheduler.registerRecurringJob({
  id: "activity-cache-fetch",
  intervalMs: appSettings.activityCacheFetchIntervalMinutes * 60 * 1000,
  task: requiresSetup(async () => {
    await services.syncActivityCache();
  })
});

if (setupComplete && appSettings.rssEnabled) {
  services.initRss().catch((error) => {
    logger.warn("RSS initialization failed at startup", {
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

scheduler.registerRecurringJob({
  id: "rss-sync",
  intervalMs: appSettings.rssPollIntervalSeconds * 1000,
  enabled: appSettings.rssEnabled,
  task: requiresSetup(async () => {
    try {
      await services.pollRss();
    } catch (error) {
      logger.warn("RSS polling tick failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })
});

// Startup sync sequence (if enabled and setup is complete)
if (setupComplete && appSettings.fullSyncOnStartup) {
  void (async () => {
    logger.info("Startup sync sequence started", {
      steps: ["plex-full-library-scan", "full-sync", "collection-publish"]
    });

    const startupSteps = [
      {
        id: "plex-full-library-scan",
        failureMessage: "Startup Plex full library scan failed"
      },
      {
        id: "full-sync",
        failureMessage: "Startup GraphQL sync failed"
      },
      {
        id: "collection-publish",
        failureMessage: "Startup collection sync failed"
      }
    ] as const;

    for (const step of startupSteps) {
      try {
        const result = await scheduler.runNowAndWait(step.id);
        if (result === null) {
          logger.warn("Startup sync step is not registered", { jobId: step.id });
        } else if (!result) {
          logger.warn(step.failureMessage);
        }
      } catch (error) {
        logger.warn(step.failureMessage, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    logger.info("Startup sync sequence finished");
  })();
} else if (!setupComplete && appSettings.fullSyncOnStartup) {
  logger.info("Skipping startup sync sequence — setup is not complete");
}
