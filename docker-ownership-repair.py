#!/usr/bin/env python3
"""Repair DATA_DIR ownership without following mutable path components."""

import os
import pwd
import sys


def repair_entry(name: str, directory_fd: int, node_uid: int, node_gid: int) -> None:
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
        return


def repair_tree(directory_fd: int, node_uid: int, node_gid: int) -> None:
    try:
        entries = list(os.scandir(directory_fd))
    except OSError:
        return

    for entry in entries:
        repair_entry(entry.name, directory_fd, node_uid, node_gid)
        if entry.is_dir(follow_symlinks=False):
            try:
                child_fd = os.open(
                    entry.name,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=directory_fd,
                )
            except (FileNotFoundError, NotADirectoryError, PermissionError):
                continue
            try:
                repair_tree(child_fd, node_uid, node_gid)
            finally:
                os.close(child_fd)


def repair(data_dir: str) -> None:
    node = pwd.getpwnam("node")
    node_uid = node.pw_uid
    node_gid = node.pw_gid
    root_fd = os.open(
        data_dir,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
    )
    try:
        root = os.fstat(root_fd)
        if root.st_uid != node_uid or root.st_gid != node_gid:
            os.fchown(root_fd, node_uid, node_gid)
        repair_tree(root_fd, node_uid, node_gid)
    finally:
        os.close(root_fd)


if __name__ == "__main__":
    repair(sys.argv[1])
