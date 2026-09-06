#!/usr/bin/env python3
"""Capture and replay dated public evidence without writing to the trading checkout.

Private audit inputs stay below .vercel (excluded from Git and deployment).
The upstream auditors run unchanged against a narrow, local input view.
No wallet, signer, execution module, or collector restart is used.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
RESEARCH = ROOT.parent / "internet-money-machine"
HOUR = 3_600_000
sys.path[:0] = [str(RESEARCH), str(RESEARCH / "scripts")]


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf8") as handle:
        json.dump(value, handle, indent=2, allow_nan=False)
        handle.write("\n")


def module(name):
    path = RESEARCH / "scripts" / (name + ".py")
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def merge_history(old, new):
    by_time = {r[0]: r for r in old}
    if len(by_time) != len(old) or len({r[0] for r in new}) != len(new):
        raise ValueError("duplicate market-history time")
    for row in new:
        if row[0] in by_time and by_time[row[0]] != row:
            raise ValueError("new public history disagrees with the stored overlap")
        by_time[row[0]] = row
    return [by_time[t] for t in sorted(by_time)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True)
    args = parser.parse_args()
    if not args.name or any(c not in "0123456789-" for c in args.name):
        raise ValueError("use a unique numeric UTC date-time name")
    destination = ROOT / ".vercel/trades-audits" / args.name
    destination.mkdir(parents=True, exist_ok=False)
    date = args.name[:8]
    capture_path = destination / f"hl-account-capture-{date}.json"
    account_path = destination / f"hl-account-audit-{date}.json"
    participation_path = destination / f"hl-zec-v5-participation-audit-{date}.json"
    capture_module = module("hl-account-capture")
    print(json.dumps(capture_module.capture(capture_path)), flush=True)
    capture_raw = capture_path.read_bytes()
    capture = json.loads(capture_raw)
    event_path = RESEARCH / "state/hyperliquid/event-live-results.jsonl"
    event_raw = event_path.read_bytes()
    auditor = module("hl-account-audit")
    account = auditor.summarize(capture, [json.loads(r) for r in event_raw.splitlines()])
    account["sources"] = {"capture": str(capture_path), "captureSha256": sha(capture_raw),
        "eventLedgerSha256": sha(event_raw), "auditorSha256": sha(Path(auditor.__file__).read_bytes())}
    save(account_path, account)

    participation_auditor = module("hl-zec-v5-participation-audit")
    history = RESEARCH / "state/hyperliquid/swing_bot/history"
    pointer_raw = (history / "_current.json").read_bytes()
    generation = participation_auditor.decode(pointer_raw)["generation"]
    if not isinstance(generation, str) or not generation.startswith("gen-") or any(
            not c.isalnum() and c not in "-_" for c in generation):
        raise ValueError("invalid stored generation")
    base = history / "generations" / generation
    candle_raw, funding_raw = (base / "ZEC.json").read_bytes(), (base / "funding/ZEC.json").read_bytes()
    candles, funding = map(participation_auditor.decode, (candle_raw, funding_raw))
    last = capture["cutoffMs"] // HOUR * HOUR - HOUR
    if last - max(r[0] for r in candles) > 72 * HOUR:
        raise ValueError("history extension exceeds this bounded 72-hour audit")
    from hl_swing_bot.data import HyperliquidInfoClient, MinuteWeightLimiter
    client = HyperliquidInfoClient(timeout=15, limiter=MinuteWeightLimiter(limit=300))
    requests = []

    def request(body):
        started = time.time_ns() // 1_000_000
        rows = client.post(body, estimated_weight=25)
        received = time.time_ns() // 1_000_000
        if not isinstance(rows, list) or len(rows) >= 500:
            raise ValueError("unexpected or saturated market-history response")
        requests.append({"request": body, "startedAtMs": started, "receivedAtMs": received,
            "response": rows, "responseSha256": sha(auditor.canonical(rows).encode())})
        return rows

    start = max(r[0] for r in candles)
    raw_candles = request({"type": "candleSnapshot", "req": {"coin": "ZEC", "interval": "1h",
        "startTime": start, "endTime": last + HOUR - 1}})
    new_candles = []
    for r in raw_candles:
        if r.get("s") != "ZEC" or r.get("i") != "1h" or not start <= r["t"] <= last:
            raise ValueError("candle identity or closed-hour bounds changed")
        new_candles.append([r["t"], *[float(r[k]) for k in ("o", "h", "l", "c", "v")]])
    funding_start = max(r[0] for r in funding) // HOUR * HOUR
    raw_funding = request({"type": "fundingHistory", "coin": "ZEC", "startTime": funding_start,
        "endTime": min(capture["cutoffMs"], last + HOUR + 119_999)})
    new_funding = []
    for r in raw_funding:
        if r.get("coin") != "ZEC" or not funding_start <= r["time"] <= capture["cutoffMs"]:
            raise ValueError("funding identity or evidence cutoff changed")
        new_funding.append([r["time"], float(r["fundingRate"])])
    candles, funding = merge_history(candles, new_candles), merge_history(funding, new_funding)
    if max(r[0] for r in candles) != last:
        raise ValueError("latest completed candle is missing")
    save(destination / "market-extension.json", {"api": "https://api.hyperliquid.xyz/info",
        "submissionCapability": False, "requests": requests,
        "baseGeneration": generation, "basePointerSha256": sha(pointer_raw),
        "baseCandlesSha256": sha(candle_raw), "baseFundingSha256": sha(funding_raw),
        "note": "Hashes bind decoded JSON, not original HTTP-wire bytes."})

    view = destination / "input-view"
    gen = "gen-audit-" + args.name
    h = view / "state/hyperliquid/swing_bot/history"
    save(h / "_current.json", {"generation": gen})
    save(h / "generations" / gen / "ZEC.json", candles)
    save(h / "generations" / gen / "funding/ZEC.json", funding)
    events = view / "state/hyperliquid/event-live-results.jsonl"
    with events.open("xb") as handle:
        handle.write(event_raw)
    links = {
        "scripts/hl-effort-audit.py": RESEARCH / "scripts/hl-effort-audit.py",
        "scripts/hl-account-audit.py": RESEARCH / "scripts/hl-account-audit.py",
        "state/hyperliquid/logs/positive-funding-pump-live.stdout.log": RESEARCH / "state/hyperliquid/logs/positive-funding-pump-live.stdout.log",
        # Compatibility filename expected by the unchanged historical auditor;
        # its actual capture date is validated from cutoffMs, never this alias.
        "reviews/hl-account-capture-20260905.json": capture_path,
    }
    for name, target in links.items():
        link = view / name
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(target)
    report = participation_auditor.build_report(view)
    if report["auditThroughSignalStartMs"] != last or report["accountFillCaptureCutoffMs"] != capture["cutoffMs"]:
        raise ValueError("audit evidence cutoff mismatch")
    for source in report["sources"]:
        source["resolvedPath"] = str(Path(source["path"]).resolve())
    report["extensionEvidence"] = {"path": str(destination / "market-extension.json"),
        "sha256": sha((destination / "market-extension.json").read_bytes()),
        "adapterSha256": sha(Path(__file__).read_bytes()),
        "note": "Read-only input view; historical capture filename is an alias to the newer dated capture."}
    save(participation_path, report)
    references = {k: {"path": str(p.relative_to(ROOT)), "sha256": sha(p.read_bytes())}
        for k, p in (("account", account_path), ("participation", participation_path))}
    save(destination / "export-references.json", references)
    print(json.dumps({"references": references, "equityUsd": account["equityUsd"],
        "accountEvidenceThrough": datetime.fromtimestamp(capture["cutoffMs"] / 1000, timezone.utc).isoformat(),
        "signalEvidenceThrough": datetime.fromtimestamp((last + HOUR) / 1000, timezone.utc).isoformat(),
        "strongSignals": report["strongSelectedEvents"], "classifications": report["classificationCounts"],
        "missingDirectObservationHourCount": report["missingDirectObservationHourCount"]}), flush=True)


if __name__ == "__main__":
    main()
