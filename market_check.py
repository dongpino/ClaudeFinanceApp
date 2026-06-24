# market_check.py
# 주요 증시 지표 4개의 실시간(15분 지연) 시세 검증 스크립트
#
# [데이터 소스 우선순위]
#   나스닥·다우 : Stooq CSV → CNBC 공개 API → 네이버 해외지수 → yfinance
#   코스피       : Naver 증권 모바일 API    → yfinance
#   BTC          : CoinGecko API             → yfinance
#
# [네이버 해외지수 소스 상세]
#   URL : https://finance.naver.com/world/worldMain.naver  (EUC-KR HTML)
#   방식: 서버사이드 렌더링된 americaData JS 변수에서 추출
#   심볼: NAS@IXIC (나스닥 종합), DJI@DJI (다우 산업)
#   필드: last(현재가), diff(전일대비 변동값·부호 포함), rate(변동률%)
#   전일종가 = last - diff 로 역산
#
# [설치 명령]
#   python -m pip install yfinance requests
#
# [실행 명령]
#   set PYTHONIOENCODING=utf-8 && python market_check.py

import sys
import io
import csv
import re
from datetime import datetime, date, timedelta, timezone

import requests
import yfinance as yf

# Windows cp949 콘솔 환경에서 한글·특수문자 깨짐 방지
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

KST = timezone(timedelta(hours=9))

# ─────────────────────────────────────────────────
# Sanity-check 범위 (현재가가 이 범위를 벗어나면 경고)
# 시장이 장기 추세를 벗어난 경우를 대비해 여유 있게 설정
# ─────────────────────────────────────────────────
SANITY = {
    "^IXIC":   (3_000,   60_000, "나스닥"),
    "^DJI":    (10_000, 120_000, "다우존스"),
    "^KS11":   (500,    25_000,  "코스피"),
    "BTC-USD": (100,   800_000,  "비트코인"),
    "^VIX":    (5,          90,  "VIX"),
    "USDKRW":  (1_000,   2_000,  "원달러"),
}

TICKER_META = {
    "^IXIC":   ("nasdaq", "지수"),
    "^DJI":    ("dow",    "지수"),
    "^KS11":   ("kospi",  "지수"),
    "BTC-USD": ("btc",    "크립토"),
    "^VIX":    ("vix",    "지수"),
    "USDKRW":  ("usdkrw", "환율"),
}

# ─────────────────────────────────────────────────
# 공통 유틸
# ─────────────────────────────────────────────────
def now_kst() -> str:
    return datetime.now(KST).strftime("%Y-%m-%d %H:%M KST")


def fmt_time(ts) -> str:
    """datetime / pandas Timestamp / UNIX 숫자 → KST 문자열."""
    if ts is None:
        return now_kst()
    if isinstance(ts, (int, float)):
        ts = datetime.fromtimestamp(ts, tz=timezone.utc)
    if hasattr(ts, "tzinfo") and ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(KST).strftime("%Y-%m-%d %H:%M KST")


def clean_num(s) -> float:
    """'1,234.56' / '-0.09%' / float → float."""
    return float(str(s).replace(",", "").replace("%", "").strip())


def arrow(change: float) -> str:
    """변동값 부호로 화살표 결정. 0은 '-'로 표시."""
    if change > 0:
        return "▲"
    if change < 0:
        return "▼"
    return "-"


def direction(change: float) -> str:
    """변동값 부호로 방향 문자열 결정 (JSON 저장용)."""
    if change > 0:
        return "up"
    if change < 0:
        return "down"
    return "flat"


def _session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept":          "application/json, text/plain, */*",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
    })
    return s


def _make_result(name: str, source: str, ticker: str,
                 current: float, prev_close: float, ts_str: str) -> dict:
    """current와 prev_close로 change/change_pct를 직접 계산해 dict 반환."""
    change     = current - prev_close
    change_pct = (change / prev_close * 100) if prev_close != 0 else 0.0
    return {
        "name": name, "source": source, "ticker": ticker,
        "current": current, "prev_close": prev_close,
        "change": change, "change_pct": change_pct,
        "timestamp": ts_str,
    }


# ─────────────────────────────────────────────────
# Sanity check
# ─────────────────────────────────────────────────
def run_sanity(r: dict) -> list[str]:
    """결과 dict에 대해 합리적 범위·부호 일관성을 검증한다."""
    warns = []
    lo, hi, label = SANITY.get(r["ticker"], (0, float("inf"), r["name"]))

    if not (lo <= r["current"] <= hi):
        warns.append(
            f"현재가 {r['current']:,.2f} 이 기대 범위 "
            f"{lo:,}~{hi:,} 밖 — 데이터 오류 가능"
        )
    if r["prev_close"] <= 0:
        warns.append(f"전일종가 {r['prev_close']:,.2f} ≤ 0")

    # 변동률 20% 초과는 이상 신호 (서킷브레이커급)
    if abs(r["change_pct"]) > 20:
        warns.append(
            f"변동률 {r['change_pct']:+.2f}% — 20% 초과 "
            "(서킷브레이커급, 데이터 이상 가능)"
        )

    # change 부호와 change_pct 부호가 달라지면 계산 오류
    if r["change"] != 0 and r["change_pct"] != 0:
        if (r["change"] > 0) != (r["change_pct"] > 0):
            warns.append(
                f"change={r['change']:+.4f} 과 "
                f"change_pct={r['change_pct']:+.4f}% 부호 불일치!"
            )

    return warns


# ─────────────────────────────────────────────────
# 화살표 로직 단위 검증 (프로그램 시작 시 1회 실행)
# ─────────────────────────────────────────────────
def verify_arrow_logic() -> None:
    """arrow() 함수가 부호와 일관되는지 케이스별로 검증."""
    cases = [
        (+100.0, "▲", "양수 변동 → ▲"),
        (-100.0, "▼", "음수 변동 → ▼"),
        (0.0,    "-", "0 변동 → -"),
        (+0.001, "▲", "미세 양수 → ▲"),
        (-0.001, "▼", "미세 음수 → ▼"),
    ]
    all_pass = True
    for val, expected, desc in cases:
        got = arrow(val)
        ok  = got == expected
        if not ok:
            all_pass = False
            print(f"  [ARROW-FAIL] {desc}: 기대={expected} 실제={got}")
    if all_pass:
        print("  [arrow 검증] 전체 통과 — 변동값 부호와 화살표 일관성 확인됨")
    else:
        print("  [arrow 검증] 일부 실패! 위 항목 확인 필요")


# ─────────────────────────────────────────────────
# 소스 A: Stooq CSV (1차 시도 — 이 환경에서는 HTML 반환으로 skip)
#   URL: https://stooq.com/q/d/l/?s={symbol}&d1=...&d2=...&i=d
#   반환: CSV (Date, Open, High, Low, Close, Volume)
#   Stooq 심볼: ndq(NASDAQ100), dji(다우), spx(S&P500)
#
#   ※ 일부 네트워크(기업망, 일부 ISP)에서 Stooq는 CSV 대신
#     JavaScript 보호 HTML을 반환한다. 이 경우 자동으로 CNBC로 폴백한다.
# ─────────────────────────────────────────────────
def _fetch_stooq_raw(stooq_symbol: str) -> tuple[float, float, str]:
    """
    Stooq CSV 엔드포인트에서 일별 OHLCV를 가져온다.
    응답이 HTML이면 ValueError를 발생시켜 상위 폴백을 유도한다.
    """
    end_d   = date.today()
    start_d = end_d - timedelta(days=14)
    url = (
        f"https://stooq.com/q/d/l/?s={stooq_symbol}"
        f"&d1={start_d:%Y%m%d}&d2={end_d:%Y%m%d}&i=d"
    )
    resp = _session().get(url, timeout=15)
    resp.raise_for_status()

    ct = resp.headers.get("Content-Type", "")
    if "text/html" in ct:
        # JavaScript 보호 or 티커 없음: CSV가 아닌 HTML 반환
        raise ValueError(
            f"Stooq가 HTML 반환 (Content-Type={ct}) "
            "— 이 네트워크에서 CSV 다운로드 차단됨"
        )

    rows = [
        r for r in csv.DictReader(io.StringIO(resp.text))
        if r.get("Close") not in (None, "", "null", "N/D")
    ]
    if len(rows) < 2:
        raise ValueError(f"Stooq CSV 데이터 부족: {len(rows)}행")

    # Stooq는 최신 → 과거 정렬
    current    = float(rows[0]["Close"])
    prev_close = float(rows[1]["Close"])
    ts_str     = rows[0].get("Date", "N/A") + " (Stooq 종가)"
    return current, prev_close, ts_str


def fetch_stooq(name: str, ticker_yf: str, stooq_symbol: str) -> dict | None:
    try:
        current, prev_close, ts_str = _fetch_stooq_raw(stooq_symbol)
        return _make_result(name, "Stooq", ticker_yf, current, prev_close, ts_str)
    except Exception as e:
        print(f"     WARN [Stooq] {name} ({stooq_symbol}): {e}")
        return None


# ─────────────────────────────────────────────────
# 소스 B: CNBC 공개 API (2차)
#   URL: https://quote.cnbc.com/quote-html-webservice/quote.htm
#   심볼: .IXIC(나스닥), .DJI(다우)
#   핵심 필드:
#     last                → 현재가 (장중 최신 호가 또는 종가)
#     previous_day_closing→ 전일 종가
#     changetype          → "UP" / "DOWN" (방향 교차 검증용)
#   주의: API의 change/change_pct 필드는 그대로 사용하지 않고,
#         current - prev_close 로 직접 재계산한다.
# ─────────────────────────────────────────────────
_cnbc_cache: dict = {}


def _fetch_cnbc_bulk() -> None:
    if _cnbc_cache:
        return
    url    = "https://quote.cnbc.com/quote-html-webservice/quote.htm"
    params = {
        "symbols":       ".IXIC|.DJI|.VIX",
        "requestMethod": "itv",
        "noform":        "1",
        "partnerId":     "2",
        "fund":          "1",
        "exthrs":        "1",
        "output":        "json",
        "events":        "0",
    }
    resp = _session().get(url, params=params, timeout=15)
    resp.raise_for_status()
    for q in resp.json()["ITVQuoteResult"]["ITVQuote"]:
        _cnbc_cache[q["symbol"]] = q


def fetch_cnbc(name: str, ticker_yf: str, cnbc_symbol: str) -> dict | None:
    """
    CNBC API에서 시세를 가져온다.
    전일대비는 last - previous_day_closing 으로 직접 계산하고,
    API의 changetype 필드로 방향을 교차 검증한다.
    """
    try:
        _fetch_cnbc_bulk()
        q = _cnbc_cache[cnbc_symbol]

        current    = clean_num(q["last"])
        prev_close = clean_num(q["previous_day_closing"])
        change     = current - prev_close   # 직접 계산 (API change 필드 무시)

        # CNBC changetype 교차 검증
        api_changetype = q.get("changetype", "").upper()   # "UP" / "DOWN"
        api_up         = api_changetype == "UP"
        calc_up        = change > 0
        if api_changetype and api_up != calc_up and abs(change) > 0.01:
            # 두 값이 다르면 경고하되 계산값을 우선한다
            print(
                f"     [WARN] CNBC {cnbc_symbol}: "
                f"changetype={api_changetype} 이지만 "
                f"계산된 change={change:+.4f} — 계산값 우선 사용"
            )

        return _make_result(name, "CNBC", ticker_yf, current, prev_close, now_kst())
    except Exception as e:
        print(f"     WARN [CNBC] {name}: {e}")
        return None


# ─────────────────────────────────────────────────
# 소스 C: 네이버 증권 모바일 API (코스피)
#   URL: https://m.stock.naver.com/api/index/KOSPI/price
#   rows[0] = 최신 거래일 종가, rows[1] = 전일 종가
# ─────────────────────────────────────────────────
def fetch_naver_kospi(name: str) -> dict | None:
    try:
        resp = _session().get(
            "https://m.stock.naver.com/api/index/KOSPI/price", timeout=10
        )
        resp.raise_for_status()
        rows = resp.json()
        if len(rows) < 2:
            raise ValueError(f"Naver 응답 행 부족: {len(rows)}")

        current    = clean_num(rows[0]["closePrice"])
        prev_close = clean_num(rows[1]["closePrice"])
        ts_str     = rows[0]["localTradedAt"] + " (Naver 종가)"
        return _make_result(name, "Naver", "^KS11", current, prev_close, ts_str)
    except Exception as e:
        print(f"     WARN [Naver] {name}: {e}")
        return None


# ─────────────────────────────────────────────────
# 소스 D: CNBC VIX 공포지수
#   심볼: .VIX (기존 .IXIC|.DJI 벌크 호출에 추가)
# ─────────────────────────────────────────────────
def fetch_cnbc_vix() -> dict | None:
    try:
        _fetch_cnbc_bulk()
        q = _cnbc_cache[".VIX"]
        current    = clean_num(q["last"])
        prev_close = clean_num(q["previous_day_closing"])
        return _make_result("VIX 공포지수", "CNBC", "^VIX", current, prev_close, now_kst())
    except Exception as e:
        print(f"     WARN [CNBC/VIX]: {e}")
        return None


# ─────────────────────────────────────────────────
# 소스 E: 네이버 환율 HTML (USD/KRW)
#   URL: finance.naver.com/marketindex/exchangeDailyQuote.naver
#   rows[0] = 최신 거래일 환율, rows[1] = 전일 환율
# ─────────────────────────────────────────────────
def fetch_naver_usdkrw() -> dict | None:
    try:
        sess = _session()
        sess.headers.update({
            "Accept":  "text/html,*/*",
            "Referer": "https://finance.naver.com/",
        })
        resp = sess.get(
            "https://finance.naver.com/marketindex/exchangeDailyQuote.naver",
            params={"marketindexCd": "FX_USDKRW", "page": 1}, timeout=15,
        )
        resp.raise_for_status()
        resp.encoding = "euc-kr"
        matches = re.findall(
            r'(\d{4}\.\d{2}\.\d{2})\s*</td>\s*<td[^>]*>\s*([\d,]+\.\d{2})',
            resp.text, re.DOTALL,
        )
        if len(matches) < 2:
            raise ValueError(f"환율 행 {len(matches)}개 (최소 2개 필요)")
        current    = clean_num(matches[0][1])
        prev_close = clean_num(matches[1][1])
        ts_str     = matches[0][0].replace(".", "-") + " (Naver 환율)"
        return _make_result("원/달러", "Naver환율", "USDKRW", current, prev_close, ts_str)
    except Exception as e:
        print(f"     WARN [Naver환율]: {e}")
        return None


def fetch_frankfurter_usdkrw() -> dict | None:
    """Frankfurter.app 무료 API → USD/KRW 일별 환율 (ECB 기반, 키 불필요)."""
    try:
        end_d   = date.today()
        start_d = end_d - timedelta(days=7)
        resp = requests.get(
            f"https://api.frankfurter.app/{start_d}..{end_d}",
            params={"from": "USD", "to": "KRW"}, timeout=15,
        )
        resp.raise_for_status()
        rates = sorted(resp.json()["rates"].items())   # [(date_str, {"KRW": val}), ...]
        if len(rates) < 2:
            raise ValueError(f"데이터 포인트 {len(rates)}개 부족")
        current    = rates[-1][1]["KRW"]
        prev_close = rates[-2][1]["KRW"]
        return _make_result("원/달러", "Frankfurter", "USDKRW", current, prev_close, now_kst())
    except Exception as e:
        print(f"     WARN [Frankfurter/USDKRW]: {e}")
        return None


# ─────────────────────────────────────────────────
# 소스 C-2: 네이버 해외지수 (미국 지수 2차 백업)
#
#   finance.naver.com/world/worldMain.naver (EUC-KR HTML)에는
#   서버사이드로 렌더링된 JavaScript 변수 americaData가 포함된다:
#     var americaData = jindo.$H({ "NAS@IXIC": { "last": 25587.04,
#       "diff": -579.56, "rate": "-2.21%", "lastUpdTime": "...", ... }, ... });
#
#   파싱 전략:
#     1) 정규식으로 americaData = jindo.$H({...}) 블록 추출
#     2) JSON.loads 로 파싱
#     3) last, diff 필드로 현재가·전일대비 추출
#     4) prev_close = last - diff 로 역산
#
#   알려진 심볼:
#     NAS@IXIC  나스닥 종합 (NASDAQ Composite)
#     DJI@DJI   다우 산업 (DowJones Industrial)
#     NAS@NDX   나스닥 100
#     SPI@SPX   S&P 500
# ─────────────────────────────────────────────────
import json as _json   # 소스 내 json 충돌 방지용 alias

_naver_world_cache: dict | None = None   # 같은 실행 내 1회만 HTML 파싱


def _fetch_naver_world_data() -> dict:
    """
    worldMain.naver HTML을 한 번 파싱해 americaData 딕셔너리를 반환한다.
    두 번째 호출부터는 캐시를 반환한다 (같은 프로세스 실행 내).
    """
    global _naver_world_cache
    if _naver_world_cache is not None:
        return _naver_world_cache

    sess = _session()
    sess.headers.update({
        "Accept":   "text/html,application/xhtml+xml,*/*",
        "Referer":  "https://finance.naver.com/",
    })
    resp = sess.get("https://finance.naver.com/world/worldMain.naver", timeout=15)
    resp.raise_for_status()
    resp.encoding = "euc-kr"   # 네이버 PC 금융은 EUC-KR 인코딩

    # americaData = jindo.$H({ ... }) 블록 추출
    m = re.search(
        r'var\s+americaData\s*=\s*jindo\.\$H\((\{.*?\})\)',
        resp.text,
        re.DOTALL,
    )
    if not m:
        raise ValueError("americaData 변수를 HTML에서 찾지 못함")

    _naver_world_cache = _json.loads(m.group(1))
    return _naver_world_cache


def fetch_naver_world(name: str, ticker_yf: str, naver_symbol: str) -> dict | None:
    """
    네이버 해외지수에서 미국 지수 데이터를 가져온다.

    인자:
      naver_symbol  네이버 심볼 (예: "NAS@IXIC", "DJI@DJI")

    반환 필드:
      현재가  = data["last"]
      변동값  = data["diff"]   (부호 포함 float)
      전일종가 = last - diff
      변동률  = data["rate"]   (문자열 "-2.21%" → float 변환)
    """
    try:
        all_data = _fetch_naver_world_data()
        if naver_symbol not in all_data:
            raise ValueError(
                f"심볼 {naver_symbol!r} 없음 — "
                f"사용 가능: {list(all_data.keys())}"
            )
        d = all_data[naver_symbol]

        current    = float(d["last"])
        change     = float(d["diff"])       # 부호 포함 변동값
        prev_close = current - change        # 전일 종가 역산

        # lastUpdTime: "2026-06-24 09:22:43" 형태 → KST 문자열
        upd_raw = d.get("lastUpdTime", "")
        try:
            dt_upd = datetime.strptime(upd_raw, "%Y-%m-%d %H:%M:%S")
            dt_upd = dt_upd.replace(tzinfo=KST)
            ts_str = dt_upd.strftime("%Y-%m-%d %H:%M KST")
        except Exception:
            ts_str = upd_raw or now_kst()

        return _make_result(name, "Naver-World", ticker_yf,
                            current, prev_close, ts_str)
    except Exception as e:
        print(f"     WARN [Naver-World] {name} ({naver_symbol}): {e}")
        return None


# ─────────────────────────────────────────────────
# 소스 D: yfinance (공통 폴백)
#   requests 세션 주입 → curl_cffi 블락 우회 시도
#   fast_info → history() 순으로 재시도
# ─────────────────────────────────────────────────
def fetch_yfinance(name: str, ticker_symbol: str) -> dict | None:
    try:
        session = _session()
        ticker  = yf.Ticker(ticker_symbol, session=session)

        try:
            fi         = ticker.fast_info
            current    = fi.last_price
            prev_close = fi.previous_close
            if current is None or prev_close is None:
                raise ValueError("fast_info 값 없음")
            try:
                ts = fi.last_fetched
            except Exception:
                ts = None
            return _make_result(name, "yfinance", ticker_symbol,
                                float(current), float(prev_close), fmt_time(ts))
        except Exception as e1:
            hist = ticker.history(period="5d", auto_adjust=True)
            if hist.empty or len(hist) < 2:
                raise ValueError(f"fast_info({e1}) & history 빈 응답")
            return _make_result(
                name, "yfinance/hist", ticker_symbol,
                float(hist["Close"].iloc[-1]),
                float(hist["Close"].iloc[-2]),
                fmt_time(hist.index[-1]),
            )
    except Exception as e:
        print(f"     WARN [yfinance] {name}: {e}")
        return None


# ─────────────────────────────────────────────────
# 소스 E: CoinGecko (BTC 전용)
#   /simple/price → 24h 변동률로 전일 종가 역산
#   prev = current / (1 + pct/100)
# ─────────────────────────────────────────────────
def fetch_coingecko_btc() -> dict | None:
    try:
        resp = requests.get(
            "https://api.coingecko.com/api/v3/simple/price",
            timeout=10,
            params={
                "ids":                     "bitcoin",
                "vs_currencies":           "usd",
                "include_24hr_change":     "true",
                "include_last_updated_at": "true",
            },
        )
        resp.raise_for_status()
        data       = resp.json()["bitcoin"]
        current    = float(data["usd"])
        change_pct = float(data["usd_24h_change"])
        prev_close = current / (1 + change_pct / 100)
        return _make_result(
            "비트코인 BTC-USD", "CoinGecko", "BTC-USD",
            current, prev_close, fmt_time(data["last_updated_at"]),
        )
    except Exception as e:
        print(f"     WARN [CoinGecko] BTC: {e}")
        return None


# ─────────────────────────────────────────────────
# 시계열(history) 데이터 수집 함수
#
# 소스별 전략:
#   BTC    — CoinGecko /market_chart (days=30, interval=daily)
#   KOSPI  — m.stock.naver /api/index/KOSPI/price?pageSize=30
#   NASDAQ — finance.naver /world/sise.naver?symbol=NAS@IXIC&page=N  (3페이지 × 10행)
#   DOW    — finance.naver /world/sise.naver?symbol=DJI@DJI&page=N   (3페이지 × 10행)
# ─────────────────────────────────────────────────
def fetch_history_coingecko_btc(days: int = 30) -> list[dict]:
    """CoinGecko market_chart → BTC 일별 종가 반환 (days 일분)."""
    resp = requests.get(
        "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart",
        params={"vs_currency": "usd", "days": str(days), "interval": "daily"},
        timeout=15,
    )
    resp.raise_for_status()
    prices = resp.json()["prices"]   # [[timestamp_ms, price], ...]
    # 날짜별 마지막 값으로 중복 제거 (오늘 날짜는 2개 반환될 수 있음)
    seen: dict[str, float] = {}
    for ts_ms, price in prices:
        dt_str = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        seen[dt_str] = round(price, 2)
    return [{"date": d, "close": p} for d, p in sorted(seen.items())]


def fetch_history_naver_kospi(page_size: int = 30) -> list[dict]:
    """Naver mobile API → KOSPI 일별 종가 반환."""
    resp = _session().get(
        "https://m.stock.naver.com/api/index/KOSPI/price",
        params={"pageSize": page_size},
        timeout=10,
    )
    resp.raise_for_status()
    rows = resp.json()
    result = []
    for row in rows:
        date_str  = row.get("localTradedAt", "")
        close_str = row.get("closePrice", "")
        if date_str and close_str:
            try:
                result.append({"date": date_str, "close": clean_num(close_str)})
            except ValueError:
                pass
    return sorted(result, key=lambda x: x["date"])


def fetch_history_fred_djia(trading_days: int = 30) -> list[dict]:
    """
    FRED (St. Louis Fed) 공개 CSV → DOW Jones 일별 종가 반환.
    API 키 불필요. fredgraph.csv?id=DJIA 로 전체 시계열 수신 후 최근 N일만 반환.
    """
    resp = requests.get(
        "https://fred.stlouisfed.org/graph/fredgraph.csv",
        params={"id": "DJIA"},
        timeout=20,
    )
    resp.raise_for_status()
    rows = [
        row for row in csv.DictReader(io.StringIO(resp.text))
        if row.get("DJIA") not in ("", ".", None)
    ]
    rows = rows[-trading_days:]   # 최신 N 거래일만 취득
    return [{"date": row["observation_date"], "close": round(float(row["DJIA"]), 2)}
            for row in rows]


def fetch_history_naver_world_sise(naver_symbol: str, num_pages: int = 3) -> list[dict]:
    """
    finance.naver.com/world/sise.naver HTML 파싱으로 미국 지수 일별 종가 반환.
    각 페이지에 약 10행, num_pages 페이지를 합쳐 반환한다.

    파싱 대상 HTML 패턴:
      <tr>
        <td>2026.06.23</td>               ← 날짜
        <td><span>25,587.04</span></td>   ← 종가
        ...
      </tr>
    """
    sess = _session()
    sess.headers.update({
        "Accept":  "text/html,application/xhtml+xml,*/*",
        "Referer": "https://finance.naver.com/",
    })
    seen: dict[str, float] = {}
    for page in range(1, num_pages + 1):
        resp = sess.get(
            "https://finance.naver.com/world/sise.naver",
            params={"symbol": naver_symbol, "page": page},
            timeout=15,
        )
        resp.raise_for_status()
        resp.encoding = "euc-kr"
        matches = re.findall(
            r'<tr[^>]*>\s*<td[^>]*>\s*(\d{4}\.\d{2}\.\d{2})\s*</td>'
            r'\s*<td[^>]*>\s*<span[^>]*>\s*([\d,]+\.?\d*)\s*</span>',
            resp.text, re.DOTALL,
        )
        for date_raw, close_raw in matches:
            date_str = date_raw.replace(".", "-")   # YYYY.MM.DD → YYYY-MM-DD
            try:
                seen[date_str] = clean_num(close_raw)
            except ValueError:
                pass
    return [{"date": d, "close": p} for d, p in sorted(seen.items())]


def fetch_history_naver_usdkrw(num_pages: int = 3) -> list[dict]:
    """
    Naver exchangeDailyQuote HTML 파싱 → USD/KRW 일별 환율 최근 30 거래일.
    각 페이지 10행 × 3페이지 = 30행 수집.
    """
    sess = _session()
    sess.headers.update({
        "Accept":  "text/html,*/*",
        "Referer": "https://finance.naver.com/",
    })
    seen: dict[str, float] = {}
    for page in range(1, num_pages + 1):
        resp = sess.get(
            "https://finance.naver.com/marketindex/exchangeDailyQuote.naver",
            params={"marketindexCd": "FX_USDKRW", "page": page}, timeout=15,
        )
        resp.raise_for_status()
        resp.encoding = "euc-kr"
        matches = re.findall(
            r'(\d{4}\.\d{2}\.\d{2})\s*</td>\s*<td[^>]*>\s*([\d,]+\.\d{2})',
            resp.text, re.DOTALL,
        )
        for date_raw, rate_raw in matches:
            date_str = date_raw.replace(".", "-")
            try:
                seen[date_str] = clean_num(rate_raw)
            except ValueError:
                pass
    if not seen:
        raise ValueError("Naver 환율 history: 데이터 없음")
    return [{"date": d, "close": p} for d, p in sorted(seen.items())]


def fetch_history_frankfurter_usdkrw(trading_days: int = 30) -> list[dict]:
    """Frankfurter 60일 범위 조회 → 최근 trading_days 거래일 환율 (Naver 실패 시 백업)."""
    end_d   = date.today()
    start_d = end_d - timedelta(days=60)
    resp = requests.get(
        f"https://api.frankfurter.app/{start_d}..{end_d}",
        params={"from": "USD", "to": "KRW"}, timeout=20,
    )
    resp.raise_for_status()
    rates = sorted(resp.json().get("rates", {}).items())
    rates = rates[-trading_days:]
    return [{"date": d, "close": round(v["KRW"], 2)} for d, v in rates]


def fetch_history_fred_vix(trading_days: int = 30) -> list[dict]:
    """FRED VIXCLS CSV → VIX 일별 종가 최근 trading_days 거래일."""
    resp = requests.get(
        "https://fred.stlouisfed.org/graph/fredgraph.csv",
        params={"id": "VIXCLS"}, timeout=20,
    )
    resp.raise_for_status()
    rows = [
        row for row in csv.DictReader(io.StringIO(resp.text))
        if row.get("VIXCLS") not in ("", ".", None)
    ]
    rows = rows[-trading_days:]
    return [{"date": row["observation_date"], "close": round(float(row["VIXCLS"]), 2)}
            for row in rows]


def _fetch_history_usdkrw_with_fallback() -> list[dict]:
    try:
        h = fetch_history_naver_usdkrw()
        if len(h) >= 10:
            return h
        raise ValueError(f"Naver 환율 history 포인트 부족: {len(h)}")
    except Exception as e:
        print(f"     WARN [history/usdkrw Naver 실패, Frankfurter 전환]: {e}")
        return fetch_history_frankfurter_usdkrw()


# 티커 → history 수집 함수 매핑
#   DOW: Naver sise.naver는 page 파라미터가 DJI@DJI에서 동작하지 않아 10행 고정 →
#        FRED (St. Louis Fed) DJIA CSV로 대체 (30거래일 확보)
_HISTORY_FETCHERS = {
    "nasdaq": lambda: fetch_history_naver_world_sise("NAS@IXIC"),
    "dow":    lambda: fetch_history_fred_djia(),
    "kospi":  lambda: fetch_history_naver_kospi(),
    "btc":    lambda: fetch_history_coingecko_btc(),
    "vix":    lambda: fetch_history_fred_vix(),
    "usdkrw": _fetch_history_usdkrw_with_fallback,
}


def enrich_with_history(results: list[dict]) -> None:
    """
    results의 각 dict에 history 키를 직접 추가한다.
    실패 시 history=[] 로 설정하고 에러 로그를 남긴다.
    """
    for r in results:
        meta_id, _ = TICKER_META.get(r["ticker"], (r["ticker"].lower(), "기타"))
        fn = _HISTORY_FETCHERS.get(meta_id)
        if fn is None:
            r["history"] = []
            print(f"     WARN [history] {meta_id}: 수집 함수 없음")
            continue
        try:
            history = fn()
            r["history"] = history
            print(f"     OK  [{meta_id}]  {len(history)}포인트  "
                  f"({history[0]['date'] if history else 'N/A'} ~ "
                  f"{history[-1]['date'] if history else 'N/A'})")
        except Exception as e:
            r["history"] = []
            print(f"     WARN [history/{meta_id}]: {e}")


# ─────────────────────────────────────────────────
# 전일대비 보정 — 장 마감 후 change=0 문제
# ─────────────────────────────────────────────────
def recalc_change_with_history(r: dict) -> None:
    """
    장 마감 후 API가 current == prev_close 를 반환해 change=0 이 되는 버그를 보정한다.
    (예: 미국장 마감 후 CNBC가 last와 previous_day_closing에 동일한 최종 종가를 넣음)

    [판단 로직]
    ① change가 이미 0이 아닌 경우: API가 정상 제공 중 → 그대로 반환 (장중·24h 거래 포함)

    ② change ≈ 0 인 경우 → history 배열로 재계산:
       A. current ≈ history[-1]  (장 마감: API 현재가 = 최근 종가)
          → history[-1] vs history[-2] 로 전일대비 계산
       B. current ≠ history[-1]  (이례: change=0 이지만 가격이 다른 경우)
          → current 유지, prev_close = history[-1] 로 교체
    """
    if abs(r.get("change", 0)) > 0.01:
        return  # 이미 정상 값 → 수정 불필요

    history = r.get("history", [])
    if len(history) < 2:
        print(f"     WARN [보정 스킵] {r['name']}: history 포인트 부족 ({len(history)}개)")
        return

    h_last = history[-1]["close"]   # 최근 거래일 종가
    h_prev = history[-2]["close"]   # 전 거래일 종가
    api_curr = r["current"]

    diff_pct = abs(api_curr - h_last) / h_last * 100 if h_last else 0

    if diff_pct < 0.05:
        # A. 장 마감: API 현재가 ≈ history 최근 종가
        #    history[-1] vs history[-2] 로 전일대비 산출
        new_curr = h_last
        new_prev = h_prev
        mode = "장마감"
    else:
        # B. 이례 케이스: change=0 이지만 가격이 다름
        #    API 현재가 유지, prev_close = history[-1] 로 교체
        new_curr = api_curr
        new_prev = h_last
        mode = "이례"

    old_pct = r["change_pct"]
    r["current"]    = new_curr
    r["prev_close"] = new_prev
    r["change"]     = new_curr - new_prev
    r["change_pct"] = (r["change"] / new_prev * 100) if new_prev else 0.0

    print(f"     [보정] {r['name']}: {old_pct:+.4f}% → {r['change_pct']:+.4f}%  ({mode})")
    print(f"            history[-1]={h_last:,.2f} ({history[-1]['date']})  "
          f"history[-2]={h_prev:,.2f} ({history[-2]['date']})")


def _simulate_recalc_scenarios() -> None:
    """장중/장마감 두 시나리오를 시뮬레이션해 recalc_change_with_history 분기 검증."""
    print("\n  [시뮬레이션] recalc 분기 검증 (나스닥 기준)")
    sim_history = [
        {"date": "2026-06-22", "close": 26_166.60},
        {"date": "2026-06-23", "close": 25_587.04},
    ]

    # 시나리오 A: 장 마감 (CNBC current == prev_close == 최근 종가)
    r_closed = {
        "name": "나스닥[장마감]", "ticker": "^IXIC",
        "current": 25_587.04, "prev_close": 25_587.04,
        "change": 0.0, "change_pct": 0.0,
        "history": sim_history,
    }
    recalc_change_with_history(r_closed)
    assert abs(r_closed["change_pct"] - (-2.214)) < 0.05, \
        f"장마감 보정 실패: {r_closed['change_pct']:.4f}%"
    print(f"  ✓ 장마감: {r_closed['change_pct']:+.4f}%  (기대 ≈ -2.21%)")

    # 시나리오 B: 장 중 (change 이미 존재 → 수정 없음)
    live_curr = 25_700.00
    live_prev = 25_587.04
    r_live = {
        "name": "나스닥[장중]", "ticker": "^IXIC",
        "current": live_curr, "prev_close": live_prev,
        "change": live_curr - live_prev,
        "change_pct": (live_curr - live_prev) / live_prev * 100,
        "history": sim_history,
    }
    original_pct = r_live["change_pct"]
    recalc_change_with_history(r_live)
    assert abs(r_live["change_pct"] - original_pct) < 0.0001, \
        f"장중: 값이 바뀌면 안 됨 ({r_live['change_pct']:.4f}%)"
    print(f"  ✓ 장중  : {r_live['change_pct']:+.4f}%  (변경 없음, 기대 ≈ +0.44%)\n")


# ─────────────────────────────────────────────────
# 소스 순서대로 시도
# ─────────────────────────────────────────────────
def fetch_with_fallback(label: str, sources: list) -> dict | None:
    for src_name, fn in sources:
        r = fn()
        if r is not None:
            print(f"     OK  [{src_name}]  현재가={r['current']:,.2f}  "
                  f"변동={r['change']:+,.2f}  변동률={r['change_pct']:+.2f}%")
            return r
    print(f"  [ERROR] '{label}' 모든 소스 실패")
    return None


# ─────────────────────────────────────────────────
# 결과 테이블 출력
# ─────────────────────────────────────────────────
def print_table(rows: list[dict]) -> None:
    div = "=" * 112
    print("\n" + div)
    print(
        f"  {'종목':<22}"
        f"  {'현재가':>14}"
        f"  {'전일종가':>14}"
        f"  {'변동':>14}"
        f"  {'변동률':>8}"
        f"  {'소스':<14}"
        f"  기준시각"
    )
    print(div)
    for r in rows:
        ar = arrow(r["change"])   # 계산된 change 값으로만 결정
        print(
            f"  {r['name']:<22}"
            f"  {r['current']:>14,.2f}"
            f"  {r['prev_close']:>14,.2f}"
            f"  {ar} {r['change']:>+12,.2f}"
            f"  {r['change_pct']:>+7.2f}%"
            f"  {r['source']:<14}"
            f"  {r['timestamp']}"
        )
    print(div + "\n")


# ─────────────────────────────────────────────────
# JSON 저장 + Round-trip 검증
# ─────────────────────────────────────────────────
def save_and_verify_json(results: list[dict], updated_at: str) -> None:
    """
    수집 결과를 market_data.json 으로 저장하고 읽어서 검증한다.
    실패 종목은 results에서 이미 제외된 상태로 넘어온다.
    """
    import pathlib

    out_path = pathlib.Path(__file__).parent / "market_data.json"

    items = []
    for r in results:
        meta_id, category = TICKER_META.get(r["ticker"], (r["ticker"].lower(), "기타"))
        items.append({
            "id":         meta_id,
            "name":       r["name"],
            "symbol":     r["ticker"],
            "price":      round(r["current"],    2),
            "prev_close": round(r["prev_close"], 2),
            "change":     round(r["change"],     2),
            "change_pct": round(r["change_pct"], 4),
            "direction":  direction(r["change"]),
            "source":     r["source"],
            "as_of":      r["timestamp"],
            "category":   category,
            "history":    r.get("history", []),
        })

    payload = {"updated_at": updated_at, "items": items}

    with open(out_path, "w", encoding="utf-8") as f:
        _json.dump(payload, f, ensure_ascii=False, indent=2)

    print(f"\n[JSON 저장] {out_path}  ({len(items)}종목 저장)")

    # Round-trip: 저장한 파일을 다시 읽어 구조·값 확인
    with open(out_path, encoding="utf-8") as f:
        loaded = _json.load(f)

    print(f"[Round-trip 검증]  updated_at={loaded['updated_at']}  "
          f"items={len(loaded['items'])}개")
    for it in loaded["items"]:
        h = it.get("history", [])
        h_range = f"{h[0]['date']} ~ {h[-1]['date']}" if h else "없음"
        print(
            f"  {it['id']:<8}  {it['name']:<22}"
            f"  price={it['price']:>12,.2f}"
            f"  chg_pct={it['change_pct']:>+7.2f}%"
            f"  direction={it['direction']:<5}"
            f"  history={len(h):>2}포인트  ({h_range})"
        )
    print()


# ─────────────────────────────────────────────────
# 메인
# ─────────────────────────────────────────────────
def _compare_sources(label: str, primary: dict | None, backup: dict | None,
                     threshold_pct: float = 1.0) -> None:
    """
    같은 종목의 두 소스 값을 나란히 출력하고 큰 차이가 나면 경고한다.
    threshold_pct: 현재가 대비 허용 차이 비율(%). 기본 1%.
    """
    if primary is None or backup is None:
        return
    diff     = primary["current"] - backup["current"]
    diff_pct = abs(diff) / backup["current"] * 100

    print(f"\n  [{label} 소스 비교]")
    print(f"    {primary['source']:<14}: {primary['current']:>12,.2f}  "
          f"변동={primary['change']:>+10,.2f}  ({primary['timestamp']})")
    print(f"    {backup['source']:<14}: {backup['current']:>12,.2f}  "
          f"변동={backup['change']:>+10,.2f}  ({backup['timestamp']})")
    print(f"    두 소스 차이   : {diff:>+10,.2f}  ({diff_pct:.3f}%)")
    if diff_pct > threshold_pct:
        print(f"    ⚑ 차이 {diff_pct:.2f}% — {threshold_pct}% 초과, 데이터 지연 또는 소스 이상 가능")
    else:
        print(f"    → 두 소스 일치 (허용 범위 {threshold_pct}% 이내)")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="주요 증시 지표 실시간 시세 검증")
    parser.add_argument("--force-fail-cnbc", action="store_true",
                        help="CNBC 소스를 강제 실패시켜 Naver-World 폴백 테스트")
    parser.add_argument("--compare", action="store_true",
                        help="CNBC와 Naver-World 두 소스를 모두 조회해 비교")
    args = parser.parse_args()

    print("=" * 60)
    print("  주요 증시 지표 실시간 시세 검증 (15분 지연)")
    print(f"  조회 시각: {datetime.now(KST).strftime('%Y-%m-%d %H:%M:%S KST')}")
    if args.force_fail_cnbc:
        print("  [모드] CNBC 강제 실패 → Naver-World 폴백 테스트")
    if args.compare:
        print("  [모드] CNBC + Naver-World 동시 조회 비교")
    print("=" * 60)

    # ── 화살표 로직 단위 검증 ──────────────────────
    print("\n[사전 검증: 화살표 로직]")
    verify_arrow_logic()

    results = []

    # CNBC 소스 래퍼: --force-fail-cnbc 시 강제 None 반환
    def cnbc_or_skip(name, ticker_yf, cnbc_symbol):
        if args.force_fail_cnbc:
            print("     [강제실패] CNBC 스킵 (--force-fail-cnbc 옵션)")
            return None
        return fetch_cnbc(name, ticker_yf, cnbc_symbol)

    # ── 1. 나스닥 ──────────────────────────────────
    print("\n  [1/4] 나스닥 (^IXIC) 조회 중...")
    nasdaq_cnbc = None   # 비교용 저장
    nasdaq_naver = None

    if args.compare or args.force_fail_cnbc:
        # 비교 모드: 두 소스 모두 조회
        nasdaq_cnbc  = cnbc_or_skip("나스닥 (^IXIC)", "^IXIC", ".IXIC")
        nasdaq_naver = fetch_naver_world("나스닥 (^IXIC)", "^IXIC", "NAS@IXIC")
        if nasdaq_cnbc:
            print(f"     OK  [CNBC]        현재가={nasdaq_cnbc['current']:,.2f}  변동={nasdaq_cnbc['change']:+,.2f}")
        if nasdaq_naver:
            print(f"     OK  [Naver-World] 현재가={nasdaq_naver['current']:,.2f}  변동={nasdaq_naver['change']:+,.2f}")
        d = nasdaq_cnbc or nasdaq_naver
    else:
        d = fetch_with_fallback("나스닥 (^IXIC)", [
            ("Stooq",        lambda: fetch_stooq("나스닥 (^IXIC)", "^IXIC", "ndq")),
            ("CNBC",         lambda: fetch_cnbc("나스닥 (^IXIC)", "^IXIC", ".IXIC")),
            ("Naver-World",  lambda: fetch_naver_world("나스닥 (^IXIC)", "^IXIC", "NAS@IXIC")),
            ("yfinance",     lambda: fetch_yfinance("나스닥 (^IXIC)", "^IXIC")),
        ])
    if d: results.append(d)

    # ── 2. 다우존스 ────────────────────────────────
    print("\n  [2/4] 다우존스 (^DJI) 조회 중...")
    dow_cnbc  = None
    dow_naver = None

    if args.compare or args.force_fail_cnbc:
        dow_cnbc  = cnbc_or_skip("다우존스 (^DJI)", "^DJI", ".DJI")
        dow_naver = fetch_naver_world("다우존스 (^DJI)", "^DJI", "DJI@DJI")
        if dow_cnbc:
            print(f"     OK  [CNBC]        현재가={dow_cnbc['current']:,.2f}  변동={dow_cnbc['change']:+,.2f}")
        if dow_naver:
            print(f"     OK  [Naver-World] 현재가={dow_naver['current']:,.2f}  변동={dow_naver['change']:+,.2f}")
        d = dow_cnbc or dow_naver
    else:
        d = fetch_with_fallback("다우존스 (^DJI)", [
            ("Stooq",        lambda: fetch_stooq("다우존스 (^DJI)", "^DJI", "dji")),
            ("CNBC",         lambda: fetch_cnbc("다우존스 (^DJI)", "^DJI", ".DJI")),
            ("Naver-World",  lambda: fetch_naver_world("다우존스 (^DJI)", "^DJI", "DJI@DJI")),
            ("yfinance",     lambda: fetch_yfinance("다우존스 (^DJI)", "^DJI")),
        ])
    if d: results.append(d)

    # ── 3. 코스피 (기존 로직 유지) ─────────────────
    print("\n  [3/4] 코스피 (^KS11) 조회 중...")
    d = fetch_with_fallback("코스피 (^KS11)", [
        ("Naver",    lambda: fetch_naver_kospi("코스피 (^KS11)")),
        ("yfinance", lambda: fetch_yfinance("코스피 (^KS11)", "^KS11")),
    ])
    if d: results.append(d)

    # ── 4. 비트코인 (기존 로직 유지) ───────────────
    print("\n  [4/4] 비트코인 (BTC-USD) 조회 중...")
    btc_yf = fetch_yfinance("비트코인 BTC-USD", "BTC-USD")
    if btc_yf:
        print(f"     OK  [yfinance]  현재가={btc_yf['current']:,.2f}  "
              f"변동={btc_yf['change']:+,.2f}  변동률={btc_yf['change_pct']:+.2f}%")

    btc_cg = fetch_coingecko_btc()
    if btc_cg:
        print(f"     OK  [CoinGecko] 현재가={btc_cg['current']:,.2f}  "
              f"변동={btc_cg['change']:+,.2f}  변동률={btc_cg['change_pct']:+.2f}%")

    btc_main = btc_yf if btc_yf else btc_cg
    if btc_main:
        results.append(btc_main)
    else:
        print("  [ERROR] 비트코인 모든 소스 실패")

    # ── 5. VIX 공포지수 ────────────────────────────
    print("\n  [5/6] VIX 공포지수 (^VIX) 조회 중...")
    d = fetch_with_fallback("VIX 공포지수", [
        ("CNBC",     fetch_cnbc_vix),
    ])
    if d:
        results.append(d)

    # ── 6. 원달러 환율 (USD/KRW) ───────────────────
    print("\n  [6/6] 원/달러 환율 (USD/KRW) 조회 중...")
    d = fetch_with_fallback("원/달러", [
        ("Naver환율",    fetch_naver_usdkrw),
        ("Frankfurter", fetch_frankfurter_usdkrw),
    ])
    if d:
        results.append(d)

    # ── 결과 테이블 ────────────────────────────────
    if results:
        print_table(results)
    else:
        print("\n[경고] 수집된 데이터가 없습니다.")

    # ── Sanity check ───────────────────────────────
    print("[Sanity Check]")
    all_ok = True
    for r in results:
        warns = run_sanity(r)
        status = "OK " if not warns else "경고"
        print(f"  {status}  {r['name']:<22}  현재가={r['current']:>12,.2f}  "
              f"변동={r['change']:>+10,.2f}  arrow={arrow(r['change'])}")
        for w in warns:
            all_ok = False
            print(f"       ⚑ {w}")
    if all_ok:
        print("  → 전 종목 범위·부호 정상\n")
    else:
        print("  → 위 경고 항목 확인 필요\n")

    # ── 시계열 history 수집 ────────────────────────
    print("[시계열 수집]")
    enrich_with_history(results)

    # ── 전일대비 보정 (장 마감 후 change=0 문제) ────
    print("[전일대비 보정]")
    for r in results:
        recalc_change_with_history(r)
    _simulate_recalc_scenarios()

    # 보정 후 최종 변동률 확인
    print("[보정 후 최종 변동률]")
    for r in results:
        ar = arrow(r["change"])
        print(f"  {r['name']:<22}  {ar} {r['change_pct']:>+7.2f}%"
              f"  현재가={r['current']:>12,.2f}  전일종가={r['prev_close']:>12,.2f}")
    print()

    # ── JSON 저장 + Round-trip 검증 ────────────────
    save_and_verify_json(results, now_kst())

    # ── CNBC vs Naver-World 소스 비교 (--compare 또는 --force-fail-cnbc) ──
    if args.compare or args.force_fail_cnbc:
        print("[ 미국 지수 소스 비교 ]")
        _compare_sources("나스닥", nasdaq_cnbc, nasdaq_naver)
        _compare_sources("다우존스", dow_cnbc, dow_naver)
        print()

    # ── BTC 소스 비교 ──────────────────────────────
    if btc_yf and btc_cg:
        diff_btc = abs(btc_yf["current"] - btc_cg["current"])
        print("[ BTC 소스 비교 ]")
        print(f"  {'yfinance':<12}: ${btc_yf['current']:>12,.2f}  "
              f"변동률={btc_yf['change_pct']:+.2f}%  ({btc_yf['timestamp']})")
        print(f"  {'CoinGecko':<12}: ${btc_cg['current']:>12,.2f}  "
              f"변동률={btc_cg['change_pct']:+.2f}%  ({btc_cg['timestamp']})")
        print(f"  두 소스 차이  : ${diff_btc:,.2f}")
        if diff_btc > 500:
            print(f"  ⚑ 차이 ${diff_btc:,.2f} — 500달러 초과")
        else:
            print("  → 두 소스 일치 (정상)")
    elif btc_cg:
        print("  ※ yfinance BTC 실패 → CoinGecko 권장")
    elif btc_yf:
        print("  ※ CoinGecko BTC 실패 → yfinance 권장")
    print()

    # ── 최종 요약 ──────────────────────────────────
    total_expected = 6
    print(f"[ 결과 요약 ]  {len(results)}/{total_expected} 종목 성공")
    for r in results:
        ar = arrow(r["change"])
        print(f"  {r['name']:<22}  {ar} {r['change_pct']:>+7.2f}%  [{r['source']}]")

    failed = total_expected - len(results)
    if failed:
        print(f"\n  ※ {failed}개 종목 실패 — 네트워크·방화벽 환경을 확인하세요.")


if __name__ == "__main__":
    main()
