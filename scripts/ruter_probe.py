#!/usr/bin/env python3
"""Probe the Ruter app GraphQL endpoint without accessing user accounts."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

ENDPOINT = "https://cosmo-router.transhub.io/graphql"
TOKEN_MUTATION = """
mutation getAnonymousToken {
  getAnonymousCustomerToken_v2 {
    accessToken
  }
}
"""
AUTH_PROBE = "{ __typename }"


def post_graphql(query: str, token: str | None, timeout: int) -> dict[str, Any]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "norway-transit-display-research/0.1",\n        "client-platform": "android",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps({"query": query}).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            status = response.status
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1500]
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"Network error: {exc}") from exc

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Endpoint returned non-JSON response") from exc
    if data.get("errors"):
        raise RuntimeError("GraphQL errors: " + json.dumps(data["errors"])[:1500])
    return {"http_status": status, "body": data}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=int, default=20)
    args = parser.parse_args()

    report: dict[str, Any] = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "endpoint": ENDPOINT,
        "token_request": "not_started",
        "authenticated_probe": "not_started",
    }

    try:
        token_response = post_graphql(TOKEN_MUTATION, None, args.timeout)
        token_data = token_response["body"].get("data") or {}
        token = (
            (token_data.get("getAnonymousCustomerToken_v2") or {}).get("accessToken")
        )
        if not token:
            raise RuntimeError("Anonymous-token mutation returned no accessToken")
        report["token_request"] = "success"
        # Deliberately never print, persist, or include the token in diagnostics.
        probe = post_graphql(AUTH_PROBE, token, args.timeout)
        report["authenticated_probe"] = "success"
        report["probe_result"] = probe["body"].get("data")
        print(json.dumps(report, indent=2))
        return 0
    except RuntimeError as exc:
        report["error"] = str(exc)
        print(json.dumps(report, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
