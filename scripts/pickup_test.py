"""Pickup/socket-connection reliability test.

Repeatedly triggers a real outbound call via SmartFlo or Exotel, waits for a
human to confirm the end user answered, then checks whether a WebSocket
connection lands on /ws/smartflo-test within a timeout window. Reports the
pass/fail rate and connect latency across N samples.

Requires the target server (app/routes.py) running and reachable at --base-url,
and provider credentials set in .env (see .env.example).

Usage:
    uv run python scripts/pickup_test.py --provider smartflo -n 10
    uv run python scripts/pickup_test.py --provider exotel -n 10 --timeout 5
"""

from __future__ import annotations

import argparse
import asyncio
import os
import statistics
import time
from dataclasses import dataclass

import aiohttp
from dotenv import load_dotenv

load_dotenv()


@dataclass
class Sample:
    triggered: bool
    ref: str | None
    connected: bool
    latency: float | None
    error: str | None = None


async def trigger_smartflo(session: aiohttp.ClientSession) -> tuple[bool, str | None, str | None]:
    url = "https://api-smartflo.tatateleservices.com/v1/click_to_call_support"
    body = {
        "async": 1,
        "customer_number": os.environ["SMARTFLO_CUSTOMER_NUMBER"],
        "caller_id": os.environ["SMARTFLO_CALLER_ID"],
        "api_key": os.environ["SMARTFLO_API_KEY"],
        "customer_ring_timeout": 30,
    }
    async with session.post(url, json=body) as resp:
        data = await resp.json()
        if not data.get("success"):
            return False, None, data.get("message", f"HTTP {resp.status}")
        return True, data.get("ref_id"), None


async def trigger_exotel(session: aiohttp.ClientSession) -> tuple[bool, str | None, str | None]:
    sid = os.environ["EXOTEL_SID"]
    url = f"https://api.exotel.com/v1/Accounts/{sid}/Calls/connect.json"
    auth = aiohttp.BasicAuth(os.environ["EXOTEL_API_KEY"], os.environ["EXOTEL_API_TOKEN"])
    form = {
        "From": os.environ["EXOTEL_FROM_NUMBER"],
        "CallerId": os.environ["EXOTEL_CALLER_ID"],
        "Url": os.environ["EXOTEL_FLOW_URL"],
    }
    async with session.post(url, data=form, auth=auth) as resp:
        data = await resp.json()
        call = data.get("Call") or {}
        if resp.status >= 300 or not call:
            return False, None, f"HTTP {resp.status}: {data}"
        return True, call.get("Sid"), None


TRIGGERS = {
    "smartflo": trigger_smartflo,
    "exotel": trigger_exotel,
}


async def get_connect_count(session: aiohttp.ClientSession, base_url: str) -> int:
    async with session.get(f"{base_url}/ws/smartflo-test/status") as resp:
        data = await resp.json()
        return data["connect_count"]


async def wait_for_connection(
    session: aiohttp.ClientSession, base_url: str, baseline: int, timeout: float
) -> tuple[bool, float | None]:
    start = time.monotonic()
    deadline = start + timeout
    while time.monotonic() < deadline:
        count = await get_connect_count(session, base_url)
        if count > baseline:
            return True, time.monotonic() - start
        await asyncio.sleep(0.1)
    return False, None


async def run(provider: str, samples: int, timeout: float, base_url: str) -> None:
    base_url = base_url.rstrip("/")
    trigger = TRIGGERS[provider]
    results: list[Sample] = []

    async with aiohttp.ClientSession() as session:
        for i in range(1, samples + 1):
            print(f"\n=== Sample {i}/{samples} ({provider}) ===")
            await asyncio.to_thread(input, f"Press Enter to trigger sample {i}/{samples} >>> ")
            baseline = await get_connect_count(session, base_url)

            try:
                ok, ref, err = await trigger(session)
            except Exception as exc:
                print(f"Trigger failed: {exc}")
                results.append(Sample(triggered=False, ref=None, connected=False, latency=None, error=str(exc)))
                continue

            if not ok:
                print(f"Trigger rejected: {err}")
                results.append(Sample(triggered=False, ref=None, connected=False, latency=None, error=err))
                continue

            print(f"Call triggered (ref={ref}). Dialing...")
            await asyncio.to_thread(input, "Press Enter the moment the end user answers >>> ")

            connected, latency = await wait_for_connection(session, base_url, baseline, timeout)
            if connected:
                print(f"Connected in {latency:.2f}s")
            else:
                print(f"No connection within {timeout}s")
            results.append(Sample(triggered=True, ref=ref, connected=connected, latency=latency))

    print_summary(results, timeout)


def print_summary(results: list[Sample], timeout: float) -> None:
    total = len(results)
    triggered = [r for r in results if r.triggered]
    connected = [r for r in results if r.connected]
    latencies = [r.latency for r in connected if r.latency is not None]

    print("\n" + "=" * 50)
    print("SUMMARY")
    print("=" * 50)
    print(f"Total samples:          {total}")
    print(f"Call trigger failed:    {total - len(triggered)}")
    rate = f"{len(connected) / len(triggered) * 100:.1f}%" if triggered else "n/a"
    print(f"Connected within {timeout}s: {len(connected)}/{len(triggered)} ({rate})")
    if latencies:
        print(
            f"Latency avg/median/max: "
            f"{statistics.mean(latencies):.2f}s / {statistics.median(latencies):.2f}s / {max(latencies):.2f}s"
        )
    failures = [r for r in results if r.triggered and not r.connected]
    if failures:
        print(f"Failed refs: {[r.ref for r in failures]}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Repeatedly test call-pickup -> socket-connection latency")
    parser.add_argument("--provider", choices=sorted(TRIGGERS), required=True)
    parser.add_argument("-n", "--samples", type=int, default=10)
    parser.add_argument("--timeout", type=float, default=5.0, help="seconds to wait for the socket after pickup")
    parser.add_argument(
        "--base-url", default="http://127.0.0.1:8000", help="base URL of the running socket-connector server"
    )
    args = parser.parse_args()

    asyncio.run(run(args.provider, args.samples, args.timeout, args.base_url))


if __name__ == "__main__":
    main()
