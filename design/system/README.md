# MemberSpark design system

## What it is

The shared look of every MemberSpark product: its colours, type, spacing and shapes as tokens, the components built on them, and the icons they use. It is drawn from the five mockups the owner approved on 2026-11-09 ([design/ideas/](../ideas/README.md)), and follows the fleet's [Site and Email Standards](https://github.com/derickca/agents-policy/blob/main/docs/site-standards.md) (agents-policy `docs/site-standards.md`) wherever it makes sense. Where a standard and the mockups disagree, it follows the standard and says so under **Where it departs**.

The light theme is dark blue on off-white, and each product takes one accent colour on top of it. Everything is named for MemberSpark: tokens and classes carry the `ms-` prefix, and the tagline is the token `--ms-brand-motto`.

## How a product uses it

1. **Link the stylesheets**, tokens first:
   ```html
   <link rel="stylesheet" href="tokens.css">
   <link rel="stylesheet" href="components.css">
   ```
   Copy both files into the product's build and serve them under its one build-set version with a long cache life. Alternatively, inline them in the page. Either way, the stylesheet never waits on a revalidation (site-standards Part 9, Recs 2 and 5).
2. **Or copy the tokens.** A product with its own stylesheet can take `tokens.css` alone and use the `--ms-` properties. A product with no CSS pipeline can read `tokens.json`, which holds the same values. The two files are kept in step by the test.
3. **Set the theme before first paint.** Light is the default. A visitor whose system asks for dark gets dark. `data-theme="light"` or `data-theme="dark"` on `<html>` forces one. Put the stored choice on `<html>` in a small head script that runs before the stylesheets, as [preview.html](preview.html) does (Part 9, Rec 1).
4. **Load the fonts.** Bricolage Grotesque for display and headings, and Figtree for body, from Google Fonts. Both have fallback stacks in the tokens. On a page that opens the site, preload the Bricolage Grotesque file or use `display=optional`, so the visitor never sees a late swap. Elsewhere `display=swap` is fine (Part 9, Rec 3).
5. **Pick the product.** Set `data-product="fundingspark"` (or `memberspark`, `galleryspark`, `tasksparkle`, `societyspark`, `grabaspot`) on `<html>`, and the page gets `--ms-color-accent` and `--ms-color-on-accent` in both themes. Without it the accent is MemberSpark's gold. The attribute works on a single element too, which is how [preview.html](preview.html) shows every product at once.
6. **Put `class="ms-page"` on `<body>`.** It sets the page's colours, font and text rhythm once. Then build with the components: `.ms-header`, `.ms-footer`, `.ms-btn`, `.ms-card`, `.ms-field`, `.ms-badge`, `.ms-table`, `.ms-show-all`, `.ms-tile`, `.ms-logo` and `.ms-chip`. [preview.html](preview.html) shows each one with its markup.
7. **Inline the icons.** Paste the SVG from `icons/` into the page and size it with CSS. It draws in `currentColor`, so it follows the text colour and the theme.

## The rules

- **Every control stands at least 44px tall**: buttons, tabs, icon buttons, fields, Show all, the brand link and footer links. Icon buttons are 44px square. A small-looking control reaches 44px by padding (Part 10, Rec 1; Part 2, Rec 3).
- **Text rhythm is stated once**: body line height 1.375, a 1em gap between paragraphs, body text never under 16px, and a 46rem reading column (`--ms-size-reading`) (Part 10, Rec 2).
- **Every colour pair used for text clears 4.5:1 in both themes.** The pairs are listed in `tokens.json` under `textPairs`, and the test measures each one. Gold `#f5a623` is for fills only, because it is about 2:1 on white (Part 10, Rec 5).
- **Every edge that shows where a control is clears 3:1 in both themes**: the border of a field or a secondary button, and the focus ring, against the colours on each side of it (WCAG 2.1 SC 1.4.11). The pairs are listed in `tokens.json` under `controlPairs`. `--ms-color-line-strong` draws control borders; `--ms-color-line` is for decorative rules and card edges only (Part 10, Rec 5; MemberSpark#47).
- **The main button, the logo tile and the chips use the product's accent**, set by `data-product`. The second button stays outlined. An accent is a fill and never the colour of text on the page (`.ms-spark` is a drawing, not text). Each accent's `on-accent` colour clears 4.5:1 on it in both themes, and each dark accent clears 3:1 against the dark surface and page (Part 10, Rec 5).
- **The seven-colour bar is the family's splash colours.** `--ms-brand-stripe-1` to `-7` are for charts, illustrations, celebrations, dividers and empty states. Any extra button or tag drawn from them is each product's own choice; the system does not fix one (Part 3; Part 10, Rec 5).
- **Colour comes only from tokens.** `components.css` holds no raw colour, so the light and dark themes need nothing of their own (Part 10, Rec 5, both themes).
- **Header**: one row of 56–80px holds, from left, the brand, then the tabs in words, then the right-hand group with no gaps. The group runs Help, Feedback, dark toggle, account, settings. On a phone a second row carries the full tab set, and there is never an overflow menu. On a narrow phone the product name gives way with an ellipsis, never the buttons (Part 2, The rows, defined; Rec 1).
- **The Help door is Lucide `circle-question-mark`**, a 20px drawing in a 44px circle, with a spoken name. Feedback is `square-pen` (Part 2, Recs 2 and 3; Part 7).
- **The theme button cycles Default, Light, Dark** and shows the face of the mode a click brings: `monitor`, `sun`, `moon` (Part 2, Rec 2).
- **Icons are Lucide, one pinned version** (lucide-static 1.68.0, the version GallerySpark uses), vendored as SVG in `currentColor` with the ISC licence. Nothing is fetched from a CDN. Each file's hash is pinned in `icons/manifest.json` (Part 2, Rec 2).
- **Footer closing block**: the link line Terms · Help · Feedback · About, then the seven-stripe bar, then "MemberSpark © year", "By MemberSpark, a BC non-profit" with the flag after the word MemberSpark, then the motto. The block follows the site's alignment, using `.ms-footer--center` on a centred site (Part 3).
- **The flag is an SVG at text height, never an emoji**, because Windows has no flag glyphs and shows the letters "CA" instead (Part 3; MemberSpark#33).
- **Terms alone**: the header and footer carry no Privacy link. Privacy is reached from the top of the Terms of Use page (Part 2, Rec 7; Part 3).
- **Lists of people show 10 at a time**, and Show all renders the whole list (Part 10, Rec 5).
- **One filled primary button per view**, and a danger button names what it destroys, e.g. "Remove this member" (Part 10, Rec 5).
- **A field's error stands beside that field**, in plain words: `.ms-error`, with `aria-invalid` on the input (Part 10, Rec 5).
- **A page has its own title, meta description and canonical address**. `preview.html` carries the first two. It is not a public page, so it has no canonical address (Part 5, Page basics).

## Where it departs

- **Line height 1.375, not the mockups' 1.5–1.6.** The standard wins (Part 10, Rec 2).
- **The tagline is "Crafted by makers, for makers."**, not the older wording in the standard's Part 3 sample. The owner ruled the MemberSpark tagline on 2026-11-09 (`docs/Mission and Tagline.md`). Bringing the standard up to date is filed as agents-policy#39. The motto is the single token `--ms-brand-motto`, so a change is one line.
- **The footer bar is named for what it is.** The seven-stripe bar of Part 3 is `.ms-footer__bar`, and its colours are `--ms-brand-stripe-1` to `-7`. They carry the same seven colours the standard lists. Only the names look forward.
- **The Help glyph keeps Lucide's ring.** GallerySpark removes the ring because its 44px button has a bordered circle. `.ms-icon-btn` has no border, so the ring is not doubled (Part 2, Rec 2).
- **The epic asked for fonts with `display=swap`.** Part 9, Rec 3 asks for a preload or `display=optional` on the pages that open a site. This system follows the standard, and keeps `swap` for preview.html and other inner pages (Part 9, Rec 3).
- **The light theme is dark blue on off-white, not black on white.** Page `#faf8f3`, text `#142a5c`, primary `#1d3a8a`. The owner approved it on 2026-11-09 (DECISIONS.md). Every text pair still clears 4.5:1 and `--ms-color-line-strong` still clears 3:1 on the surface, page and muted surface (Part 10, Rec 5).
- **GrabASpot's dark accent is `#168075`, not its logo teal `#0f6e64`.** The logo teal is 2.56:1 on the dark surface, under the 3:1 floor for a control. The lighter teal clears it and still carries white text at 4.80:1. GrabASpot's light accent and its own logo are unchanged (Part 10, Rec 5).
- **The dark theme is this system's own.** The mockups show one dark card. The rest of the dark palette was drawn to match it, and every text pair still clears 4.5:1 (Part 10, Rec 5).

## What is in this folder

- `tokens.json`: every token, with light and dark colours and shadows, each product's accent (`products`), the brand name, motto and stripe colours, the list of text pairs and the list of control pairs.
- `tokens.css`: the same tokens as `--ms-` custom properties, in four theme blocks, then one block per product and theme for `data-product`. The four are the light `:root`, the `data-theme="light"` override, the `prefers-color-scheme: dark` block, and the `data-theme="dark"` override. Change `tokens.json` and `tokens.css` together.
- `components.css`: the components, built only on tokens.
- `icons/`: `lucide/` holds the vendored Lucide subset and its LICENSE. `manifest.json` records the version, the npm integrity, each icon's use and its sha256. `flag-ca.svg` and `spark.svg` are MemberSpark's own drawings.
- `preview.html`: every token and component on one page, in light and dark. Open it from disk; `?theme=dark` or `?theme=light` opens it in one theme.
- The check is `tests/design-system-check.ps1`, and the paired suite `tests/spec-check.ps1` runs it. It checks the tokens, text and control contrast, the 44px floor, the header heights, the icon hashes, the preview and this README.
