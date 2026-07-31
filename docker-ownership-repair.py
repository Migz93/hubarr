#!/usr/bin/env python3
"""Repair DATA_DIR ownership without following mutable path components."""

import os
import pwd
import sys


def repair(data_dir: str) -> None:
    node = pwd.getpwnam("node")
    node_uid = node.pw_uid
    node_gid = node.pw_gid
    for directory, _, files, directory_fd in os.fwalk(data_dir, topdown=False):
        names = files
        try:
            names += os.listdir(directory_fd)
        except OSError:
            continue
        for name in set(names):
            try:
                entry = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                if entry.st_uid != node_uid or entry.st_gid != node_gid:
                    os.chown(
                        name,
                        node_uid,
                        node_gid,
                        dir_fd=directory_fd,
                        follow_symlinks=False,
                    )
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    repair(sys.argv[1])
