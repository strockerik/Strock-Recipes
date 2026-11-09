#!/usr/bin/env python3
"""Build the House Index spirits ratings catalog, one source at a time.

The app never queries review sites live: this script collects scores into
Supabase (tables in README "Spirits ratings catalog"), matches each one to a
catalog bottle, and the `spirit_consensus` view blends them into one 0-10 score.

Every command that writes is a DRY RUN unless you pass --apply.

  seed [--catalog-name "BAR NAME=FULL NAME" ...]
                             Create catalog bottles from your bar inventory
                             (bar items that have a brand/name) and link them.
                             --catalog-name gives a short bar label its full
                             product name in the catalog; the bar label stays
                             and is kept as an alias.
  product "NAME" [--category bourbon] [--abv 50] [--age 9]
                             Add one bottle to the catalog by hand.
  iwsc "QUERY" ["QUERY" ...] Search IWSC results and record medals/points.
  iwsc --from-catalog        ...for every bottle already in the catalog.
  score "BOTTLE" --source whisky_advocate --raw 92 [--year 2024] [--url URL] [--medal Gold]
        [--reviewer NAME] [--scale critic100]
                             Record a score you looked up yourself. Use this for
                             Distiller and Tastings.com (BTI), whose terms forbid
                             scraping, and for print sources (Jim Murray).
                             --scale overrides the source's usual scale, for a
                             review from before it changed (Whiskey Wash's old
                             100-point reviews).
  review                     Walk the queue of reviews that didn't match a bottle
                             confidently, and pick the right one (always writes).
  show ["NAME"]              Print consensus scores.
  inspect URL                Fetch one page and show what the IWSC parser sees.
  sfwsc-import [--year 2025] [--url PDF]
                             Add a year of San Francisco World Spirits Competition
                             medals from SevenFifty Daily's published results PDF:
                             a medal joins an existing bottle on a clear match,
                             otherwise it becomes a new catalog bottle.
  field                      Walk the scores in-app lookups found (unverified):
                             verify, reject or skip each (always writes).
  reports                    "Wrong bottle?" reports from the app's score card.

Credentials (never hard-coded), first match wins:
  SUPABASE_URL + SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY in the environment,
  then the gitignored notes.md ("Project URL:", "Secret Key:" / "Service Role:"),
  then the gitignored .env.local.

Politeness: robots.txt is honoured, at most one request every 4 s per host, an
honest User-Agent, and every fetched page is cached in scripts/ratings/cache/
(gitignored, 30 days) so re-running a parser never re-downloads.

Python 3.9+, standard library only.
"""
import argparse
import datetime
import hashlib
import html
import json
import os
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from html.parser import HTMLParser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import normalize as N  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
CACHE_DIR = os.path.join(HERE, "cache")
CACHE_DAYS = 30
MIN_GAP_S = 4.0
USER_AGENT = "HouseIndexRatings/0.1 (personal, non-commercial bottle catalog; low volume)"

AUTO_MIN = 0.55      # similarity needed to link a review to a bottle without asking
AUTO_GAP = 0.10      # ...and the lead it needs over the runner-up


def _ssl_context():
    """python.org's macOS Python has no CA certificates until its 'Install Certificates'
    step is run, so every HTTPS call fails; fall back to the bundle macOS ships."""
    ctx = ssl.create_default_context()
    paths = ssl.get_default_verify_paths()
    if not (paths.cafile or paths.capath) and os.path.exists("/etc/ssl/cert.pem"):
        ctx.load_verify_locations("/etc/ssl/cert.pem")
    return ctx


SSL_CTX = _ssl_context()


# =============================================================================
# Credentials + Supabase REST
# =============================================================================
def _load_creds():
    url = os.environ.get("SUPABASE_URL")
    key = (os.environ.get("SUPABASE_SECRET_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    try:
        text = open(os.path.join(REPO, "notes.md")).read()
        m = re.search(r"Project URL:\s*(\S+)", text)
        url = url or (m.group(1) if m else None)
        m = re.search(r"Secret Key:\s*(sb_secret_\S+)", text) or re.search(r"Service Role:\s*(\S+)", text)
        key = key or (m.group(1) if m else None)
    except OSError:
        pass
    try:
        for line in open(os.path.join(REPO, ".env.local")):
            k, _, v = line.strip().partition("=")
            v = v.strip().strip('"').strip("'")
            if k == "SUPABASE_URL":
                url = url or v
            elif k in ("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"):
                key = key or v
    except OSError:
        pass
    if not url or not key:
        sys.exit("Missing SUPABASE_URL / secret key (env, notes.md, or .env.local).")
    return url.rstrip("/"), key


SB_URL = SB_KEY = None


def sb(method, path, body=None, prefer="return=representation"):
    global SB_URL, SB_KEY
    if SB_URL is None:
        SB_URL, SB_KEY = _load_creds()
    headers = {"apikey": SB_KEY, "Content-Type": "application/json", "Prefer": prefer}
    if SB_KEY.startswith("eyJ"):                       # legacy service-role JWT
        headers["Authorization"] = "Bearer " + SB_KEY
    req = urllib.request.Request(SB_URL + path, method=method, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        if "spirit_" in detail and ("does not exist" in detail or "schema cache" in detail):
            sys.exit("The ratings tables aren't there yet — run the README "
                     "'Spirits ratings catalog' SQL in the Supabase SQL editor first.\n" + detail)
        sys.exit(f"Supabase {method} {path} -> HTTP {e.code}: {detail}")


def q(v):
    return urllib.parse.quote(str(v), safe="")


def candidates(name, limit=5):
    """Catalog bottles that look like `name`, best first, after the hard attribute rules."""
    attrs = N.parse_attrs(name)
    rows = sb("POST", "/rest/v1/rpc/spirit_candidates",
              {"q": N.norm_name(name), "max_results": limit}) or []
    out = []
    for r in rows:
        theirs = {"age_years": r.get("age_years"), "batch": r.get("batch"),
                  "abv": float(r["abv"]) if r.get("abv") is not None else None}
        if N.attrs_compatible(attrs, theirs):
            out.append(r)
    return out


def decide(cands):
    """(product_id, score, status) for a candidate list."""
    if not cands:
        return None, None, "pending"
    top = float(cands[0]["score"])
    runner = float(cands[1]["score"]) if len(cands) > 1 else 0.0
    if top >= AUTO_MIN and top - runner >= AUTO_GAP:
        return cands[0]["product_id"], top, "auto"
    return None, top, "pending"


def add_alias(product_id, name, source_id):
    sb("POST", "/rest/v1/spirit_aliases?on_conflict=alias_norm",
       {"alias_norm": N.norm_name(name), "product_id": product_id, "source_id": source_id},
       prefer="resolution=ignore-duplicates,return=minimal")


def find_or_create_product(name, category=None, apply=False, **extra):
    """Exact name_norm hit, else create. Returns (product_id or None on dry run, created?)."""
    key = N.norm_name(name)
    rows = sb("GET", f"/rest/v1/spirit_products?select=id&name_norm=eq.{q(key)}&limit=1")
    if rows:
        return rows[0]["id"], False
    if not apply:
        return None, True
    attrs = N.parse_attrs(name)
    row = {"canonical_name": name.strip(), "name_norm": key,
           "category": category or N.guess_category(name),
           "age_years": attrs["age_years"], "abv": attrs["abv"], "batch": attrs["batch"],
           "is_single_barrel": attrs["single_barrel"], "is_store_pick": attrs["store_pick"]}
    row.update({k: v for k, v in extra.items() if v is not None})
    created = sb("POST", "/rest/v1/spirit_products", row)[0]
    add_alias(created["id"], name, None)
    return created["id"], True


def source_row(source_id):
    rows = sb("GET", f"/rest/v1/rating_sources?id=eq.{q(source_id)}")
    if not rows:
        ids = [r["id"] for r in sb("GET", "/rest/v1/rating_sources?select=id&order=id")]
        sys.exit(f"Unknown source {source_id!r}. Known: {', '.join(ids)}")
    return rows[0]


# =============================================================================
# Polite fetching
# =============================================================================
_last_hit = {}
_robots = {}
_blocked = {}        # site -> why it won't serve this script


def _base(url):
    host = urllib.parse.urlsplit(url)
    return f"{host.scheme}://{host.netloc}"


def allowed(url):
    base = _base(url)
    if base not in _robots:
        rp = urllib.robotparser.RobotFileParser()
        try:
            req = urllib.request.Request(base + "/robots.txt", headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=20, context=SSL_CTX) as r:
                rp.parse(r.read().decode(errors="replace").splitlines())
        except urllib.error.HTTPError as e:
            # Same rule as urllib.robotparser: 401/403 = keep out, other 4xx = no robots.txt.
            if e.code in (401, 403):
                rp.disallow_all = True
                _blocked[base] = ("it answers scripts with a Cloudflare bot challenge"
                                  if e.headers.get("cf-mitigated") == "challenge"
                                  else f"its robots.txt answers HTTP {e.code}")
            elif e.code < 500:
                rp.allow_all = True
            else:
                rp.disallow_all = True
                _blocked[base] = f"its robots.txt answers HTTP {e.code} (try again later)"
        except OSError as e:
            rp.disallow_all = True
            _blocked[base] = f"its robots.txt couldn't be read ({e})"
        _robots[base] = rp
    return _robots[base].can_fetch(USER_AGENT, url)


def blocked_reason(url):
    """None if this script may fetch url, else a sentence saying why not."""
    if allowed(url):
        return None
    return _blocked.get(_base(url), "its robots.txt disallows it")


def fetch(url, refresh=False, binary=False):
    """Cached, rate-limited GET. Returns HTML text (or, with binary=True, the path
    of the cached file), or None if robots.txt says no."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    ext = os.path.splitext(urllib.parse.urlsplit(url).path)[1] if binary else ".html"
    path = os.path.join(CACHE_DIR, hashlib.sha1(url.encode()).hexdigest() + (ext or ".bin"))
    if not refresh and os.path.exists(path) and \
            time.time() - os.path.getmtime(path) < CACHE_DAYS * 86400:
        return path if binary else open(path, encoding="utf-8").read()
    why = blocked_reason(url)
    if why:
        print(f"  skipped {url}: {why}")
        return None
    host = urllib.parse.urlsplit(url).netloc
    wait = MIN_GAP_S - (time.time() - _last_hit.get(host, 0))
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                               "Accept": "*/*" if binary else "text/html,application/xhtml+xml"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60, context=SSL_CTX) as r:
                raw = r.read()
                body = raw if binary else raw.decode(r.headers.get_content_charset() or "utf-8", errors="replace")
            break
        except urllib.error.HTTPError as e:
            if e.code == 403 and e.headers.get("cf-mitigated") == "challenge":
                _blocked[_base(url)] = "it answers scripts with a Cloudflare bot challenge"
                print(f"  skipped {url}: {_blocked[_base(url)]}")
                return None
            if e.code in (429, 503) and attempt < 2:
                time.sleep(30 * (attempt + 1))
                continue
            raise
        finally:
            _last_hit[host] = time.time()
    if binary:
        with open(path, "wb") as f:
            f.write(body)
        return path
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)
    return body


class _Page(HTMLParser):
    """Visible text lines, links in document order, <title>, <h1>, og:title."""
    SKIP = {"script", "style", "noscript", "svg", "template"}
    BLOCK = {"p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "th",
             "br", "dt", "dd", "section", "article", "span", "a", "strong", "label"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.lines, self.events, self.meta = [], [], {}
        self._buf, self._skip, self._tag = [], 0, []

    def _flush(self):
        t = re.sub(r"\s+", " ", "".join(self._buf)).strip()
        self._buf = []
        if t:
            self.lines.append(t)
            self.events.append(("text", t))
            for tag in ("title", "h1", "h2"):
                if tag in self._tag and tag not in self.meta:
                    self.meta[tag] = t

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in self.SKIP:
            self._skip += 1
        if tag == "meta" and a.get("property") in ("og:title", "og:description"):
            self.meta[a["property"]] = html.unescape(a.get("content") or "")
        if tag in self.BLOCK or tag == "title":
            self._flush()
        if tag == "a" and a.get("href"):
            self.events.append(("link", a["href"]))
        self._tag.append(tag)

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self._skip = max(0, self._skip - 1)
        if tag in self.BLOCK or tag == "title":
            self._flush()
        if tag in self._tag:
            del self._tag[len(self._tag) - 1 - self._tag[::-1].index(tag)]

    def handle_data(self, data):
        if not self._skip:
            self._buf.append(data)

    def close(self):
        super().close()
        self._flush()


def parse_page(text):
    p = _Page()
    p.feed(text)
    p.close()
    return p


# =============================================================================
# IWSC
# =============================================================================
IWSC = "https://www.iwsc.net"
_MEDAL_RE = (r"(?P<medal>(?:(?:spirits?|packaging|design|label|mixer|whisky highball|highball|rtd|"
             r"alternative drinks)\s+)?(?:gold outstanding|silver outstanding|double gold|"
             r"gold|silver|bronze|trophy))\s*[-–:]?\s*(?P<year>(?:19|20)\d{2})")


def iwsc_search(query, max_pages=3):
    """[(detail_id, entry_text)] for one search; entry_text is the listing's text block."""
    seen, out = set(), []
    for page in range(1, max_pages + 1):
        body = fetch(f"{IWSC}/site/search/results/{page}?q={urllib.parse.quote_plus(query)}")
        if body is None:
            break
        p = parse_page(body)
        block, fresh = [], 0
        for kind, val in p.events:
            if kind == "text":
                block.append(val)
                block = block[-8:]
                continue
            m = re.search(r"/results/detail/(\d+)", val)
            if not m:
                continue
            did = m.group(1)
            if did not in seen:
                seen.add(did)
                fresh += 1
                out.append((did, " | ".join(block)))
            block = []
        if not fresh:
            break
    return out


def iwsc_parse_detail(body):
    """Best-effort read of one IWSC result page. Missing fields come back None."""
    p = parse_page(body)
    lines = p.lines
    full = "\n".join(lines)
    title = p.meta.get("og:title") or p.meta.get("title") or ""
    title = re.split(r"\s+[|]\s+", title)[0].strip()

    medal = year = name = None
    m = re.match(_MEDAL_RE + r"\s*[-–]\s*(?P<name>.+)$", title, re.I)
    if m:
        medal, year, name = m.group("medal"), int(m.group("year")), m.group("name").strip()
    if not medal:
        m = re.search(_MEDAL_RE, full, re.I)
        if m:
            medal, year = m.group("medal"), int(m.group("year"))
    if not name:
        name = p.meta.get("h1") or title or None

    points = None
    for pat in (r"\b(\d{2,3})\s*(?:points|pts)\b", r"\bscore\D{0,6}(\d{2,3})\b"):
        for m in re.finditer(pat, full, re.I):
            v = int(m.group(1))
            if 80 <= v <= 100:
                points = v
                break
        if points:
            break

    producer = None
    for i, ln in enumerate(lines):
        m = re.match(r"(?:producer|company|entrant|produced by)\s*:?\s*(.*)$", ln, re.I)
        if m:
            producer = m.group(1).strip() or (lines[i + 1] if i + 1 < len(lines) else None)
            break
    country = None
    m = re.search(r"regions\.twig,\s*([A-Za-z .'-]+)", full) or \
        re.search(r"\bcountry\s*:?\s*\n?([A-Z][A-Za-z .'-]+)", full)
    if m:
        country = m.group(1).strip()
    abv = None
    m = re.search(r"\b(\d{2}(?:\.\d{1,2})?)\s*%\s*(?:abv|alc|vol)", full, re.I)
    if m:
        abv = float(m.group(1))
    return {"name": name, "medal": medal, "year": year, "points": points,
            "producer": producer, "country": country, "abv": abv, "lines": lines}


def iwsc_review_row(did, d, source):
    medal = N.clean_medal(d["medal"])
    if d["medal"] and medal is None:
        return None, "packaging/mixer award, not the spirit"
    if d["points"] is not None:
        s10, w = N.to_10(source["scale"], d["points"]), float(source["default_weight"])
    elif medal:
        s10, w = N.medal_to_10("iwsc", medal), 0.5
        if s10 is None:
            return None, f"unrecognised medal {d['medal']!r}"
    else:
        return None, "no medal or points found (run `inspect` on it)"
    return {"source_id": "iwsc", "source_ref": did, "url": f"{IWSC}/results/detail/{did}",
            "source_name": d["name"], "source_producer": d["producer"],
            "review_year": d["year"], "medal": d["medal"], "score_raw": d["points"],
            "score_10": round(s10, 2), "weight": w}, None


def cmd_iwsc(args):
    why = blocked_reason(IWSC + "/results")
    if why:
        # Since at least 2026-11 every scripted request, robots.txt included, gets a
        # Cloudflare challenge. Don't try to get past it: enter results by hand.
        sys.exit(f"IWSC can't be collected automatically: {why}.\n"
                 "Look the bottle up on iwsc.net in a browser and record it by hand, e.g.\n"
                 '  python3 ratings.py score "Knob Creek 12" --source iwsc --raw 95 --year 2022 '
                 "--url https://www.iwsc.net/results/detail/120667 --apply")
    source = source_row("iwsc")
    queries = list(args.queries)
    if args.from_catalog:
        rows = sb("GET", "/rest/v1/spirit_products?select=canonical_name&order=canonical_name") or []
        queries += [r["canonical_name"] for r in rows]
    if not queries:
        sys.exit('Give a search, e.g.  iwsc "Knob Creek"   (or --from-catalog)')
    have = {r["source_ref"] for r in
            (sb("GET", "/rest/v1/spirit_reviews?select=source_ref&source_id=eq.iwsc") or [])}
    added = pending = 0
    for query in queries:
        print(f"\nIWSC search: {query}")
        hits = iwsc_search(query, args.pages)
        hits = [(d, t) for d, t in hits if N.query_relevant(query, t)]
        print(f"  {len(hits)} relevant result(s)")
        for did, _ in hits[: args.max_results]:
            if did in have and not args.refresh:
                continue
            body = fetch(f"{IWSC}/results/detail/{did}", refresh=args.refresh)
            if body is None:
                continue
            d = iwsc_parse_detail(body)
            if not d["name"] or not N.query_relevant(query, d["name"]):
                continue
            row, why = iwsc_review_row(did, d, source)
            label = f"{d['name']} — {d['medal'] or '?'} {d['year'] or ''} {d['points'] or ''}".strip()
            if row is None:
                print(f"  skip  {label}: {why}")
                continue
            pid, score, status = decide(candidates(d["name"]))
            row.update({"product_id": pid, "match_score": score, "match_status": status})
            tag = "auto " if status == "auto" else "QUEUE"
            print(f"  {tag} {label} -> {row['score_10']:.2f}/10"
                  + (f"  (match {score:.2f})" if score else ""))
            if args.apply:
                sb("POST", "/rest/v1/spirit_reviews?on_conflict=source_id,source_ref", row,
                   prefer="resolution=ignore-duplicates,return=minimal")
                if pid:
                    add_alias(pid, d["name"], "iwsc")
            have.add(did)
            added += 1
            pending += status == "pending"
    verb = "Recorded" if args.apply else "Would record"
    print(f"\n{verb} {added} IWSC result(s); {pending} need a match (run `review`)."
          + ("" if args.apply else "  Dry run — add --apply to write."))


def cmd_inspect(args):
    body = fetch(args.url, refresh=True)
    if body is None:
        return
    d = iwsc_parse_detail(body)
    for k in ("name", "medal", "year", "points", "producer", "country", "abv"):
        print(f"{k:>9}: {d[k]}")
    print("\nFirst text lines on the page:")
    for ln in d["lines"][:80]:
        print("   ", ln)


# =============================================================================
# Catalog + manual scores
# =============================================================================
def cmd_seed(args):
    full = {}
    for pair in args.catalog_name:
        bar, sep, name = pair.partition("=")
        if not sep or not bar.strip() or not name.strip():
            sys.exit(f'--catalog-name wants "BAR NAME=FULL NAME", got {pair!r}')
        full[N.norm_name(bar)] = name.strip()
    used = set()
    rows = sb("GET", "/rest/v1/inventory_items?select=id,category,name,product_id"
                     "&section=eq.bar&name=not.is.null&product_id=is.null") or []
    skip = {"mixer", "bitters", "wine"}
    n = 0
    for r in rows:
        if r["category"] in skip:
            continue
        label = r["name"].strip()
        name = full.get(N.norm_name(label), label)
        if name != label:
            used.add(N.norm_name(label))
        pid, created = find_or_create_product(name, r["category"], apply=args.apply)
        print(f"  {'new   ' if created else 'exists'} {name}  [{r['category']}]"
              + (f"  (bar: {label})" if name != label else ""))
        if args.apply and pid:
            if name != label:
                add_alias(pid, label, None)
            sb("PATCH", f"/rest/v1/inventory_items?id=eq.{r['id']}", {"product_id": pid},
               prefer="return=minimal")
        n += 1
    for key in full.keys() - used:
        print(f"  ! --catalog-name for {key!r} matched no unlinked bar bottle (typo?)")
    print(f"\n{n} bar bottle(s) " + ("linked to the catalog." if args.apply
                                     else "would be linked. Dry run — add --apply to write."))


def cmd_product(args):
    pid, created = find_or_create_product(args.name, args.category, apply=args.apply,
                                          abv=args.abv, age_years=args.age,
                                          producer=args.producer)
    if not created:
        print(f"Already in the catalog ({pid}).")
    else:
        print(f"Added {args.name} ({pid})." if args.apply else
              f"Would add {args.name}. Dry run — add --apply to write.")


def cmd_score(args):
    source = source_row(args.source)
    scale = args.scale or source["scale"]
    if args.raw is not None and scale not in N.ANCHORS:
        sys.exit(f"{source['name']} records medals, not points (scale {scale!r}): use --medal, "
                 f"or --scale with one of {', '.join(N.ANCHORS)}")
    cands = candidates(args.bottle)
    pid, score, status = decide(cands)
    if not pid:
        if cands:
            print("Not sure which bottle you mean:")
            for c in cands:
                print(f"   {c['canonical_name']}  ({float(c['score']):.2f})")
        sys.exit(f"Add it first:  ratings.py product \"{args.bottle}\" --apply   (or use the exact name)")
    if args.raw is not None:
        s10, w = N.to_10(scale, args.raw), float(source["default_weight"])
    elif args.medal:
        s10, w = N.medal_to_10(scale, args.medal), 0.5
        if s10 is None:
            sys.exit(f"Unrecognised medal {args.medal!r}")
    else:
        sys.exit("Give --raw SCORE or --medal NAME")
    # One page can list several results (a brand's awards page), so the year and
    # reviewer are part of the identity; re-running the same command updates in place.
    ref = f"{args.url or 'manual'}#{pid}:{args.year or ''}:{args.reviewer or ''}"
    row = {"source_id": source["id"], "source_ref": ref, "product_id": pid,
           "source_name": cands[0]["canonical_name"], "url": args.url,
           "review_year": args.year, "reviewer": args.reviewer, "medal": args.medal,
           "score_raw": args.raw, "score_10": round(s10, 2), "weight": w,
           "match_status": "confirmed", "match_score": 1}
    print(f"{source['name']}: {cands[0]['canonical_name']} {args.raw or args.medal} -> "
          f"{s10:.2f}/10 (shows as {N.round_half(s10)})")
    if args.apply:
        sb("POST", "/rest/v1/spirit_reviews?on_conflict=source_id,source_ref", row,
           prefer="resolution=merge-duplicates,return=minimal")
        print("Saved.")
    else:
        print("Dry run — add --apply to write.")


def cmd_review(args):
    rows = sb("GET", "/rest/v1/spirit_reviews?select=*&match_status=eq.pending"
                     "&order=fetched_at&limit=200") or []
    if not rows:
        print("Nothing waiting for a match.")
        return
    print(f"{len(rows)} review(s) need a bottle. For each: number = that bottle, "
          "n = new bottle, r = not a spirit we track, s = skip, q = quit.\n")
    for r in rows:
        cands = candidates(r["source_name"])
        print(f"[{r['source_id']}] {r['source_name']}  "
              f"({r.get('medal') or ''} {r.get('review_year') or ''} {r.get('score_raw') or ''})")
        for i, c in enumerate(cands, 1):
            print(f"   {i}. {c['canonical_name']}  ({float(c['score']):.2f})")
        ans = input("   > ").strip().lower()
        if ans == "q":
            break
        if ans == "r":
            sb("PATCH", f"/rest/v1/spirit_reviews?id=eq.{r['id']}", {"match_status": "rejected"},
               prefer="return=minimal")
            continue
        pid = None
        if ans.isdigit() and 1 <= int(ans) <= len(cands):
            pid = cands[int(ans) - 1]["product_id"]
        elif ans == "n":
            cat = input(f"   category [{N.guess_category(r['source_name'])}]: ").strip() or None
            pid, _ = find_or_create_product(r["source_name"], cat, apply=True,
                                            producer=r.get("source_producer"))
        if pid:
            sb("PATCH", f"/rest/v1/spirit_reviews?id=eq.{r['id']}",
               {"product_id": pid, "match_status": "confirmed"}, prefer="return=minimal")
            add_alias(pid, r["source_name"], r["source_id"])


def cmd_show(args):
    path = "/rest/v1/spirit_consensus?select=*&order=score_10.desc,canonical_name"
    if args.name:
        path += "&canonical_name=ilike." + q(f"*{args.name}*")
    rows = sb("GET", path) or []
    if not rows:
        print("No scored bottles yet.")
        return
    for r in rows:
        print(f"{float(r['score_10']):4.1f}  {r['confidence']:<6} {r['n_sources']} src  "
              f"{r['canonical_name']}")


# =============================================================================
# SFWSC bulk import (SevenFifty Daily's results PDF)
# =============================================================================
# The competition's own site keeps AI agents out; SevenFifty Daily publishes the
# full results table each year and its robots.txt allows scripts. Add a year's
# PDF here once you've found its link (or pass --url).
SFWSC_PDFS = {
    2025: "http://daily.sevenfifty.com/wp-content/uploads/2025/05/2025-SF-World-Spirits-Competition-Results_SevenFifty-Daily.pdf",
}
SFWSC_MEDALS = {"bronze": "Bronze", "silver": "Silver", "gold": "Gold", "double gold": "Double Gold",
                "platinum": "Platinum", "best in show": "Best in Show"}
PDF_ROWS_JS = os.path.join(HERE, "pdf_rows.js")


def pdf_rows(path, headers="BRAND NAME|PRODUCT NAME|REGION|COUNTRY|MEDAL"):
    """Table rows from a results PDF, split by column position (macOS PDFKit)."""
    r = subprocess.run(["osascript", "-l", "JavaScript", PDF_ROWS_JS, path, headers],
                       capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        sys.exit("Couldn't read the PDF (needs macOS): " + (r.stderr or r.stdout).strip()[:300])
    return [line.split("\t") for line in r.stdout.splitlines() if line.strip()]


def rejoin_split_words(cells, line):
    """A long cell spills past its column edge and gets cut mid-word: "…Wheated
    Bour" | "bon Texas" when the line reads "…Wheated Bourbon Texas". Where two
    neighbouring cells' edge pieces make one of the line's words, give the whole
    word to the longer cell — the one that overflowed."""
    words = set(line.split())
    cells = list(cells)
    for i in range(len(cells) - 1):
        a, b = cells[i].split(), cells[i + 1].split()
        if not a or not b or (a[-1] + b[0]) not in words or a[-1] in words and b[0] in words:
            continue
        if len(cells[i]) >= len(cells[i + 1]):
            a[-1] += b.pop(0)
        else:
            b[0] = a.pop() + b[0]
        cells[i], cells[i + 1] = " ".join(a), " ".join(b)
    return cells


def sfwsc_entries(rows):
    """[{name, brand, country, medal, category}] from the PDF's rows, one per distinct bottle."""
    out, seen = [], set()
    for cells in rows:
        if len(cells) == 6:
            cells = rejoin_split_words(cells[:5], cells[5])
        if len(cells) != 5:
            continue
        brand, product, region, country, medal = (c.strip() for c in cells)
        tier = SFWSC_MEDALS.get(medal.lower())
        if not tier or not (brand or product):
            continue
        b, pr = brand.lower(), product.lower()
        if pr.startswith(b):                 # "1800 | 1800 Anejo"
            name = product
        elif not product or b.endswith(pr):
            name = brand
        else:
            name = f"{brand} {product}"
        key = N.norm_name(name)
        if not key or key in seen:
            continue
        seen.add(key)
        # The product column says what it is better than the brand does
        # ("10th Mountain Whiskey & Spirit Company | Alpenglow Cordial").
        cat = N.guess_category(product) if product else "other"
        if cat == "other":
            cat = N.guess_category(name)
        if cat == "whiskey" and "scotland" in f"{region} {country}".lower():
            cat = "scotch"
        out.append({"name": re.sub(r"\s+", " ", name), "key": key, "brand": brand or None,
                    "country": country or None, "medal": tier, "category": cat})
    return out


def sb_all(path, page=1000):
    """Every row of a PostgREST select, a page at a time (Supabase caps a response at 1,000)."""
    rows, offset = [], 0
    while True:
        chunk = sb("GET", f"{path}&limit={page}&offset={offset}") or []
        rows += chunk
        if len(chunk) < page:
            return rows
        offset += page


def cmd_sfwsc_import(args):
    url = args.url or SFWSC_PDFS.get(args.year)
    if not url:
        sys.exit(f"No results PDF on file for {args.year} — pass --url (see SFWSC_PDFS in ratings.py).")
    pdf = fetch(url, refresh=args.refresh, binary=True)
    if not pdf:
        sys.exit("Couldn't download the results PDF.")
    entries = sfwsc_entries(pdf_rows(pdf))
    if not entries:
        sys.exit("No medal rows found in that PDF — has its layout changed? Check pdf_rows.js.")
    tiers = {}
    for e in entries:
        tiers[e["medal"]] = tiers.get(e["medal"], 0) + 1
    print(f"{len(entries)} medal-winning bottles in SFWSC {args.year}: "
          + ", ".join(f"{n} {t}" for t, n in sorted(tiers.items(), key=lambda kv: -kv[1])))

    # Match against the catalog: exact key or alias first; then, only for brands
    # the catalog already knows, the fuzzy search (cheap prefilter, few RPCs).
    products = sb_all("/rest/v1/spirit_products?select=id,name_norm,age_years,abv,batch&order=id")
    by_key = {p["name_norm"]: p["id"] for p in products}
    for a in sb_all("/rest/v1/spirit_aliases?select=alias_norm,product_id&order=alias_norm"):
        by_key.setdefault(a["alias_norm"], a["product_id"])
    first_words = {k.split()[0] for k in by_key if k}
    have = {(r["product_id"], r["review_year"]) for r in
            sb_all(f"/rest/v1/spirit_reviews?select=product_id,review_year&source_id=eq.sfwsc&review_year=eq.{args.year}&order=id")}
    # Fuzzy hits only count when same_bottle() agrees: a one-word difference
    # ("Reposado" vs "Plata", "Barrel Proof" vs "Small Batch") is another bottle.
    matched, new = [], []
    for e in entries:
        pid = by_key.get(e["key"])
        if not pid and e["key"].split()[0] in first_words:
            hits = [c for c in candidates(e["name"]) if N.same_bottle(e["key"], N.norm_name(c["canonical_name"]))]
            pid = hits[0]["product_id"] if len(hits) == 1 else None
        (matched if pid else new).append((e, pid))
    print(f"  {len(matched)} join bottles already in the catalog, {len(new)} would be new.")
    for e, _ in matched[:25]:
        print(f"    = {e['name']}  ({e['medal']})")
    for e, _ in new[:10]:
        print(f"    + {e['name']}  ({e['medal']})  [{e['category']}]")
    if not args.apply:
        print("\nDry run — add --apply to write.")
        return

    # New bottles, 500 at a time; then their keys as aliases; then the medals.
    # Every row carries every key: a PostgREST bulk insert rejects rows whose
    # keys differ ("All object keys must match"), so absent values go as null.
    def product_row(e):
        a = N.parse_attrs(e["name"])
        return {"canonical_name": e["name"][:200], "name_norm": e["key"], "category": e["category"],
                "producer": e["brand"], "country": e["country"], "age_years": a["age_years"],
                "abv": a["abv"], "batch": a["batch"], "is_single_barrel": a["single_barrel"],
                "is_store_pick": a["store_pick"]}
    for i in range(0, len(new), 500):
        batch = [product_row(e) for e, _ in new[i:i + 500]]
        # Plain insert: every key here was checked absent above and is unique within
        # the file, and the identity index is an expression PostgREST can't target.
        made = sb("POST", "/rest/v1/spirit_products", batch) or []
        for m in made:
            by_key[m["name_norm"]] = m["id"]
        print(f"  added bottles {i + 1}–{i + len(batch)}")
    missing = [e["key"] for e, _ in new if e["key"] not in by_key]
    for i in range(0, len(missing), 100):         # rows the insert skipped as duplicates
        keys = ",".join(q('"' + k + '"') for k in missing[i:i + 100])
        for m in sb("GET", f"/rest/v1/spirit_products?select=id,name_norm&name_norm=in.({keys})") or []:
            by_key[m["name_norm"]] = m["id"]
    aliases = [{"alias_norm": e["key"], "product_id": by_key[e["key"]], "source_id": "sfwsc"}
               for e, _ in new if e["key"] in by_key]
    for i in range(0, len(aliases), 500):
        sb("POST", "/rest/v1/spirit_aliases?on_conflict=alias_norm", aliases[i:i + 500],
           prefer="resolution=ignore-duplicates,return=minimal")
    reviews = []
    for e, pid in matched + new:
        pid = pid or by_key.get(e["key"])
        if not pid or (pid, args.year) in have:
            continue
        reviews.append({"source_id": "sfwsc", "source_ref": f"sfwsc:{args.year}:{e['key']}", "product_id": pid,
                        "source_name": e["name"][:200], "source_producer": e["brand"], "url": url,
                        "review_year": args.year, "medal": e["medal"], "score_raw": None,
                        "score_10": N.medal_to_10("sfwsc", e["medal"]), "weight": 0.5,
                        "match_status": "auto", "match_score": 1, "origin": "bulk"})
    for i in range(0, len(reviews), 500):
        sb("POST", "/rest/v1/spirit_reviews?on_conflict=source_id,source_ref", reviews[i:i + 500],
           prefer="resolution=ignore-duplicates,return=minimal")
    print(f"\nAdded {len(reviews)} SFWSC {args.year} medals ({len(new)} new bottles).")


# =============================================================================
# What the app's lookups add: verify, reject, read reports
# =============================================================================
def _names(ids):
    ids = [i for i in set(ids) if i]
    out = {}
    for i in range(0, len(ids), 100):
        for p in sb("GET", "/rest/v1/spirit_products?select=id,canonical_name&id=in.(" + ",".join(ids[i:i + 100]) + ")") or []:
            out[p["id"]] = p["canonical_name"]
    return out


def cmd_field(args):
    rows = sb("GET", "/rest/v1/spirit_reviews?select=id,product_id,source_id,source_name,url,review_year,"
                     "score_raw,medal,score_10,reviewer,seen_count&origin=eq.field&verified=is.false"
                     "&match_status=neq.rejected&order=fetched_at&limit=200") or []
    if not rows:
        print("Nothing waiting — every score the app's lookups found has been checked.")
        return
    names = _names(r["product_id"] for r in rows)
    print(f"{len(rows)} lookup find(s) to check. v = verified, r = reject, s = skip, q = quit.\n")
    for r in rows:
        what = r.get("medal") or (f"{float(r['score_raw']):g}" if r.get("score_raw") is not None else "?")
        print(f"{names.get(r['product_id'], '?')}  ←  [{r['source_id']}{' · ' + r['reviewer'] if r.get('reviewer') else ''}] "
              f"{what} {r.get('review_year') or ''} → {float(r['score_10']):.2f}/10")
        print(f"   page names it: {r['source_name']}")
        print(f"   {r.get('url') or '(no link)'}")
        ans = input("   > ").strip().lower()
        if ans == "q":
            break
        if ans == "v":
            sb("PATCH", f"/rest/v1/spirit_reviews?id=eq.{r['id']}", {"verified": True}, prefer="return=minimal")
        elif ans == "r":
            sb("PATCH", f"/rest/v1/spirit_reviews?id=eq.{r['id']}", {"match_status": "rejected"},
               prefer="return=minimal")


def cmd_reports(args):
    rows = sb("GET", "/rest/v1/spirit_reports?select=id,product_id,review_id,kind,note,created_at"
                     "&status=eq.open&order=created_at") or []
    if not rows:
        print("No open reports.")
        return
    names = _names(r["product_id"] for r in rows)
    print(f"{len(rows)} open report(s). f = fixed, d = dismiss, s = skip, q = quit.")
    print("A wrong-bottle report usually means a bad alias or a review on the wrong bottle:"
          " fix it in the SQL editor or with `review`, then mark it fixed.\n")
    for r in rows:
        print(f"[{r['kind']}] {names.get(r['product_id'], '?')}  {r['created_at'][:10]}"
              + (f"  review {r['review_id']}" if r.get("review_id") else "") + (f"\n   “{r['note']}”" if r.get("note") else ""))
        ans = input("   > ").strip().lower()
        if ans == "q":
            break
        if ans in ("f", "d"):
            sb("PATCH", f"/rest/v1/spirit_reports?id=eq.{r['id']}",
               {"status": "fixed" if ans == "f" else "dismissed"}, prefer="return=minimal")


# =============================================================================
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("seed")
    s.add_argument("--catalog-name", action="append", default=[], metavar="BAR=FULL")
    s.add_argument("--apply", action="store_true")
    s.set_defaults(fn=cmd_seed)

    s = sub.add_parser("product")
    s.add_argument("name")
    s.add_argument("--category")
    s.add_argument("--abv", type=float)
    s.add_argument("--age", type=int)
    s.add_argument("--producer")
    s.add_argument("--apply", action="store_true")
    s.set_defaults(fn=cmd_product)

    s = sub.add_parser("iwsc")
    s.add_argument("queries", nargs="*")
    s.add_argument("--from-catalog", action="store_true")
    s.add_argument("--pages", type=int, default=2, help="search pages per query (default 2)")
    s.add_argument("--max-results", type=int, default=15, help="detail pages per query (default 15)")
    s.add_argument("--refresh", action="store_true", help="ignore the page cache")
    s.add_argument("--apply", action="store_true")
    s.set_defaults(fn=cmd_iwsc)

    s = sub.add_parser("score")
    s.add_argument("bottle")
    s.add_argument("--source", required=True)
    s.add_argument("--raw", type=float)
    s.add_argument("--medal")
    s.add_argument("--year", type=int)
    s.add_argument("--reviewer")
    s.add_argument("--url")
    s.add_argument("--scale", help="override the source's scale for this review")
    s.add_argument("--apply", action="store_true")
    s.set_defaults(fn=cmd_score)

    s = sub.add_parser("review")
    s.set_defaults(fn=cmd_review)

    s = sub.add_parser("show")
    s.add_argument("name", nargs="?")
    s.set_defaults(fn=cmd_show)

    s = sub.add_parser("inspect")
    s.add_argument("url")
    s.set_defaults(fn=cmd_inspect)

    s = sub.add_parser("sfwsc-import")
    s.add_argument("--year", type=int, default=max(SFWSC_PDFS))
    s.add_argument("--url", help="the results PDF (default: the one on file for --year)")
    s.add_argument("--refresh", action="store_true", help="download the PDF again")
    s.add_argument("--apply", action="store_true")
    s.set_defaults(fn=cmd_sfwsc_import)

    s = sub.add_parser("field")
    s.set_defaults(fn=cmd_field)

    s = sub.add_parser("reports")
    s.set_defaults(fn=cmd_reports)

    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
