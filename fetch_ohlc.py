#!/usr/bin/env python3
# fetch_ohlc.py — 6개 종목 90일치 OHLC 수집 → market_data.json 에 history_90d / ohlc_available 추가
#
# 소스 전략:
#   BTC    : Binance klines(1d,90) → CoinGecko /ohlc?days=30(4h집계) → yfinance → 종가전용
#   NASDAQ : Stooq(^ixic) → Stooq(ndq) → yfinance → 종가전용(Naver-World 9p)
#   DOW    : Stooq(dji)   → yfinance               → 종가전용(FRED-DJIA)
#   VIX    : Stooq(^vix)  → yfinance               → 종가전용(FRED-VIXCLS)
#   KOSPI  : yfinance(^KS11) → 종가전용(Naver sise_index_day 9p)
#   USDKRW : 종가전용 (Naver exchangeDailyQuote 9p → Frankfurter)
#
# 진단 결과 (2026-06-24):
#   - Stooq: 이 네트워크에서 CSV 차단, HTML 반환
#   - yfinance: Yahoo Finance 연결 차단 (ConnectionResetError)
#   - CoinGecko ohlc?days=90: 4-day 캔들 반환 (집계 후 23일만) — days=30 사용
#   - Naver sise_index_day: OHLC 없음, 종가(체결가)만 제공
#   - Binance klines: BTC OHLC 최적 소스
#
# 실행: python fetch_ohlc.py

import sys, io, csv, re, json
from datetime import date, timedelta, datetime, timezone
import pathlib
import requests

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

try:
    import yfinance as yf
    _YF = True
except ImportError:
    _YF = False
    print("WARN: yfinance 없음 — pip install yfinance")

KST        = timezone(timedelta(hours=9))
BASE_DIR   = pathlib.Path(__file__).parent
JSON_SRC   = BASE_DIR / "market_data.json"
JSON_REACT = BASE_DIR / "react-app" / "public" / "market_data.json"
TARGET     = 90   # 목표 거래일 수


# ──────────────────────────────────────────────────────
# 공통 헬퍼
# ──────────────────────────────────────────────────────
def _sess() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
    })
    return s


def _n(s) -> float:
    return float(str(s).replace(",", "").strip())


def _row(date_s, o, h, l, c) -> dict:
    return {
        "date":  date_s,
        "open":  round(float(o), 2),
        "high":  round(float(h), 2),
        "low":   round(float(l), 2),
        "close": round(float(c), 2),
    }


def _close_row(date_s, c) -> dict:
    return {"date": date_s, "close": round(float(c), 2)}


# ──────────────────────────────────────────────────────
# OHLC 논리 검증
# ──────────────────────────────────────────────────────
def validate_ohlc(records: list[dict], label: str) -> list[str]:
    issues = []
    for r in records:
        if not all(k in r for k in ("open", "high", "low", "close")):
            continue
        o, h, l, c = r["open"], r["high"], r["low"], r["close"]
        tag = f"{label}[{r['date']}]"
        if h < l:
            issues.append(f"{tag}: high({h}) < low({l})")
        if not (l <= o <= h):
            issues.append(f"{tag}: open({o}) ∉ [low={l}, high={h}]")
        if not (l <= c <= h):
            issues.append(f"{tag}: close({c}) ∉ [low={l}, high={h}]")
        if any(v <= 0 for v in (o, h, l, c)):
            issues.append(f"{tag}: 가격 ≤ 0")
    return issues


# ──────────────────────────────────────────────────────
# BTC: Binance klines API (primary)
# ──────────────────────────────────────────────────────
def fetch_ohlc_binance_btc(limit: int = TARGET) -> list[dict]:
    """
    Binance REST API v3 /klines — BTCUSDT 일봉.
    반환: [[open_time_ms, open, high, low, close, volume, ...], ...]
    모든 값이 문자열로 반환되므로 float 변환 필요.
    """
    resp = requests.get(
        "https://api.binance.com/api/v3/klines",
        params={"symbol": "BTCUSDT", "interval": "1d", "limit": str(limit)},
        timeout=20,
    )
    resp.raise_for_status()
    raw = resp.json()
    if not raw or not isinstance(raw, list):
        raise ValueError(f"Binance 응답 형식 오류: {type(raw)}")

    rows = []
    for k in raw:
        ts_ms = int(k[0])
        ds    = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        rows.append(_row(ds, k[1], k[2], k[3], k[4]))

    if len(rows) < 10:
        raise ValueError(f"Binance 데이터 부족: {len(rows)}행")
    return rows


# ──────────────────────────────────────────────────────
# BTC: CoinGecko OHLC (backup — days=30, 4h캔들 → 일별집계)
# days=90은 4-day 캔들 반환 → 집계 후 ~23일만 확보되므로 사용 불가
# days=30은 4h 캔들 → 집계 후 ~30 일별 캔들
# ──────────────────────────────────────────────────────
def fetch_ohlc_coingecko_btc(days: int = 30) -> list[dict]:
    """
    CoinGecko /ohlc?days=30 → 4시간 캔들 → 일별 OHLC 집계.
    days=90은 4-day 캔들이므로 days=30(4h) 사용.
    최대 ~30일치만 확보되므로 Binance 실패 시 백업용.
    """
    resp = requests.get(
        "https://api.coingecko.com/api/v3/coins/bitcoin/ohlc",
        params={"vs_currency": "usd", "days": str(days)},
        timeout=20,
    )
    resp.raise_for_status()
    raw = resp.json()
    if not raw or not isinstance(raw, list):
        raise ValueError(f"형식 오류: {type(raw)}")

    daily: dict[str, dict] = {}
    for entry in sorted(raw, key=lambda x: x[0]):
        ts_ms, o, h, l, c = entry
        ds = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        if ds not in daily:
            daily[ds] = {"date": ds, "open": o, "high": h, "low": l, "close": c}
        else:
            d = daily[ds]
            d["high"]  = max(d["high"], h)
            d["low"]   = min(d["low"],  l)
            d["close"] = c

    result = [_row(d["date"], d["open"], d["high"], d["low"], d["close"])
              for d in sorted(daily.values(), key=lambda x: x["date"])]

    if len(result) < 5:
        raise ValueError(f"일별 집계 후 {len(result)}일 — 데이터 부족")

    return result


# ──────────────────────────────────────────────────────
# Stooq CSV OHLC
# ──────────────────────────────────────────────────────
def fetch_ohlc_stooq(symbol: str) -> list[dict]:
    end_d   = date.today()
    start_d = end_d - timedelta(days=int(TARGET * 1.8))
    url = (
        f"https://stooq.com/q/d/l/?s={symbol}"
        f"&d1={start_d:%Y%m%d}&d2={end_d:%Y%m%d}&i=d"
    )
    resp = _sess().get(url, timeout=20)
    resp.raise_for_status()

    ct = resp.headers.get("Content-Type", "")
    if "text/html" in ct or resp.text.strip().startswith("<!"):
        raise ValueError(f"HTML 반환 — CSV 차단됨 (symbol={symbol})")

    rows = []
    for r in csv.DictReader(io.StringIO(resp.text)):
        if r.get("Close") in (None, "", "null", "N/D"):
            continue
        try:
            rows.append(_row(r["Date"], r["Open"], r["High"], r["Low"], r["Close"]))
        except (ValueError, KeyError):
            pass

    if len(rows) < 10:
        raise ValueError(f"데이터 부족: {len(rows)}행 (symbol={symbol})")

    return sorted(rows, key=lambda x: x["date"])[-TARGET:]


# ──────────────────────────────────────────────────────
# yfinance OHLC (custom session 없이 — Yahoo Finance가 일부 환경에서
#               requests 세션을 차단하므로 기본 세션 사용)
# ──────────────────────────────────────────────────────
def fetch_ohlc_yfinance(symbol: str) -> list[dict]:
    if not _YF:
        raise ImportError("yfinance 없음")
    end_d   = date.today()
    start_d = end_d - timedelta(days=int(TARGET * 1.8))

    # custom session 없이 yfinance 기본 동작 사용
    ticker = yf.Ticker(symbol)
    hist   = ticker.history(start=str(start_d), end=str(end_d),
                            interval="1d", auto_adjust=True)

    if hist.empty or len(hist) < 10:
        raise ValueError(f"빈 응답 ({len(hist)}행)")

    rows = []
    for ts, r in hist.iterrows():
        ds = ts.strftime("%Y-%m-%d") if hasattr(ts, "strftime") else str(ts)[:10]
        try:
            rows.append(_row(ds, r["Open"], r["High"], r["Low"], r["Close"]))
        except (ValueError, KeyError):
            pass
    return sorted(rows, key=lambda x: x["date"])[-TARGET:]


# ──────────────────────────────────────────────────────
# Naver KOSPI 종가전용 (sise_index_day.naver)
#
# [진단 결과] 이 페이지의 컬럼: 날짜 | 체결가(종가) | 전일비 | 등락률 | 거래량 | 거래대금
# → 시가/고가/저가 없음. OHLC 불가, 종가만 수집.
#
# number_1 셀 순서: [종가, 등락률, 거래량, 거래대금]
# 종가는 <td class="number_1">8,504.58</td> 형식 (span 없음, 소수점 2자리)
# 등락률은 <td class="number_1"><span ...>+3.67%</span></td> 형식 (span 있음, % 포함)
# ──────────────────────────────────────────────────────
def _close_naver_kospi_web(num_pages: int = 15) -> list[dict]:
    """Naver sise_index_day(15페이지 × 6행) → KOSPI 종가 ~90 거래일"""
    sess = _sess()
    sess.headers.update({"Accept": "text/html,*/*", "Referer": "https://finance.naver.com/"})
    seen: dict[str, float] = {}

    for page in range(1, num_pages + 1):
        resp = sess.get(
            "https://finance.naver.com/sise/sise_index_day.naver",
            params={"code": "KOSPI", "page": page}, timeout=15,
        )
        resp.raise_for_status()
        resp.encoding = "euc-kr"

        for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", resp.text, re.DOTALL):
            dm = re.search(r'class="date"[^>]*>\s*(\d{4}\.\d{2}\.\d{2})', tr)
            if not dm:
                continue
            ds = dm.group(1).replace(".", "-")
            # 종가: number_1 셀 중 소수점 2자리 숫자가 직접 들어있는 첫 번째
            # (등락률은 span 안에 % 포함, 거래량은 소수점 없음)
            cm = re.search(r'class="number_1"[^>]*>\s*([\d,]+\.\d{2})\s*</td>', tr)
            if not cm:
                continue
            try:
                v = _n(cm.group(1))
                if 100 < v < 20_000:  # KOSPI 범위
                    seen[ds] = v
            except ValueError:
                pass

    if len(seen) < 5:
        raise ValueError(f"Naver KOSPI web 종가 파싱 실패 ({len(seen)}행)")

    return [_close_row(d, v) for d, v in sorted(seen.items())][-TARGET:]


# ──────────────────────────────────────────────────────
# 종가전용 폴백
# ──────────────────────────────────────────────────────
def _close_naver_sise(naver_symbol: str) -> list[dict]:
    """Naver world/sise.naver → 종가 9페이지 ~90일"""
    sess = _sess()
    sess.headers.update({"Accept": "text/html,*/*", "Referer": "https://finance.naver.com/"})
    seen: dict[str, float] = {}
    for page in range(1, 10):
        resp = sess.get(
            "https://finance.naver.com/world/sise.naver",
            params={"symbol": naver_symbol, "page": page}, timeout=15,
        )
        resp.raise_for_status()
        resp.encoding = "euc-kr"
        for dr, cr in re.findall(
            r'<tr[^>]*>\s*<td[^>]*>\s*(\d{4}\.\d{2}\.\d{2})\s*</td>'
            r'\s*<td[^>]*>\s*<span[^>]*>\s*([\d,]+\.?\d*)\s*</span>',
            resp.text, re.DOTALL,
        ):
            try:
                seen[dr.replace(".", "-")] = _n(cr)
            except ValueError:
                pass
    if not seen:
        raise ValueError("Naver sise 데이터 없음")
    return [_close_row(d, v) for d, v in sorted(seen.items())][-TARGET:]


def _close_fred(fred_id: str) -> list[dict]:
    resp = requests.get(
        "https://fred.stlouisfed.org/graph/fredgraph.csv",
        params={"id": fred_id}, timeout=20,
    )
    resp.raise_for_status()
    rows = [r for r in csv.DictReader(io.StringIO(resp.text))
            if r.get(fred_id) not in ("", ".", None)]
    return [_close_row(r["observation_date"], r[fred_id]) for r in rows[-TARGET:]]


def _close_naver_kospi_mobile() -> list[dict]:
    resp = _sess().get(
        "https://m.stock.naver.com/api/index/KOSPI/price",
        params={"pageSize": TARGET}, timeout=15,
    )
    resp.raise_for_status()
    rows = []
    for r in resp.json():
        d, c = r.get("localTradedAt", ""), r.get("closePrice", "")
        if d and c:
            try:
                rows.append(_close_row(d, _n(c)))
            except ValueError:
                pass
    return sorted(rows, key=lambda x: x["date"])[-TARGET:]


def _close_usdkrw_naver(num_pages: int = 9) -> list[dict]:
    sess = _sess()
    sess.headers.update({"Accept": "text/html,*/*", "Referer": "https://finance.naver.com/"})
    seen: dict[str, float] = {}
    for page in range(1, num_pages + 1):
        resp = sess.get(
            "https://finance.naver.com/marketindex/exchangeDailyQuote.naver",
            params={"marketindexCd": "FX_USDKRW", "page": page}, timeout=15,
        )
        resp.raise_for_status()
        resp.encoding = "euc-kr"
        for dr, rr in re.findall(
            r'(\d{4}\.\d{2}\.\d{2})\s*</td>\s*<td[^>]*>\s*([\d,]+\.\d{2})',
            resp.text, re.DOTALL,
        ):
            try:
                seen[dr.replace(".", "-")] = _n(rr)
            except ValueError:
                pass
    if len(seen) < 5:
        raise ValueError(f"환율 종가 부족: {len(seen)}행")
    return [_close_row(d, v) for d, v in sorted(seen.items())][-TARGET:]


def _close_usdkrw_frankfurter() -> list[dict]:
    end_d   = date.today()
    start_d = end_d - timedelta(days=int(TARGET * 1.8))
    resp = requests.get(
        f"https://api.frankfurter.app/{start_d}..{end_d}",
        params={"from": "USD", "to": "KRW"}, timeout=20,
    )
    resp.raise_for_status()
    rates = sorted(resp.json().get("rates", {}).items())
    if len(rates) < 5:
        raise ValueError(f"Frankfurter 데이터 부족: {len(rates)}행")
    return [_close_row(d, v["KRW"]) for d, v in rates][-TARGET:]


# ──────────────────────────────────────────────────────
# 수집 전략 테이블
# ──────────────────────────────────────────────────────
STRATEGIES = {
    "btc": {
        "name": "비트코인",
        "ohlc": [
            ("Binance-klines",  fetch_ohlc_binance_btc),           # 일봉 90개, 가장 안정적
            ("CoinGecko-OHLC",  fetch_ohlc_coingecko_btc),         # 4h→일별집계, ~30일
            ("yfinance",        lambda: fetch_ohlc_yfinance("BTC-USD")),
        ],
        "close": [],
    },
    "nasdaq": {
        "name": "나스닥",
        "ohlc": [
            ("Stooq(^ixic)",   lambda: fetch_ohlc_stooq("^ixic")),
            ("Stooq(ndq)",     lambda: fetch_ohlc_stooq("ndq")),
            ("yfinance",       lambda: fetch_ohlc_yfinance("^IXIC")),
        ],
        "close": [
            ("Naver-World",    lambda: _close_naver_sise("NAS@IXIC")),
        ],
    },
    "dow": {
        "name": "다우존스",
        "ohlc": [
            ("Stooq(dji)",     lambda: fetch_ohlc_stooq("dji")),
            ("yfinance",       lambda: fetch_ohlc_yfinance("^DJI")),
        ],
        "close": [
            ("FRED-DJIA",      lambda: _close_fred("DJIA")),
        ],
    },
    "vix": {
        "name": "VIX",
        "ohlc": [
            ("Stooq(^vix)",    lambda: fetch_ohlc_stooq("^vix")),
            ("yfinance",       lambda: fetch_ohlc_yfinance("^VIX")),
        ],
        "close": [
            ("FRED-VIXCLS",    lambda: _close_fred("VIXCLS")),
        ],
    },
    "kospi": {
        "name": "코스피",
        # Naver sise_index_day 에는 OHLC 없음(체결가/등락률/거래량만)
        # → yfinance 시도 후 실패하면 Naver web 종가전용
        "ohlc": [
            ("yfinance",       lambda: fetch_ohlc_yfinance("^KS11")),
        ],
        "close": [
            ("Naver-web",      _close_naver_kospi_web),    # sise_index_day 종가 15페이지 ≈90일
        ],
    },
    "usdkrw": {
        "name": "원/달러",
        "ohlc": [],   # 환율 OHLC 소스 없음
        "close": [
            ("Naver-환율",     _close_usdkrw_naver),
            ("Frankfurter",    _close_usdkrw_frankfurter),
        ],
    },
}


# ──────────────────────────────────────────────────────
# JSON 업데이트 (history 필드 절대 건드리지 않음)
# ──────────────────────────────────────────────────────
def update_json(results: dict) -> None:
    if not JSON_SRC.exists():
        print(f"  WARN: {JSON_SRC} 없음 — 저장 건너뜀")
        return

    with open(JSON_SRC, encoding="utf-8") as f:
        data = json.load(f)

    for item in data.get("items", []):
        tid = item.get("id")
        if tid not in results:
            continue
        res = results[tid]
        item["ohlc_available"] = res["ohlc_available"]
        item["history_90d"]    = res["history_90d"]
        # ↑ history(30일 스파크라인) 는 절대 수정하지 않음

    for path in (JSON_SRC, JSON_REACT):
        if path.parent.exists():
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            print(f"  저장: {path}")


# ──────────────────────────────────────────────────────
# main
# ──────────────────────────────────────────────────────
def main() -> None:
    print("=" * 72)
    print("  90일치 OHLC 데이터 수집")
    print(f"  {datetime.now(KST).strftime('%Y-%m-%d %H:%M:%S KST')}")
    print("=" * 72)

    results: dict = {}

    for tid, strat in STRATEGIES.items():
        name = strat["name"]
        print(f"\n── [{tid}] {name} ──")

        ohlc_available = False
        history_90d: list = []
        used_source = "없음"

        # 1) OHLC 소스 순서대로 시도
        for src, fn in strat["ohlc"]:
            print(f"  [{src}]...", end=" ", flush=True)
            try:
                data = fn()
                if len(data) < 5:
                    print(f"부족 ({len(data)}행)")
                    continue
                has_ohlc = "open" in data[0]
                ohlc_available = has_ohlc
                history_90d    = data
                used_source    = src
                print(
                    f"OK  {len(data)}일  "
                    f"{data[0]['date']} ~ {data[-1]['date']}  "
                    f"{'(OHLC)' if has_ohlc else '(종가만)'}"
                )
                break
            except Exception as e:
                print(f"실패: {e}")

        # 2) OHLC 실패 시 종가전용 폴백
        if not history_90d:
            for src, fn in strat["close"]:
                print(f"  [{src}(종가전용)]...", end=" ", flush=True)
                try:
                    data = fn()
                    if len(data) < 5:
                        print(f"부족 ({len(data)}행)")
                        continue
                    ohlc_available = False
                    history_90d    = data
                    used_source    = src + "(종가)"
                    print(f"OK  {len(data)}일  {data[0]['date']} ~ {data[-1]['date']}")
                    break
                except Exception as e:
                    print(f"실패: {e}")

        if not history_90d:
            print(f"  ⚑ 모든 소스 실패")

        # OHLC 논리 검증
        issues: list[str] = []
        if ohlc_available and history_90d:
            issues = validate_ohlc(history_90d, name)
            if issues:
                print(f"  ⚑ OHLC 논리 위반 {len(issues)}건:")
                for iss in issues[:5]:
                    print(f"    - {iss}")
                if len(issues) > 5:
                    print(f"    ... 외 {len(issues)-5}건")

        results[tid] = {
            "ohlc_available": ohlc_available,
            "history_90d":    history_90d,
            "source":         used_source,
            "days":           len(history_90d),
            "issues":         issues,
        }

    # ── 결과 요약 테이블 ──────────────────────────
    W = 82
    print("\n" + "=" * W)
    print(f"  {'ID':<8}  {'이름':<10}  {'ohlc_available':<6}  {'일수':>5}  {'기간':^23}  소스")
    print("=" * W)
    for tid, res in results.items():
        h = res["history_90d"]
        period = f"{h[0]['date']} ~ {h[-1]['date']}" if h else "---"
        mark   = "true  ✓캔들" if res["ohlc_available"] else "false ✗종가"
        warn   = f"  ⚑{len(res['issues'])}건" if res["issues"] else ""
        print(
            f"  {tid:<8}  {STRATEGIES[tid]['name']:<10}  {mark:<15}  "
            f"{res['days']:>3}일  {period:<23}  {res['source']}{warn}"
        )
    print("=" * W)

    # ── sanity 요약 ───────────────────────────────
    total_issues = sum(len(r["issues"]) for r in results.values())
    if total_issues == 0:
        print("\n[OHLC Sanity] 전 종목 통과 — high≥low, open/close ∈ [low, high]")
    else:
        print(f"\n[OHLC Sanity] ⚑ 총 {total_issues}건 위반")

    # ── JSON 저장 ─────────────────────────────────
    print("\n[JSON 저장]")
    update_json(results)
    print("완료.")


if __name__ == "__main__":
    main()
