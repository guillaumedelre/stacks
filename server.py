"""Lists Docker Compose projects found in configured folders and starts or stops them."""

import hashlib
import json
import os
import queue
import re
import shutil
import urllib.request
import subprocess
import threading
import time
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import yaml

CONFIG_PATH = os.environ.get("STACKS_CONFIG", "/etc/stacks/stacks.yaml")
SELF_PROJECT = os.environ.get("STACKS_SELF_PROJECT", "stacks")
PORT = int(os.environ.get("STACKS_PORT", "8080"))
DASHBOARD_URL = os.environ.get("STACKS_DASHBOARD_URL", "http://dashboard:3000")
DASHBOARD_HOST = os.environ.get("STACKS_DASHBOARD_HOST", "")
APP_DIR = Path(__file__).parent
STATIC = {
    "/": (APP_DIR / "index.html", "text/html; charset=utf-8"),
    "/index.html": (APP_DIR / "index.html", "text/html; charset=utf-8"),
    "/app.css": (APP_DIR / "app.css", "text/css; charset=utf-8"),
    "/cards.js": (APP_DIR / "cards.js", "text/javascript; charset=utf-8"),
    "/ui.js": (APP_DIR / "ui.js", "text/javascript; charset=utf-8"),
}

COMPOSE_FILES = ("compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml")
WATCHED_FILES = COMPOSE_FILES + ("compose.override.yaml", "compose.override.yml",
                                 "docker-compose.override.yaml", "docker-compose.override.yml", ".env")
SKIP_DIRS = {"node_modules", "vendor", ".git", "var", ".cache", ".idea", "__pycache__"}
COMPOSE = ["docker", "compose", "--ansi", "never"]
CONFIG_TIMEOUT = 60  # seconds, per project
# Container events that change a state; exec_* (fired by every healthcheck) and the others are left out
EVENT_FILTERS = [arg for event in ("create", "start", "restart", "stop", "die", "kill", "destroy", "pause", "unpause",
                                   "rename", "oom", "health_status") for arg in ("--filter", f"event={event}")] \
    + ["--filter", "type=container"]
STATES_DEBOUNCE = 0.3  # seconds
STATES_REFRESH = 30  # seconds between two refreshes without event
LOG_TAIL = 300  # lines sent when a log stream opens
LOG_HEARTBEAT = 15  # seconds; a write is the only way to notice that the client went away
JOB_RETENTION = 15 * 60  # seconds a finished job stays readable through /api/jobs/<id>

_resolved = {}  # project dir -> (signature, project)
_projects = {}  # project id -> project, from the last scan
_jobs = {}  # job id -> job
_states = {"version": 0, "projects": {}, "containers": {}}  # from the last docker ps
_states_changed = threading.Condition()
_lock = threading.Lock()  # guards _projects, _jobs and the job outputs, written by the worker threads
_actions = threading.Lock()  # makes the "already running" check and the job registration atomic


def load_config():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as handle:
            config = yaml.safe_load(handle) or {}
    except FileNotFoundError:
        config = {}
    config.setdefault("roots", [])
    config.setdefault("max_depth", 4)
    config.setdefault("exclude", [])
    config.setdefault("projects", {})
    return config


def is_excluded(path, config):
    for excluded in config["exclude"]:
        excluded = os.path.expanduser(excluded).rstrip("/")
        if path == excluded or path.startswith(excluded + "/"):
            return True
    return False


def find_project_dirs(config):
    dirs = set()
    for root in config["roots"]:
        root = os.path.expanduser(root).rstrip("/")
        base_depth = root.count("/")
        for current, subdirs, files in os.walk(root):
            if is_excluded(current, config):
                subdirs[:] = []
                continue
            if any(name in files for name in COMPOSE_FILES):
                dirs.add(current)
            if current.count("/") - base_depth >= config["max_depth"]:
                subdirs[:] = []
            else:
                subdirs[:] = [d for d in subdirs if d not in SKIP_DIRS]

    # Projects already known by Docker, wherever they live
    try:
        result = subprocess.run(COMPOSE + ["ls", "--all", "--format", "json"], capture_output=True, text=True,
                                timeout=CONFIG_TIMEOUT)
    except subprocess.TimeoutExpired:
        return dirs
    if result.returncode == 0:
        for entry in json.loads(result.stdout or "[]"):
            first_file = (entry.get("ConfigFiles") or "").split(",")[0]
            if first_file and os.path.isfile(first_file) and not is_excluded(os.path.dirname(first_file), config):
                dirs.add(os.path.dirname(first_file))
    return dirs


def signature(directory):
    stamps = []
    for name in WATCHED_FILES:
        try:
            stamps.append(f"{name}:{os.stat(os.path.join(directory, name)).st_mtime_ns}")
        except FileNotFoundError:
            pass
    return "|".join(stamps)


def normalize_name(name):
    return re.sub(r"[^a-z0-9_-]", "", name.lower()) or "default"


def resolve(directory):
    sig = signature(directory)
    cached = _resolved.get(directory)
    if cached and cached[0] == sig:
        return cached[1]

    project = {
        "id": hashlib.sha1(directory.encode()).hexdigest()[:12],
        "dir": directory,
        "name": normalize_name(os.path.basename(directory)),
        "services": {},
        "profiles": [],
        "buildable": [],
        "error": None,
    }
    try:
        result = subprocess.run(COMPOSE + ["--profile", "*", "config", "--format", "json"],
                                cwd=directory, capture_output=True, text=True, timeout=CONFIG_TIMEOUT)
    except subprocess.TimeoutExpired:
        # Only this project is flagged, and it is not cached: the next refresh tries again
        project["error"] = f"docker compose config did not answer within {CONFIG_TIMEOUT} seconds"
        return project
    if result.returncode == 0:
        data = json.loads(result.stdout)
        project["name"] = data.get("name", project["name"])
        project["services"] = {name: sorted(service.get("profiles") or [])
                               for name, service in (data.get("services") or {}).items()}
        project["profiles"] = sorted({p for profiles in project["services"].values() for p in profiles})
        # Built locally: rebuilt, never pulled (their image name often does not exist in any registry)
        project["buildable"] = sorted(name for name, service in (data.get("services") or {}).items() if service.get("build"))
    else:
        lines = [line for line in result.stderr.strip().splitlines() if line.strip()]
        project["error"] = lines[-1] if lines else f"docker compose config exited with {result.returncode}"

    _resolved[directory] = (sig, project)
    return project


def scan():
    config = load_config()
    dirs = sorted(find_project_dirs(config))
    with ThreadPoolExecutor(max_workers=8) as pool:
        projects = list(pool.map(resolve, dirs))

    home = os.environ.get("HOME", "")
    payload = []
    for project in projects:
        settings = config["projects"].get(project["name"]) or {}
        payload.append({
            **project,
            "display_dir": project["dir"].replace(home, "~", 1) if home else project["dir"],
            "default_profiles": [p for p in settings.get("profiles") or [] if p in project["profiles"]],
            "confirm": bool(settings.get("confirm")),
            "self": project["name"] == SELF_PROJECT,
        })

    with _lock:
        _projects.clear()
        _projects.update({p["id"]: p for p in payload})
    return sorted(payload, key=lambda p: p["name"])


def read_states():
    """Compose containers by project, and the state of every container by name (dashboard cards)."""
    result = subprocess.run(
        ["docker", "ps", "--all", "--format",
         '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}\t{{.Status}}\t{{.Names}}'],
        capture_output=True, text=True, timeout=30)
    states, containers = {}, {}
    for line in result.stdout.splitlines():
        project, service, state, status, name = (line.split("\t") + [""] * 5)[:5]
        containers[name] = state
        if project:
            # The health is only exposed inside the status: "Up 2 minutes (unhealthy)", "(health: starting)"
            health = re.search(r"\((healthy|unhealthy|health: starting)\)", status)
            states.setdefault(project, []).append({
                "service": service, "state": state, "status": status, "name": name,
                "health": health.group(1).replace("health: ", "") if health else "",
            })
    return {"projects": states, "containers": containers}


def container_states():
    with _states_changed:
        return _states["projects"]


def refresh_states():
    try:
        fresh = read_states()
    except subprocess.TimeoutExpired:
        return
    with _states_changed:
        if fresh["projects"] != _states["projects"] or fresh["containers"] != _states["containers"]:
            _states.update(fresh, version=_states["version"] + 1)
            _states_changed.notify_all()


def watch_events():
    """Refreshes the states on Docker container events instead of polling them from every open page."""
    lines = queue.Queue()

    def reader():
        while True:
            process = subprocess.Popen(["docker", "events", "--format", "{{json .}}", *EVENT_FILTERS],
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            for line in process.stdout:
                lines.put(line)
            process.wait()
            # Daemon restarted or socket unavailable: events missed meanwhile are caught by the refresh below
            time.sleep(2)
            lines.put("restart")

    threading.Thread(target=reader, daemon=True).start()
    while True:
        try:
            lines.get(timeout=STATES_REFRESH)
            # A compose up emits a burst of events: one refresh for the whole burst
            time.sleep(STATES_DEBOUNCE)
            while not lines.empty():
                lines.get_nowait()
        except queue.Empty:
            pass  # periodic refresh: the "Up 5 minutes" statuses are not events
        refresh_states()


def start_job(project, action, profiles, services):
    # A service named on the command line starts even when its profile is not enabled
    if action == "create":
        args = ["--progress", "plain", "create", *services]
    elif action == "up" and services:
        args = ["--progress", "plain", "up", "--detach", *services]
    elif action == "up":
        args = [arg for p in profiles for arg in ("--profile", p)] + ["--progress", "plain", "up", "--detach"]
    elif action == "build":
        args = ["--progress", "plain", "up", "--detach", "--build", *services]
    elif action == "pull":
        args = ["--progress", "plain", "pull", *services]
    elif action == "restart":
        args = ["--profile", "*", "restart", *services]
    elif action == "stop":
        args = ["--profile", "*", "stop", *services]
    else:
        args = ["--profile", "*", "down"]

    return spawn(COMPOSE + args, project["dir"], project["id"], project["name"], action, services)


def orphans(project):
    """Containers of the project whose service is no longer in its configuration (renamed or removed)."""
    if project["error"]:
        return []
    return sorted(c["name"] for c in container_states().get(project["name"], []) if c["service"] not in project["services"])


def start_orphans_job(project):
    # Compose has no command removing only the orphans: "up --remove-orphans" also starts the project
    names = orphans(project)
    if not names:
        return None
    return spawn(["docker", "rm", "--force", *names], project["dir"], project["id"], project["name"], "remove-orphans", [])


def spawn(command, cwd, key, name, action, services):
    job = {"id": uuid.uuid4().hex[:12], "project": key, "name": name, "action": action, "services": services,
           "command": " ".join(c for c in command if c not in ("--ansi", "never")), "status": "running",
           "output": deque(maxlen=400), "started": time.time(), "ended": None}
    with _lock:
        # Finished jobs keep up to 400 output lines each: drop the old ones instead of keeping them forever
        expired = [i for i, j in _jobs.items() if j["ended"] and j["ended"] < job["started"] - JOB_RETENTION]
        for job_id in expired:
            del _jobs[job_id]
        _jobs[job["id"]] = job

    def worker():
        try:
            process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       text=True, bufsize=1)
            for line in process.stdout:
                with _lock:
                    job["output"].append(line.rstrip())
            status = "ok" if process.wait() == 0 else "error"
        except Exception as exc:  # noqa: BLE001 - reported to the UI
            with _lock:
                job["output"].append(str(exc))
            status = "error"
        with _lock:
            job["status"] = status
            job["ended"] = time.time()

    threading.Thread(target=worker, daemon=True).start()
    return job


def container_target(name):
    """Compose project and service of a container, from its labels; compose is None outside Compose or $HOME."""
    result = subprocess.run(["docker", "inspect", "--type", "container", "--format", "{{json .Config.Labels}}", name],
                            capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        return None
    labels = json.loads(result.stdout) or {}
    project = labels.get("com.docker.compose.project")
    service = labels.get("com.docker.compose.service")
    workdir = labels.get("com.docker.compose.project.working_dir")
    config_files = [f for f in labels.get("com.docker.compose.project.config_files", "").split(",") if f]
    # Outside the mounted $HOME the compose files are unreadable: only the plain container can be driven
    readable = project and service and workdir and config_files and all(os.path.isfile(f) for f in config_files)
    return {"project": project, "service": service, "workdir": workdir, "files": config_files if readable else None}


def update_kind(target):
    """"build" for a service with a build section, "pull" for the others, None when the config is unknown."""
    if not target or not target["files"]:
        return None
    project = resolve(target["workdir"])
    if project["error"] or target["service"] not in project["services"]:
        return None
    return "build" if target["service"] in project["buildable"] else "pull"


def start_container_job(name, action):
    """Drives the container of a Homepage card, through Compose when it belongs to a readable project."""
    target = container_target(name)
    if target is None:
        return None, "unknown container"
    if target["project"] == SELF_PROJECT:
        return None, "stacks cannot manage its own project"

    key = f"container:{name}"
    if running_jobs(key):
        return None, "an action is already running on this container"

    if not target["files"]:
        if action == "update":
            return None, "no compose file readable for this container"
        return spawn(["docker", action, name], None, key, name, action, []), None

    service = target["service"]
    if action == "update":
        kind = update_kind(target)
        if kind is None:
            return None, "service not found in the compose configuration"
        # Pulled then recreated when the image changed: a pull alone would not reach the running container
        args = ["--progress", "plain", "up", "--detach", "--build" if kind == "build" else "--pull=always", service]
    else:
        args = {"start": ["--progress", "plain", "up", "--detach", service], "stop": ["stop", service],
                "restart": ["restart", service]}[action]
    files = [arg for f in target["files"] for arg in ("-f", f)]
    return spawn(COMPOSE + ["-p", target["project"], *files, *args], target["workdir"], key, name, action, [service]), None


def running_jobs(key):
    with _lock:
        return [j for j in _jobs.values() if j["project"] == key and j["status"] == "running"]


def get_job(job_id):
    with _lock:
        job = _jobs.get(job_id)
    return serialize_job(job) if job else None


def serialize_job(job):
    """Copy taken under _lock: the worker thread appends to the output deque meanwhile."""
    with _lock:
        return {**job, "output": list(job["output"])}


class Handler(BaseHTTPRequestHandler):
    server_version = "stacks"

    def log_message(self, fmt, *args):
        if not self.path.startswith(("/api/states", "/api/jobs", "/api/health", "/api/events")) \
                and not self.path.endswith("/logs"):
            super().log_message(fmt, *args)

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_homepage_custom_js(self):
        """Homepage custom.js followed by ui.js and cards.js, routed by Traefik in place of /api/config/custom.js."""
        request = urllib.request.Request(f"{DASHBOARD_URL}/api/config/custom.js",
                                         headers={"Host": DASHBOARD_HOST} if DASHBOARD_HOST else {})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                original = response.read()
        except OSError as exc:
            original = f"// stacks: Homepage custom.js unavailable ({exc})".encode()
        body = b"\n;\n".join([original, STATIC["/ui.js"][0].read_bytes(), STATIC["/cards.js"][0].read_bytes()])
        self.send_response(200)
        self.send_header("Content-Type", "text/javascript; charset=utf-8")
        # Revalidated on each load, Homepage serves its own file again as soon as stacks stops
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_container_logs(self, name):
        """Server-sent events: the last lines, then the new ones until the container stops or the client leaves."""
        process = subprocess.Popen(["docker", "logs", "--follow", "--tail", str(LOG_TAIL), name],
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
        lines = queue.Queue()

        def reader():
            for line in process.stdout:
                lines.put(line.rstrip("\n"))
            lines.put(None)

        threading.Thread(target=reader, daemon=True).start()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            while True:
                try:
                    line = lines.get(timeout=LOG_HEARTBEAT)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                if line is None:
                    # Tells the client not to reconnect: EventSource would replay the tail in a loop
                    self.wfile.write(f"event: end\ndata: {process.wait()}\n\n".encode())
                    self.wfile.flush()
                    break
                self.wfile.write(f"data: {json.dumps(line)}\n\n".encode())
                # Bursts (the tail) are flushed once the queue is drained
                if lines.empty():
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            process.kill()
            process.wait()
        self.close_connection = True

    def send_states_stream(self):
        """Server-sent events: the container states, then each change pushed by watch_events."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        version = -1
        try:
            while True:
                with _states_changed:
                    _states_changed.wait_for(lambda: _states["version"] != version, timeout=LOG_HEARTBEAT)
                    changed = _states["version"] != version
                    version = _states["version"]
                    payload = json.dumps({"projects": _states["projects"], "containers": _states["containers"]})
                self.wfile.write(f"data: {payload}\n\n".encode() if changed else b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = True

    def do_GET(self):
        info = re.fullmatch(r"/api/containers/([A-Za-z0-9][A-Za-z0-9_.-]*)", self.path)
        if info:
            target = container_target(info.group(1))
            self.send_json({"update": update_kind(target), "self": target["project"] == SELF_PROJECT} if target
                           else {"error": "unknown container"}, 200 if target else 404)
            return
        if self.path == "/api/events":
            self.send_states_stream()
            return
        logs = re.fullmatch(r"/api/containers/([A-Za-z0-9][A-Za-z0-9_.-]*)/logs", self.path)
        if logs:
            self.send_container_logs(logs.group(1))
            return
        if self.path == "/homepage-custom.js":
            self.send_homepage_custom_js()
            return
        static = STATIC.get(self.path)
        if static:
            body = static[0].read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", static[1])
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/api/health":
            self.send_json({"status": "ok"})
        elif self.path == "/api/projects":
            self.send_json(scan())
        elif self.path == "/api/states":
            self.send_json(container_states())
        elif self.path.startswith("/api/jobs/"):
            job = get_job(self.path.rsplit("/", 1)[-1])
            self.send_json(job or {"error": "unknown job"}, 200 if job else 404)
        else:
            self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        # Cross-site guard: a custom header forces a CORS preflight that this server never answers
        origin = self.headers.get("Origin")
        host = self.headers.get("Host", "")
        if self.headers.get("X-Stacks-Request") != "1" or (origin and origin.split("://", 1)[-1] != host):
            self.send_json({"error": "forbidden"}, 403)
            return

        container = re.fullmatch(r"/api/containers/([A-Za-z0-9][A-Za-z0-9_.-]*)/(start|stop|restart|update)", self.path)
        if container:
            with _actions:
                job, error = start_container_job(*container.groups())
            self.send_json(serialize_job(job) if job else {"error": error}, 202 if job else 409 if "running" in error else 400)
            return

        match = re.fullmatch(r"/api/projects/([0-9a-f]{12})/(up|stop|down|create|restart|build|pull|remove-orphans)", self.path)
        if not match:
            self.send_json({"error": "not found"}, 404)
            return

        with _lock:
            project = _projects.get(match.group(1))
        if project is None:
            self.send_json({"error": "unknown project, refresh the list"}, 404)
            return
        if project["self"]:
            self.send_json({"error": "stacks cannot manage its own project"}, 400)
            return

        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        action = match.group(2)
        profiles = body.get("profiles") or []
        services = sorted(set(body.get("services") or []))
        if not isinstance(profiles, list) or any(p not in project["profiles"] for p in profiles):
            self.send_json({"error": "unknown profile"}, 400)
            return
        if any(s not in project["services"] for s in services) or (services and action == "down") \
                or (not services and action in ("create", "build", "pull")):
            self.send_json({"error": "unknown service"}, 400)
            return
        if (action == "build" and any(s not in project["buildable"] for s in services)) \
                or (action == "pull" and any(s in project["buildable"] for s in services)):
            self.send_json({"error": "build applies to services with a build section, pull to the others"}, 400)
            return

        # A project-wide action excludes any other one, service actions only exclude the same services
        with _actions:
            running = running_jobs(project["id"])
            if any(not services or not j["services"] or set(services) & set(j["services"]) for j in running):
                self.send_json({"error": "an action is already running on these services"}, 409)
                return
            job = start_orphans_job(project) if action == "remove-orphans" else start_job(project, action, profiles, services)
        if job is None:
            self.send_json({"error": "no orphan container"}, 400)
            return
        self.send_json(serialize_job(job), 202)


def init_docker_config():
    """Copies the host registry credentials into the writable DOCKER_CONFIG (HOME is mounted read-only)."""
    target = os.environ.get("DOCKER_CONFIG")
    source = os.path.join(os.environ.get("HOME", ""), ".docker", "config.json")
    if target and os.path.isfile(source):
        os.makedirs(target, exist_ok=True)
        shutil.copyfile(source, os.path.join(target, "config.json"))


if __name__ == "__main__":
    init_docker_config()
    refresh_states()
    threading.Thread(target=watch_events, daemon=True).start()
    print(f"stacks listening on :{PORT}", flush=True)
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
