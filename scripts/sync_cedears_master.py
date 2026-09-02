#!/usr/bin/env python3
"""Sincroniza la tabla maestra de CEDEARs desde Banco Comafi.

Fuente principal:
    https://www.comafi.com.ar/Programas-CEDEARs-2483.note.aspx

Por defecto corre en dry-run y no modifica Firestore. Con --apply:
  - crea tickers faltantes
  - actualiza tickerUsa / ratio
  - mantiene ratioHistory con vigencia desde la fecha del sync
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
from bs4 import BeautifulSoup


ENV_PATH = pathlib.Path(".env")
DEFAULT_SOURCE_URL = "https://www.comafi.com.ar/Programas-CEDEARs-2483.note.aspx"
USER_AGENT = "Mozilla/5.0 (compatible; TradesLogger/1.0)"


@dataclass
class ComafiCedear:
    ticker: str
    nombre: str
    ticker_usa: str
    ratio: Decimal
    mercado_origen: str
    pais: str
    source_url: str


@dataclass
class FirestoreTicker:
    doc_name: str
    doc_path: str
    doc_id: str
    ticker: str
    nombre: str | None
    ticker_usa: str | None
    underlying_ticker: str | None
    ratio: Decimal | None
    ratio_history: list[dict[str, Any]]


@dataclass
class SyncResult:
    ticker: str
    action: str
    reason: str
    doc_path: str | None = None
    current_ratio: Decimal | None = None
    next_ratio: Decimal | None = None
    current_ticker_usa: str | None = None
    next_ticker_usa: str | None = None
    current_nombre: str | None = None
    next_nombre: str | None = None


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
    if isinstance(value, list):
        return {"arrayValue": {"values": [encode_firestore_value(item) for item in value]}}
    if isinstance(value, dict):
        return {
            "mapValue": {
                "fields": {key: encode_firestore_value(item) for key, item in value.items()}
            }
        }
    if value is None:
        return {"nullValue": None}
    return {"stringValue": str(value)}


def normalize_ticker(value: Any) -> str | None:
    if value in (None, ""):
        return None
    return str(value).strip().upper()


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


def normalize_text(value: str) -> str:
    return " ".join(value.replace("\xa0", " ").split()).strip()


def parse_ratio(text: str) -> Decimal | None:
    cleaned = normalize_text(text).replace(" ", "")
    if ":" not in cleaned:
        return parse_decimal(cleaned)
    left_text, right_text = cleaned.split(":", 1)
    left = parse_decimal(left_text)
    right = parse_decimal(right_text)
    if not left or not right or right == 0:
        return None
    return quantize_decimal(left / right)


def fetch_comafi_cedears(source_url: str) -> list[ComafiCedear]:
    response = requests.get(
        source_url,
        headers={"User-Agent": USER_AGENT},
        timeout=30,
    )
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "lxml")
    tables = soup.find_all("table")
    rows: list[ComafiCedear] = []

    for table in tables:
        headers = [normalize_text(th.get_text(" ")) for th in table.find_all("th")]
        if not headers:
            continue

        header_blob = " | ".join(headers).lower()
        if "ticker en mercado de origen" not in header_blob or "ratio" not in header_blob:
            continue

        for tr in table.find_all("tr"):
            cells = [normalize_text(td.get_text(" ")) for td in tr.find_all("td")]
            if len(cells) < 7:
                continue

            nombre = cells[0]
            ratio = parse_ratio(cells[2])
            ticker = normalize_ticker(cells[5])
            ticker_usa = normalize_ticker(cells[6]) or ticker
            pais = cells[9] if len(cells) > 9 else ""
            mercado_origen = cells[10] if len(cells) > 10 else ""

            if not ticker or not ticker_usa or not ratio or ratio <= 0:
                continue

            rows.append(
                ComafiCedear(
                    ticker=ticker,
                    nombre=nombre,
                    ticker_usa=ticker_usa,
                    ratio=ratio,
                    mercado_origen=mercado_origen,
                    pais=pais,
                    source_url=source_url,
                )
            )
        if rows:
            break

    if not rows:
        raise RuntimeError("No pude parsear la tabla de CEDEARs de Comafi")

    unique: dict[str, ComafiCedear] = {}
    for row in rows:
        unique[row.ticker] = row
    return [unique[ticker] for ticker in sorted(unique)]


def load_firestore_tickers(base_url: str, token: str) -> tuple[dict[str, FirestoreTicker], list[str]]:
    page_token: str | None = None
    tickers: dict[str, FirestoreTicker] = {}
    duplicates: list[str] = []

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
            if not ticker:
                continue

            path = document["name"].split("/documents/", 1)[-1]
            doc_id = path.split("/")[-1]
            item = FirestoreTicker(
                doc_name=document["name"],
                doc_path=path,
                doc_id=doc_id,
                ticker=ticker,
                nombre=decode_firestore_value(fields.get("nombre")),
                ticker_usa=normalize_ticker(decode_firestore_value(fields.get("tickerUsa"))),
                underlying_ticker=normalize_ticker(decode_firestore_value(fields.get("underlyingTicker"))),
                ratio=parse_decimal(decode_firestore_value(fields.get("ratio"))),
                ratio_history=decode_firestore_value(fields.get("ratioHistory")) or [],
            )

            if ticker in tickers:
                duplicates.append(ticker)
                continue
            tickers[ticker] = item

        page_token = payload.get("nextPageToken")
        if not page_token:
            break

    return tickers, duplicates


def build_ratio_history(
    current: FirestoreTicker | None,
    next_row: ComafiCedear,
    effective_date: str,
) -> list[dict[str, Any]]:
    history = list(current.ratio_history) if current else []

    current_ticker_usa = current.ticker_usa or current.underlying_ticker if current else None
    current_ratio = current.ratio if current else None
    unchanged = (
        current is not None
        and current_ratio == next_row.ratio
        and normalize_ticker(current_ticker_usa) == next_row.ticker_usa
    )
    if unchanged:
        return history

    open_entries = [item for item in history if isinstance(item, dict) and not item.get("validTo")]
    for entry in open_entries:
        entry["validTo"] = effective_date

    history.append(
        {
            "ratio": float(quantize_decimal(next_row.ratio)),
            "tickerUsa": next_row.ticker_usa,
            "validFrom": effective_date,
            "validTo": None,
            "source": "comafi",
            "sourceUrl": next_row.source_url,
        }
    )
    return history


def compare_rows(
    comafi_rows: list[ComafiCedear],
    firestore_rows: dict[str, FirestoreTicker],
    include_name: bool,
) -> list[SyncResult]:
    results: list[SyncResult] = []
    for row in comafi_rows:
        current = firestore_rows.get(row.ticker)
        if not current:
            results.append(
                SyncResult(
                    ticker=row.ticker,
                    action="create",
                    reason="ticker faltante en Firestore",
                    next_ratio=row.ratio,
                    next_ticker_usa=row.ticker_usa,
                    next_nombre=row.nombre,
                )
            )
            continue

        current_ticker_usa = current.ticker_usa or current.underlying_ticker
        ratio_changed = current.ratio != row.ratio
        ticker_usa_changed = normalize_ticker(current_ticker_usa) != row.ticker_usa
        nombre_changed = include_name and normalize_text(current.nombre or "") != normalize_text(row.nombre)

        if ratio_changed or ticker_usa_changed or nombre_changed:
            reasons = []
            if ratio_changed:
                reasons.append("ratio")
            if ticker_usa_changed:
                reasons.append("tickerUsa")
            if nombre_changed:
                reasons.append("nombre")
            results.append(
                SyncResult(
                    ticker=row.ticker,
                    action="update",
                    reason=", ".join(reasons),
                    doc_path=current.doc_path,
                    current_ratio=current.ratio,
                    next_ratio=row.ratio,
                    current_ticker_usa=current_ticker_usa,
                    next_ticker_usa=row.ticker_usa,
                    current_nombre=current.nombre,
                    next_nombre=row.nombre,
                )
            )
        else:
            results.append(
                SyncResult(
                    ticker=row.ticker,
                    action="ok",
                    reason="sin cambios",
                    doc_path=current.doc_path,
                    current_ratio=current.ratio,
                    next_ratio=row.ratio,
                    current_ticker_usa=current_ticker_usa,
                    next_ticker_usa=row.ticker_usa,
                    current_nombre=current.nombre,
                    next_nombre=row.nombre,
                )
            )
    return results


def upsert_firestore_ticker(
    base_url: str,
    token: str,
    current: FirestoreTicker | None,
    next_row: ComafiCedear,
    effective_date: str,
) -> None:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    history = build_ratio_history(current, next_row, effective_date)
    fields = {
        "ticker": next_row.ticker,
        "nombre": next_row.nombre,
        "tickerUsa": next_row.ticker_usa,
        "ratio": quantize_decimal(next_row.ratio),
        "ratioHistory": history,
        "source": "comafi",
        "sourceUrl": next_row.source_url,
        "sourceMarket": next_row.mercado_origen,
        "sourceCountry": next_row.pais,
        "sourceUpdatedAt": now,
    }
    encoded_fields = {key: encode_firestore_value(value) for key, value in fields.items()}

    if current:
        update_mask = "&".join(f"updateMask.fieldPaths={key}" for key in fields)
        response = requests.patch(
            f"{base_url}/{current.doc_path}?{update_mask}",
            headers={"Authorization": f"Bearer {token}"},
            json={"fields": encoded_fields},
            timeout=30,
        )
        response.raise_for_status()
        return

    doc_id = next_row.ticker
    response = requests.patch(
        f"{base_url}/tickers/{doc_id}",
        headers={"Authorization": f"Bearer {token}"},
        json={"fields": encoded_fields},
        timeout=30,
    )
    response.raise_for_status()


def sync_results_to_dict(results: list[SyncResult]) -> list[dict[str, Any]]:
    payload = []
    for item in results:
        payload.append(
            {
                "ticker": item.ticker,
                "action": item.action,
                "reason": item.reason,
                "docPath": item.doc_path,
                "currentRatio": float(item.current_ratio) if item.current_ratio is not None else None,
                "nextRatio": float(item.next_ratio) if item.next_ratio is not None else None,
                "currentTickerUsa": item.current_ticker_usa,
                "nextTickerUsa": item.next_ticker_usa,
                "currentNombre": item.current_nombre,
                "nextNombre": item.next_nombre,
            }
        )
    return payload


def print_summary(results: list[SyncResult], duplicates: list[str], applied: int) -> None:
    counts: dict[str, int] = {}
    for item in results:
        counts[item.action] = counts.get(item.action, 0) + 1

    print("\nResumen")
    print(f"- CEDEARs oficiales leidos: {len(results)}")
    print(f"- Altas faltantes: {counts.get('create', 0)}")
    print(f"- Cambios detectados: {counts.get('update', 0)}")
    print(f"- Sin cambios: {counts.get('ok', 0)}")
    print(f"- Duplicados en Firestore: {len(duplicates)}")
    print(f"- Aplicados: {applied}")


def print_examples(results: list[SyncResult], max_rows: int) -> None:
    rows = [item for item in results if item.action in {"create", "update"}][:max_rows]
    if not rows:
        return

    print("\nCambios detectados")
    for item in rows:
        print(f"{item.ticker} [{item.action}] {item.reason}")
        if item.current_ticker_usa or item.next_ticker_usa:
            print(f"  tickerUsa: {item.current_ticker_usa} -> {item.next_ticker_usa}")
        if item.current_ratio is not None or item.next_ratio is not None:
            print(f"  ratio: {item.current_ratio} -> {item.next_ratio}")
        if item.current_nombre or item.next_nombre:
            print(f"  nombre: {item.current_nombre} -> {item.next_nombre}")


def write_report(path: pathlib.Path | None, results: list[SyncResult], duplicates: list[str]) -> None:
    if not path:
        return
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "duplicates": duplicates,
        "results": sync_results_to_dict(results),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"\nReporte escrito en {path}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Sincroniza tickerUsa y ratio de CEDEARs desde Comafi.",
    )
    parser.add_argument("--apply", action="store_true", help="Actualiza Firestore. Sin esto es dry-run.")
    parser.add_argument("--source-url", default=DEFAULT_SOURCE_URL, help="Fuente oficial de Comafi.")
    parser.add_argument("--effective-date", help="Fecha YYYY-MM-DD para ratioHistory. Default: hoy UTC.")
    parser.add_argument("--report", type=pathlib.Path, help="Escribe reporte JSON.")
    parser.add_argument("--examples", type=int, default=20, help="Cantidad de cambios a imprimir.")
    parser.add_argument(
        "--include-name",
        action="store_true",
        help="Tambien compara y actualiza el campo nombre.",
    )
    args = parser.parse_args()

    env = load_env()
    project_id = env.get("FIREBASE_PROJECT_ID")
    if not project_id:
        raise RuntimeError("Falta FIREBASE_PROJECT_ID")

    effective_date = args.effective_date or datetime.now(timezone.utc).date().isoformat()
    comafi_rows = fetch_comafi_cedears(args.source_url)
    token = firestore_token(env)
    base_url = firestore_base_url(project_id)
    firestore_rows, duplicates = load_firestore_tickers(base_url, token)
    results = compare_rows(comafi_rows, firestore_rows, include_name=args.include_name)

    applied = 0
    if args.apply:
        for row in comafi_rows:
            current = firestore_rows.get(row.ticker)
            result = next(item for item in results if item.ticker == row.ticker)
            if result.action not in {"create", "update"}:
                continue
            upsert_firestore_ticker(base_url, token, current, row, effective_date)
            applied += 1

    print_summary(results, duplicates, applied)
    print_examples(results, args.examples)
    if duplicates:
        print("\nDuplicados en Firestore")
        for ticker in duplicates[: args.examples]:
            print(f"- {ticker}")
    write_report(args.report, results, duplicates)

    if not args.apply:
        print("\nDry-run: no se modifico Firestore. Usar --apply para actualizar.")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
