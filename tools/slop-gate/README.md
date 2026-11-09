# The slop gate — vendored copy

Vendored from derickca/certifiablemedia, `tools/slop-gate`, at commit
4ebc100 (that repo's issue #89). The set — `slop-gate.py`,
`watchlist.txt`, `watchlist-exemptions.json`, `gate-record.json` —
belongs together; the README in the source repo describes the gate's
design (scope rules S1/S2: a hit in the service's own words fails, a
hit inside a verbatim quote or prescribed text is recorded and does
not fail the page; unit rule C1: furniture is scanned once, as
furniture).

How TaskSparkle runs it: the smoke tier of `tests/local-checks.mjs`
stages this tree's extracted reader-facing text — the pages its list
names, staged as they stand, and the string literals of the
text-bearing files, staged as text pages of their own — and runs
`slop-gate.py check` over the staging. A hit on a ruled entry in the
service's own words fails the smoke tier. The watchlist's
`[proposed]` section is reported and never fails: those entries wait
for the owner's ruling in the source. The extraction reads text only,
never raw files, so a watchlist word in a code comment is never read.

Rules for this copy:

- `watchlist.txt` is never edited here. The list's source of record
  is the Site and Email Standards; changes land in the copy-from
  source (certifiablemedia) and are re-copied from there.
- `watchlist-exemptions.json` is this repo's own record. It opens
  with the source's entries as vendored; this repo's exemptions
  stand after them, each naming the exact page and sentence it
  covers and its reason — literal uses of the sense-limited entry
  `key` (a real agent key, a real cryptographic key), which the
  list's sources exclude. An exemption covers that line on that
  page only; the same words in a new sentence still block.
- The gate's second layer — the antagonistic text review of changed
  text, by a reviewer who did not write it — is wired in
  CONTRIBUTING.md under "Text changes".
