#!/usr/bin/env python3
"""The slop gate for certifiable.media (issue #89).

Layer 1 (this script): scan the built site's extracted reader-facing
text, page by page, against the vendored watchlist in watchlist.txt.
One hit in a page's own words fails the gate, naming the page and the
quoted sentence. Entries in the watchlist's [proposed] section are
carried and reported but never enforced — they stand PROPOSED,
unruled, in the audit file they were transcribed from, and the
distinction is kept here exactly as that file states it. A hit inside a verbatim quote is recorded against its
source and never fails the page (consolidated scope rule S2). Header,
footer and navigation text is furniture: it is scanned once per run,
as furniture, not once per page (unit rule C1). Stamp lines ("Last
updated ...", "Last verified ...") are prescribed text: recorded, not
failed (S1). Em-dash density is measured and reported only; it never
fails the gate.

Layer 2 (machinery here, judgement by an agent): `bundle` prepares the
changed pages' extracted text as a review packet for the antagonistic
text review (derickca/agents-policy, skills/claude/antagonistic-text-
review); `record` writes the review's verdicts into gate-record.json;
`check` blocks the publish while a FAIL verdict stands against a
page's current text, byte for byte (by hash). The deploying agent runs
the review itself, per the skill — never the agent that wrote the text.

Modes:
  check   --dist dist [--record gate-record.json] [--json out.json]
          Layer 1 over every staged page + the Layer 2 FAIL block.
          This is the deploy-path mode: exit 1 stops the publish.
  sweep   --dist dist [--json out.json]
          Layer 1 over every page, changed or not, scan only — the
          monthly sweep. Same engine, no record enforcement.
  bundle  --dist dist --base <git-ref> --out DIR [--prompt prompt.md]
          Prepare the changed pages' review packet.
  record  --bundle DIR --verdicts FILE [--record gate-record.json]
          Verdicts file: one line per page, "<page> <PASS|FAIL>".
  fingerprint --entry E --sentence S
          Print the exemption fingerprint for one sentence, to paste
          into watchlist-exemptions.json with its reason.

Exit codes: 0 = gate passes, 1 = gate fails, 2 = could not run.
Stdlib only. Python 3.12 (the deploy runner's version).
"""

import argparse
import hashlib
import json
import re
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
EM_DASH = "\u2014"
STAMP_RE = re.compile(r"^Last (updated|verified)\b", re.IGNORECASE)
SKIP_TAGS = {"script", "style", "noscript", "template", "svg", "head"}
FURNITURE_TAGS = {"header", "footer", "nav"}
QUOTE_TAGS = {"blockquote", "q"}
BLOCK_TAGS = {
    "p", "div", "section", "article", "li", "ul", "ol", "tr", "table",
    "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "figure",
    "figcaption", "button", "a", "span", "td", "th", "label", "option",
    "title",
}


def norm(text):
    """Normalize for matching: case, curly quotes, whitespace."""
    text = text.replace("\u2019", "'").replace("\u2018", "'")
    text = text.replace("\u201c", '"').replace("\u201d", '"')
    return re.sub(r"\s+", " ", text.lower()).strip()


def split_sentences(chunk):
    parts = re.split(r"(?<=[.!?])\s+", chunk.strip())
    return [p.strip() for p in parts if p.strip()]


class PageText(HTMLParser):
    """Extract a page's text into buckets: own, head, quotes, furniture."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.own = []        # the page's own prose chunks
        self.head = []       # title + meta description + og text
        self.quotes = []     # verbatim-quote chunks (recorded, not failed)
        self.furniture = []  # header / footer / nav chunks
        self._stack = []     # (tag, bucket) for open bucket elements
        self._skip = 0
        self._buf = []

    def _bucket(self):
        for _tag, bucket in reversed(self._stack):
            if bucket:
                return bucket
        return "own"

    def _flush(self):
        text = re.sub(r"\s+", " ", "".join(self._buf)).strip()
        self._buf = []
        if not text:
            return
        bucket = self._bucket()
        getattr(self, bucket).append(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in SKIP_TAGS and tag != "head":
            self._skip += 1
            return
        if tag == "head":
            self._skip += 1
            return
        if tag == "meta":
            name = (attrs.get("name") or attrs.get("property") or "").lower()
            if name in ("description", "og:description", "og:title",
                        "twitter:description", "twitter:title"):
                content = (attrs.get("content") or "").strip()
                if content:
                    self.head.append(content)
            return
        if tag == "title":
            self._stack.append((tag, "head"))
            return
        if tag in FURNITURE_TAGS:
            self._flush()
            self._stack.append((tag, "furniture"))
            return
        if tag in QUOTE_TAGS:
            self._flush()
            self._stack.append((tag, "quotes"))
            return
        if tag in BLOCK_TAGS:
            self._flush()
            self._stack.append((tag, None))

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS or tag == "head":
            self._skip = max(0, self._skip - 1)
            return
        if self._stack and self._stack[-1][0] == tag:
            self._flush()
            self._stack.pop()
        elif tag in BLOCK_TAGS or tag in FURNITURE_TAGS or tag in QUOTE_TAGS:
            self._flush()

    def handle_data(self, data):
        if self._skip:
            return
        self._buf.append(data)

    def finish(self):
        self._flush()
        # Stamp lines are prescribed text wherever they stand: move
        # them out of the page's own prose (recorded, never failed).
        prescribed, kept = [], []
        for chunk in self.own:
            for sent in split_sentences(chunk):
                (prescribed if STAMP_RE.match(sent) else kept).append(sent)
        self.prescribed = prescribed
        self.own = kept
        return self


def extract_page(path):
    parser = PageText()
    parser.feed(path.read_text(encoding="utf-8", errors="replace"))
    return parser.finish()


def page_text_hash(page):
    joined = "\n".join(page.head + page.own)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


class Entry:
    def __init__(self, raw, proposed=False):
        self.raw = raw
        self.proposed = proposed
        self.sense_limited = raw.startswith("~")
        text = raw[1:] if self.sense_limited else raw
        self.sentence_start = text.startswith("^")
        if self.sentence_start:
            text = text[1:]
        self.is_regex = text.startswith("re:")
        self.text = text[3:] if self.is_regex else text
        self.key = norm(self.text)  # exemption fingerprints key on this
        if self.is_regex:
            self.pattern = re.compile(self.text, re.IGNORECASE)
        elif self.sentence_start:
            self.pattern = re.compile(
                r"(?:^|[.!?]\s+)" + re.escape(norm(self.text)) +
                r"(?![a-z0-9])", re.IGNORECASE)
        else:
            self.pattern = re.compile(
                r"(?<![a-z0-9])" + re.escape(norm(self.text)) +
                r"(?![a-z0-9])", re.IGNORECASE)

    def find(self, sentence_norm):
        m = self.pattern.search(sentence_norm)
        return m


def load_watchlist(path):
    entries = []
    proposed = False
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            # Entries under [proposed] are carried and reported but
            # never enforced: they wait for the owner's ruling, and
            # the distinction is the audit file's own.
            proposed = line.lower() == "[proposed]"
            continue
        entries.append(Entry(line, proposed=proposed))
    return entries


def load_exemptions(path):
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    out = {}
    for item in data:
        out[(item["page"], item["entry"],
             item["sentence_sha256"])] = item.get("reason", "")
    return out


def sentence_fingerprint(sentence):
    return hashlib.sha256(norm(sentence).encode("utf-8")).hexdigest()


def scan_sentences(sentences, entries):
    """Return [(entry, sentence)] for every match."""
    hits = []
    for sent in sentences:
        snorm = norm(sent)
        for entry in entries:
            if entry.find(snorm):
                hits.append((entry, sent))
    return hits


def scan_dist(dist, entries, exemptions):
    """Layer 1 over every .html page under dist. Returns a result dict."""
    pages = sorted(dist.rglob("*.html"))
    result = {"pages": [], "furniture_hits": [], "failing_pages": []}
    furniture_chunks = []
    for path in pages:
        rel = path.relative_to(dist).as_posix()
        page = extract_page(path)
        furniture_chunks.extend(page.furniture)
        own_sentences = []
        for chunk in page.head + page.own:
            own_sentences.extend(split_sentences(chunk))
        quote_sentences = []
        for chunk in page.quotes:
            quote_sentences.extend(split_sentences(chunk))
        hits, exempted, proposed_hits = [], [], []
        for entry, sent in scan_sentences(own_sentences, entries):
            if entry.proposed:
                proposed_hits.append({"entry": entry.raw, "sentence": sent})
                continue
            fp = (rel, entry.key, sentence_fingerprint(sent))
            if fp in exemptions:
                exempted.append({"entry": entry.raw, "sentence": sent,
                                 "reason": exemptions[fp]})
            else:
                hits.append({"entry": entry.raw, "sentence": sent,
                             "sense_limited": entry.sense_limited})
        quote_hits = [{"entry": e.raw, "sentence": s}
                      for e, s in scan_sentences(quote_sentences, entries)]
        words = len(" ".join(page.head + page.own).split())
        dashes = " ".join(page.head + page.own).count(EM_DASH)
        result["pages"].append({
            "page": rel,
            "text_sha256": page_text_hash(page),
            "hits": hits,
            "proposed_hits": proposed_hits,
            "exempted": exempted,
            "quote_hits": quote_hits,
            "prescribed_lines": page.prescribed,
            "words": words,
            "em_dashes": dashes,
            "em_dash_per_1000": round(1000.0 * dashes / words, 2) if words else 0.0,
        })
        if hits:
            result["failing_pages"].append(rel)
    # Furniture is scanned once per run, as furniture (C1).
    furn_sentences = []
    for chunk in furniture_chunks:
        furn_sentences.extend(split_sentences(chunk))
    seen = set()
    for entry, sent in scan_sentences(furn_sentences, entries):
        if (entry.key, sentence_fingerprint(sent)) in seen:
            continue
        seen.add((entry.key, sentence_fingerprint(sent)))
        result["furniture_hits"].append(
            {"entry": entry.raw, "sentence": sent})
    return result


def load_record(path):
    if path and Path(path).exists():
        return json.loads(Path(path).read_text(encoding="utf-8"))
    return {"version": 1, "verdicts": []}


def blocked_by_record(result, record):
    """Pages whose current text carries a Layer 2 FAIL verdict."""
    fail = {(v["page"], v["text_sha256"])
            for v in record.get("verdicts", []) if v["verdict"] == "FAIL"}
    return [p["page"] for p in result["pages"]
            if (p["page"], p["text_sha256"]) in fail]


def print_report(result, blocked):
    for p in result["pages"]:
        for h in p["hits"]:
            print(f'HIT {p["page"]}: "{h["entry"]}" in: {h["sentence"]}')
        for h in p.get("proposed_hits", []):
            print(f'PROPOSED-HIT (not ruled, never fails) {p["page"]}: '
                  f'"{h["entry"]}" in: {h["sentence"]}')
        for h in p["quote_hits"]:
            print(f'QUOTE-HIT (recorded, not failed) {p["page"]}: '
                  f'"{h["entry"]}" in: {h["sentence"]}')
        for h in p["exempted"]:
            print(f'EXEMPTED {p["page"]}: "{h["entry"]}" — {h["reason"]}')
        print(f'EM-DASH {p["page"]}: {p["em_dashes"]} dashes, '
              f'{p["em_dash_per_1000"]} per 1000 words (report only)')
    for h in result["furniture_hits"]:
        print(f'FURNITURE-HIT (recorded, reviewed as furniture): '
              f'"{h["entry"]}" in: {h["sentence"]}')
    for page in blocked:
        print(f"REVIEW-FAIL {page}: the gate record carries a FAIL "
              f"verdict against this page's current text")
    total_words = sum(p["words"] for p in result["pages"])
    total_dashes = sum(p["em_dashes"] for p in result["pages"])
    density = round(1000.0 * total_dashes / total_words, 2) if total_words else 0.0
    print(f"EM-DASH site: {total_dashes} dashes over {total_words} words, "
          f"{density} per 1000 words (report only, never fails)")


def summary_line(failing):
    if failing:
        return "Slop gate: FAIL — " + ", ".join(sorted(set(failing)))
    return "Slop gate: PASS"


def run_scan(args, enforce_record):
    dist = Path(args.dist)
    if not dist.is_dir():
        print(f"slop-gate: dist directory not found: {dist}", file=sys.stderr)
        return 2
    entries = load_watchlist(HERE / "watchlist.txt")
    exemptions = load_exemptions(HERE / "watchlist-exemptions.json")
    result = scan_dist(dist, entries, exemptions)
    blocked = []
    if enforce_record:
        record = load_record(args.record or (HERE / "gate-record.json"))
        blocked = blocked_by_record(result, record)
    print_report(result, blocked)
    failing = result["failing_pages"] + blocked
    print(summary_line(failing))
    if args.json:
        out = dict(result)
        out["review_blocked"] = blocked
        out["summary"] = summary_line(failing)
        Path(args.json).write_text(json.dumps(out, indent=2),
                                   encoding="utf-8")
    return 1 if failing else 0


ALL_PAGES_TRIGGERS = {
    "CONTENT_AUTHORITY.json", "scripts/sync-meta.py", "build-blog.py",
    "scripts/build-splashes.py", "scripts/stage-dist.py",
}


def changed_sources(base, repo):
    def git(*argv):
        return subprocess.run(["git", "-C", str(repo), *argv],
                              capture_output=True, text=True, check=True
                              ).stdout.splitlines()
    names = set(git("diff", "--name-only", base))
    names.update(git("ls-files", "--others", "--exclude-standard"))
    return sorted(n for n in names if n)


def run_bundle(args):
    dist = Path(args.dist)
    repo = Path(args.repo or REPO)
    out = Path(args.out)
    if not dist.is_dir():
        print(f"slop-gate: dist directory not found: {dist}", file=sys.stderr)
        return 2
    changed = changed_sources(args.base, repo)
    all_pages = any(c in ALL_PAGES_TRIGGERS for c in changed)
    page_names, strings_files, ignored = set(), [], []
    for c in changed:
        if c.endswith(".html") and "/" not in c:
            page_names.add(c)
        elif c.startswith("blog/") and c.endswith(".md"):
            slug = Path(c).stem + ".html"
            if (dist / "blog" / slug).exists():
                page_names.add(f"blog/{slug}")
            else:
                ignored.append(c)
        elif c.startswith("functions/"):
            strings_files.append(c)
        elif c in ALL_PAGES_TRIGGERS:
            pass
        else:
            ignored.append(c)
    if all_pages:
        page_names = {p.relative_to(dist).as_posix()
                      for p in dist.rglob("*.html")}
    out.mkdir(parents=True, exist_ok=True)
    manifest = {"base": args.base, "pages": {}, "strings_files": strings_files,
                "ignored_sources": ignored, "all_pages": all_pages}
    furniture = []
    packet_pages = []
    for rel in sorted(page_names):
        path = dist / rel
        if not path.exists():
            continue
        page = extract_page(path)
        furniture.extend(page.furniture)
        text = "\n\n".join(page.head + page.own)
        (out / (rel.replace("/", "__") + ".txt")).write_text(
            text + "\n", encoding="utf-8")
        manifest["pages"][rel] = page_text_hash(page)
        packet_pages.append(f"## Page: {rel}\n\n{text}")
    if strings_files:
        literals = []
        for rel in strings_files:
            src = (repo / rel).read_text(encoding="utf-8", errors="replace")
            for m in re.finditer(r"""['"`]([^'"`]{25,})['"`]""", src):
                if " " in m.group(1):
                    literals.append(f"[{rel}] {m.group(1)}")
        (out / "changed-strings.txt").write_text(
            "\n".join(literals) + "\n", encoding="utf-8")
    (out / "furniture.txt").write_text(
        "\n".join(dict.fromkeys(furniture)) + "\n", encoding="utf-8")
    head = (Path(args.prompt).read_text(encoding="utf-8")
            if args.prompt else
            "Hand this packet to a reviewing agent that did not write "
            "the text, with the prompt at derickca/agents-policy "
            "skills/claude/antagonistic-text-review/prompt.md, the three "
            "blanks filled from the sections below.\n")
    packet = [head, "\n---\n",
              "The text under review:\n",
              "\n\n".join(packet_pages) or "(no changed pages)",
              "\n---\n",
              "Where its facts live: the certifiablemedia repo — the "
              "page sources and CONTENT_AUTHORITY.json (the owner-"
              "approved source for public wording) and the code under "
              "functions/ for behaviour claims.\n",
              "\n---\n",
              "The prescribed parts of this text, exempt as scoped: "
              "the site furniture in furniture.txt (header, footer, "
              "closing block), stamp lines (\"Last updated ...\", "
              "\"Last verified ...\") wherever they stand, and wording "
              "standing as APPROVED in CONTENT_AUTHORITY.json.\n"]
    (out / "packet.md").write_text("".join(packet), encoding="utf-8")
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2),
                                       encoding="utf-8")
    print(f"Bundle written to {out}: {len(manifest['pages'])} pages, "
          f"{len(strings_files)} strings files, base {args.base}")
    return 0


def run_record(args):
    bundle = Path(args.bundle)
    manifest = json.loads((bundle / "manifest.json").read_text(
        encoding="utf-8"))
    record_path = Path(args.record or (HERE / "gate-record.json"))
    record = load_record(record_path)
    verdicts = []
    for line in Path(args.verdicts).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        page, verdict = line.rsplit(None, 1)
        verdicts.append((page, verdict.upper()))
    import datetime
    today = datetime.date.today().isoformat()
    for page, verdict in verdicts:
        if page not in manifest["pages"]:
            print(f"slop-gate: page not in bundle manifest: {page}",
                  file=sys.stderr)
            return 2
        if verdict not in ("PASS", "FAIL"):
            print(f"slop-gate: bad verdict for {page}: {verdict}",
                  file=sys.stderr)
            return 2
        record["verdicts"] = [
            v for v in record["verdicts"]
            if not (v["page"] == page
                    and v["text_sha256"] == manifest["pages"][page])]
        record["verdicts"].append({
            "page": page, "text_sha256": manifest["pages"][page],
            "verdict": verdict, "date": today,
            "bundle": str(bundle)})
    record_path.write_text(json.dumps(record, indent=2) + "\n",
                           encoding="utf-8")
    (bundle / "verdicts.txt").write_text(
        "".join(f"{p} {v}\n" for p, v in verdicts), encoding="utf-8")
    print(f"Recorded {len(verdicts)} verdicts in {record_path}")
    return 0


def main():
    ap = argparse.ArgumentParser(description="The slop gate.")
    sub = ap.add_subparsers(dest="mode", required=True)
    for name in ("check", "sweep"):
        p = sub.add_parser(name)
        p.add_argument("--dist", required=True)
        p.add_argument("--record")
        p.add_argument("--json")
    p = sub.add_parser("bundle")
    p.add_argument("--dist", required=True)
    p.add_argument("--base", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--repo")
    p.add_argument("--prompt")
    p = sub.add_parser("record")
    p.add_argument("--bundle", required=True)
    p.add_argument("--verdicts", required=True)
    p.add_argument("--record")
    p = sub.add_parser("fingerprint")
    p.add_argument("--entry", required=True)
    p.add_argument("--sentence", required=True)
    args = ap.parse_args()
    if args.mode == "check":
        return run_scan(args, enforce_record=True)
    if args.mode == "sweep":
        return run_scan(args, enforce_record=False)
    if args.mode == "bundle":
        return run_bundle(args)
    if args.mode == "record":
        return run_record(args)
    if args.mode == "fingerprint":
        entry = Entry(args.entry)
        print(json.dumps({
            "entry": entry.key,
            "sentence_sha256": sentence_fingerprint(args.sentence),
            "sentence": args.sentence}, indent=2))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
