#!/bin/sh
set -e

if [ "$(id -u)" = "0" ]; then
  case "$DATA_DIR" in
    /*) ;;
    *) echo "DATA_DIR must be an absolute path" >&2; exit 1 ;;
  esac

  requested_data_dir="$(realpath -m -- "$DATA_DIR")"
  case "$requested_data_dir" in
    /|/app|/app/*)
      echo "DATA_DIR must not resolve to the container root or /app" >&2
      exit 1
      ;;
  esac
  mkdir -p "$requested_data_dir"
  DATA_DIR="$(realpath -- "$requested_data_dir")"
  if [ "$DATA_DIR" != "$requested_data_dir" ]; then
    echo "DATA_DIR must not contain symlinked path components" >&2
    exit 1
  fi

  # DATA_DIR may be a fresh host bind mount, or contain files restored or
  # copied in with different ownership after the directory was initialized.
  # The helper uses directory descriptors and no-follow operations so a
  # concurrent rename or symlink cannot redirect ownership changes outside it.
  python3 /ownership-repair.py "$DATA_DIR"

  exec gosu node "$@"
fi

exec "$@"
