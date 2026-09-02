#!/usr/bin/env python3
"""Audita y corrige precios USD historicos de trades de CEDEARs.

Regla de calculo:

    priceCedear = precio_accion_subyacente_usd / ratio_cedear

Por defecto corre en modo dry-run y no modifica Firestore. Usar --apply para
actualizar documentos con diferencias.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import pathlib
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any
from urllib.parse import quote

import jwt
import requests


ENV_PATH = pathlib.Path(".env")
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart"
DEFAULT_EXCLUDED_TICKERS = {"AL30", "AL30D"}


@dataclass
class RatioInfo:
    ticker: str
    ticker_usa: str
    ratio: Decimal
    source: str
    valid_from: str | None = None
    valid_to: str | None = None


@dataclass
class TradeAudit:
    document_name: str
    document_path: str
    trade_id: str
    fecha_path: str | None
    ticker: str
    fecha: str
    hora: str
    tipo: str
    cantidad: Decimal
    stored_price: Decimal
    stored_total: Decimal | None
    ticker_usa: str | None = None
    ratio: Decimal | None = None
    ratio_source: str | None = None
    underlying_price: Decimal | None = None
    source_date: str | None = None
    corrected_price: Decimal | None = None
    corrected_total: Decimal | None = None
    price_diff: Decimal | None = None
    total_diff: Decimal | None = None
    status: str = "pending"
    reason: str = ""


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


def parse_decimal(value: Any) -> Decimal | None:
    if value is None or value == "":
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


def quantize_decimal(value: Decimal, places: str) -> Decimal:
    return value.quantize(Decimal(places), rounding=ROUND_HALF_UP)


def first_present(mapping: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        value = mapping.get(key)
        if value not in (None, ""):
            return value
    return None


def normalize_ticker(value: Any) -> str | None:
    if value in (None, ""):
        return None
    ticker = str(value).strip().upper()
    return ticker.replace(".C", "C") if ticker.endswith(".C") else ticker


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


def load_ratio_overrides(path: pathlib.Path | None) -> dict[str, list[RatioInfo]]:
    if not path:
        return {}

    overrides: dict[str, list[RatioInfo]] = {}
    with path.open(newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            ticker = normalize_ticker(row.get("ticker") or row.get("Ticker"))
            ticker_usa = normalize_ticker(
                first_present(
                    row,
                    (
                        "underlyingTicker",
                        "UnderlyingTicker",
                        "tickerUsa",
                        "tickerUSA",
                        "subyacente",
                        "Subyacente",
                    ),
                )
            ) or ticker
            ratio = parse_decimal(row.get("ratio") or row.get("Ratio"))
            if ticker and ratio and ratio > 0:
                overrides.setdefault(ticker, []).append(
                    RatioInfo(
                        ticker=ticker,
                        ticker_usa=ticker_usa,
                        ratio=ratio,
                        source=str(path),
                        valid_from=first_present(row, ("validFrom", "desde", "vigenteDesde")),
                        valid_to=first_present(row, ("validTo", "hasta", "vigenteHasta")),
                    )
                )

    return overrides


def firestore_ticker_usa(fields: dict[str, Any], ticker: str) -> str:
    decoded = {key: decode_firestore_value(value) for key, value in fields.items()}
    return normalize_ticker(
        first_present(
            decoded,
            (
                "underlyingTicker",
                "tickerUsa",
                "tickerUSA",
                "tickerSubyacente",
                "subyacente",
                "symbol",
            ),
        )
    ) or ticker


def firestore_ratio_history(fields: dict[str, Any], ticker: str, default_ticker_usa: str) -> list[RatioInfo]:
    decoded = {key: decode_firestore_value(value) for key, value in fields.items()}
    raw_history = first_present(
        decoded,
        ("ratioHistory", "ratiosHistoricos", "historialRatios", "ratio_history"),
    )
    if not isinstance(raw_history, list):
        return []

    history: list[RatioInfo] = []
    for item in raw_history:
        if not isinstance(item, dict):
            continue
        ratio = parse_decimal(item.get("ratio") or item.get("Ratio"))
        if not ratio or not ratio.is_finite() or ratio <= 0:
            continue
        ticker_usa = normalize_ticker(
            first_present(
                item,
                (
                    "underlyingTicker",
                    "tickerUsa",
                    "tickerUSA",
                    "tickerSubyacente",
                    "subyacente",
                    "symbol",
                ),
            )
        ) or default_ticker_usa
        history.append(
            RatioInfo(
                ticker=ticker,
                ticker_usa=ticker_usa,
                ratio=ratio,
                source="firestore:tickers.ratioHistory",
                valid_from=first_present(item, ("validFrom", "desde", "vigenteDesde")),
                valid_to=first_present(item, ("validTo", "hasta", "vigenteHasta")),
            )
        )
    return history


def load_ratios_from_firestore(
    base_url: str,
    token: str,
    overrides: dict[str, list[RatioInfo]],
) -> dict[str, list[RatioInfo]]:
    ratios: dict[str, list[RatioInfo]] = {}
    page_token: str | None = None

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
            ticker = decode_firestore_value(fields.get("ticker"))
            ratio = decode_firestore_value(fields.get("ratio"))
            ticker_upper = normalize_ticker(ticker)
            if not ticker_upper:
                continue

            ticker_usa = firestore_ticker_usa(fields, ticker_upper)

            parsed_ratio = parse_decimal(ratio)
            if parsed_ratio and parsed_ratio.is_finite() and parsed_ratio > 0:
                ratios.setdefault(ticker_upper, []).append(
                    RatioInfo(
                        ticker=ticker_upper,
                        ticker_usa=ticker_usa,
                        ratio=parsed_ratio,
                        source="firestore:tickers.ratio",
                    )
                )

            history = firestore_ratio_history(fields, ticker_upper, ticker_usa)
            if history:
                ratios.setdefault(ticker_upper, []).extend(history)

        page_token = payload.get("nextPageToken")
        if not page_token:
            break

    for ticker, entries in overrides.items():
        ratios.setdefault(ticker, []).extend(entries)
    return ratios


def load_trades(
    base_url: str,
    token: str,
    user_id: str | None = None,
) -> list[dict[str, Any]]:
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

    trades: list[dict[str, Any]] = []
    for item in response.json():
        document = item.get("document")
        if document:
            trades.append(document)

    return trades


def parse_trade_document(document: dict[str, Any]) -> TradeAudit | None:
    fields = document.get("fields", {})
    name = document["name"]
    path = name.split("/documents/", 1)[-1]
    path_parts = path.split("/")

    ticker = decode_firestore_value(fields.get("ticker"))
    fecha = decode_firestore_value(fields.get("fecha"))
    tipo = decode_firestore_value(fields.get("tipo"))
    cantidad = parse_decimal(decode_firestore_value(fields.get("cantidad")))
    stored_price = parse_decimal(decode_firestore_value(fields.get("priceCedear")))
    stored_total = parse_decimal(decode_firestore_value(fields.get("total")))
    hora = decode_firestore_value(fields.get("hora")) or ""

    if not ticker or not fecha or not tipo or not cantidad or not stored_price:
        return None

    fecha_path = path_parts[1] if len(path_parts) >= 4 and path_parts[0] == "trades" else None
    trade_id = path_parts[-1]

    return TradeAudit(
        document_name=name,
        document_path=path,
        trade_id=trade_id,
        fecha_path=fecha_path,
        ticker=str(ticker).upper(),
        fecha=str(fecha),
        hora=str(hora),
        tipo=str(tipo),
        cantidad=cantidad,
        stored_price=stored_price,
        stored_total=stored_total,
    )


def yahoo_daily_price(ticker: str, date: str, allow_nearest: bool = False) -> dict[str, Any]:
    ticker_encoded = quote(ticker.upper())
    target = datetime.fromisoformat(date).replace(tzinfo=timezone.utc)
    period1 = int((target - timedelta(days=1)).timestamp())
    period2 = int((target + timedelta(days=4)).timestamp())
    url = (
        f"{YAHOO_CHART_URL}/{ticker_encoded}"
        f"?period1={period1}&period2={period2}&interval=1d"
    )

    response = requests.get(
        url,
        headers={"User-Agent": "Mozilla/5.0 (compatible; TradesLogger/1.0)"},
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    result = payload.get("chart", {}).get("result", [None])[0]

    if not result:
        raise RuntimeError("Yahoo no devolvio datos")

    timestamps = result.get("timestamp") or []
    closes = result.get("indicators", {}).get("quote", [{}])[0].get("close") or []
    target_date = datetime.fromisoformat(date).date()
    candidates = []

    for ts, close in zip(timestamps, closes):
        if close is None:
            continue
        source_date = datetime.fromtimestamp(ts, tz=timezone.utc).date()
        candidates.append((abs((source_date - target_date).days), source_date, close))
        if source_date == target_date:
            return {
                "underlyingPriceUsd": Decimal(str(close)),
                "sourceDate": source_date.isoformat(),
                "source": "yahoo:1d-close",
            }

    if not allow_nearest:
        raise RuntimeError(f"Yahoo no devolvio cierre exacto para {date}")

    if not candidates:
        raise RuntimeError("Yahoo no devolvio cierres historicos")

    _, source_date, close = min(candidates, key=lambda item: item[0])
    return {
        "underlyingPriceUsd": Decimal(str(close)),
        "sourceDate": source_date.isoformat(),
        "source": "yahoo:nearest-1d-close",
    }


def app_api_price(api_base: str, ticker: str, date: str, time_value: str | None = None) -> dict[str, Any]:
    params: dict[str, str] = {"ticker": ticker.upper(), "date": date}
    if time_value and time_value != "actual":
        params["time"] = time_value

    response = requests.get(
        f"{api_base.rstrip('/')}/api/stock-price",
        params=params,
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    price = payload.get("price")
    if not price:
        raise RuntimeError("La API de la app no devolvio precio")

    return {
        "underlyingPriceUsd": Decimal(str(price)),
        "sourceDate": payload.get("date") or date,
        "source": f"app-api:{api_base.rstrip('/')}",
    }


def resolve_price(
    ticker: str,
    date: str,
    hora: str,
    api_base: str | None,
    use_time: bool,
    allow_nearest: bool,
) -> dict[str, Any]:
    if api_base:
        return app_api_price(api_base, ticker, date, hora if use_time else None)
    return yahoo_daily_price(ticker, date, allow_nearest=allow_nearest)


def audit_trade(
    trade: TradeAudit,
    ratios: dict[str, list[RatioInfo]],
    excluded_tickers: set[str],
    api_base: str | None,
    use_time: bool,
    allow_nearest: bool,
    min_diff: Decimal,
) -> TradeAudit:
    if trade.ticker in excluded_tickers:
        trade.status = "skipped"
        trade.reason = "ticker excluido"
        return trade

    ratio_info = resolve_ratio_info(ratios, trade.ticker, trade.fecha)
    if not ratio_info:
        trade.status = "skipped"
        trade.reason = "ratio faltante para la fecha"
        return trade

    if not ratio_info.ticker_usa:
        trade.status = "skipped"
        trade.reason = "ticker subyacente faltante"
        trade.ratio = ratio_info.ratio
        trade.ratio_source = ratio_info.source
        return trade

    try:
        price_info = resolve_price(
            ratio_info.ticker_usa,
            trade.fecha,
            trade.hora,
            api_base=api_base,
            use_time=use_time,
            allow_nearest=allow_nearest,
        )
    except Exception as error:
        trade.status = "error"
        trade.reason = f"precio historico no disponible: {error}"
        trade.ticker_usa = ratio_info.ticker_usa
        trade.ratio = ratio_info.ratio
        trade.ratio_source = ratio_info.source
        return trade

    underlying = Decimal(str(price_info["underlyingPriceUsd"]))
    if underlying <= 0:
        trade.status = "error"
        trade.reason = "precio historico invalido"
        trade.ticker_usa = ratio_info.ticker_usa
        trade.ratio = ratio_info.ratio
        trade.ratio_source = ratio_info.source
        return trade

    corrected_price_raw = underlying / ratio_info.ratio
    corrected_price = quantize_decimal(corrected_price_raw, "0.000001")
    corrected_total = quantize_decimal(corrected_price_raw * trade.cantidad, "0.01")
    stored_total = trade.stored_total or quantize_decimal(trade.stored_price * trade.cantidad, "0.01")

    trade.ratio = ratio_info.ratio
    trade.ratio_source = ratio_info.source
    trade.ticker_usa = ratio_info.ticker_usa
    trade.underlying_price = underlying
    trade.source_date = price_info.get("sourceDate")
    trade.corrected_price = corrected_price
    trade.corrected_total = corrected_total
    trade.price_diff = corrected_price - trade.stored_price
    trade.total_diff = corrected_total - stored_total

    if abs(trade.price_diff) <= min_diff and abs(trade.total_diff or Decimal("0")) <= min_diff:
        trade.status = "ok"
        trade.reason = "sin diferencia relevante"
    else:
        trade.status = "needs-update"
        trade.reason = price_info.get("source", "historical-price")

    return trade


def update_trade(base_url: str, token: str, audit: TradeAudit) -> None:
    if audit.corrected_price is None or audit.corrected_total is None:
        raise RuntimeError("No hay precio corregido para actualizar")

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    fields = {
        "priceCedear": audit.corrected_price,
        "total": audit.corrected_total,
        "precioAccionUsd": quantize_decimal(audit.underlying_price or Decimal("0"), "0.000001"),
        "ratio": audit.ratio,
        "tickerUsa": audit.ticker_usa,
        "precioUsdRatioSource": audit.ratio_source,
        "precioUsdSourceDate": audit.source_date,
        "precioUsdSource": audit.reason,
        "precioUsdAuditUpdatedAt": now,
    }
    update_mask = "&".join(f"updateMask.fieldPaths={key}" for key in fields)
    response = requests.patch(
        f"{base_url}/{audit.document_path}?{update_mask}",
        headers={"Authorization": f"Bearer {token}"},
        json={"fields": {key: encode_firestore_value(value) for key, value in fields.items()}},
        timeout=30,
    )
    response.raise_for_status()


def audit_to_dict(audit: TradeAudit) -> dict[str, Any]:
    return {
        "path": audit.document_path,
        "tradeId": audit.trade_id,
        "fecha": audit.fecha,
        "hora": audit.hora,
        "tipo": audit.tipo,
        "ticker": audit.ticker,
        "tickerUsa": audit.ticker_usa,
        "cantidad": float(audit.cantidad),
        "precioActualDB": float(audit.stored_price),
        "totalActualDB": float(audit.stored_total) if audit.stored_total is not None else None,
        "precioAccionUsd": float(audit.underlying_price) if audit.underlying_price is not None else None,
        "ratio": float(audit.ratio) if audit.ratio is not None else None,
        "ratioSource": audit.ratio_source,
        "sourceDate": audit.source_date,
        "precioCorrecto": float(audit.corrected_price) if audit.corrected_price is not None else None,
        "totalCorrecto": float(audit.corrected_total) if audit.corrected_total is not None else None,
        "diferenciaPrecio": float(audit.price_diff) if audit.price_diff is not None else None,
        "diferenciaTotal": float(audit.total_diff) if audit.total_diff is not None else None,
        "status": audit.status,
        "motivo": audit.reason,
    }


def print_summary(audits: list[TradeAudit], applied: int) -> None:
    counts: dict[str, int] = {}
    for audit in audits:
        counts[audit.status] = counts.get(audit.status, 0) + 1

    print("\nResumen")
    print(f"- Operaciones revisadas: {len(audits)}")
    print(f"- Para actualizar: {counts.get('needs-update', 0) + counts.get('updated', 0)}")
    print(f"- Actualizadas: {applied}")
    print(f"- Sin cambios relevantes: {counts.get('ok', 0)}")
    print(f"- Omitidas: {counts.get('skipped', 0)}")
    print(f"- Errores: {counts.get('error', 0)}")


def print_audit_rows(audits: list[TradeAudit], max_rows: int) -> None:
    rows = [audit for audit in audits if audit.status in {"needs-update", "updated"}][:max_rows]
    if not rows:
        return

    print("\nEjemplos a corregir")
    for audit in rows:
        print(f"{audit.fecha} {audit.ticker} {audit.tipo} {audit.cantidad}")
        print(f"  ID: {audit.trade_id}")
        print(f"  Precio actual DB: {audit.stored_price}")
        print(f"  Precio {audit.ticker_usa or audit.ticker} USA: {audit.underlying_price}")
        print(f"  Ratio: {audit.ratio} ({audit.ratio_source})")
        print(f"  Precio correcto: {audit.corrected_price}")
        print(f"  Diferencia: {audit.price_diff}")
        print(f"  Total actual/correcto: {audit.stored_total} -> {audit.corrected_total}")


def print_issue_rows(audits: list[TradeAudit], max_rows: int) -> None:
    rows = [audit for audit in audits if audit.status in {"skipped", "error"}][:max_rows]
    if not rows:
        return

    print("\nOperaciones no corregidas")
    for audit in rows:
        print(f"{audit.fecha} {audit.ticker} {audit.tipo} {audit.cantidad}")
        print(f"  ID: {audit.trade_id}")
        print(f"  Motivo: {audit.reason}")


def write_report(path: pathlib.Path | None, audits: list[TradeAudit]) -> None:
    if not path:
        return

    payload = [audit_to_dict(audit) for audit in audits]
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"\nReporte escrito en {path}")


def parse_ticker_set(value: str | None) -> set[str] | None:
    if not value:
        return None
    return {item.strip().upper() for item in value.split(",") if item.strip()}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Audita/corrige priceCedear historico usando precio USA / ratio CEDEAR.",
    )
    parser.add_argument("--apply", action="store_true", help="Actualiza Firestore. Sin esto es dry-run.")
    parser.add_argument("--user-id", help="Filtra por userId.")
    parser.add_argument("--tickers", help="Lista separada por comas para auditar solo algunos tickers.")
    parser.add_argument("--exclude", default=",".join(sorted(DEFAULT_EXCLUDED_TICKERS)))
    parser.add_argument("--limit", type=int, help="Limita cantidad de trades auditados.")
    parser.add_argument("--min-diff", default="0.01", help="Diferencia minima para actualizar.")
    parser.add_argument("--api-base", help="URL base de Vercel para usar /api/stock-price.")
    parser.add_argument("--use-time", action="store_true", help="Usa hora con --api-base si el trade la tiene.")
    parser.add_argument(
        "--allow-nearest",
        action="store_true",
        help="Si Yahoo no tiene cierre exacto, usa el cierre mas cercano.",
    )
    parser.add_argument("--ratio-overrides", type=pathlib.Path, help="CSV ticker,ratio para ratios manuales.")
    parser.add_argument("--report", type=pathlib.Path, help="Escribe reporte JSON.")
    parser.add_argument("--examples", type=int, default=20, help="Cantidad de ejemplos a imprimir.")
    args = parser.parse_args()

    env = load_env()
    project_id = env.get("FIREBASE_PROJECT_ID")
    if not project_id:
        raise RuntimeError("Falta FIREBASE_PROJECT_ID")

    token = firestore_token(env)
    base_url = firestore_base_url(project_id)
    ticker_filter = parse_ticker_set(args.tickers)
    excluded_tickers = parse_ticker_set(args.exclude) or set()
    min_diff = parse_decimal(args.min_diff) or Decimal("0.01")

    overrides = load_ratio_overrides(args.ratio_overrides)
    ratios = load_ratios_from_firestore(base_url, token, overrides)
    documents = load_trades(base_url, token, user_id=args.user_id)

    audits: list[TradeAudit] = []
    for document in documents:
        trade = parse_trade_document(document)
        if not trade:
            continue
        if ticker_filter and trade.ticker not in ticker_filter:
            continue
        if args.limit and len(audits) >= args.limit:
            break

        audits.append(
            audit_trade(
                trade,
                ratios,
                excluded_tickers=excluded_tickers,
                api_base=args.api_base,
                use_time=args.use_time,
                allow_nearest=args.allow_nearest,
                min_diff=min_diff,
            )
        )

    applied = 0
    if args.apply:
        for audit in audits:
            if audit.status != "needs-update":
                continue
            update_trade(base_url, token, audit)
            audit.status = "updated"
            applied += 1

    print_summary(audits, applied)
    print_audit_rows(audits, args.examples)
    print_issue_rows(audits, args.examples)
    write_report(args.report, audits)

    if not args.apply:
        print("\nDry-run: no se modifico Firestore. Usar --apply para actualizar.")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
