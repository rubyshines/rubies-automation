Turn a raw product-shoot folder into live, correctly ordered Shopify product images.

**Trigger phrases**: `/process-shoot <dir>`, "process the new product images," "new shoot in Downloads."

## What it is

The end-to-end pipeline for professional product photography: fix filenames to the live
convention, composite onto the standard pastel canvas, synthesize missing colorways when
needed, and replace the product media on Shopify in the right order.

**Division of labor — this is deliberate and keeps the tool free to run:**
- **Scripts do everything mechanical** (image processing, GraphQL). They are deterministic,
  re-runnable, and cost nothing.
- **Claude does the judgment in-session** (no `aiClient`/API calls): identifying garments
  visually, catching mislabeled files, matching recolor hues, QAing composition, and asking
  Jamie the decisions that are his. Never build an API-charging automation for these steps.

## The scripts (all local-only, never deployed)

| Script | Does | Contract |
|---|---|---|
| [scripts/process-product-images.js](../../scripts/process-product-images.js) | Parse/fix filenames → live convention, dimension-aware composite onto 11:12 pastel canvas | `--src DIR [--out DIR] [--width 2000]` → PNGs + `manifest.json` |
| [scripts/recolor-product-images.js](../../scripts/recolor-product-images.js) | Synthesize a colorway via luminance histogram matching against a reference image | `--ref REF.png --color PNK --out DIR inputs...` |
| [scripts/upload-product-images.js](../../scripts/upload-product-images.js) | Staged upload → replace old numbered media (full-res backup first) → enforce order | `--dir PROCESSED_DIR [--execute]` — **dry-run by default** |

sharp resolves from the rubies-utilities checkout (not a dependency here — keeps it out of
the Railway deploy). Run scripts from a worktree with `node --env-file=.env` for Shopify creds.

Conventions (canvas ratio, background palettes, shoot→site code map like ESB→SPB and
Neomi→GF, size-token rules) live **in the process script**, not here. The `PRODUCTS`
gid map lives in the upload script — extend both when new codes appear.

## Workflow

1. **Orient.** Inventory the source dir (`sips -g pixelWidth` per file). Parse every filename;
   list product codes, colors, frame numbers, anomalies (typos, mixed separators, missing size
   tokens are normal — the script tolerates them; flag anything unparseable).

2. **Map codes to products — with your eyes, not just names.** Pull the catalog
   (`get_product_catalog`) and each candidate product's current media filenames (the filename
   prefixes on live images are the source of truth for codes). Then **look at a few source
   images per code** (make small previews with `sips -Z 400`, Read them) and confirm the
   garment actually matches the product. *Lesson learned: a shoot arrived with CKY_PNK/CKY_SND
   files that were recolors of the wrong garment — Cheeky only comes in black; the "pink Cheeky"
   was really the Sassy. Filenames lie; images don't.* Unknown or mismatched codes → show Jamie
   a thumbnail and ask.

3. **Missing colorways.** If a product sells colors the shoot lacks, offer placeholder recolors:
   run the recolor script with a reference image that carries the TARGET hue — prefer a live
   site image of a same-palette product (flattened references work; the script masks by
   background distance). Visually compare the result against the live colorway before accepting.
   Placeholders are stopgaps: label them as such and park replacing them with real photography.

4. **Process.** Run the process script (`--width 2000`). Read its log: every image prints its
   measured content margins and chosen treatment (`center` vs `bleed:<edges>`). Then **visually
   QA every bleed-treated output** plus a couple of centered ones — bleed shots must preserve
   the photographer's framing (docked where the source was docked), centered shots must float
   at 80% with even margins.

5. **Contact sheet.** Build an Artifact contact sheet: per product, the current live images
   beside the new set in upload order, with treatment/background annotations. Jamie reviews
   here — this is the approval surface.

6. **Decisions that are Jamie's** (ask, don't assume, unless he's already answered this
   session): replace vs append for colors that already have photos (default: replace numbered
   shots, always keep `-char` illustrations), anything flagged in steps 2–4.

7. **Upload.** Dry-run first and read the plan carefully: what's uploaded, deleted, kept, and
   the final order (per color: 01..NN then char; colors in the product's existing order). On
   explicit go-ahead, `--execute`. The script backs up deleted media full-res to
   `<src>/../replaced-originals/` before deleting. Paste the FINAL STATE listing back to Jamie
   as verification. Re-runs are idempotent (it replaces its own previous uploads cleanly).

8. **Close out.** Keep `generated-sources/` (synthetic recolor inputs) beside the shoot for
   future reprocessing. If scripts changed, commit via worktree PR. If a new product code or
   convention emerged, update the script maps in the same change.

## Guardrails

- **Never `--execute` without showing Jamie the dry-run plan and getting a yes** (deleting
  live product images is destructive even with backups).
- Customer-visible placeholders (recolors) must be brand-quality — when in doubt, show Jamie
  before uploading.
- Don't add AI API calls to this pipeline. If a step seems to need model judgment, it belongs
  in-session, in this skill's workflow — not in a script.
