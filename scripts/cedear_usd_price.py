#!/usr/bin/env python3
"""Consulta precios USD historicos de CEDEARs.

La app guarda el precio por CEDEAR en USD como:

    precio_accion_usd / ratio_cedear

Esta herramienta puede usar la API desplegada en Vercel (`--api-base`) o Yahoo
Finance directo para el precio de la accion subyacente. Si puede, lee el ratio
desde la coleccion `tickers` de Firestore. Para tickers que no esten cargados
en Firestore, pasar `--ratio`.
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
from decimal import Decimal, ROUND_HALF_UP
from typing import Any
from urllib.parse import quote

import jwt
import requests


ENV_PATH = pathlib.Path(".env")
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart"


@dataclass
class CedearQuery:
    ticker: str
    date: str | None = None
    quantity: Decimal | None = None
    ratio: Decimal | None = None


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


def firestore_token(env: dict[str, str]) -> str | None:
    project_id = env.get("FIREBASE_PROJECT_ID")
    client_email = env.get("FIREBASE_CLIENT_EMAIL")
    private_key = env.get("FIREBASE_PRIVATE_KEY")

    if not project_id or not client_email or not private_key:
        return None

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
        timeout=20,
    )
    response.raise_for_status()
    return response.json()["access_token"]


def decode_firestore_value(value: dict[str, Any]) -> Any:
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
    return None


def load_ratios_from_firestore(env: dict[str, str]) -> dict[str, Decimal]:
    project_id = env.get("FIREBASE_PROJECT_ID")
    if not project_id:
        return {}

    token = firestore_token(env)
    if not token:
        return {}

    base = (
        f"https://firestore.googleapis.com/v1/projects/{project_id}"
        "/databases/(default)/documents"
    )
    ratios: dict[str, Decimal] = {}
    page_token: str | None = None

    while True:
        params: dict[str, Any] = {"pageSize": 500}
        if page_token:
            params["pageToken"] = page_token

        response = requests.get(
            f"{base}/tickers",
            headers={"Authorization": f"Bearer {token}"},
            params=params,
            timeout=20,
        )
        response.raise_for_status()
        payload = response.json()

        for document in payload.get("documents", []):
            fields = document.get("fields", {})
            ticker = decode_firestore_value(fields.get("ticker", {}))
            ratio = decode_firestore_value(fields.get("ratio", {}))

            if ticker and ratio:
                ratios[str(ticker).upper()] = Decimal(str(ratio))

        page_token = payload.get("nextPageToken")
        if not page_token:
            break

    return ratios


def parse_decimal(value: str | int | float | Decimal | None) -> Decimal | None:
    if value is None or value == "":
        return None

    text = str(value).strip().replace("$", "")
    if "," in text:
        text = text.replace(".", "").replace(",", ".")

    return Decimal(text)


def quantize_money(value: Decimal, places: str = "0.01") -> Decimal:
    return value.quantize(Decimal(places), rounding=ROUND_HALF_UP)


def app_api_price(api_base: str, ticker: str, date: str | None) -> dict[str, Any]:
    api_base = api_base.rstrip("/")
    params: dict[str, str] = {"ticker": ticker.upper()}
    if date:
        params["date"] = date

    response = requests.get(
        f"{api_base}/api/stock-price",
        params=params,
        timeout=20,
    )
    response.raise_for_status()
    payload = response.json()
    price = payload.get("price")

    if not price:
        raise RuntimeError(f"La API de la app no devolvio precio para {ticker}")

    return {
        "underlyingPriceUsd": Decimal(str(price)),
        "sourceDate": payload.get("date") or date or "current",
        "source": f"app-api:{api_base}",
    }


def yahoo_price(ticker: str, date: str | None) -> dict[str, Any]:
    ticker_encoded = quote(ticker.upper())

    if date:
        target = datetime.fromisoformat(date).replace(tzinfo=timezone.utc)
        period1 = int((target - timedelta(days=1)).timestamp())
        period2 = int((target + timedelta(days=3)).timestamp())
        url = (
            f"{YAHOO_CHART_URL}/{ticker_encoded}"
            f"?period1={period1}&period2={period2}&interval=1d"
        )
    else:
        url = f"{YAHOO_CHART_URL}/{ticker_encoded}?interval=1d&range=1d"

    response = requests.get(
        url,
        headers={"User-Agent": "Mozilla/5.0 (compatible; TradesLogger/1.0)"},
        timeout=20,
    )
    response.raise_for_status()
    payload = response.json()
    result = payload.get("chart", {}).get("result", [None])[0]

    if not result:
        raise RuntimeError(f"Yahoo no devolvio datos para {ticker}")

    if not date:
        price = result.get("meta", {}).get("regularMarketPrice")
        if not price:
            raise RuntimeError(f"Yahoo no devolvio precio actual para {ticker}")
        return {
            "underlyingPriceUsd": Decimal(str(price)),
            "sourceDate": "current",
            "source": "yahoo",
        }

    timestamps = result.get("timestamp") or []
    closes = result.get("indicators", {}).get("quote", [{}])[0].get("close") or []
    target_date = datetime.fromisoformat(date).date()

    candidates = []
    for ts, close in zip(timestamps, closes):
        if close is None:
            continue
        source_date = datetime.fromtimestamp(ts, tz=timezone.utc).date()
        candidates.append((abs((source_date - target_date).days), source_date, close))

    if not candidates:
        raise RuntimeError(f"Yahoo no devolvio cierres historicos para {ticker} {date}")

    _, source_date, close = min(candidates, key=lambda item: item[0])
    return {
        "underlyingPriceUsd": Decimal(str(close)),
        "sourceDate": source_date.isoformat(),
        "source": "yahoo",
    }


def resolve_query(
    query: CedearQuery,
    ratios: dict[str, Decimal],
    api_base: str | None,
) -> dict[str, Any]:
    ticker = query.ticker.upper()
    ratio = query.ratio or ratios.get(ticker)

    if not ratio:
        raise RuntimeError(
            f"No encontre ratio para {ticker}. Pasalo con --ratio o cargalo en tickers."
        )

    price_info = (
        app_api_price(api_base, ticker, query.date)
        if api_base
        else yahoo_price(ticker, query.date)
    )
    underlying = price_info["underlyingPriceUsd"]
    cedear_usd = underlying / ratio
    total_usd = cedear_usd * query.quantity if query.quantity is not None else None

    return {
        "ticker": ticker,
        "date": query.date or "current",
        "sourceDate": price_info["sourceDate"],
        "ratio": float(ratio),
        "underlyingPriceUsd": float(quantize_money(underlying, "0.0001")),
        "cedearPriceUsd": float(quantize_money(cedear_usd, "0.0001")),
        "quantity": float(query.quantity) if query.quantity is not None else None,
        "totalUsd": float(quantize_money(total_usd)) if total_usd is not None else None,
        "source": price_info["source"],
    }


def read_csv_queries(path: pathlib.Path) -> list[CedearQuery]:
    with path.open(newline="") as handle:
        reader = csv.DictReader(handle)
        rows = []
        for row in reader:
            ticker = row.get("ticker") or row.get("Ticker")
            if not ticker:
                raise RuntimeError("El CSV necesita una columna ticker")

            rows.append(
                CedearQuery(
                    ticker=ticker,
                    date=row.get("fecha") or row.get("Fecha") or None,
                    quantity=parse_decimal(row.get("cantidad") or row.get("Cantidad")),
                    ratio=parse_decimal(row.get("ratio") or row.get("Ratio")),
                )
            )
        return rows


def print_table(results: list[dict[str, Any]]) -> None:
    headers = [
        "ticker",
        "date",
        "sourceDate",
        "ratio",
        "underlyingPriceUsd",
        "cedearPriceUsd",
        "quantity",
        "totalUsd",
    ]
    print(",".join(headers))
    for row in results:
        print(",".join("" if row.get(header) is None else str(row.get(header)) for header in headers))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Busca precio USD historico/actual de un CEDEAR usando Yahoo Finance y ratio.",
    )
    parser.add_argument("--ticker", help="Ticker subyacente/CEDEAR, por ejemplo AAPL")
    parser.add_argument("--date", help="Fecha historica YYYY-MM-DD. Si se omite, usa precio actual.")
    parser.add_argument("--quantity", help="Cantidad de CEDEARs para calcular totalUsd")
    parser.add_argument("--ratio", help="Ratio CEDEAR. Si se omite, intenta leerlo de Firestore.")
    parser.add_argument("--csv", type=pathlib.Path, help="CSV con columnas fecha,ticker,cantidad,ratio")
    parser.add_argument(
        "--api-base",
        help="URL base de la app en Vercel. Tambien puede venir de CEDEAR_PRICE_API_BASE.",
    )
    parser.add_argument("--json", action="store_true", help="Imprime JSON en lugar de CSV")
    args = parser.parse_args()

    if not args.csv and not args.ticker:
        parser.error("usar --ticker o --csv")

    env = load_env()
    ratios = load_ratios_from_firestore(env)
    api_base = args.api_base or env.get("CEDEAR_PRICE_API_BASE")

    queries = (
        read_csv_queries(args.csv)
        if args.csv
        else [
            CedearQuery(
                ticker=args.ticker,
                date=args.date,
                quantity=parse_decimal(args.quantity),
                ratio=parse_decimal(args.ratio),
            )
        ]
    )
    results = [resolve_query(query, ratios, api_base) for query in queries]

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        print_table(results)

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
