#!/usr/bin/env python3
"""Backfill de tickerUsa y ratio en trades historicos de Firestore.

Usa la coleccion `tickers` como fuente de verdad:
  - toma `tickerUsa`
  - busca el ratio vigente por fecha en `ratioHistory`
  - si no hay historial, usa `ratio`

Por defecto corre en dry-run. Con --apply actualiza los documentos de `trades/*/items/*`.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

import jwt
import requests


ENV_PATH = pathlib.Path(".env")


@dataclass
class RatioInfo:
    ticker: str
    ticker_usa: str
    ratio: Decimal
    source: str
    valid_from: str | None = None
    valid_to: str | None = None


@dataclass
class TradeRow:
    document_name: str
    document_path: str
    trade_id: str
    fecha: str
    ticker: str
    current_ticker_usa: str | None
    current_ratio: Decimal | None


@dataclass
class BackfillResult:
    ticker: str
    fecha: str
    trade_id: str
    document_path: str
    action: str
    reason: str
    current_ticker_usa: str | None = None
    next_ticker_usa: str | None = None
    current_ratio: Decimal | None = None
    next_ratio: Decimal | None = None


def load_env() -> dict[str, str]:
    env = dict(os.environ)
    if not ENV_PATH.exists():
        return env

    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env.setdefault(key, value)

    return env


def firestore_token(env: dict[str, str]) -> str:
    project_id = env.get("FIREBASE_PROJECT_ID")
    client_email = env.get("FIREBASE_CLIENT_EMAIL")
    private_key = env.get("FIREBASE_PRIVATE_KEY")
    if not project_id or not client_email or not private_key:
        raise RuntimeError(
            "Faltan FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL o FIREBASE_PRIVATE_KEY"
        )

    now = int(time.time())
    claims = {
        "iss": client_email,
        "scope": "https://www.googleapis.com/auth/datastore",
        "aud": "https://oauth2.googleapis.com/token",
        "iat": now,
        "exp": now + 3600,
    }
    assertion = jwt.encode(
        claims,
        private_key.replace("\\n", "\n"),
        algorithm="RS256",
    )
    response = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion,
        },
        timeout=30,
    )
    response.raise_for_status()
    return response.json()["access_token"]


def firestore_base_url(project_id: str) -> str:
    return (
        f"https://firestore.googleapis.com/v1/projects/{project_id}"
        "/databases/(default)/documents"
    )


def decode_firestore_value(value: dict[str, Any] | None) -> Any:
    if not value:
        return None
    if "stringValue" in value:
        return value["stringValue"]
    if "integerValue" in value:
        return int(value["integerValue"])
    if "doubleValue" in value:
        return Decimal(str(value["doubleValue"]))
    if "booleanValue" in value:
        return value["booleanValue"]
    if "timestampValue" in value:
        return value["timestampValue"]
    if "nullValue" in value:
        return None
    if "mapValue" in value:
        fields = value.get("mapValue", {}).get("fields", {})
        return {key: decode_firestore_value(item) for key, item in fields.items()}
    if "arrayValue" in value:
        values = value.get("arrayValue", {}).get("values", [])
        return [decode_firestore_value(item) for item in values]
    return None


def encode_firestore_value(value: Any) -> dict[str, Any]:
    if isinstance(value, Decimal):
        return {"doubleValue": float(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, int):
        return {"integerValue": str(value)}
    if isinstance(value, bool):
        return {"booleanValue": value}
    if value is None:
        return {"nullValue": None}
    return {"stringValue": str(value)}


def normalize_ticker(value: Any) -> str | None:
    if value in (None, ""):
        return None
    ticker = str(value).strip().upper()
    return ticker.replace(".C", "C") if ticker.endswith(".C") else ticker


def parse_decimal(value: Any) -> Decimal | None:
    if value in (None, ""):
        return None
    if isinstance(value, Decimal):
        return value

    text = str(value).strip().replace("$", "")
    if "," in text:
        text = text.replace(".", "").replace(",", ".")

    try:
        return Decimal(text)
    except InvalidOperation:
        return None


def quantize_decimal(value: Decimal, places: str = "0.000001") -> Decimal:
    return value.quantize(Decimal(places), rounding=ROUND_HALF_UP)


def date_in_range(date: str, valid_from: str | None, valid_to: str | None) -> bool:
    return (not valid_from or date >= valid_from) and (not valid_to or date <= valid_to)


def ratio_sort_key(info: RatioInfo) -> tuple[int, str]:
    return (1 if info.valid_from else 0, info.valid_from or "")


def resolve_ratio_info(ratios: dict[str, list[RatioInfo]], ticker: str, date: str) -> RatioInfo | None:
    candidates = [
        info
        for info in ratios.get(ticker, [])
        if date_in_range(date, info.valid_from, info.valid_to)
    ]
    if not candidates:
        return None
    return sorted(candidates, key=ratio_sort_key, reverse=True)[0]


def load_ratios_from_firestore(base_url: str, token: str) -> dict[str, list[RatioInfo]]:
    page_token: str | None = None
    ratios: dict[str, list[RatioInfo]] = {}

    while True:
        params: dict[str, Any] = {"pageSize": 500}
        if page_token:
            params["pageToken"] = page_token

        response = requests.get(
            f"{base_url}/tickers",
            headers={"Authorization": f"Bearer {token}"},
            params=params,
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()

        for document in payload.get("documents", []):
            fields = document.get("fields", {})
            ticker = normalize_ticker(decode_firestore_value(fields.get("ticker")))
            ticker_usa = normalize_ticker(decode_firestore_value(fields.get("tickerUsa")))
            ratio = parse_decimal(decode_firestore_value(fields.get("ratio")))
            ratio_history = decode_firestore_value(fields.get("ratioHistory")) or []

            if not ticker or not ticker_usa:
                continue

            if ratio and ratio > 0:
                ratios.setdefault(ticker, []).append(
                    RatioInfo(
                        ticker=ticker,
                        ticker_usa=ticker_usa,
                        ratio=ratio,
                        source="firestore:tickers.ratio",
                    )
                )

            for item in ratio_history:
                if not isinstance(item, dict):
                    continue
                history_ratio = parse_decimal(item.get("ratio"))
                history_ticker_usa = normalize_ticker(item.get("tickerUsa")) or ticker_usa
                if not history_ratio or history_ratio <= 0 or not history_ticker_usa:
                    continue
                ratios.setdefault(ticker, []).append(
                    RatioInfo(
                        ticker=ticker,
                        ticker_usa=history_ticker_usa,
                        ratio=history_ratio,
                        source="firestore:tickers.ratioHistory",
                        valid_from=item.get("validFrom"),
                        valid_to=item.get("validTo"),
                    )
                )

        page_token = payload.get("nextPageToken")
        if not page_token:
            break

    return ratios


def load_trades(base_url: str, token: str, user_id: str | None = None) -> list[dict[str, Any]]:
    structured_query: dict[str, Any] = {
        "from": [{"collectionId": "items", "allDescendants": True}],
    }
    if user_id:
        structured_query["where"] = {
            "fieldFilter": {
                "field": {"fieldPath": "userId"},
                "op": "EQUAL",
                "value": {"stringValue": user_id},
            }
        }

    response = requests.post(
        f"{base_url}:runQuery",
        headers={"Authorization": f"Bearer {token}"},
        json={"structuredQuery": structured_query},
        timeout=60,
    )
    response.raise_for_status()

    return [item["document"] for item in response.json() if item.get("document")]


def parse_trade(document: dict[str, Any]) -> TradeRow | None:
    fields = document.get("fields", {})
    name = document["name"]
    path = name.split("/documents/", 1)[-1]
    ticker = normalize_ticker(decode_firestore_value(fields.get("ticker")))
    fecha = decode_firestore_value(fields.get("fecha"))
    if not ticker or not fecha:
        return None

    return TradeRow(
        document_name=name,
        document_path=path,
        trade_id=path.split("/")[-1],
        fecha=str(fecha),
        ticker=ticker,
        current_ticker_usa=normalize_ticker(decode_firestore_value(fields.get("tickerUsa"))),
        current_ratio=parse_decimal(decode_firestore_value(fields.get("ratio"))),
    )


def compare_trade(trade: TradeRow, ratios: dict[str, list[RatioInfo]]) -> BackfillResult:
    ratio_info = resolve_ratio_info(ratios, trade.ticker, trade.fecha)
    if not ratio_info:
        return BackfillResult(
            ticker=trade.ticker,
            fecha=trade.fecha,
            trade_id=trade.trade_id,
            document_path=trade.document_path,
            action="skip",
            reason="sin ratio vigente para la fecha",
            current_ticker_usa=trade.current_ticker_usa,
            current_ratio=trade.current_ratio,
        )

    ticker_changed = trade.current_ticker_usa != ratio_info.ticker_usa
    ratio_changed = trade.current_ratio != ratio_info.ratio
    if not ticker_changed and not ratio_changed:
        return BackfillResult(
            ticker=trade.ticker,
            fecha=trade.fecha,
            trade_id=trade.trade_id,
            document_path=trade.document_path,
            action="ok",
            reason="sin cambios",
            current_ticker_usa=trade.current_ticker_usa,
            next_ticker_usa=ratio_info.ticker_usa,
            current_ratio=trade.current_ratio,
            next_ratio=ratio_info.ratio,
        )

    reasons = []
    if ticker_changed:
        reasons.append("tickerUsa")
    if ratio_changed:
        reasons.append("ratio")

    return BackfillResult(
        ticker=trade.ticker,
        fecha=trade.fecha,
        trade_id=trade.trade_id,
        document_path=trade.document_path,
        action="update",
        reason=", ".join(reasons),
        current_ticker_usa=trade.current_ticker_usa,
        next_ticker_usa=ratio_info.ticker_usa,
        current_ratio=trade.current_ratio,
        next_ratio=ratio_info.ratio,
    )


def update_trade(base_url: str, token: str, result: BackfillResult) -> None:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    fields = {
        "tickerUsa": result.next_ticker_usa,
        "ratio": quantize_decimal(result.next_ratio or Decimal("0")),
        "tickerUsaMigratedAt": now,
    }
    update_mask = "&".join(f"updateMask.fieldPaths={key}" for key in fields)
    response = requests.patch(
        f"{base_url}/{result.document_path}?{update_mask}",
        headers={"Authorization": f"Bearer {token}"},
        json={"fields": {key: encode_firestore_value(value) for key, value in fields.items()}},
        timeout=30,
    )
    response.raise_for_status()


def results_to_dict(results: list[BackfillResult]) -> list[dict[str, Any]]:
    payload = []
    for item in results:
        payload.append(
            {
                "ticker": item.ticker,
                "fecha": item.fecha,
                "tradeId": item.trade_id,
                "path": item.document_path,
                "action": item.action,
                "reason": item.reason,
                "currentTickerUsa": item.current_ticker_usa,
                "nextTickerUsa": item.next_ticker_usa,
                "currentRatio": float(item.current_ratio) if item.current_ratio is not None else None,
                "nextRatio": float(item.next_ratio) if item.next_ratio is not None else None,
            }
        )
    return payload


def print_summary(results: list[BackfillResult], applied: int) -> None:
    counts: dict[str, int] = {}
    for item in results:
        counts[item.action] = counts.get(item.action, 0) + 1

    print("\nResumen")
    print(f"- Trades revisados: {len(results)}")
    print(f"- Para actualizar: {counts.get('update', 0)}")
    print(f"- Sin cambios: {counts.get('ok', 0)}")
    print(f"- Saltados: {counts.get('skip', 0)}")
    print(f"- Aplicados: {applied}")


def print_examples(results: list[BackfillResult], max_rows: int) -> None:
    rows = [item for item in results if item.action == "update"][:max_rows]
    if not rows:
        return

    print("\nEjemplos")
    for item in rows:
        print(f"{item.fecha} {item.ticker} [{item.trade_id}] {item.reason}")
        print(f"  tickerUsa: {item.current_ticker_usa} -> {item.next_ticker_usa}")
        print(f"  ratio: {item.current_ratio} -> {item.next_ratio}")


def write_report(path: pathlib.Path | None, results: list[BackfillResult]) -> None:
    if not path:
        return
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "results": results_to_dict(results),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"\nReporte escrito en {path}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Backfill de tickerUsa y ratio en trades historicos.",
    )
    parser.add_argument("--apply", action="store_true", help="Actualiza Firestore. Sin esto es dry-run.")
    parser.add_argument("--user-id", help="Filtra trades por userId.")
    parser.add_argument("--report", type=pathlib.Path, help="Escribe reporte JSON.")
    parser.add_argument("--examples", type=int, default=20, help="Cantidad de ejemplos a imprimir.")
    args = parser.parse_args()

    env = load_env()
    project_id = env.get("FIREBASE_PROJECT_ID")
    if not project_id:
        raise RuntimeError("Falta FIREBASE_PROJECT_ID")

    token = firestore_token(env)
    base_url = firestore_base_url(project_id)
    ratios = load_ratios_from_firestore(base_url, token)
    trades = load_trades(base_url, token, user_id=args.user_id)
    results: list[BackfillResult] = []

    for document in trades:
        trade = parse_trade(document)
        if not trade:
            continue
        results.append(compare_trade(trade, ratios))

    applied = 0
    if args.apply:
        for item in results:
            if item.action != "update":
                continue
            update_trade(base_url, token, item)
            applied += 1

    print_summary(results, applied)
    print_examples(results, args.examples)
    write_report(args.report, results)

    if not args.apply:
        print("\nDry-run: no se modifico Firestore. Usar --apply para actualizar.")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
