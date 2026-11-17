#!/usr/bin/env python3
"""Create a dedicated Harly import key and keep its plaintext in Secret Manager only."""

import argparse
import json
import subprocess
import sys
import urllib.parse
import urllib.request


def cloud(args, *, stdin=None):
    result = subprocess.run(["gcloud", *args], input=stdin, capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError("Google Cloud operation failed; check the active identity and IAM permissions")
    return result.stdout.strip()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Unexpected redirect from Harly")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-base-url", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--admin-key-secret", required=True)
    parser.add_argument("--secret-name", default="harly-boss-resume-import-key")
    args = parser.parse_args()
    origin = urllib.parse.urlsplit(args.api_base_url)
    if origin.scheme != "https" or not origin.netloc or origin.username or origin.password or origin.query or origin.fragment:
        parser.error("api-base-url must be a trusted HTTPS origin")
    admin_key = cloud(["secrets", "versions", "access", "latest", "--secret", args.admin_key_secret,
                       "--project", args.project])
    exists = subprocess.run(["gcloud", "secrets", "describe", args.secret_name, "--project", args.project],
                            capture_output=True, timeout=120)
    if exists.returncode == 0:
        versions = cloud(["secrets", "versions", "list", args.secret_name, "--project", args.project,
                          "--filter=state=ENABLED", "--format=value(name)"])
        if versions:
            raise ValueError("Destination secret already has a credential; inspect it before provisioning another key")
    else:
        cloud(["secrets", "create", args.secret_name, "--project", args.project, "--replication-policy=automatic"])
    request = urllib.request.Request(args.api_base_url.rstrip("/") + "/api/v1/api-keys",
        headers={"Authorization": "Bearer " + admin_key, "Content-Type": "application/json"},
        data=json.dumps({"name": "BOSS resume incremental sync", "type": "secret",
                         "scopes": ["candidates:write"]}).encode())
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(request, timeout=90) as response:
        key = json.load(response)["data"]
    try:
        cloud(["secrets", "versions", "add", args.secret_name, "--project", args.project, "--data-file=-"],
              stdin=key["key"])
    except Exception:
        revoke = urllib.request.Request(args.api_base_url.rstrip("/") + "/api/v1/api-keys/" + key["id"],
            method="DELETE", headers={"Authorization": "Bearer " + admin_key})
        try:
            with opener.open(revoke, timeout=90):
                pass
        except Exception:
            print(json.dumps({"status": "requires_key_revocation", "keyId": key["id"]}))
        raise
    print(json.dumps({"status": "stored", "keyId": key["id"], "secretName": args.secret_name}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({"status": "blocked", "error": type(error).__name__}))
        sys.exit(1)
