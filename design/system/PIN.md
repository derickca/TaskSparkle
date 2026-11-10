# Pinned copy — do not edit here

This folder is a pinned copy of the MemberSpark design system, taken
from derickca/MemberSpark, `design/system/`, at commit
b142cae ("Design system: the Spark family look (#59)"), on 2026-11-09,
for TaskSparkle's adoption of the Spark family look (MemberSpark#61,
this repo's issue #59).

Every file in this folder is byte for byte the source's, except this
note. Token changes are made in MemberSpark and copied in again as a
new pin; nothing here is edited in place.

How TaskSparkle uses it:

- `public/tokens.css` is the served copy of `tokens.css` from this
  folder. The local checks hold the two byte for byte equal.
- `public/styles.css` imports that copy and the standard look — this
  product's default of its eight looks — reads its colours from the
  `--ms-` tokens, with `data-product="tasksparkle"` set on the root
  element. The other seven looks keep their own palettes.
- The product mark in `public/icons/` is the family's spark
  (`icons/spark.svg` in this folder) on a tile of the product accent.
- The sign-in pages (worker/auth.js) carry a small mirrored subset of
  the token values inline, because their content policy allows no
  stylesheet file; the local checks hold the subset equal to
  `tokens.css`.
