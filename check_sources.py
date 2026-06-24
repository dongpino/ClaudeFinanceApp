#!/usr/bin/env python3
# check_sources.py — 데이터 소스 연결 상태 점검
#
# 점검 항목:
#   1. yfinance  — ^IXIC / ^DJI / ^VIX  최근 5일 데이터 수신
#   2. Stooq CSV — NASDAQ(^ixic) CSV vs HTML 판별
#   3. CoinGecko — BTC OHLC 90일 캔들 수 / 날짜 범위
#   4. Binance   — BTC 1d klines 5개 수신 (기준선)

import sys, io, csv, subprocess
from datetime import date, timedelta, datetime, timezone

# ── stdout 인코딩 설정 ─────────────────────────────
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ── yfinance 자동 설치 ────────────────────────────
try:
    import yfinance as yf
except ImportError:
    print("[setup] yfinance 없음 — pip install 실행 중...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "yfinance", "-q"])
    import yfinance as yf
    print("[setup] yfinance 설치 완료\n")

import requests

KST = timezone(timedelta(hours=9))

# ── 결과 수집 ─────────────────────────────────────
results: list[dict] = []   # {label, ok, detail}


def ok(label: str, detail: str) -> None:
    results.append({"label": label, "ok": True, "detail": detail})
    print(f"  ✓  {label}: {detail}")


def fail(label: str, detail: str) -> None:
    results.append({"label": label, "ok": False, "detail": detail})
    print(f"  ✗  {label}: {detail}")


def _sess() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        )
    })
    return s


# ══════════════════════════════════════════════════
# 1. yfinance 테스트
# ══════════════════════════════════════════════════
print("=" * 62)
print("  [1] yfinance — ^IXIC / ^DJI / ^VIX 최근 5일")
print("=" * 62)

YF_SYMBOLS = [("^IXIC", "나스닥"), ("^DJI", "다우존스"), ("^VIX", "VIX")]

for sym, name in YF_SYMBOLS:
    label = f"yfinance/{sym}"
    try:
        # ① no custom session (curl_cffi 기본 동작 허용)
        ticker = yf.Ticker(sym)
        hist   = ticker.history(period="5d", interval="1d", auto_adjust=True)

        if hist.empty:
            # ② requests session 으로 재시도
            ticker2 = yf.Ticker(sym, session=_sess())
            hist    = ticker2.history(period="5d", interval="1d", auto_adjust=True)

        if hist.empty or len(hist) == 0:
            fail(label, "빈 응답 (0행) — Yahoo Finance 차단 가능성")
            continue

        last = hist.index[-1]
        last_close = float(hist["Close"].iloc[-1])
        last_date  = last.strftime("%Y-%m-%d") if hasattr(last, "strftime") else str(last)[:10]
        ok(label, f"{len(hist)}행  최근={last_date}  종가={last_close:>12,.2f}")

    except Exception as e:
        err = str(e)
        if "curl: (35)" in err or "Connection was reset" in err or "Connection aborted" in err:
            fail(label, f"네트워크 차단 — curl(35)/ConnectionReset  [{err[:80]}]")
        elif "possibly delisted" in err.lower() or "no timezone" in err.lower():
            fail(label, f"심볼 미인식 또는 Yahoo 응답 없음  [{err[:80]}]")
        else:
            fail(label, f"예외: {err[:100]}")


# ══════════════════════════════════════════════════
# 2. Stooq CSV 테스트
# ══════════════════════════════════════════════════
print()
print("=" * 62)
print("  [2] Stooq CSV — ^ixic (나스닥 14일)")
print("=" * 62)

stooq_label = "Stooq/^ixic"
try:
    end_d   = date.today()
    start_d = end_d - timedelta(days=14)
    url = (
        f"https://stooq.com/q/d/l/?s=^ixic"
        f"&d1={start_d:%Y%m%d}&d2={end_d:%Y%m%d}&i=d"
    )
    resp = _sess().get(url, timeout=15)
    resp.raise_for_status()

    ct      = resp.headers.get("Content-Type", "")
    preview = resp.text.strip()[:120].replace("\n", " ")

    if "text/html" in ct or resp.text.strip().startswith("<!"):
        fail(stooq_label,
             f"HTML 반환 — JS 보호 페이지 (CSV 차단)  Content-Type={ct[:40]!r}  "
             f"| 미리보기: {preview}")
    else:
        rows = [r for r in csv.DictReader(io.StringIO(resp.text))
                if r.get("Close") not in (None, "", "null", "N/D")]
        if rows:
            ok(stooq_label,
               f"CSV 정상  {len(rows)}행  최신={rows[0].get('Date','?')}  "
               f"Close={rows[0].get('Close','?')}  Content-Type={ct[:30]!r}")
        else:
            fail(stooq_label, f"CSV 빈 데이터  Content-Type={ct[:30]!r}  미리보기: {preview}")

except Exception as e:
    fail(stooq_label, f"예외: {e}")


# ══════════════════════════════════════════════════
# 3. CoinGecko OHLC 테스트
# ══════════════════════════════════════════════════
print()
print("=" * 62)
print("  [3] CoinGecko — BTC OHLC 90일")
print("=" * 62)

for days in [90, 30, 14]:
    cg_label = f"CoinGecko/ohlc?days={days}"
    try:
        resp = requests.get(
            "https://api.coingecko.com/api/v3/coins/bitcoin/ohlc",
            params={"vs_currency": "usd", "days": str(days)},
            timeout=20,
        )
        resp.raise_for_status()
        raw = resp.json()

        if not raw or not isinstance(raw, list):
            fail(cg_label, f"형식 오류: {type(raw)}")
            continue

        # 날짜별 집계
        daily: dict[str, dict] = {}
        for entry in sorted(raw, key=lambda x: x[0]):
            ts_ms, o, h, l, c = entry
            ds = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            if ds not in daily:
                daily[ds] = {"o": o, "h": h, "l": l, "c": c}
            else:
                daily[ds]["h"] = max(daily[ds]["h"], h)
                daily[ds]["l"] = min(daily[ds]["l"], l)
                daily[ds]["c"] = c

        sorted_dates = sorted(daily.keys())
        n_raw   = len(raw)
        n_daily = len(daily)
        first   = sorted_dates[0]  if sorted_dates else "N/A"
        last    = sorted_dates[-1] if sorted_dates else "N/A"

        # 캔들 유형 추정
        if n_raw > 0 and n_daily > 0:
            ratio = n_raw / n_daily
            if ratio < 1.5:
                candle_type = "일봉(1d)"
            elif ratio < 5:
                candle_type = "4시간봉(집계 후 일봉)"
            else:
                candle_type = f"4-day봉(raw/daily={ratio:.1f})"
        else:
            candle_type = "알 수 없음"

        ok(cg_label,
           f"raw={n_raw}개  집계후={n_daily}일  {first}~{last}  캔들유형={candle_type}")

    except requests.HTTPError as e:
        if e.response is not None and e.response.status_code == 429:
            fail(cg_label, "429 Too Many Requests — rate limit 초과")
        else:
            fail(cg_label, f"HTTP 오류: {e}")
    except Exception as e:
        fail(cg_label, f"예외: {e}")


# ══════════════════════════════════════════════════
# 4. Binance klines 테스트 (기준선)
# ══════════════════════════════════════════════════
print()
print("=" * 62)
print("  [4] Binance — BTC 1d klines 5개 수신")
print("=" * 62)

binance_label = "Binance/klines(BTCUSDT,1d)"
try:
    resp = requests.get(
        "https://api.binance.com/api/v3/klines",
        params={"symbol": "BTCUSDT", "interval": "1d", "limit": "5"},
        timeout=15,
    )
    resp.raise_for_status()
    raw = resp.json()

    if not raw or not isinstance(raw, list):
        fail(binance_label, f"형식 오류: {type(raw)}")
    else:
        rows = []
        for k in raw:
            ts_ms = int(k[0])
            ds    = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            o, h, l, c = float(k[1]), float(k[2]), float(k[3]), float(k[4])
            rows.append((ds, o, h, l, c))
        first_d = rows[0][0]
        last_d  = rows[-1][0]
        last_c  = rows[-1][4]
        ok(binance_label,
           f"{len(rows)}캔들  {first_d}~{last_d}  최근종가=${last_c:>12,.2f}")
        for ds, o, h, l, c in rows:
            print(f"      {ds}  O={o:>12,.2f}  H={h:>12,.2f}  L={l:>12,.2f}  C={c:>12,.2f}")

except Exception as e:
    fail(binance_label, f"예외: {e}")


# ══════════════════════════════════════════════════
# 최종 요약 테이블
# ══════════════════════════════════════════════════
print()
W = 68
print("=" * W)
print(f"  최종 요약  ({datetime.now(KST).strftime('%Y-%m-%d %H:%M KST')})")
print("=" * W)
ok_items   = [r for r in results if r["ok"]]
fail_items = [r for r in results if not r["ok"]]

for r in results:
    mark = "✓ OK  " if r["ok"] else "✗ FAIL"
    print(f"  {mark}  {r['label']}")
    if not r["ok"]:
        # 실패 항목은 원인 축약 출력
        detail = r["detail"]
        if len(detail) > 75:
            detail = detail[:72] + "..."
        print(f"         → {detail}")

print("-" * W)
print(f"  성공 {len(ok_items)}/{len(results)}  실패 {len(fail_items)}/{len(results)}")
print()

# 실패 항목 권장 조치
if fail_items:
    print("[권장 조치]")
    for r in fail_items:
        lbl = r["label"]
        d   = r["detail"]
        if "yfinance" in lbl:
            if "curl(35)" in d or "ConnectionReset" in d or "차단" in d:
                print(f"  {lbl}: Yahoo Finance 차단 — VPN 전환 또는 yfinance 대신 대체 소스 사용")
            else:
                print(f"  {lbl}: {d[:60]}")
        elif "Stooq" in lbl:
            print(f"  {lbl}: Stooq JS 보호 — VPN 전환 또는 yfinance/Alpha Vantage 대체")
        elif "CoinGecko" in lbl:
            if "429" in d:
                print(f"  {lbl}: Rate limit — 잠시 대기 후 재시도")
            elif "4-day봉" in d:
                print(f"  {lbl}: days=90은 4-day 캔들 반환 → days=30(4h→일봉) 또는 Binance 사용")
            else:
                print(f"  {lbl}: {d[:60]}")
        elif "Binance" in lbl:
            print(f"  {lbl}: Binance 연결 실패 — {d[:60]}")
    print()
