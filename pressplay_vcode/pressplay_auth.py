import json
import os

USERS_FILE = "users.json"
ASSIGNMENTS_FILE = "assignments.json"


def _ensure_file(path: str, default):
    if not os.path.exists(path):
        with open(path, "w") as f:
            json.dump(default, f)


_ensure_file(USERS_FILE, {})
_ensure_file(ASSIGNMENTS_FILE, {})


def load_users():
    with open(USERS_FILE, "r") as f:
        return json.load(f)


def save_users(users):
    with open(USERS_FILE, "w") as f:
        json.dump(users, f, indent=2)


def load_assignments():
    with open(ASSIGNMENTS_FILE, "r") as f:
        return json.load(f)


def save_assignments(assignments):
    with open(ASSIGNMENTS_FILE, "w") as f:
        json.dump(assignments, f, indent=2)
