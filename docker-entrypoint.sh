#!/bin/sh
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"

  # DATA_DIR may be a fresh host bind mount, or contain files restored or
  # copied in with different ownership after the directory was initialized.
  # Walk the tree so nested mismatches are repaired, but only chown entries
  # that need it and never follow symlinks into files outside the data
  # directory.
  find "$DATA_DIR" \( ! -user node -o ! -group node \) -exec chown -h node:node {} +

  exec gosu node "$@"
fi

exec "$@"
