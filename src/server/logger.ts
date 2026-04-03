import path from "node:path";
import fs from "node:fs";
import * as winston from "winston";
import "winston-daily-rotate-file";
import type { LogEntry } from "../shared/types.js";

const LOG_RING_SIZE = 500;

const humanFormat = winston.format.printf(({ level, message, timestamp, ...meta }) => {
  const rest = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  return `${timestamp} [${level.toUpperCase()}]: ${message}${rest}`;
});

export class Logger {
  private readonly ring: LogEntry[] = [];
  private readonly winstonLogger: winston.Logger;

  constructor(dataDir: string) {
    const logDir = path.join(dataDir, "logs");

    const transports: winston.transport[] = [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp(),
          humanFormat
        )
      })
    ];

    // Add disk transports — skip gracefully if log dir is not writable (dev without mounted volume)
    try {
      fs.mkdirSync(logDir, { recursive: true });

      transports.push(
        new winston.transports.DailyRotateFile({
          filename: path.join(logDir, "hubarr-%DATE%.log"),
          datePattern: "YYYY-MM-DD",
          zippedArchive: true,
          maxSize: "20m",
          maxFiles: "7d",
          createSymlink: true,
          symlinkName: "hubarr.log",
          format: winston.format.combine(
            winston.format.timestamp(),
            humanFormat
          )
        }) as winston.transport,
        new winston.transports.DailyRotateFile({
          filename: path.join(logDir, ".machinelogs-%DATE%.json"),
          datePattern: "YYYY-MM-DD",
          zippedArchive: true,
          maxSize: "20m",
          maxFiles: "3d",
          createSymlink: true,
          symlinkName: ".machinelogs.json",
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
          )
        }) as winston.transport
      );
    } catch {
      // Log dir not writable — console only
    }

    this.winstonLogger = winston.createLogger({
      level: "debug",
      transports
    });
  }

  private write(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(meta !== undefined ? { meta } : {})
    };

    this.ring.push(entry);
    if (this.ring.length > LOG_RING_SIZE) {
      this.ring.shift();
    }

    if (meta !== undefined) {
      this.winstonLogger[level](message, meta as object);
    } else {
      this.winstonLogger[level](message);
    }
  }

  getRecentLogs(limit = 200): LogEntry[] {
    return this.ring.slice(-limit);
  }

  debug(message: string, meta?: unknown) {
    this.write("debug", message, meta);
  }

  info(message: string, meta?: unknown) {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: unknown) {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: unknown) {
    this.write("error", message, meta);
  }
}
