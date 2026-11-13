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
  harvest SOURCE [--years 2024 2025]
                             Fetch a whole source into batches/SOURCE.json (no
                             database): bsa (Bartender Spirits Awards), lonecaner,
                             ginisin (critics), and more — see HARVESTERS.
  import-batch batches/SOURCE.json
                             Match a harvested batch to the catalog (exact name,
                             alias, or the same distinguishing words) and add its
                             new bottles, aliases and scores.
  dupes                      List bottles one distinguishing word apart (possible
                             duplicates) into batches/dupes.csv.
  merge KEEP_ID DROP_ID      Fold one bottle into another: reviews, aliases, bar
                             bottles, lookups and reports move; the name becomes an alias.
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
    asked = _robots[_base(url)].crawl_delay(USER_AGENT) if _base(url) in _robots else None
    wait = max(MIN_GAP_S, float(asked or 0)) - (time.time() - _last_hit.get(host, 0))
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
# Bulk batches: harvest a source into a JSON file you can read, then import it
# =============================================================================
# `harvest SOURCE` fetches (politely, cached) and writes scripts/ratings/batches/
# SOURCE.json — no database involved, so the file can be read, diffed and
# checked before anything is written. `import-batch FILE` matches every row to
# the catalog the same strict way sfwsc-import does and, with --apply, adds the
# new bottles, their aliases and the scores.
BATCH_DIR = os.path.join(HERE, "batches")
BAR_CATEGORIES = {"gin", "vodka", "rum", "tequila", "mezcal", "whiskey", "bourbon", "rye", "scotch",
                  "brandy", "liqueur", "vermouth", "amaro", "bitters", "wine", "mixer", "other"}


def text_of(fragment):
    """HTML fragment -> one line of plain text."""
    t = re.sub(r"<(script|style)\b.*?</\1>", " ", fragment or "", flags=re.S | re.I)
    t = html.unescape(re.sub(r"<[^>]+>", " ", t)).replace("\xa0", " ").replace("\\'", "'")
    return re.sub(r"\s+", " ", t).strip()


def match_name(name):
    """A printed name, tidied: a trailing "– Review" and quotes go; parentheses
    go but their words stay — BSA prints the product there ("Hoyo 19 Hole
    (Blanco)" and "(Extra Anejo)" are two bottles)."""
    n = re.sub(r"\s*[–—-]\s*(rum |gin |whisk(?:e)?y )?review\s*$", "", name, flags=re.I)
    n = re.sub(r"[“”\"«»()]", " ", n)
    return re.sub(r"\s+", " ", n).strip(" ,;:-–")


# Bottles merge only when what they ARE agrees too. Amaro and liqueur are one
# family; a plain "whiskey" joins a bourbon / rye / scotch unless its own name
# says another style ("Old Dominick Straight Tennessee Whiskey" is not its bourbon).
CATEGORY_FAMILY = {"amaro": "liqueur", "liqueur": "liqueur", "vermouth": "wine", "wine": "wine"}
WHISKEYS = {"whiskey", "bourbon", "rye", "scotch"}
WHISKEY_STYLE = re.compile(r"\b(single malt|tennessee|american|irish|canadian|japanese|corn|wheat|rye|bourbon|scotch)\b")


def says_whiskey(cat, name):
    """A 'whiskey' whose own name spells it out ("Bar Boss Whiskey") is stating a
    type, so it isn't the same maker's bourbon; one that names no type at all
    ("Four Roses Single Barrel") still is."""
    return cat == "whiskey" and bool(re.search(r"\bwhisk(e)?y\b", name or "", re.I))


def categories_agree(cat_a, cat_b, key_a="", key_b=""):
    if not cat_a or not cat_b or cat_a == cat_b or "other" in (cat_a, cat_b):
        return True
    if CATEGORY_FAMILY.get(cat_a, cat_a) == CATEGORY_FAMILY.get(cat_b, cat_b):
        return True
    if {cat_a, cat_b} <= WHISKEYS and "whiskey" in (cat_a, cat_b):
        return not WHISKEY_STYLE.search(key_a if cat_a == "whiskey" else key_b)
    return False


def write_batch(name, meta, rows):
    os.makedirs(BATCH_DIR, exist_ok=True)
    rows = sorted(rows, key=lambda r: (-(r.get("year") or 0), r["name"].lower()))
    path = os.path.join(BATCH_DIR, name + ".json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({**meta, "harvested": datetime.date.today().isoformat(), "count": len(rows), "rows": rows},
                  f, indent=1, ensure_ascii=False)
        f.write("\n")
    years = [r["year"] for r in rows if r.get("year")]
    print(f"Wrote {len(rows)} rows to {os.path.relpath(path, REPO)}"
          + (f" ({min(years)}–{max(years)})" if years else ""))
    return path


def read_batch(path):
    with open(path, encoding="utf-8") as f:
        b = json.load(f)
    for k in ("source_id", "rows"):
        if k not in b:
            sys.exit(f"{path}: not a batch file (no {k!r})")
    return b


def row_score(b, row):
    """0-10 for one batch row (unrounded), or None when it carries no score we use."""
    if row.get("score_raw") is not None:
        return N.to_10(row.get("scale") or b["scale"], row["score_raw"])
    if row.get("medal"):
        return N.medal_to_10(row.get("medal_scale") or b.get("medal_scale") or "default", row["medal"])
    return None


def _prod_attrs(p):
    return {"age_years": p.get("age_years"), "batch": p.get("batch"),
            "abv": float(p["abv"]) if p.get("abv") is not None else None}


def plan_batch(b, products, aliases, have, join_only=False):
    """What importing batch `b` would do, without touching anything.

    products: [{id, name_norm, age_years, abv, batch}]; aliases: [{alias_norm,
    product_id}]; have: the (product_id, ref) pairs this source already holds,
    ref being the review year (competitions) or the page URL (critics).
    A row joins a catalog bottle on its exact name key or an alias, else on the
    very same distinguishing words (same_bottle) with no age/ABV/batch conflict;
    two catalog bottles with those words = ambiguous, left out. Rows naming the
    same new bottle (any order of the same words) become one new bottle —
    unless join_only, which only deepens bottles the catalog already has (for an
    international medal list full of bottles no US shop carries)."""
    by_id = {p["id"]: p for p in products}
    by_key = {p["name_norm"]: p["id"] for p in products if p.get("name_norm")}
    for a in aliases:
        by_key.setdefault(a["alias_norm"], a["product_id"])
    by_words = {}
    for p in products:
        if p.get("name_norm"):
            by_words.setdefault(frozenset(N.bottle_words(p["name_norm"])), []).append(p["id"])
    per_url = b.get("ref") == "url"
    new = {}                    # new key -> product row
    new_words = {}              # word set -> [new keys]
    # have: (product_id, ref) for a one-source batch, or (source_id, product_id, ref)
    seen = {h if len(h) == 3 else (b["source_id"],) + tuple(h) for h in have}
    out = {"joined": [], "new_rows": [], "reviews": [], "aliases": [], "skipped": {}}
    def skip(why):
        out["skipped"][why] = out["skipped"].get(why, 0) + 1
    for row in b["rows"]:
        name = (row.get("name") or "").strip()
        key = N.norm_name(match_name(name))
        if row.get("year") and re.search(r"\s(%d|%d)$" % (row["year"], row["year"] - 1), key):
            key = key.rsplit(" ", 1)[0]   # "Sazerac 18-Year-Old Rye-2025": that year's release of the bottle
        if not key:
            skip("no name"); continue
        score = row_score(b, row)
        if score is None:
            skip("no usable score"); continue
        attrs = N.parse_attrs(name)
        if row.get("abv") is not None:   # a stated strength keeps a cask-strength release off the standard bottle
            attrs["abv"] = float(row["abv"])
        words = frozenset(N.bottle_words(key))
        cat = row.get("category") if row.get("category") in BAR_CATEGORIES else N.guess_category(name)
        def fits(p):
            other = p.get("category")
            if (says_whiskey(cat, name) and other in ("bourbon", "rye", "scotch")) or \
                    (says_whiskey(other, p.get("canonical_name")) and cat in ("bourbon", "rye", "scotch")):
                return False
            return N.attrs_compatible(attrs, _prod_attrs(p)) and \
                categories_agree(cat, other, key, p.get("name_norm") or "")
        pid, how = by_key.get(key), "exact name"
        if pid:
            # The very same printed name is the same bottle even when two sources
            # file it differently (BSA: "Rhum Clement Bana Canne" under liqueurs);
            # only a stated age/ABV conflict keeps it out — never as a second
            # bottle of that name, which the catalog's identity index refuses.
            target = by_id.get(pid) or new.get(pid[4:] if pid.startswith("new:") else "", {})
            if not N.attrs_compatible(attrs, _prod_attrs(target)):
                skip("same name as a catalog bottle of another age or strength"); continue
        if not pid:
            if not words:
                skip("only generic words (a bare 'Gin')"); continue
            hits = {i for i in by_words.get(words, []) if fits(by_id[i]) and N.same_bottle(key, by_id[i]["name_norm"])}
            if len(hits) > 1:
                skip("ambiguous (two catalog bottles share its words)"); continue
            pid, how = (hits.pop(), "same words") if hits else (None, None)
        if not pid and (join_only or row.get("join_only")):
            skip("not in the catalog (--join-only)" if join_only else "a limited release not in the catalog"); continue
        if not pid:
            nk = next((k for k in new_words.get(words, []) if fits(new[k]) and N.same_bottle(key, new[k]["name_norm"])), None)
            if nk is None:
                if key in by_key:              # (belt and braces) a taken name never becomes a new bottle
                    skip("same name as a catalog bottle of another age or strength"); continue
                nk = key
                abv = row.get("abv") if row.get("abv") is not None else attrs["abv"]
                new[nk] = {"canonical_name": match_name(name)[:200] or name[:200], "name_norm": key, "category": cat,
                           "producer": row.get("producer") or None, "country": row.get("country") or None,
                           "age_years": attrs["age_years"], "abv": abv, "batch": attrs["batch"],
                           "is_single_barrel": attrs["single_barrel"], "is_store_pick": attrs["store_pick"]}
                new_words.setdefault(words, []).append(nk)
            pid = "new:" + nk
        if pid.startswith("new:"):
            out["new_rows"].append(row)
        else:
            out["joined"].append((row, pid, how))
        if key not in by_key:          # this printed form finds the bottle next time
            by_key[key] = pid
            out["aliases"].append((key, pid))
        ref = row.get("url") if per_url else row.get("year")
        src_id = row.get("source_id") or b["source_id"]
        if (src_id, pid, ref) in seen:
            skip("already held (same bottle, same " + ("page" if per_url else "year") + ")"); continue
        seen.add((src_id, pid, ref))
        out["reviews"].append((row, pid, score))
    out["new"] = new
    return out


def review_row(b, row, pid, score):
    per_url = b.get("ref") == "url"
    src_id = row.get("source_id") or b["source_id"]
    key = N.norm_name(match_name(row["name"]))
    ref = row.get("ref") or (f"{src_id}:{row.get('url')}#{key}" if per_url and b["source_id"] == "*"
                             else f"{src_id}:{row.get('url')}" if per_url else f"{src_id}:{row.get('year')}:{key}")
    return {"source_id": src_id, "source_ref": ref[:500], "product_id": pid,
            "source_name": (row.get("printed") or row["name"])[:200], "source_producer": row.get("producer") or None,
            "url": row.get("url") or None, "review_year": row.get("year"), "reviewer": row.get("reviewer") or b.get("reviewer"),
            "medal": row.get("medal") or None, "score_raw": row.get("score_raw"),
            "score_10": round(score, 2), "weight": float(row.get("weight") or b.get("weight") or 0.5),
            "match_status": "auto", "match_score": 1, "origin": b.get("origin") or "bulk"}


def cmd_import_batch(args):
    b = read_batch(args.file)
    if b["source_id"] == "*":                  # hand-checked scores from several sources
        known = {r["id"]: r for r in sb_all("/rest/v1/rating_sources?select=id,name,default_weight&order=id")}
        missing = sorted({r.get("source_id") for r in b["rows"]} - set(known))
        if missing:
            sys.exit(f"Unknown sources in {args.file}: {', '.join(map(str, missing))} — run the README SQL first.")
        for r in b["rows"]:
            r.setdefault("weight", float(known[r["source_id"]]["default_weight"]))
        src = {"name": "several sources"}
        ids = sorted({r["source_id"] for r in b["rows"]})
    else:
        src = source_row(b["source_id"])       # exits if the source isn't in rating_sources yet
        ids = [b["source_id"]]
    products = sb_all("/rest/v1/spirit_products?select=id,canonical_name,name_norm,category,age_years,abv,batch&order=id")
    aliases = sb_all("/rest/v1/spirit_aliases?select=alias_norm,product_id&order=alias_norm")
    held = sb_all(f"/rest/v1/spirit_reviews?select=source_id,product_id,review_year,url&source_id=in.({','.join(q(i) for i in ids)})&order=id")
    have = {(r["source_id"], r["product_id"], r["url"] if b.get("ref") == "url" else r["review_year"]) for r in held}
    plan = plan_batch(b, products, aliases, have, join_only=args.join_only)
    print(f"{b['source_id']} ({src.get('name')}): {len(b['rows'])} rows in {os.path.relpath(args.file, REPO)}")
    print(f"  {len(plan['joined'])} join bottles already in the catalog, {len(plan['new'])} new bottles"
          f" ({len(plan['new_rows'])} rows), {len(plan['reviews'])} scores to add")
    for why, n in sorted(plan["skipped"].items(), key=lambda kv: -kv[1]):
        print(f"  skipped {n}: {why}")
    for row, pid, how in plan["joined"][:12]:
        print(f"    = {row['name']}  ({row.get('year') or ''} {row.get('medal') or row.get('score_raw')})  [{how}]")
    for nk, p in list(plan["new"].items())[:8]:
        print(f"    + {p['canonical_name']}  [{p['category']}]")
    if not args.apply:
        print("\nDry run — add --apply to write.")
        return
    made = {}
    rows = list(plan["new"].items())
    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        for m in sb("POST", "/rest/v1/spirit_products", [p for _, p in chunk]) or []:
            made[m["name_norm"]] = m["id"]
        print(f"  added bottles {i + 1}–{i + len(chunk)}")
    alias_rows = []
    # A hand-checked batch is marked "*" (several sources); that isn't a
    # rating_sources id, so its aliases carry none. Saving "*" broke the
    # 2026-11-12 curated import after its bottles were made, before any score.
    alias_src = None if b["source_id"] == "*" else b["source_id"]
    for key, pid in plan["aliases"]:   # every printed form points at its bottle
        pid = made.get(pid[4:]) if pid.startswith("new:") else pid
        if pid:
            alias_rows.append({"alias_norm": key, "product_id": pid, "source_id": alias_src})
    for i in range(0, len(alias_rows), 500):
        sb("POST", "/rest/v1/spirit_aliases?on_conflict=alias_norm", alias_rows[i:i + 500],
           prefer="resolution=ignore-duplicates,return=minimal")
    reviews = []
    for row, pid, score in plan["reviews"]:
        if pid.startswith("new:"):
            pid = made.get(pid[4:])
            if not pid:
                continue
        reviews.append(review_row(b, row, pid, score))
    for i in range(0, len(reviews), 500):
        sb("POST", "/rest/v1/spirit_reviews?on_conflict=source_id,source_ref", reviews[i:i + 500],
           prefer="resolution=ignore-duplicates,return=minimal")
    print(f"\nAdded {len(reviews)} {b['source_id']} scores ({len(made)} new bottles).")


# --- Harvesters --------------------------------------------------------------
def wp_api_all(endpoint, params, per_page=100):
    """Every item of a WordPress REST listing, 100 a request (a site's own public
    feed, so a whole review catalog is a dozen requests instead of a thousand)."""
    items, page = [], 1
    while True:
        url = endpoint + "?" + urllib.parse.urlencode({**params, "per_page": per_page, "page": page})
        try:
            body = fetch(url)
        except urllib.error.HTTPError as e:
            if e.code == 400:          # past the last page
                return items
            raise
        if body is None:
            return items
        chunk = json.loads(body)
        items += chunk
        if len(chunk) < per_page:
            return items
        page += 1


# Bartender Spirits Awards: one page per year lists every medal with its points
# and the product's own results page (judged blind by bartenders on mixability,
# balance, taste, packaging and value — weights unpublished).
BSA_URL = "https://bartenderspiritsawards.com/en/competition-global-results/{year}/"
BTN_MEDALS = {"double gold medal": "Double Gold", "gold medal": "Gold", "silver medal": "Silver", "bronze medal": "Bronze"}
BTN_SKIP = re.compile(r"ready to drink|\brtd\b|non-alcoholic", re.I)
BTN_FIXED = {"tequila": "tequila", "mezcal": "mezcal", "gin": "gin", "vodka": "vodka", "rum": "rum",
             "liqueurs": "liqueur", "liqueur": "liqueur", "cognac": "brandy", "brandy": "brandy",
             "armagnac": "brandy", "absinthe": "other"}


def btn_category(category, name, country):
    c, g = (category or "").strip().lower(), N.guess_category(name)
    if c in ("whisky", "whiskey"):
        if g in ("bourbon", "rye", "scotch", "whiskey"):
            return g
        return "scotch" if (country or "").strip().lower() == "scotland" else "whiskey"
    return BTN_FIXED.get(c) or refine_category(name, g)


DESCRIPTOR_WORDS = set("""rye straight barrel barrels aged single malt small batch reserve blanco reposado anejo extra
silver gold dark spiced white original classic dry navy strength cask finish finished oak oaked honey coffee vanilla
cinnamon apple cherry peach lemon orange lime coconut pineapple blended blend wheat wheated corn moonshine double
triple proof high bottled in bond the premium craft select special limited edition year old new make light aged
pot still overproof gold añejo cristalino joven plata cream flavored flavoured spirit whiskey whisky chocolate
caramel maple butterscotch pecan peanut butter salted banana strawberry raspberry blackberry blueberry watermelon
mango passion fruit grapefruit pear plum ginger mint pumpkin spice vs vsop xo xxo napoleon hors age bianco rosso
blanc rouge ambrato vermouth aperitivo aperitif bitter liqueur cordial repsado reposada anejo añejo""".split())
CORP_SUFFIX = re.compile(r"[,\s]+(llc|l\.l\.c\.|inc\.?|ltd\.?|limited|co\.|corp\.?|corporation|company|brands|group|s\.a\.?)$", re.I)


def with_brand(name, producer):
    """'Rye Whiskey' by Nelson Brothers is 'Nelson Brothers Rye Whiskey': a name
    made only of describing words gets its producer in front."""
    words = N.bottle_words(N.norm_name(match_name(name)))
    # 1-2 digits are an age ("4 Year"); 1800, 1792, 291 are brands.
    if producer and all(w in DESCRIPTOR_WORDS or (w.isdigit() and len(w) <= 2) for w in words):
        brand = producer
        while CORP_SUFFIX.search(brand):
            brand = CORP_SUFFIX.sub("", brand)
        if N.norm_name(brand) and N.norm_name(brand) not in N.norm_name(name):
            return f"{brand.strip()} {name}"
    return name


def btn_rows(page, year, domain):
    """[{name, producer, country, category, year, score_raw, medal, url}] from one
    Beverage Trade Network results page (BSA; same layout as its sister sites)."""
    out, seen = [], set()
    for art in re.findall(r"<article\b(.*?)</article>", page, flags=re.S):
        field = lambda label: text_of((re.search(rf"<strong>{label}:</strong>(.*?)</li>", art, flags=re.S) or [None, ""])[1])
        h1 = re.search(r"<h1>(.*?)</h1>", art, flags=re.S)
        name = text_of(h1.group(1)) if h1 else ""
        medal = BTN_MEDALS.get(field("Award").lower())
        if not name or not medal:          # "Vodka of the Year" etc. repeat medal rows
            continue
        cat = re.search(r'data-category="([^"]*)"', art)
        category = html.unescape(cat.group(1)) if cat else field("Category")
        if BTN_SKIP.search(category) or (category.lower() == "bitters and mixers" and "bitter" not in name.lower()) \
                or is_cocktail(name) or SKIP_NAME.search(name):
            continue
        m = re.search(r'data-points="(\d+)"', art) or re.search(r"(\d{2,3})\s*Points", art) or re.search(r"_(\d{2,3})points", art)
        url = re.search(r'href="(https://' + re.escape(domain) + r'/en/winner-brands/[^"]+)"', art)
        if (name.lower(), year) in seen:
            continue
        seen.add((name.lower(), year))
        country, producer = field("Country"), field("Producer Name")
        printed, name = name, with_brand(name, producer)
        out.append({"name": name, "printed": printed, "producer": producer or None, "country": country or None,
                    "category": btn_category(category, name, country), "year": year,
                    "score_raw": int(m.group(1)) if m else None, "medal": medal,
                    "url": url.group(1) if url else BSA_URL.format(year=year)})
    return out


def harvest_bsa(args):
    rows = []
    for year in args.years or range(2019, datetime.date.today().year + 1):
        page = fetch(BSA_URL.format(year=year), refresh=args.refresh)
        if page:
            got = btn_rows(page, year, "bartenderspiritsawards.com")
            print(f"  {year}: {len(got)} medals")
            rows += got
    return "bsa", {"source_id": "bartender_spirits_awards", "scale": "competition100", "weight": 0.5, "origin": "bulk",
                   "note": "Bartender Spirits Awards medals with their points, from each year's global results page."}, rows


def score_100(text):
    """The last 'NN/100' (or 'NN.5/100') a review states — its verdict."""
    hits = re.findall(r"\(?\b(\d{2,3}(?:\.\d)?)\s*/\s*100\b", text)
    hits = [float(h) for h in hits if 40 <= float(h) <= 100]
    return hits[-1] if hits else None


# The Lone Caner (Lance Surujbally): 1,100+ numbered rum reviews, 100-point, a
# hard grader. Read through the site's own WordPress feed. Most are independent
# or limited bottlings (a vintage, a cask, an indie bottler): those only deepen
# bottles the catalog already has; core-range rums may become catalog bottles.
RUM_LIMITED = re.compile(r"\b(19|20)\d\d\b|\b(19|20)\d0s\b|\bcask\b|#\s?\d|\bno\.\s?\d|\bbatch\b|\bedition\b|\bsingle barrel\b|"
                         r"\bvelier\b|colours of rum|cadenhead|kill devil|samaroli|silver seal|moon import|duncan taylor|"
                         r"wild parrot|rom de luxe|that boutique|bristol spirits|compagnie des indes|l.esprit|"
                         r"the rum cask|habitation|rumaniacs|\bteca\b|\bnrj\b|\bvssr\b", re.I)
def harvest_lonecaner(args):
    posts = wp_api_all("https://thelonecaner.com/wp-json/wp/v2/posts", {"_fields": "link,date,title,content"})
    rows = []
    for p in posts:
        title = text_of(p["title"]["rendered"])
        text = text_of(p["content"]["rendered"])
        # A review: "– Review" in the title, or older posts with one score in them
        # ("Key Rums of the World: …", "Revisiting the …"); lists and essays carry none or many.
        if not re.search(r"review\s*$", title, re.I) and len(re.findall(r"\b\d{2,3}(?:\.\d)?\s*/\s*100\b", text)) != 1:
            continue
        score = score_100(text)
        if score is None:
            continue
        printed = re.sub(r"\s*[–—-]\s*review\s*$", "", title, flags=re.I).strip()
        printed = re.sub(r"^(key rums of the world\s*[:–—-]\s*|revisiting\s+(the\s+)?|a second look at\s+(the\s+)?)", "", printed, flags=re.I).strip()
        limited = bool(RUM_LIMITED.search(printed))
        rows.append({"name": re.sub(r"\s+", " ", re.sub(r"\([^)]*\)", " ", printed)).strip(), "printed": printed, "category": "rum",
                     "join_only": limited,
                     "year": int(p["date"][:4]), "score_raw": score, "url": p["link"],
                     "reviewer": "Lance Surujbally (The Lone Caner)"})
    print(f"  {len(posts)} posts, {len(rows)} scored reviews")
    return "lonecaner", {"source_id": "lone_caner", "scale": "critic100_harsh", "weight": 1.0, "origin": "bulk", "ref": "url",
                         "note": "The Lone Caner's scored rum reviews (100-point, hard grader), from the site's WordPress feed."}, rows


# The GIN is IN (Aaron Knoll): ~900 gin reviews, 0.5-5 stars. The rating is the
# site's own "ginratings" term; reader votes are a separate number and never read.
def harvest_ginisin(args):
    posts = wp_api_all("https://theginisin.com/wp-json/wp/v2/reviews", {"_fields": "link,date,title,ginratings_terms"})
    rows = []
    for p in posts:
        terms = p.get("ginratings_terms") or []
        try:
            stars = float(terms[0]["name"])
        except (IndexError, KeyError, ValueError):
            continue
        if not 0.5 <= stars <= 5:
            continue
        rows.append({"name": text_of(p["title"]["rendered"]), "category": "gin", "year": int(p["date"][:4]),
                     "score_raw": stars, "url": p["link"], "reviewer": "Aaron Knoll (The GIN is IN)"})
    print(f"  {len(posts)} reviews, {len(rows)} rated")
    return "ginisin", {"source_id": "gin_is_in", "scale": "stars5", "weight": 1.0, "origin": "bulk", "ref": "url",
                       "note": "The GIN is IN's own star ratings (not reader votes), from the site's WordPress feed."}, rows


# Spirits Selection by Concours Mondial: medals capped at 30% of entries,
# 2013 on, ~30 cards a page; every card links its own result page.
SSEL_URL = "https://results.spiritsselection.com/en/results/{year}"
SSEL_MEDALS = {"grand gold medal": "Grand Gold", "gold medal": "Gold", "silver medal": "Silver"}
SKIP_NAME = re.compile(r"\b(ready[- ]to[- ]drink|rtd|non[- ]alcoholic|alcohol[- ]free|0[.,]0 ?%|zero proof|"
                       r"ginger beer|ginger ale|tonic water|tonic|lemonade|seltzer|soda|mixer|syrup|hard cider|"
                       r"canned cocktail|cocktail mix|high noon|buzzballz|hard tea|hard lemonade)\b", re.I)


# Canned and bottled cocktails; bitters named after a drink ("Old Fashioned
# Aromatic Bitters") stay.
COCKTAIL_NAME = re.compile(r"\b(mule|iced tea|margarita|paloma|spritz|old fashioned|highball|punch|sangria|mojito|"
                           r"daiquiri|cosmopolitan|cosmo|lemon drop|espresso martini|pi[ñn]a colada|bloody mary|mai tai|"
                           r"negroni|whiske?y sour|gimlet|hurricane|painkiller|rum punch)\b", re.I)


# Big brands whose bottles often print no type word ("SMIRNOFF No. 21",
# "Dewar's Signature"). Used only when the name itself gives nothing away.
BRAND_CATEGORY = {}
for _cat, _brands in {
    "vodka": "smirnoff, absolut, grey goose, ketel one, titos, belvedere, stolichnaya, stoli, chopin, skyy, deep eddy, svedka",
    "gin": "hendricks, tanqueray, beefeater, bombay, aviation, plymouth, botanist, monkey 47, empress, roku, sipsmith, fords",
    "rum": "bacardi, captain morgan, mount gay, appleton, el dorado, diplomatico, zacapa, plantation, planteray, goslings, "
           "kraken, sailor jerry, havana club, flor de cana, don q, smith and cross, wray and nephew, hamilton, rhum jm",
    "tequila": "patron, don julio, casamigos, espolon, 1800, herradura, el jimador, hornitos, olmeca, milagro, cazadores, "
               "jose cuervo, clase azul, teremana, 818, lalo, fortaleza, siete leguas, tapatio, el tesoro, cimarron, gran centenario",
    "mezcal": "del maguey, montelobos, ilegal, vago, 400 conejos",
    "scotch": "dewars, johnnie walker, chivas regal, glenlivet, glenfiddich, macallan, laphroaig, lagavulin, ardbeg, talisker, "
              "oban, balvenie, monkey shoulder, famous grouse, cutty sark, highland park, bowmore, glenmorangie, auchentoshan, aberlour",
    "bourbon": "makers mark, buffalo trace, wild turkey, woodford reserve, four roses, jim beam, evan williams, elijah craig, "
               "knob creek, basil hayden, bulleit, old forester, weller, blantons, eagle rare, angels envy, larceny, "
               "old grand dad, early times, 1792, heaven hill",
    "whiskey": "jameson, bushmills, redbreast, tullamore, powers, teeling, jack daniels, george dickel, uncle nearest, crown royal",
    "brandy": "courvoisier, hennessy, remy martin, martell, dusse, pierre ferrand, christian brothers, paul masson",
    "amaro": "campari, aperol, fernet, montenegro, averna, cynar, nonino",
    "liqueur": "cointreau, grand marnier, chartreuse, st germain, saint germain, kahlua, baileys, disaronno, frangelico, "
               "luxardo, licor 43, drambuie, benedictine, galliano, jagermeister, fireball",
}.items():
    for _b in _brands.split(","):
        BRAND_CATEGORY[N.norm_name(_b.strip())] = _cat


def brand_category(name):
    key = N.norm_name(name)
    best = None
    for brand, cat in BRAND_CATEGORY.items():      # the brand may follow a company ("Diageo SMIRNOFF")
        if re.search(r"(?:^|\s)" + re.escape(brand) + r"(?:\s|$)", key) and (best is None or len(brand) > len(best[0])):
            best = (brand, cat)
    return best[1] if best else None


def refine_category(name, cat):
    """A name-only source (no category column) still says what it is: an añejo is
    a tequila, a VSOP a brandy. Kept here, not in normalize.guess_category, whose
    JS and TS copies must stay word-for-word the same."""
    if cat != "other":
        return cat
    t = N.strip_marks(name).lower()
    if re.search(r"\b(mezcal|espadin|tobala|ensamble)\b", t):
        return "mezcal"
    if re.search(r"\b(anejo|reposado|blanco|plata|cristalino|extra anejo)\b", t):
        return "tequila"
    if re.search(r"\b(vsop|vs|xo|napoleon|hors d.age|calvados|pisco|armagnac)\b", t):
        return "brandy"
    if re.search(r"\b(amaro|amari|fernet|aperitivo|aperitif)\b", t):
        return "amaro"
    if re.search(r"\b(triple sec|limoncello|amaretto|schnapps|curacao|cordial|creme de|cream)\b", t):
        return "liqueur"
    if re.search(r"\b(single malt|malt whisk|whisk)", t):
        return "whiskey"
    return brand_category(name) or cat


MIXED_DRINK = re.compile(r"\b(rum|vodka|whiske?y|bourbon|gin|tequila)\s+(and|&|n)\s+(ginger|cola|coke|soda|tonic|lime|lemonade)\b", re.I)


def is_cocktail(name):
    return (bool(COCKTAIL_NAME.search(name)) and "bitter" not in name.lower()) or bool(MIXED_DRINK.search(name))


def fix_mojibake(t):
    """'Jose Cuervo¬Æ' / 'AÌ±ejo' (UTF-8 read as Mac Roman in an old PDF) -> 'Jose Cuervo®' / 'Añejo'."""
    t = t.replace("å¨", "®")                 # Denver 2023's "Jim Beamå¨"
    if not re.search(r"[¬ÆÃÂÌ√]", t):
        return t
    try:
        raw = t.replace("¬†", " ").encode("mac_roman")
    except UnicodeEncodeError:
        return t
    fixed = raw.decode("utf-8", errors="replace").replace("\ufffd", " ")    # a half-lost no-break space
    return re.sub(r"\s+", " ", fixed) if not re.search(r"[¬ÆÃÂÌ√]", fixed) else t


def ssel_category(label, name):
    t = f"{label} {name}".lower()
    for words, cat in ((("vermouth",), "vermouth"), (("amaro", "amari", "bitter", "aperitif", "aperitivo"), "amaro"),
                       (("liqueur", "cream", "crème", "creme"), "liqueur"), (("mezcal", "agave", "sotol", "raicilla"), "mezcal"),
                       (("tequila",), "tequila"), (("rum", "rhum", "ron ", "cachaça", "cachaca", "cane"), "rum"),
                       (("gin", "genever", "jenever"), "gin"), (("vodka",), "vodka"),
                       (("cognac", "armagnac", "brandy", "calvados", "pisco", "grappa", "eau-de-vie", "fruit spirit"), "brandy")):
        if any(re.search(r"\b" + re.escape(w.strip()) + r"\b", t) for w in words):
            return cat
    if re.search(r"whisk", t):
        g = N.guess_category(name)
        return g if g in ("bourbon", "rye", "scotch") else ("scotch" if "scotland" in t else "whiskey")
    return refine_category(name, N.guess_category(name))


def ssel_rows(page, year):
    out = []
    for card in re.findall(r'<div class="card bg-transparent card-product.*?<div class="card-footer">.*?</div>', page, flags=re.S):
        url = re.search(r'href="(https://results\.spiritsselection\.com/en/results/\d{4}/[^"]+)"', card)
        title = re.search(r'<h3[^>]*card-title[^>]*>(.*?)</h3>', card, flags=re.S)
        medal = re.search(r'alt="((?:Grand )?Gold Medal|Silver Medal)"', card)
        if not (url and title and medal):
            continue
        spans = [text_of(x) for x in re.findall(r'<span class="d-block[^"]*">(.*?)</span>', card, flags=re.S)]
        label = text_of((re.search(r'<div class="card-footer">(.*?)</div>', card, flags=re.S) or [None, ""])[1])
        name = text_of(title.group(1))
        if SKIP_NAME.search(f"{name} {label}") or is_cocktail(name):
            continue
        place = spans[1] if len(spans) > 1 else ""
        out.append({"name": name, "producer": spans[0] if spans else None,
                    "country": place.split(" - ")[0].strip() or None, "category": ssel_category(label, name),
                    "year": year, "score_raw": None, "medal": SSEL_MEDALS[medal.group(1).lower()], "url": url.group(1)})
    return out


def harvest_ssel(args):
    rows = []
    for year in args.years or range(2013, datetime.date.today().year + 1):
        first = fetch(SSEL_URL.format(year=year), refresh=args.refresh)
        if not first:
            continue
        last = max([int(n) for n in re.findall(r"results/%d\?page=(\d+)" % year, first)] or [1])
        got = ssel_rows(first, year)
        for n in range(2, last + 1):
            got += ssel_rows(fetch(SSEL_URL.format(year=year) + f"?page={n}", refresh=args.refresh) or "", year)
        print(f"  {year}: {len(got)} medals over {last} pages")
        rows += got
    return "ssel", {"source_id": "cmb", "scale": "competition100", "medal_scale": "spirits_selection", "weight": 0.6,
                    "origin": "bulk", "note": "Spirits Selection by Concours Mondial medals (capped at 30% of entries), from its results database."}, rows


# Denver International Spirits Competition (Broomfield, CO): a winners PDF a
# year. Since 2025 Company | Brand | Product | Award | Score (every medal with
# its points); before that the medal only, under a header that changes wording.
DISC_LAYOUTS = ["Company|Brand|Product|Award|Score", "Company|Brand|Product Name|Award",
                "Company|Brand|Product|Award", "Company|Brand|Name|Award", "Type|Category|Company|Brand|Name|Award"]
DISC_LINE = re.compile(r"^(?P<head>.*?)\s+(?P<award>Platinum|Double Gold|Gold|Silver|Bronze)(?:\s+(?P<score>\d{2,3}))?\s*$")
CORP = re.compile(r"\b(llc|l\.l\.c\.|inc\.?|ltd\.?|co\.|corp\.?|company)(?=\s|$)", re.I)


def disc_rows(rows, year, url, layout=DISC_LAYOUTS[0]):
    cols = layout.split("|")
    ci, bi = cols.index("Company"), cols.index("Brand")
    out = []
    for cells in rows:
        if len(cells) != len(cols) + 1:
            continue
        cells = [fix_mojibake(c) for c in cells]
        line = cells[-1]
        m = DISC_LINE.match(line.strip())
        if not m:
            continue                      # headers, "Best of Show" placings, packaging
        cells = rejoin_split_words(cells[:-1], line)
        company, brand = cells[ci].strip(), cells[bi].strip()
        rest = m.group("head")
        if ci:                            # 2017's Type | Category come first
            rest = rest.split(company, 1)[-1].strip() if company and company in rest else rest
            company_done = True
        else:
            company_done = False
        if not company_done and company and rest.startswith(company):
            rest = rest[len(company):].strip()
        if brand and rest.startswith(brand) and len(rest) > len(brand):
            product = rest[len(brand):].strip()
        else:
            brand, product = "", rest
        first = brand.split()[0] if brand else ""
        bw = brand.split()
        tail = next((" ".join(bw[i:]) for i in range(1, len(bw)) if product.startswith(" ".join(bw[i:]) + " ")), None)
        if tail:                          # a cut-off company name ran into the brand cell
            name = product
        elif first and re.search(r"(?:^|\s)" + re.escape(first) + r"(?:\s|$)", product):
            name = product[product.find(first):] if not product.startswith(first) else product
        else:
            name = f"{brand} {product}".strip()
        name = re.sub(r"\s+", " ", CORP.sub(" ", name)).strip(" -–")
        name = re.sub(r"^((?:\S+ ){0,3}\S+) \1(?=\s|$)", r"\1", name)      # "Minden Mill Minden Mill …"
        score = int(m.group("score")) if m.group("score") else None
        if not name or SKIP_NAME.search(name) or is_cocktail(name) or (score is not None and not 50 <= score <= 100):
            continue
        out.append({"name": name, "producer": company or None, "country": None, "category": refine_category(name, N.guess_category(name)),
                    "year": year, "score_raw": score, "medal": m.group("award"), "url": url})
    return out


def harvest_disc(args):
    page = fetch("https://denverspiritscomp.com/results/", refresh=args.refresh) or ""
    pdfs = list(dict.fromkeys(re.findall(r'href="(https://denverspiritscomp\.com/wp-content/uploads/[^"]+\.pdf)"', page)))
    by_year = {}
    for u in pdfs:
        if re.search(r"pack|design", u, re.I):
            continue                      # packaging awards aren't about the spirit
        y = re.search(r"(20\d\d)", u.rsplit("/", 1)[-1]) or re.search(r"/uploads/(20\d\d)/", u)
        year = int(y.group(1))
        by_year.setdefault(year, []).append(u)
    rows = []
    for year in sorted(by_year):
        if args.years and year not in args.years:
            continue
        got, seen = [], set()
        for u in by_year[year]:           # a year can have a first list and an update
            path = fetch(u, refresh=args.refresh, binary=True)
            if not path:
                continue
            best = []
            for layout in DISC_LAYOUTS:   # whichever header this year's PDF uses
                try:
                    got_here = disc_rows(pdf_rows(path, headers=layout), year, u, layout)
                except SystemExit:
                    continue
                if len(got_here) > len(best):
                    best = got_here
            for r in best:
                k = (N.norm_name(r["name"]), r["medal"], r["score_raw"])
                if k not in seen:
                    seen.add(k)
                    got.append(r)
        print(f"  {year}: {len(got)} medals from {len(by_year[year])} PDF(s)")
        rows += got
    return "disc", {"source_id": "denver_isc", "scale": "competition100", "medal_scale": "denver", "weight": 0.6,
                    "origin": "bulk", "note": "Denver International Spirits Competition medals with their points, from each year's winners PDF."}, rows


# Whiskyfun (Serge Valentin, Angus MacRaild): ~520 archive pages of tasting
# notes, each "Name (abv%, bottler, details)" and "SGP:xxx - NN points".
# Official bottlings ("OB") only — what a shop sells; independent bottlings never
# reach a US shelf. Core-range OBs may become catalog bottles; limited editions,
# single casks and vintages only deepen bottles the catalog already has.
WF_MONTHS = "january february march april may june july august september october november december".split()
# What it is comes from the bottle's name and its region, never the cask notes
# ("ex-bourbon", "cognac cask" are about the wood).
WF_NAME_TYPES = [(r"\b(rum|rhum|ron|cachaca|clairin)\b", "rum"), (r"\b(cognac|armagnac|calvados|brandy)\b", "brandy"),
                 (r"\b(mezcal)\b", "mezcal"), (r"\b(tequila)\b", "tequila"), (r"\b(gin)\b", "gin"),
                 (r"\b(bourbon)\b", "bourbon"), (r"\b(rye)\b", "rye")]
WF_REGIONS = {"rum": "jamaica martinique guadeloupe barbados guyana trinidad demerara haiti cuba puerto rico marie-galante "
                     "reunion mauritius fiji agricole panama nicaragua guatemala venezuela",
              "brandy": "grande champagne petite champagne fine champagne fins bois bons bois borderies bas-armagnac "
                        "tenareze haut-armagnac cognac armagnac calvados pays d'auge",
              "whiskey": "japan usa ireland india taiwan denmark sweden norway finland france england wales australia "
                         "tasmania canada germany netherlands switzerland israel south africa new zealand austria "
                         "belgium spain italy iceland"}
# "Cask" alone is core-range naming (Sherry Oak Cask, Triple Cask, Quarter Cask);
# a cask number, a bottle count or a batch number is a limited release.
WF_LIMITED = re.compile(r"\b(bottles|batch\s*(?:no\.?\s*)?\d+|edition|release|vintage|single barrel|single cask|private|"
                        r"selected|exclusive|festival|feis|distillery only|hand.?filled|sample|cask\s*(?:#|no\.?|number)\s*\d+|"
                        r"\d{4}/\d{4})\b", re.I)


def whiskyfun_rows(page, url, year):
    out = []
    for m in re.finditer(r'<span class="textegrandfoncegras">(.*?)</span>(.*?)SGP:\s*\d+\s*-\s*(\d{2,3})\s*points', page, flags=re.S):
        if '<span class="textegrandfoncegras">' in m.group(2):
            continue                      # the score belongs to a later note
        full = text_of(m.group(1))
        score = int(m.group(3))
        pm = re.match(r"^(.*?)\s*\((.*)\)\s*$", full)
        if not pm or not 50 <= score <= 100:
            continue
        base, details = pm.group(1).strip(), [d.strip() for d in pm.group(2).split(",")]
        if "OB" not in details:
            continue
        abv = next((float(x.rstrip("%").replace(",", ".")) for x in details if re.fullmatch(r"\d{2}(?:[.,]\d+)?%", x)), None)
        rest = [x for x in details if x != "OB" and not re.fullmatch(r"\d{2}(?:[.,]\d+)?%", x)]
        name_low = N.strip_marks(base).lower()
        regions = [N.strip_marks(x).lower() for x in rest]
        cat = next((c for pat, c in WF_NAME_TYPES if re.search(pat, name_low)), None) or \
            next((c for c, words in WF_REGIONS.items() if any(r in words.split() or r in words for r in regions if len(r) > 3)), None) or \
            (lambda g: g if g != "other" else "scotch")(refine_category(base, "other"))   # "Camus XO" is a brandy
        old = [int(y) for x in rest for y in re.findall(r"\b(19\d\d|20\d\d)\b", x)]
        limited = bool(WF_LIMITED.search(" ".join(rest) + " " + base)) or bool(re.search(r"\b(19|20)\d\ds\b", " ".join(rest))) or \
            any(y < year - 8 for y in old) or any(re.fullmatch(r"\d{4}", x) for x in rest) or bool(re.search(r"\b(19|20)\d\d\b", base))
        out.append({"name": base, "printed": full, "category": cat, "year": year, "score_raw": score, "abv": abv,
                    "url": url, "ref": f"whiskyfun:{url}#{N.norm_name(full)}"[:500], "join_only": limited,
                    "weight": 1.0 if cat in ("scotch", "whiskey", "bourbon", "rye") else 0.8,
                    "reviewer": "Whiskyfun (Serge Valentin / Angus MacRaild)"})
    return out


def whiskyfun_year(url, default):
    m = re.search(r"archive(" + "|".join(WF_MONTHS) + r")(\d{2})", url)
    return 2000 + int(m.group(2)) if m else default


def harvest_whiskyfun(args):
    home_url = "https://www.whiskyfun.com/"
    home = fetch(home_url, refresh=args.refresh) or ""
    pages = [home_url] + [urllib.parse.urljoin(home_url, h) for h in
                          dict.fromkeys(re.findall(r'href="((?:https?://www\.whiskyfun\.com/)?archive[^"#]+\.html)"', home))]
    if args.limit:
        pages = pages[:args.limit]
    rows = []
    for i, u in enumerate(pages):
        page = home if u == home_url else fetch(u, refresh=args.refresh)
        if page:
            rows += whiskyfun_rows(page, u, whiskyfun_year(u, datetime.date.today().year))
        if (i + 1) % 50 == 0:
            print(f"  …{i + 1}/{len(pages)} pages, {len(rows)} official bottlings scored")
    core = sum(1 for r in rows if not r["join_only"])
    print(f"  {len(pages)} pages: {len(rows)} official-bottling notes ({core} core range, {len(rows) - core} limited)")
    return "whiskyfun", {"source_id": "whiskyfun", "scale": "critic100_harsh", "weight": 1.0, "origin": "bulk", "ref": "url",
                         "note": "Whiskyfun's scored notes on official bottlings (hard graders; their own curve). "
                                 "Limited releases only join bottles already in the catalog."}, rows


# Not harvested: The Rum Howler Blog (WordPress.com) answers scripts with a
# "Checking your browser" challenge, the same as IWSC's — lookups and `score` only.


HARVESTERS = {"bsa": harvest_bsa, "lonecaner": harvest_lonecaner, "ginisin": harvest_ginisin,
              "ssel": harvest_ssel, "disc": harvest_disc, "whiskyfun": harvest_whiskyfun}


def cmd_harvest(args):
    name, meta, rows = HARVESTERS[args.source](args)
    if not rows:
        sys.exit("Nothing harvested — has the page layout changed? (`inspect URL` shows what the parser sees.)")
    write_batch(name, meta, rows)
    print(f"Next: python3 ratings.py import-batch batches/{name}.json   (preview; --apply to write)")


# =============================================================================
# Curation: near-duplicate bottles, and merging two into one
# =============================================================================
# Words whose presence alone rarely makes another bottle ("Plantation 3 Stars
# White Rum" is Plantation 3 Stars); anything else one word apart is shown as
# "check" — a flavour, an age or a finish usually IS another bottle.
WEAK_WORDS = {"white", "silver", "original", "classic", "straight", "traditional", "premium", "blended", "the",
              "fine", "finest", "superior", "signature", "estate", "spirits", "distillery", "brand", "rhum", "ron",
              "london", "dry", "imported", "handcrafted", "craft", "small", "batch", "aged"}


def near_duplicates(products):
    """[(longer, shorter, extra_word, verdict)] for bottles one distinguishing word apart, same category family."""
    fam = lambda c: "whiskey" if c in WHISKEYS else CATEGORY_FAMILY.get(c, c)
    index = {}
    for p in products:
        w = frozenset(N.bottle_words(p.get("name_norm") or ""))
        if w:
            index.setdefault((fam(p.get("category")), w), []).append(p)
    out = []
    for p in products:
        w = frozenset(N.bottle_words(p.get("name_norm") or ""))
        if len(w) < 2:
            continue
        for extra in sorted(w):
            for q_ in index.get((fam(p.get("category")), w - {extra}), []):
                if q_["id"] != p["id"] and N.attrs_compatible(_prod_attrs(p), _prod_attrs(q_)):
                    # "Blended" is filler on a rum label but a different bottle
                    # in whiskey: Arlett Single Malt vs Arlett Blended, Early
                    # Times Bourbon vs Early Times American Blended.
                    weak = extra in WEAK_WORDS and not (extra == "blended" and fam(p.get("category")) == "whiskey")
                    verdict = "likely same" if weak or re.fullmatch(r"(19|20)\d\d", extra) else "check"
                    out.append((p, q_, extra, verdict))
    return out


def cmd_dupes(args):
    products = sb_all("/rest/v1/spirit_products?select=id,canonical_name,name_norm,category,age_years,abv,batch&order=id")
    counts = {}
    for r in sb_all("/rest/v1/spirit_reviews?select=product_id&order=id"):
        counts[r["product_id"]] = counts.get(r["product_id"], 0) + 1
    pairs = near_duplicates(products)
    pairs.sort(key=lambda t: (t[3] != "likely same", t[1]["canonical_name"].lower()))
    path = os.path.join(BATCH_DIR, "dupes.csv")
    os.makedirs(BATCH_DIR, exist_ok=True)
    import csv
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["verdict", "keep_id", "keep_name", "keep_reviews", "drop_id", "drop_name", "drop_reviews", "extra_word"])
        for longer, shorter, extra, verdict in pairs:
            # keep the one with more reviews behind it (ties: the shorter, plainer name)
            keep, drop = (longer, shorter) if counts.get(longer["id"], 0) > counts.get(shorter["id"], 0) else (shorter, longer)
            w.writerow([verdict, keep["id"], keep["canonical_name"], counts.get(keep["id"], 0),
                        drop["id"], drop["canonical_name"], counts.get(drop["id"], 0), extra])
    likely = sum(1 for t in pairs if t[3] == "likely same")
    print(f"{len(pairs)} pairs one word apart ({likely} likely the same bottle) → {os.path.relpath(path, REPO)}")
    for longer, shorter, extra, verdict in pairs[:args.show]:
        print(f"  [{verdict}] {shorter['canonical_name']}  ~  {longer['canonical_name']}   (+{extra})")
    print("Merge one with:  python3 ratings.py merge KEEP_ID DROP_ID   (preview; --apply to write)")


MERGE_TABLES = ["spirit_aliases", "spirit_barcodes", "spirit_lookup_queue", "inventory_items", "spirit_lookups", "spirit_reports"]


def cmd_merge(args):
    keep, drop = args.keep, args.drop
    rows = sb("GET", f"/rest/v1/spirit_products?select=id,canonical_name,name_norm&id=in.({q(keep)},{q(drop)})") or []
    by = {r["id"]: r for r in rows}
    if keep not in by or drop not in by or keep == drop:
        sys.exit("Both ids must be catalog bottles, and different.")
    revs = sb("GET", f"/rest/v1/spirit_reviews?select=id,product_id,source_id,review_year,medal,score_raw&product_id=in.({q(keep)},{q(drop)})") or []
    sig = lambda r: (r["source_id"], r["review_year"], r["medal"], None if r["score_raw"] is None else float(r["score_raw"]))
    held = {sig(r) for r in revs if r["product_id"] == keep}
    twins = [r["id"] for r in revs if r["product_id"] == drop and sig(r) in held]
    moving = [r["id"] for r in revs if r["product_id"] == drop and r["id"] not in twins]
    print(f"Keep  {by[keep]['canonical_name']}\nDrop  {by[drop]['canonical_name']}")
    print(f"  {len(moving)} reviews move over, {len(twins)} are the same review twice and go;"
          f" aliases, barcodes, bar bottles, lookups and reports follow; the dropped name becomes an alias.")
    if not args.apply:
        print("\nDry run — add --apply to write.")
        return
    for rid in twins:
        sb("DELETE", f"/rest/v1/spirit_reviews?id=eq.{rid}", prefer="return=minimal")
    if moving:
        sb("PATCH", f"/rest/v1/spirit_reviews?product_id=eq.{q(drop)}", {"product_id": keep}, prefer="return=minimal")
    for t in MERGE_TABLES:
        try:
            sb("PATCH", f"/rest/v1/{t}?product_id=eq.{q(drop)}", {"product_id": keep}, prefer="return=minimal")
        except SystemExit:               # a table this project never created (barcodes, the queue)
            print(f"  ({t} skipped: not in this database)")
    sb("PATCH", f"/rest/v1/spirit_products?parent_id=eq.{q(drop)}", {"parent_id": keep}, prefer="return=minimal")
    sb("DELETE", f"/rest/v1/spirit_summaries?product_id=eq.{q(keep)}", prefer="return=minimal")   # regenerated later
    sb("DELETE", f"/rest/v1/spirit_products?id=eq.{q(drop)}", prefer="return=minimal")
    add_alias(keep, by[drop]["canonical_name"], None)
    print("Merged.")


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

    s = sub.add_parser("harvest")
    s.add_argument("source", choices=sorted(HARVESTERS))
    s.add_argument("--years", type=int, nargs="*", help="competition years (default: all published)")
    s.add_argument("--limit", type=int, help="stop after this many reviews (a quick test run)")
    s.add_argument("--refresh", action="store_true", help="ignore the page cache")
    s.set_defaults(fn=cmd_harvest)

    s = sub.add_parser("import-batch")
    s.add_argument("file")
    s.add_argument("--join-only", action="store_true", help="only add scores to bottles already in the catalog")
    s.add_argument("--apply", action="store_true")
    s.set_defaults(fn=cmd_import_batch)

    s = sub.add_parser("dupes")
    s.add_argument("--show", type=int, default=25, help="how many pairs to print (all go to batches/dupes.csv)")
    s.set_defaults(fn=cmd_dupes)

    s = sub.add_parser("merge")
    s.add_argument("keep")
    s.add_argument("drop")
    s.add_argument("--apply", action="store_true")
    s.set_defaults(fn=cmd_merge)

    s = sub.add_parser("field")
    s.set_defaults(fn=cmd_field)

    s = sub.add_parser("reports")
    s.set_defaults(fn=cmd_reports)

    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
