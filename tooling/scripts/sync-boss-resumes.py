#!/usr/bin/env python3
"""Incrementally copy verified BOSS originals from Lark/GCS to Harly.

Requires Python 3.10+, lark-cli and gcloud with existing workload/user identity.
The API credential is read from Secret Manager into memory on every run.
"""

import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

MAX_BYTES = 10 * 1024 * 1024
FIELDS = ["Source", "Candidate Name", "Canonical Object Key", "Document SHA256", "Position", "email", "phone"]
MIME_TYPES = {
    ".pdf": "application/pdf", ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


# Final states for an original that can never be imported while its SHA256 stays the same (Harly accepts PDF / Word
# up to MAX_BYTES): recorded once and skipped afterwards, unlike `retry`.
UNSYNCABLE = ("too_large", "unsupported_type")


class Unsyncable(Exception):
    """The original can never be imported as it is: its state is the reason (one of UNSYNCABLE)."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Unexpected redirect from private service")


def request_bytes(url, *, headers=None, data=None, limit=MAX_BYTES):
    request = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=90) as response:
        value = response.read(limit + 1)
    if len(value) > limit:
        raise ValueError("Response exceeds size limit")
    return value


def command(args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"{Path(args[0]).name} timed out") from error
    if result.returncode:
        # CLI stderr can contain account or credential details. Keep it private.
        raise RuntimeError(f"{Path(args[0]).name} failed with exit {result.returncode}")
    return result.stdout.strip()


def lark_records(config):
    offset, seen = 0, set()
    while True:
        args = [config.get("lark_cli", "lark-cli"), "base", "+record-list", "--as",
                config.get("lark_identity", "user"), "--base-token", config["base_token"],
                "--table-id", config["table_id"], "--limit", "200", "--offset", str(offset),
                "--format", "json", "--filter-json", json.dumps({
                    "logic": "and", "conditions": [["Source", "intersects", ["BOSS"]]]})]
        for field in FIELDS:
            args += ["--field-id", field]
        response = json.loads(command(args))
        if not response.get("ok"):
            raise RuntimeError("Lark did not confirm the records query")
        page = response["data"]
        if page["fields"] != FIELDS or page.get("query_context", {}).get("record_scope") != "filtered_records":
            raise ValueError("Lark returned an unexpected projection or record scope")
        ids, rows = page["record_id_list"], page["data"]
        if len(ids) != len(rows) or any(len(row) != len(FIELDS) for row in rows):
            raise ValueError("Lark returned an incomplete records matrix")
        for record_id, row in zip(ids, rows):
            if record_id in seen:
                continue
            seen.add(record_id)
            yield record_id, dict(zip(FIELDS, row))
        if not page.get("has_more"):
            return
        next_offset = page.get("next_offset", offset + len(rows))
        if not rows or next_offset <= offset:
            raise ValueError("Lark pagination made no progress")
        offset = next_offset


def source_is_boss(value):
    return value == "BOSS" or isinstance(value, list) and "BOSS" in value


def object_name(bucket, canonical):
    if canonical.startswith("gs://"):
        parsed = urllib.parse.urlsplit(canonical)
        if parsed.netloc != bucket or parsed.query or parsed.fragment:
            raise ValueError("Canonical object points outside the configured private bucket")
        canonical = parsed.path.lstrip("/")
    if not canonical or canonical.startswith("/") or canonical.startswith(("http:", "https:")):
        raise ValueError("Invalid canonical object key")
    return canonical


def build_upload(record_id, fields, original):
    filename = Path(fields["Canonical Object Key"]).name
    content_type = MIME_TYPES.get(Path(filename).suffix.lower())
    if not content_type:
        raise ValueError("Unsupported original file type")
    candidate = {"name": fields["Candidate Name"]}
    for field in ("email", "phone"):
        value = fields.get(field)
        if isinstance(value, str) and value.strip():
            candidate[field] = value.strip()
    position = fields.get("Position")
    if isinstance(position, str) and position:
        candidate["position"] = position
    metadata = json.dumps({"sourceRecordId": record_id, "sha256": fields["Document SHA256"].lower(),
                           "candidate": candidate}, ensure_ascii=False).encode()
    boundary = "boss-" + uuid.uuid4().hex
    # Keep the original UTF-8 filename while disallowing multipart header injection.
    filename = filename.replace('"', "_").replace("\r", "_").replace("\n", "_").replace("\\", "_")
    prefix = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n'
        f'Content-Type: application/json\r\n\r\n').encode()
    middle = (f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
              f'Content-Type: {content_type}\r\n\r\n').encode()
    return boundary, prefix + metadata + middle + original + f"\r\n--{boundary}--\r\n".encode()


def import_original(config, api_key, record_id, fields, original):
    boundary, payload = build_upload(record_id, fields, original)
    response = json.loads(request_bytes(config["api_base_url"].rstrip("/") + "/api/v1/integrations/boss/resumes",
        headers={"Authorization": "Bearer " + api_key,
                 "Content-Type": "multipart/form-data; boundary=" + boundary}, data=payload, limit=64 * 1024))
    result = response.get("data", {})
    if (result.get("sourceRecordId") != record_id or result.get("sha256") != fields["Document SHA256"].lower()
            or not result.get("candidateId") or not result.get("fileId")):
        raise ValueError("Harly did not confirm a matching candidate attachment")
    for field in ("candidateId", "fileId"):
        uuid.UUID(result[field])
    return result


def sync(config, *, record_id=None, verify_repeat=False):
    state_path = Path(config["state_path"]).expanduser()
    state_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.umask(0o077)
    counts = {"eligible": 0, "synced": 0, "unchanged": 0, "failed": 0, "missing_original": 0,
              "unsyncable": 0, "skipped_unsyncable": 0}
    with state_path.with_suffix(".lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"status": "already_running"}
        if config.get("gcloud_python"):
            os.environ["CLOUDSDK_PYTHON"] = config["gcloud_python"]
        gcloud = config.get("gcloud", "gcloud")
        api_key = command([gcloud, "secrets", "versions", "access", "latest", "--secret",
                           config["api_key_secret"], "--project", config["gcp_project"]])
        with contextlib.closing(sqlite3.connect(state_path)) as state:
            # A checkpoint must never be reused for a different Base or Harly deployment.
            state.execute("CREATE TABLE IF NOT EXISTS sync_config (id INTEGER PRIMARY KEY, identity TEXT NOT NULL)")
            identity = json.dumps({key: config[key] for key in
                ("base_token", "table_id", "api_base_url", "gcs_bucket", "api_key_secret", "gcp_project")}, sort_keys=True)
            previous_config = state.execute("SELECT identity FROM sync_config WHERE id=1").fetchone()
            if previous_config and previous_config[0] != identity:
                raise ValueError("Use a separate state_path for each source and destination")
            state.execute("INSERT OR IGNORE INTO sync_config VALUES (1,?)", (identity,))
            state.execute("""CREATE TABLE IF NOT EXISTS resume_sync (
                source_record_id TEXT PRIMARY KEY, sha256 TEXT, candidate_id TEXT, file_id TEXT,
                state TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT)""")
            for current_id, fields in lark_records(config):
                if not source_is_boss(fields["Source"]) or record_id and record_id != current_id:
                    continue
                counts["eligible"] += 1
                sha = fields.get("Document SHA256") or ""
                previous = state.execute("SELECT sha256,state FROM resume_sync WHERE source_record_id=?",
                                         (current_id,)).fetchone()
                if previous == (sha.lower(), "synced") and not verify_repeat:
                    counts["unchanged"] += 1
                    continue
                if previous and previous[0] == sha.lower() and previous[1] in UNSYNCABLE:
                    # The same original was already found too large or of an unsupported type: it can never be
                    # imported, so it is not downloaded again on every run (each retry held the lock ~1-2 minutes).
                    counts["skipped_unsyncable"] += 1
                    continue
                now = datetime.datetime.now(datetime.timezone.utc).isoformat()
                try:
                    canonical = fields.get("Canonical Object Key")
                    if not canonical:
                        counts["missing_original"] += 1
                        raise ValueError("Original not available yet")
                    if not re.fullmatch(r"[a-fA-F0-9]{64}", sha):
                        raise ValueError("Document SHA256 is missing or invalid")
                    if not isinstance(fields.get("Candidate Name"), str) or not fields["Candidate Name"].strip():
                        raise ValueError("Candidate name is missing")
                    key = object_name(config["gcs_bucket"], canonical)
                    if not MIME_TYPES.get(Path(canonical).suffix.lower()):
                        raise Unsyncable("unsupported_type")
                    token = command([gcloud, "auth", "print-access-token"])
                    url = ("https://storage.googleapis.com/storage/v1/b/" + urllib.parse.quote(config["gcs_bucket"], safe="")
                           + "/o/" + urllib.parse.quote(key, safe=""))
                    headers = {"Authorization": "Bearer " + token}
                    size = int(json.loads(request_bytes(url, headers=headers, limit=64 * 1024)).get("size") or 0)
                    if size > MAX_BYTES:
                        raise Unsyncable("too_large")   # over Harly's resume upload limit: never downloaded
                    original = request_bytes(url + "?alt=media", headers=headers)
                    if not original or hashlib.sha256(original).hexdigest() != sha.lower():
                        raise ValueError("GCS original does not match Document SHA256")
                    result = import_original(config, api_key, current_id, fields, original)
                    if verify_repeat:
                        repeated = import_original(config, api_key, current_id, fields, original)
                        if (result["candidateId"], result["fileId"]) != (repeated["candidateId"], repeated["fileId"]):
                            raise ValueError("Repeated import created a different attachment")
                    state.execute("""INSERT INTO resume_sync VALUES (?,?,?,?,?,?,NULL)
                        ON CONFLICT(source_record_id) DO UPDATE SET sha256=excluded.sha256,
                        candidate_id=excluded.candidate_id,file_id=excluded.file_id,
                        state=excluded.state,updated_at=excluded.updated_at,error=NULL""",
                        (current_id, sha.lower(), result["candidateId"], result["fileId"], "synced", now))
                    counts["synced"] += 1
                    print(json.dumps({"sourceRecordId": current_id, **result}, ensure_ascii=False))
                except Unsyncable as error:
                    state.execute("""INSERT INTO resume_sync VALUES (?,?,NULL,NULL,?,?,NULL)
                        ON CONFLICT(source_record_id) DO UPDATE SET sha256=excluded.sha256,state=excluded.state,
                        updated_at=excluded.updated_at,error=NULL""", (current_id, sha.lower(), str(error), now))
                    counts["unsyncable"] += 1
                    print(json.dumps({"sourceRecordId": current_id, "state": str(error)}))
                except (ValueError, RuntimeError, urllib.error.URLError, TimeoutError) as error:
                    # HTTP response bodies, tokens and candidate PII never enter the ledger or stdout.
                    code = f"HTTP_{error.code}" if isinstance(error, urllib.error.HTTPError) else type(error).__name__
                    state.execute("""INSERT INTO resume_sync VALUES (?,?,NULL,NULL,'retry',?,?)
                        ON CONFLICT(source_record_id) DO UPDATE SET state='retry',updated_at=excluded.updated_at,
                        error=excluded.error""", (current_id, sha.lower(), now, code))
                    counts["failed"] += 1
                    print(json.dumps({"sourceRecordId": current_id, "state": "retry", "error": code}))
                state.commit()
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--record-id", help="Limit the acceptance run to one Lark record")
    parser.add_argument("--verify-repeat", action="store_true", help="Submit the same original twice and compare IDs")
    args = parser.parse_args()
    if args.verify_repeat and not args.record_id:
        parser.error("--verify-repeat requires --record-id")
    config = json.loads(args.config.read_text())
    origin = urllib.parse.urlsplit(config["api_base_url"])
    if origin.scheme != "https" or not origin.netloc or origin.username or origin.password or origin.query or origin.fragment:
        parser.error("api_base_url must be a trusted HTTPS origin")
    try:
        result = sync(config, record_id=args.record_id, verify_repeat=args.verify_repeat)
    except (RuntimeError, ValueError, OSError) as error:
        print(json.dumps({"status": "blocked", "error": type(error).__name__}))
        return 1
    print(json.dumps(result))
    return int(bool(result.get("failed")))


if __name__ == "__main__":
    sys.exit(main())
