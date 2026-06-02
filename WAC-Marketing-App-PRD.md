# WAC Group Marketing App — Product Requirements Document

**Owner:** Davis Rothenberg
**Status:** Draft v3
**Last updated:** 2026-06-02
**Purpose:** Reference doc for building the app with Claude Code / Cursor. Written to be implementation-ready and incrementally buildable.

---

## 1. Summary

A web app for the WAC Group marketing team (and external reps) that automates four recurring creative/marketing production tasks, stores every output to a searchable shared asset library, and pulls authoritative product data + assets from existing systems (Sales Layer PIM, Ziflow DAM).

The four tools, in build order:

1. **UTM & QR Code Generator** (Phase 1 — MVP)
2. **Application Image Generator** — fixtures placed to-scale in rooms (Phase 2)
3. **PPT Generator** and **Simple Design Layouts** (Phase 3 — either order)

Everything is gated by an account system: internal WAC Group staff (corporate-domain email) get automatic access to all assets; external reps are manually verified and see only their own or explicitly shared assets.

### Goals
- Cut time spent on repetitive marketing production (link tagging, decks, application imagery, one-off layouts).
- Keep all output **on-brand** by sourcing templates, fonts, colors, logos from a central brand config.
- Centralize and make searchable every generated asset.
- Reuse authoritative product data/images instead of hunting them down per task.

### Non-goals (v1)
- Full DAM replacement (Ziflow/Sales Layer remain sources of truth).
- Real-time multi-user co-editing of a single asset.
- Print production / prepress workflows beyond exporting layered files.
- Mobile-native apps (responsive web only).

---

## 2. Users, roles & access model

### Personas
- **Internal marketer (WAC Group staff):** power user of all four tools; needs everything fast and on-brand.
- **External rep / agency:** uses the same tools but only sees a scoped subset of assets.
- **Admin:** approves reps, manages brand config, manages sharing/permissions, sees usage.

### Roles
| Role | Verification | Asset visibility | Admin powers |
|------|-------------|------------------|--------------|
| Internal | Automatic — Google SSO **or** email verification on an approved WAC corporate domain | All internal assets | No (unless also Admin) |
| Rep | Manual approval by an Admin | Only assets they created + assets explicitly shared with them | No |
| Admin | Granted by another Admin | All | Yes |

### Access rules (must be enforced at the data layer, not just UI)
- Authn via **Supabase Auth**: Google OAuth + email/password (magic link) fallback.
- On signup, check email domain against an `approved_domains` table. Match → auto-provision `internal`. No match → create as `rep` with `status = pending` until an Admin approves.
- Authorization via **Postgres Row-Level Security (RLS)**. Every asset row carries `owner_id`, `org_visibility` (`internal` | `private`), and an explicit `asset_shares` join table for rep-specific grants.
- Internal users: RLS policy grants read on any row where `org_visibility = 'internal'`.
- Reps: RLS grants read only where `owner_id = auth.uid()` OR a row exists in `asset_shares (asset_id, user_id)`.
- All four tools write through the same asset service so these rules apply uniformly.

> **Domains:** the production app will live on **`wacgroup.com`** (e.g. `marketing.wacgroup.com`), with development on a temporary dev URL until finalized. The `approved_domains` table holds the corporate email domain(s) that auto-provision internal accounts (to be finalized alongside the production domain).

---

## 3. Cross-cutting requirements

### Brand system (applies to every generated output)
- Central **brand config** (stored in DB + versioned JSON): logos (each brand/sub-brand, light/dark, SVG+PNG), color palette, type ramp/fonts, spacing, slide masters, layout templates, safe-area/clear-space rules.
- All generators read from this config. Changing the brand config updates future outputs; existing assets are not retroactively changed.
- **Structure:** **one primary WAC Group template** with **subtle variations for 4 sub-brands**. Each sub-brand overrides only its **logo** and **accent color(s)**; everything else (layout, type, spacing, masters) inherits from the primary. Model this as a base template + 4 lightweight theme overrides, not 5 independent template sets — so a base change propagates to all.

### Asset library (shared, searchable)
- Every generated file is saved to the user's profile **and** the shared library (subject to visibility rules).
- Each asset record stores: type, source tool, owner, visibility, timestamps, file links (all formats), and **tags + metadata** for search.
- **Auto-tagging:** derive tags from inputs (product SKU/name, campaign, brand, tool, room type, layout type) plus optional user tags. Full-text search over name/tags/metadata (Postgres `tsvector` or Supabase full-text).
- Versioning: regenerating an asset creates a new version linked to the original.

### Integrations
- **Sales Layer (PIM)** — source of truth for products, SKUs, **dimensions**, and primary product images. REST/OData API with output connectors (APPS/Custom Connector). Used by Application Images (fixture geometry + cutouts), PPT, and Layouts (product imagery/specs).
  - **Sync:** **daily push** from Sales Layer into the local `products` cache table (dimensions normalized to **mm**, plus metadata + image URLs).
  - **Images are NOT hosted by us.** Product images are served directly from the **Sales Layer CDN** (no R2 hosting, no CORS issues). We store only the CDN URLs. For Application Images we fetch the cutout source from the CDN at generation time. (Only *generated* assets live in R2.)
- **HubSpot (Marketing)** — source of truth for **campaigns**. The UTM tool's campaign field is a **dropdown populated from HubSpot campaigns** (not free text). Pull campaign list via HubSpot API; cache + refresh. **Decision:** confirm whether UTM-tagged links should also be written back to HubSpot, or just reference its campaign names.
- **Ziflow** — supplemental/customer-facing assets and approved creative. RESTful API (header API-key auth, JSON, webhooks); **confirmed available**. Used as a secondary asset source in Layouts/PPT.
- Build each integration behind an internal adapter interface so the rest of the app doesn't care about the upstream API shape, and so any provider could be swapped later.

### Output & export standards
- Consistent naming convention for exported files: `{brand}_{tool}_{slug}_{date}_{version}.{ext}`.
- All exports also stored in the asset library with download links.

---

## 4. Tech stack

**Preferred (confirmed):** Cloudflare Workers + Supabase, cost-conscious, ~100 users (range 10–500). **Cloudflare is a preference, not a hard requirement** — performance is the top priority, so any component can be swapped if it performs better. (Note: Cloudflare Pages is being deprecated, so the **frontend ships on Cloudflare Workers Static Assets**, not Pages.)

| Layer | Choice | Notes |
|-------|--------|-------|
| Frontend | React (Vite) SPA served via **Workers Static Assets** | Pages deprecated; Workers now serves static assets directly |
| Auth | **Supabase Auth** | Google OAuth + magic link; domain-based role provisioning |
| Database | **Supabase Postgres** w/ **RLS** | Single source for users, assets, products cache, shares |
| File storage | **Cloudflare R2** | Zero egress — ideal for serving *generated* assets repeatedly. (Product images stay on the Sales Layer CDN.) |
| API / edge | **Cloudflare Workers** | Auth-checked endpoints, signed URLs, orchestration, **QR redirect/short-link service** |
| Background queue | **Cloudflare Queues** + Durable Objects | Enqueue generation jobs, poll status |
| **Heavy generation jobs** | **Persistent container service** (see note) | PPTX build, image compositing, PDF render, AI orchestration |
| AI image inference | **Managed APIs** (see §6) | fal.ai / Replicate for Flux+ControlNet+inpainting; Gemini image; etc. |

> **Architectural note — generation compute.** Cloudflare Workers have CPU/runtime limits and a constrained runtime (not full Node, no arbitrary native binaries). Heavy work — PPTX assembly (`pptxgenjs`/`python-pptx`), raster compositing (`sharp`/ImageMagick), PDF rendering (LibreOffice headless), and orchestrating multi-step AI image pipelines — needs a real runtime. Since **performance is the priority**, use an **always-warm persistent container** (avoids cold-start latency) rather than scale-to-zero functions for the interactive path.
>
> **Recommended:** **Cloudflare Containers** — keeps everything in one ecosystem, integrates natively with Workers + Queues, triggered by the queue and writing to R2.
> **Strong alternative if you want more headroom/maturity:** a small always-on Node service on **Fly.io** or **Render** (fast global, low cold start, simple Docker deploy) — equally valid and arguably more battle-tested for long-running render jobs. **Modal** is the pick if you ever self-host GPU inference (e.g. custom ControlNet) instead of managed APIs.
> Phase 1 (UTM/QR + short-link) fits **entirely within Workers** — no container needed until Phase 2.

### Cost posture
- Cloudflare Workers paid (~$5/mo base) + R2 (storage + Class A/B ops, no egress).
- Supabase Pro (~$25/mo) covers Postgres, Auth, RLS at this scale.
- Container service: low fixed cost for one always-warm small instance.
- Dominant variable cost = **AI image generation** (per-image inference). Budget is **fine for quality/performance, but should not reach tens of thousands** — so: cache aggressively, store outputs (never regenerate the same image), and let users preview/iterate deliberately. At ~100 users this is very manageable with managed per-image pricing.

---

## 5. Phase 1 — UTM & QR Code Generator (MVP)

**Why first:** highest-frequency, lowest-risk, exercises the full account + asset-library plumbing end-to-end.

### User stories
- I fill a form (base URL + UTM params) and get a tagged URL, a **short link on our own domain**, and a QR code.
- I can **edit the destination of a QR/short link after it's been created/printed** without reprinting.
- I upload an Excel/CSV and generate many tagged links + QR codes in bulk.
- I download QR codes as **SVG and PNG** and copy/export the URLs.
- Everything is saved, tagged, and findable later.

### Functional requirements

**UTM builder (governed dropdowns):** — field set confirmed from your reference sheets: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` (no `utm_term` in practice). Each generated row also carries **Project** and **QR Code Name** labels (org/grouping fields from your sheet), plus the destination **Link** and the assembled **final URL**.
- **Campaign:** **dropdown from HubSpot campaigns** (required). Your "Campaigns" sheet already mirrors this exactly — coded value `{hubspotId}_{slug}` (e.g. `39174698_hd_expo_2026`) shown by display name (e.g. "HD Expo 2026"). The app stores the coded value into `utm_campaign` and displays the name.
- **Source / Medium / Content:** **dropdowns** from controlled vocabularies (your data uses sources like `print`, `tradeshow`; mediums like `postcard`, `vignette`, `paid_media`, `social`; content like `aia`, `ce_pro`).
  - **Content** supports **"add your own"** inline — new value persists and is reusable.
- **Destination link** can point to any brand/property (your sheets span waclighting.com, modernforms.com, schonbek.com, wacarchitectural.com, aispire.com, inspire.wacgroup.com, etc.) — destination brand is independent of the 4 template sub-brands.
- Admins manage the source/medium/content vocabularies.

**Data-quality validation (explicitly motivated by errors in the current sheets):** the current manual process produces real bugs — e.g. `?&utm_source=...` (stray `&` after `?`), a missing `&` before `utm_content` (`...campaign=...2026utm_content=aia`), and incrementing campaign IDs (`..._2026`, `_2027`, `_2028`) that should be constant. The builder **assembles the query string programmatically** so these can't happen: correct `?`/`&` joins, encoding, no duplicate/missing params, and the campaign value comes from the HubSpot dropdown (never hand-typed). Validate every generated URL before save.

**Social multi-channel fan-out (required):** a "social campaign" mode where the user picks campaign + content + destination once and generates a **set of tagged links/short-links/QRs in one action — one per channel: YouTube, TikTok, LinkedIn, Facebook, Instagram, X.** Each row sets `utm_source` to the channel (e.g. `youtube`, `tiktok`, `linkedin`, `facebook`, `instagram`, `x`) with a shared `utm_medium` (e.g. `social` / `organic_social` / `paid_social`, selectable). Output is a batch (downloadable sheet + saved assets), so one campaign yields all six channel-tagged links at once.

**Short-link + dynamic QR service (must-have, in scope):**
- A **redirect service on our own domain**: **`gowac.cc`** (purchased, DNS self-managed via Cloudflare). Self-hosted on Workers.
- Each short link maps a **slug → destination URL** in a `short_links` table; the **QR encodes the short link, not the raw destination**. Editing the destination updates the row — **the same printed QR keeps working**. This is the mechanism that makes QRs editable after the fact.
- Redirects run on a **Cloudflare Worker** (KV/Hyperdrive lookup) for low-latency edge redirects; capture basic scan counts/timestamps.
- Slugs: auto-generated short, optional custom vanity slug.

**QR generation:**
- Encode the short link. Output **SVG** (vector) + **PNG** (selectable resolution).
- Optional brand styling (sub-brand logo center, accent color, enforced quiet zone); validate scannability after styling.

**Bulk mode:**
- Upload `.xlsx`/`.csv`, map columns → fields, preview, generate. Each row produces a tagged URL + short link + QR. Download a results sheet (original rows + tagged URL + short link + QR links).
- **Migration/export compatibility:** support the column layout of your existing files — input like `UTM Generator.xlsx` (PROJECT, QR CODE NAME, LINK, utm_source, utm_medium, utm_campaign, utm_content) and **export** to your current dynamic-QR platform import format (`QR Name (mandatory)`, `Website URL`, `Add to Watchlist`, `Folder`) so the tool can drop into or fully replace the existing workflow. Since we run our own short-link/QR service, this export is mainly for migration/parallel-running.

**Save & tag:** each link/QR/short-link saved as an asset, tagged by campaign/source/medium/content.

### Acceptance criteria
- Campaign list loads from HubSpot; source/medium/content dropdowns work; new Content values persist and reappear.
- Generates valid, correctly-encoded UTM URLs (param order + encoding correct) — and specifically does **not** reproduce the current-sheet bugs (stray `?&`, missing `&` before `utm_content`, drifting campaign IDs).
- **Social fan-out:** one action with a campaign selected yields six correctly-tagged links/short-links/QRs (YouTube, TikTok, LinkedIn, Facebook, Instagram, X), each with the right `utm_source`.
- Imports the existing `UTM Generator.xlsx` layout and can export the dynamic-QR platform template format.
- Short link resolves via our domain and redirects fast; **changing the destination updates where the existing QR/short link points** without regenerating the QR.
- SVG and PNG both download and the QR scans reliably (including styled variant).
- 100-row bulk upload processes and returns a downloadable results file.
- All outputs appear in the asset library with correct visibility + tags.

### Notes
- Builder + QR rendering run in-browser (`qrcode`, `qr-code-styling`); redirect service + short-link store run on Workers + KV/Postgres. **No container needed** — fits entirely in the Workers stack.

---

## 6. Phase 2 — Application Image Generator

Place a selected fixture (or fan) into a described room, **to scale** and **visually accurate** to the real product. Support **multiple fixtures** in one scene for product types like downlights and landscape lighting.

### User stories
- I pick a fixture from the product database (Sales Layer), describe the room and where the fixture goes, and get a realistic image with the fixture correctly sized for the space.
- For downlights/landscape lights, I specify a count/spacing/array and get multiple placed correctly.
- I save the result; it's tagged by product + room type.

### The core hard problem: scale + fidelity
The product must look like the *actual* fixture and be the *right size* relative to the room. This is the riskiest feature. Three approaches, with tradeoffs:

#### Option A — Compositing-first (place real fixture cutouts into a scene)
Generate or use a room image, then **composite the real fixture PNG** (from Sales Layer / DAM, background removed) into it. Use the known fixture dimensions + an estimated scene scale (camera height / reference object / depth map) to size the cutout correctly, then blend with AI for contact shadows/reflections (inpainting at the edges only).

- **Advantages:** Maximum product fidelity — it *is* the real fixture, so exact shape, finish, proportions. Deterministic scale (you control pixel size from real mm). Cheapest at inference time (one room gen + light blending, or even a stock/real room). Brand/legal-safe (no hallucinated products).
- **Tradeoffs / the key problem you flagged:** the cutout's **perspective and viewing angle won't match the scene's**, so simple edge-blending isn't enough — a fixture shot straight-on looks pasted into a room photographed from below/at an angle. To fix this you must **reproject the cutout's perspective** to match the scene (needs the scene's camera/vanishing geometry and ideally a multi-angle or 3D-ish reference of the fixture; a single flat cutout can only be perspective-corrected so far before it looks wrong). Emitted light (glow, beam, landscape wash) also still needs generative help.
- **Best for:** Fixtures viewed near the scene's angle, or near-flush products (downlights, flush mounts) where perspective mismatch is small.
- **Viability of perspective adjustment:** feasible for mild corrections (homography/warp from estimated scene geometry), but **a flat 2D cutout can't be turned into an arbitrary new 3D viewpoint**. If perspective adjustment proves insufficient, that's the trigger to lean on Option C's generative harmonization (or, longer term, a 3D/relighting model fed fixture geometry).

#### Option B — Pure generative (text/image-to-image generates the fixture in-scene)
Describe the room + fixture; a diffusion model renders everything, optionally conditioned on a reference image of the fixture (IP-Adapter / image prompt).

- **Advantages:** Most flexible and natural-looking scenes; lighting, shadows, beams, and reflections are inherently consistent because the model paints the whole image. Easiest UX (just describe it). Handles emitted light beautifully.
- **Tradeoffs:** **Lowest product accuracy** — the model approximates the fixture; finishes, proportions, and details drift. Scale is not guaranteed (the model has no real dimension data). Risk of producing a fixture that isn't actually a WAC product. Hardest to keep on-brand/accurate. Higher variance → more regenerations → more cost.
- **This is essentially the current workflow** (Midjourney / nano-banana) — hence the "lots of trial and error" and mixed results. The PRD should treat this as the baseline to beat, not the target.
- **Best for:** Mood/concept imagery where exact product accuracy is secondary.

#### Option C — Hybrid (generative scene + controlled product, recommended default)
Generate the room with structural control, and constrain the fixture using control signals: **depth/edge/segmentation conditioning (ControlNet)** to lock geometry + perspective, **inpainting** to insert the fixture into a masked region at a computed scale, and a **reference image** of the real fixture to drive appearance. Effectively: composite the real cutout into a masked region, then let the model harmonize lighting/shadows/emitted light within that region while ControlNet holds geometry.

- **Advantages:** Balances fidelity and realism — real product appearance + believable integrated lighting. Scale stays controllable via the masked region size derived from real dimensions. Multiple fixtures handled by multiple masked regions/instances. Industry-leading approach for scale-accurate product-in-scene work (ControlNet + iterative inpainting).
- **Tradeoffs:** Most complex pipeline to build and tune (masking, scale estimation, conditioning, harmonization passes). Higher per-image compute than pure compositing. Requires good fixture reference assets + dimensions.
- **Best for:** The actual requirement here — accurate, multi-fixture, realistic application images.

**Decision — go with Option C (hybrid) as the target.** Rationale confirmed: A's blocker is that a flat cutout's perspective won't match the scene (edge-blending alone is insufficient); B is the current Midjourney/nano-banana approach that produces mixed results and inaccurate products. C — generative scene with the real fixture inserted under ControlNet geometry + inpainting harmonization at a computed scale — is the best balance of fidelity, scale control, and realistic integrated lighting.

**Build approach:** attempt C directly. As a cheaper validation step, prototype A's **scale + perspective-correction** logic (it's reusable inside C for sizing/placing the masked region). If C's full pipeline proves too complex to get right, **pivot** — but try to make C work first. Pure B stays available only as a fast "concept image" mode, clearly labeled as not product-accurate.

> **Inference = managed APIs, go direct-to-creator wherever possible** (your cost note: aggregators like Replicate mark up; nano-banana is far cheaper straight from Google). Here's what's actually available direct vs. not, for the Option C building blocks:
>
> | Capability needed for C | Direct from creator? | Notes |
> |---|---|---|
> | **Prompt-based editing / harmonization** (blend fixture into scene, fix lighting) | ✅ **Google Gemini 2.5 Flash Image ("nano-banana")**, ~$0.039/image direct | Natural-language edits, **no explicit mask/ControlNet** — great for harmonization & concept passes, weak for precise geometry locking |
> | **Masked inpainting / outpainting** (insert fixture into a defined region) | ✅ **Black Forest Labs FLUX.1 Fill**, direct via bfl.ai (~$0.01/credit, pay-per-image) | Direct, no GPU |
> | **Mask + prompt surgical edits** | ✅ **FLUX.1 Kontext** (Pro ~$0.08/image), direct from BFL | Direct, no GPU |
> | **Reference-image conditioning** (drive appearance from the real fixture) | ✅ **FLUX.1 Redux** / **FLUX.2** multi-reference, direct from BFL | Direct; FLUX.2 is the newer multi-ref path |
> | **Explicit ControlNet structural conditioning (depth/canny)** — the strict geometry/scale lock | ⚠️ **Not direct anymore** — BFL **deprecated FLUX.1 Depth & Canny** in their API | This specific control either comes via an **aggregator (fal.ai/Replicate)** or **self-hosted GPU** (SDXL/Flux ControlNet) |
>
> **Answer to "do these require our own GPU?":** Mostly **no.** The harmonization, masked inpainting, reference-conditioning, and surgical-edit pieces are all available **directly from Google and Black Forest Labs at low per-image cost, no GPU**. The **only** piece that may force an aggregator or self-hosted GPU is **explicit depth/canny ControlNet** (deprecated on BFL's direct API). 
>
> **Recommended plan:** build C primarily on **direct APIs** — composite the real fixture cutout into a computed-scale masked region, then **FLUX.1 Fill + Redux/FLUX.2 (reference) + Gemini for harmonization**, all direct. Try to achieve sufficient geometry/scale control through masked placement + reference conditioning **without** explicit ControlNet. **Only if** that proves insufficient do we add depth/canny ControlNet via **fal.ai** (managed, no GPU) or, last resort, self-host on **Modal** (GPU, cheapest at high volume). Keep all of this behind a provider adapter so swapping is trivial. Cache + store every output; at ~100 users, direct per-image pricing stays far under the "tens of thousands" ceiling.

### Functional requirements
- Fixture picker backed by Sales Layer: search by SKU/name/category; show product image + **dimensions** (pull and store in mm).
- Room input: text description + optional reference room image upload + room dimensions / ceiling height (improves scale).
- Placement controls: where the fixture goes; for arrays (downlights/landscape), specify count + spacing/pattern.
- Scale engine: compute fixture pixel size from real dimensions + scene scale estimate (use provided room dimensions, a reference object, or monocular depth estimation).
- Generate → preview → regenerate/adjust → save. Store generation params for reproducibility.
- Output: high-res image (PNG/JPG/WebP), tagged by product SKU + room type.

### Acceptance criteria
- For a known fixture in a known-size room, rendered fixture size is within a stated tolerance of correct scale.
- Rendered fixture is recognizably the selected product (finish/shape correct) — reviewed against the catalog image.
- Multi-fixture scenes place the specified count without overlap/duplication artifacts.
- Output saved with product + room tags.

---

## 7. Phase 3a — PPT Generator

Build a presentation slide-by-slide via a form; choose layout per slide; use catalog images or AI-generated (Application Image) images; basic tables; export **PPTX + PDF**.

### User stories
- I add slides one at a time, pick a layout per slide, add text + images (from catalog, upload, or AI generator) + a basic table, and export an on-brand PPTX and a PDF.

### Functional requirements
- Slide builder UI: ordered list of slides; per-slide layout chooser from brand slide masters (title, title+content, two-column, image-full, image+caption, table, section divider, etc.).
- Content per slide: headers/subheaders, body/bullets, image slot(s), basic table (rows/cols, header styling).
- Image sources: Sales Layer/Ziflow catalog, upload, or **invoke the Application Image generator** inline.
- On-brand: uses brand master/theme (fonts, colors, logo, footer) from brand config.
- Export: **PPTX** (editable, true to template) + **PDF** render. Save both to library.

### Implementation notes
- Generate PPTX with a real Office library (`pptxgenjs` in Node, or `python-pptx`) running in the **generation worker/container**, from brand `.pptx` masters → fidelity to templates.
- PDF via headless render of the PPTX (LibreOffice headless) or render slides to images → PDF.

### Acceptance criteria
- Exported PPTX opens in PowerPoint/Google Slides on-brand, with editable text/tables and correctly placed images.
- PDF matches the deck.
- Deck saved + tagged.

---

## 8. Phase 3b — Simple Design Layouts

Compose a layout from an image (catalog or AI-generated) + logos + text (headers/subheaders/bullets), choose layout type(s), auto-generate, allow image reposition/crop/center, export PNG + web image + layered **PSD/AI**.

### User stories
- I pick/generate an image, add logos and text, choose one or several layout types, and the tool produces the layouts. I reposition/crop the image, then export PNG, a web-optimized image, and a layered PSD or Illustrator file.

### Functional requirements
- Inputs: image (catalog / upload / Application Image generator), logo(s) from brand config, text blocks (header, subheader, bullets, CTA).
- Layout templates: pick one or **generate multiple at once** (e.g. social square, story/vertical, banner, print). Templates carry brand rules.
- Editing: reposition/crop/center/zoom the image within its frame; basic text edits within brand constraints.
- Export: **PNG**, **web-optimized image** (WebP/compressed JPG at target size), and **layered PSD + layered PDF** preserving editable layers (image, logo, text). **Native Illustrator (.ai) is not required.**
- Save all exports + tag.

### Implementation notes
- Canvas/layout engine client-side (Konva/Fabric.js) for interactive reposition/crop; server-side render for final raster export (`sharp`/headless) in the generation worker.
- **PSD export:** `ag-psd` (Node) writes layered PSDs; pair with a layered PDF. Illustrator opens both — this fully covers the requirement (native `.ai` confirmed out of scope).

### Acceptance criteria
- Selecting N layout types yields N on-brand compositions.
- Image reposition/crop reflects in all exports.
- PNG + web image + layered PSD export correctly with separable layers.
- All saved + tagged.

---

## 9. Data model (initial sketch)

- `users` (id, email, role[`internal`|`rep`|`admin`], status[`active`|`pending`], created_at)
- `approved_domains` (domain)
- `brands` (id, name, config_json, assets: logos/colors/fonts/templates)
- `products` (cache of Sales Layer: sku, name, category, dimensions_mm, primary_image_url, raw_json, synced_at)
- `assets` (id, owner_id, tool[`utm`|`qr`|`appimage`|`ppt`|`layout`], name, org_visibility[`internal`|`private`], tags[], metadata_json, search_tsv, created_at, version, parent_asset_id)
- `asset_files` (id, asset_id, format, r2_key, bytes) — multiple formats per asset
- `asset_shares` (asset_id, user_id, granted_by) — explicit rep grants
- `generation_jobs` (id, asset_id, tool, status, params_json, error) — async job tracking
- `short_links` (id, slug, destination_url, owner_id, scan_count, created_at, updated_at) — editable QR/short-link targets
- `utm_vocab` (id, type[`source`|`medium`|`content`], value) — governed dropdown values; `content` is user-extendable
- `hubspot_campaigns` (cached campaign id + name for the campaign dropdown)

RLS policies enforce the §2 access rules on `assets`/`asset_files`.

---

## 10. Non-functional requirements
- **Security:** RLS-enforced authorization; signed, expiring R2 URLs; API keys for Sales Layer/Ziflow stored as secrets, never client-side.
- **Performance:** Phase-1 actions feel instant (<1s for single UTM/QR). Heavy generation runs async with progress/polling; target reasonable wait + clear status.
- **Reliability:** generation jobs are retryable and idempotent; failures surfaced to the user.
- **Cost control:** cache product data + AI outputs; dedupe regenerations; R2 (no egress) for serving.
- **Observability:** log generations, integration calls, and errors; basic usage dashboard for Admin.
- **Auditability:** asset records retain who/what/when + generation params.

---

## 11. Phased roadmap

| Phase | Scope | Shared plumbing introduced |
|-------|-------|----------------------------|
| **0** | Auth (Google SSO + domain provisioning + rep approval), user roles, RLS, brand config, asset library + search, R2 storage | Foundation for everything |
| **1** | UTM & QR generator (HubSpot campaigns + governed dropdowns; form + bulk; SVG/PNG; **editable short-link/QR redirect service**; save/tag) | Validates account + asset library + edge redirects end-to-end on light compute; HubSpot integration |
| **2** | Application Image generator (compositing-first → hybrid; multi-fixture; Sales Layer dimensions) | Generation worker/container + queue; AI inference; PIM integration |
| **3a/3b** | PPT generator and Design Layouts (either order) | Reuse generation worker, brand templates, image generator, Ziflow assets |

> Phase 0 can fold into Phase 1 in practice — build the account/library skeleton while shipping UTM/QR.

---

## 12. Decisions (resolved) & remaining questions

### Resolved
1. **Domain:** production on `wacgroup.com` (e.g. `marketing.wacgroup.com`); build on a dev URL first.
2. **Brand:** 1 primary WAC Group template + 4 sub-brand variations (logo + accent color overrides only).
3. **AI inference:** managed APIs; budget fine for quality/performance but capped well below "tens of thousands."
4. **Fixture fidelity:** as accurate as possible (target Option C hybrid).
5. **Sales Layer:** daily push into local cache; product images served directly from Sales Layer CDN (no hosting, no CORS).
6. **Ziflow:** API confirmed available; use as secondary asset source.
7. **Layout exports:** layered PSD + layered PDF; native `.ai` not required.
8. **UTM governance:** governed dropdowns — campaign from HubSpot; source/medium fixed vocab; content user-extendable.
9. **Editable QR / short-link service:** must-have, in scope (own domain preferred; Bitly only as a complexity-reducing fallback).

### Remaining to confirm
- Exact corporate email domain(s) for `approved_domains` (auto-internal provisioning) — finalize with the production domain.
- ~~Final short-link host~~ **Resolved:** `gowac.cc`, self-hosted on Workers, DNS self-managed via Cloudflare.
- HubSpot: just reference campaign names, or also write tagged links back into HubSpot?
- Acceptable numeric scale tolerance for Application Images QA (e.g. ±X%).
- Whether direct APIs (Google Gemini + BFL FLUX Fill/Redux/Kontext, no GPU) give enough geometry/scale control for C, or whether explicit depth/canny ControlNet (via fal.ai, or self-hosted on Modal) is actually needed. Default plan is direct-first.
- Generation compute host final pick: Cloudflare Containers vs Fly.io/Render (perf-tested).

---

## 13. Sources
- Sales Layer API / connectors: https://www.saleslayer.com/ , http://support.saleslayer.com/api/connectors-and-api-calls-sales-layer-pim
- Ziflow API: https://api-docs.ziflow.com/ , https://www.ziflow.com/online-proofing-api-and-integrations
- AI compositing / ControlNet + inpainting for scale-accurate scenes: https://arxiv.org/pdf/2406.02461 , https://www.superteams.ai/blog/how-to-choose-the-best-ai-image-generation-model-in-2026/
- Cloudflare Workers / R2 / Supabase: https://developers.cloudflare.com/workers/platform/pricing/ , https://developers.cloudflare.com/r2/pricing/ , https://supabase.com/partners/integrations/cloudflare-workers
