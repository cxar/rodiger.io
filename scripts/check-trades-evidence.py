#!/usr/bin/env python3
"""Offline replay of the hash-pinned account and participation audit receipts."""
import importlib.util
import json
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("evidence_adapter", ROOT / "scripts/refresh-trades-evidence.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def read_reference(ref):
    path = ROOT / ref["path"]
    if not path.resolve().is_relative_to(ROOT / ".vercel/trades-audits"):
        raise ValueError("audit reference escaped private evidence directory")
    raw = path.read_bytes()
    assert adapter.sha(raw) == ref["sha256"], "dated audit hash mismatch"
    return path, json.loads(raw)


def main():
    old = [[1, 10], [2, 20]]
    assert adapter.merge_history(old, [[2, 20], [3, 30]]) == [[1, 10], [2, 20], [3, 30]]
    assert old == [[1, 10], [2, 20]]
    for initial, extension in [(old, [[2, 99]]), (old, [[3, 30], [3, 30]]), ([[1, 10], [1, 10]], [])]:
        try:
            adapter.merge_history(initial, extension)
        except ValueError:
            pass
        else:
            raise AssertionError("conflicting or duplicate history was accepted")
    with tempfile.TemporaryDirectory(prefix="trades-exclusive-write-") as temporary:
        path = Path(temporary) / "receipt.json"
        adapter.save(path, {"original": True})
        try:
            adapter.save(path, {"overwritten": True})
        except FileExistsError:
            pass
        else:
            raise AssertionError("immutable receipt was overwritten")
        assert json.loads(path.read_bytes()) == {"original": True}
    refs = json.loads((ROOT / "config/hyperliquid-evidence-sources.json").read_bytes())
    account_path, account = read_reference(refs["account"])
    _, participation = read_reference(refs["participation"])
    directory = account_path.parent
    view = directory / "input-view"
    capture_path = Path(account["sources"]["capture"])
    capture_raw = capture_path.read_bytes()
    event_raw = (view / "state/hyperliquid/event-live-results.jsonl").read_bytes()
    assert adapter.sha(capture_raw) == account["sources"]["captureSha256"]
    assert adapter.sha(event_raw) == account["sources"]["eventLedgerSha256"]
    auditor = adapter.module("hl-account-audit")
    assert adapter.sha(Path(auditor.__file__).read_bytes()) == account["sources"]["auditorSha256"]
    assert auditor.summarize(json.loads(capture_raw), [json.loads(r) for r in event_raw.splitlines()]) == {
        k: v for k, v in account.items() if k != "sources"}
    for source in participation["sources"]:
        raw = Path(source["path"]).read_bytes()
        assert len(raw) == source["bytes"] and adapter.sha(raw) == source["sha256"]

    extension_raw = Path(participation["extensionEvidence"]["path"]).read_bytes()
    assert adapter.sha(extension_raw) == participation["extensionEvidence"]["sha256"]
    assert adapter.sha(Path(adapter.__file__).read_bytes()) == participation["extensionEvidence"]["adapterSha256"]
    extension = json.loads(extension_raw)
    assert extension["api"] == "https://api.hyperliquid.xyz/info" and extension["submissionCapability"] is False
    history = adapter.RESEARCH / "state/hyperliquid/swing_bot/history"
    base = history / "generations" / extension["baseGeneration"]
    candle_raw, funding_raw = (base / "ZEC.json").read_bytes(), (base / "funding/ZEC.json").read_bytes()
    assert adapter.sha(candle_raw) == extension["baseCandlesSha256"]
    assert adapter.sha(funding_raw) == extension["baseFundingSha256"]
    requests = extension["requests"]
    assert [r["request"]["type"] for r in requests] == ["candleSnapshot", "fundingHistory"]
    for request in requests:
        assert request["startedAtMs"] <= request["receivedAtMs"]
        assert adapter.sha(auditor.canonical(request["response"]).encode()) == request["responseSha256"]
    assert requests[0]["receivedAtMs"] <= requests[1]["startedAtMs"]
    new_candles = [[r["t"], *[float(r[k]) for k in ("o", "h", "l", "c", "v")]] for r in requests[0]["response"]]
    new_funding = [[r["time"], float(r["fundingRate"])] for r in requests[1]["response"]]
    h = view / "state/hyperliquid/swing_bot/history"
    gen = json.loads((h / "_current.json").read_bytes())["generation"]
    assert adapter.merge_history(json.loads(candle_raw), new_candles) == json.loads((h / "generations" / gen / "ZEC.json").read_bytes())
    assert adapter.merge_history(json.loads(funding_raw), new_funding) == json.loads((h / "generations" / gen / "funding/ZEC.json").read_bytes())

    auditor = adapter.module("hl-zec-v5-participation-audit")
    assert adapter.sha(Path(auditor.__file__).read_bytes()) == participation["auditSourceSha256"]
    prefix = participation["runtime"]["input"]
    with Path(prefix["path"]).open("rb") as handle:
        raw = handle.read(prefix["prefixBytes"])
    assert len(raw) == prefix["prefixBytes"] and adapter.sha(raw) == prefix["prefixSha256"]
    assert raw.count(b"\n") == prefix["prefixRows"]
    # Replay exactly the already captured complete-line prefix, excluding later
    # appended runtime observations. This adapter never writes to the live log.
    with tempfile.TemporaryDirectory(prefix="trades-audit-replay-") as temporary:
        log = Path(temporary) / "runtime.jsonl"
        with log.open("xb") as handle:
            handle.write(raw)
        scan = auditor.scan_log

        def fixed_scan(path, last, selector=None):
            assert str(path) == prefix["path"]
            result = scan(log, last, selector)
            result["input"]["path"] = str(path)
            return result

        auditor.scan_log = fixed_scan
        replayed = auditor.build_report(view)
    expected = {k: v for k, v in participation.items() if k != "extensionEvidence"}
    for source in expected["sources"]:
        source.pop("resolvedPath", None)
    replayed["generatedAtUtc"] = expected["generatedAtUtc"]
    assert replayed == expected, "participation audit replay differs"
    print(json.dumps({"status": "verified", "accountCutoffMs": account["cutoffMs"],
        "signalStartMs": participation["auditThroughSignalStartMs"], "fillCount": account["fillCount"],
        "missingDirectObservationHours": participation["missingDirectObservationHourCount"]}))


if __name__ == "__main__":
    main()
