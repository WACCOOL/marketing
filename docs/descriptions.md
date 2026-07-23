# Descriptions

Internal tool for drafting and reviewing product copy for upcoming (unreleased) products across the WAC Group brands. Lives at `/descriptions` in the web app, gated to internal users with the "product" feature (reps are refused).

One table row per product page (PPID group). Each row carries the product facts parsed from the seasonal master lists (images, finishes, sizes, CCTs, models, features), plus three pieces of copy: the marketing description, the HTML title, and the meta description, with a single review status per row (not written, generated, edited, approved).

## File slots

Six upload cards, one live file per slot (re-uploading replaces that slot's products wholesale):

| Slot | File | Role |
| --- | --- | --- |
| `dweled_master` | xlsx | Master list, one group per product (alpha name grouping) |
| `mf_master` | xlsx | Master list (hybrid grouping; Fans vs Luminaires split) |
| `schonbek_master` | xlsx | Master list, multiple sheets/years (alpha + numeric grouping) |
| `dweled_pptx` | pptx | Enrichment deck: feature bullets + hero images |
| `mf_pdf` | pdf | Enrichment: naming PDF feature bullets |
| `schonbek_pdf` | pdf | Image-only pages, rendered to an unassigned tray for manual attach |

All binary parsing happens in the browser (SheetJS, fflate, pdf.js). The Worker receives the archived raw file, downscaled images (content-hash keys, deduped), and a zod-validated JSON payload; it re-validates everything before writing. Product images are auth-gated (never public).

## Import flow

Commit is two-phase. A dry run first applies the model-base auto-relink (renames keep their copy), then reports new / updated / removed / orphaned; the UI asks for confirmation when products would disappear. Edited or approved copy is never deleted by a re-import: rows whose product vanished are orphaned and surfaced in the "Orphaned copy" card, where they can be attached to another product of the same file or deleted deliberately. The import summary reports how many descriptions were kept and how many were orphaned.

## Voice profiles and generation

"Edit brand voice & prompt" opens a modal with one tab per brand and collection (seven seeded profiles). Each tab holds the description prompt, a voice-guidance paragraph, and up to five reference products picked from the PIM whose existing copy is fed to the model as style reference. "Derive voice from references" drafts guidance from that copy but never saves it.

Generation runs in client-driven chunks with a progress notice and a stop button. Descriptions and metas are generated per product (meta from the just-generated or current edited description, clamped to 50 to 160 characters), with rotating structure directives and an avoid-list of recent openings so sibling products do not read alike. Approved rows are always skipped; rows with manual edits are only overwritten through the per-row Regenerate after an explicit confirm. HTML titles are never AI-generated: they come from deterministic per-brand formulas, with a manual override and a "Reset to formula" button.

## Export

Fully client-side from the loaded dataset: "Export ▾" in the batch card offers XLSX or CSV, scoped to the filtered rows, the selected rows, or approved rows only. Columns: Brand, Collection, Year, Name, Family, Product Type, Diffuser Type, Finishes, Length, Width, Height, CCT, Model Numbers, Features (one per line), Description, HTML Title, Meta Description, Status. A product with several sizes stays one row: each axis column collapses to a single value when it is uniform, otherwise it lists the values in tuple order joined by "; ", so the Nth entry of Length, Width and Height always belongs to the same size tuple.

## Database

Migration `supabase/migrations/0072_descriptions.sql` creates the tables (`desc_imports`, `desc_products`, `desc_product_images`, `desc_content`, `desc_voice_profiles`, `desc_enrichment`), RLS policies, and the seeded voice profiles. It must be applied to Supabase (dashboard SQL editor or CLI) before the deployed feature works; Davis applies it manually. Deploys ship via `pnpm deploy:web` (no Container changes).
