-- =============================================================================
-- Descriptions — new-product master-list import + AI copywriting workflow.
--
-- One row per PPID group parsed from the seasonal master lists (DWELED /
-- Modern Forms / Schonbek). Products are a prunable projection of the current
-- file, replaced wholesale on re-import; the copy itself (desc_content) is
-- keyed by (slot, content_key) with deliberately NO FK to desc_products —
-- same reasoning as product_content (0015): approved/edited copy must survive
-- a re-import. Orphans are surfaced, relinked by model-base intersection, and
-- never auto-deleted when they hold human work.
--
-- Statuses reuse public.product_content_status (0015). RLS mirrors 0015:
-- active internal users + admins read/write, deletes are admin-only (the
-- Worker's service-role client performs the commit/replace machinery).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- desc_imports — per-upload history rows. The live file per slot is the
-- latest committed row. Slot is text + CHECK (6 fixed slots).
-- ---------------------------------------------------------------------------
create table if not exists public.desc_imports (
  id uuid primary key default gen_random_uuid(),
  slot text not null check (slot in
    ('dweled_master','mf_master','schonbek_master',
     'dweled_pptx','mf_pdf','schonbek_pdf')),
  filename text not null,
  r2_key text not null,             -- archived original: descriptions/raw/{slot}/{sha256}.{ext}
  bytes integer not null,
  sha256 text not null,
  status text not null default 'uploaded'
    check (status in ('uploaded','committed','failed')),
  parse_report jsonb,               -- counts, diff summary, warnings
  uploaded_by uuid references public.users(id) on delete set null,
  uploaded_at timestamptz not null default now(),
  committed_at timestamptz
);

create index if not exists desc_imports_slot_idx
  on public.desc_imports (slot, uploaded_at desc);

-- ---------------------------------------------------------------------------
-- desc_products — one row per PPID group. Replaced wholesale on slot re-import.
-- ---------------------------------------------------------------------------
create table if not exists public.desc_products (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.desc_imports(id) on delete cascade,
  slot text not null check (slot in
    ('dweled_master','mf_master','schonbek_master',
     'dweled_pptx','mf_pdf','schonbek_pdf')),
  brand text not null,
  collection text not null,
  year int not null,
  content_key text not null,        -- stable content-derived identity
  name text,
  family text,
  product_type text,
  diffuser_type text,
  finishes text[] not null default '{}',
  sizes jsonb not null default '[]',      -- [{length,width,height}] source strings preserved
  cct text[] not null default '{}',
  model_numbers text[] not null default '{}',
  model_bases text[] not null default '{}',  -- finish-suffix-stripped, matching + relink
  features text[] not null default '{}',
  attributes jsonb not null default '{}',    -- romance, hierarchy, variants, sheet catch-all
  source_rows int not null,
  sort_order int not null,
  created_at timestamptz not null default now(),
  unique (slot, content_key)
);

create index if not exists desc_products_slot_idx
  on public.desc_products (slot);
create index if not exists desc_products_brand_idx
  on public.desc_products (brand, collection);

-- ---------------------------------------------------------------------------
-- desc_product_images — xlsx renders / pptx heroes / pdf pages. product_id is
-- nullable: null = unassigned tray (Schonbek pdf pages, manual assign).
-- ---------------------------------------------------------------------------
create table if not exists public.desc_product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.desc_products(id) on delete set null,
  import_id uuid not null references public.desc_imports(id) on delete cascade,
  slot text not null check (slot in
    ('dweled_master','mf_master','schonbek_master',
     'dweled_pptx','mf_pdf','schonbek_pdf')),
  r2_key text not null,             -- descriptions/img/{slot}/{contenthash}.{ext}
  source text not null check (source in ('xlsx','pptx','pdf')),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists desc_product_images_product_idx
  on public.desc_product_images (product_id);
create index if not exists desc_product_images_import_idx
  on public.desc_product_images (import_id);

-- ---------------------------------------------------------------------------
-- desc_content — the copy. Flat, keyed (slot, content_key), NO FK to
-- desc_products (survives re-imports). Single status drives the UI's
-- "Description" filter. Reuses product_content_status from 0015.
-- ---------------------------------------------------------------------------
create table if not exists public.desc_content (
  id uuid primary key default gen_random_uuid(),
  slot text not null check (slot in
    ('dweled_master','mf_master','schonbek_master',
     'dweled_pptx','mf_pdf','schonbek_pdf')),
  content_key text not null,
  description_ai text,
  description_final text,           -- human-edited/approved; export prefers final else ai
  meta_ai text,
  meta_final text,
  title_override text,              -- manual title; null = formula-computed at read time
  status public.product_content_status not null default 'none',
  note text,
  reviewed_by uuid references public.users(id) on delete set null,
  model text,                       -- Claude model id used
  prompt_hash text,                 -- sha256 of the assembled prompt
  generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (slot, content_key)
);

create index if not exists desc_content_status_idx
  on public.desc_content (slot, status);

create or replace function public.desc_content_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists desc_content_touch_trigger on public.desc_content;
create trigger desc_content_touch_trigger
  before update on public.desc_content
  for each row execute function public.desc_content_touch();

-- ---------------------------------------------------------------------------
-- desc_voice_profiles — one editable voice/prompt profile per brand+collection
-- tab. Seeded below from the shared voiceDefaults constants (packages/shared/
-- src/descriptions/voiceDefaults.ts) — KEEP THE TEXT IN SYNC: the shared
-- constants back the "Reset to default" action, and a vitest guard asserts
-- this file contains the same strings.
-- ---------------------------------------------------------------------------
create table if not exists public.desc_voice_profiles (
  id uuid primary key default gen_random_uuid(),
  brand text not null,
  collection text not null,
  prompt text not null,
  voice_guidance text not null default '',
  reference_skus text[] not null default '{}',   -- cap 5 enforced in app
  updated_by uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (brand, collection)
);

drop trigger if exists desc_voice_profiles_touch_trigger on public.desc_voice_profiles;
create trigger desc_voice_profiles_touch_trigger
  before update on public.desc_voice_profiles
  for each row execute function public.desc_content_touch();

-- ---------------------------------------------------------------------------
-- desc_enrichment — persisted pptx/pdf supplemental units (Stage 2 fills
-- these; schema lands now so re-imports on either side can re-match).
-- ---------------------------------------------------------------------------
create table if not exists public.desc_enrichment (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.desc_imports(id) on delete cascade,
  slot text not null check (slot in ('dweled_pptx','mf_pdf','schonbek_pdf')),
  match_key text not null,          -- model base or normalized name
  name text,
  model_numbers text[] not null default '{}',
  model_bases text[] not null default '{}',
  bullets text[] not null default '{}',
  image_keys text[] not null default '{}',
  matched boolean not null default false,
  matched_content_key text,         -- the master group it attached to
  created_at timestamptz not null default now(),
  unique (slot, match_key)
);

-- ---------------------------------------------------------------------------
-- RLS — 0015 pattern: internal marketing data. Active internal users and
-- admins read/write; reps have no access; deletes are admin-only (the
-- commit/replace path runs on the service role, which bypasses RLS).
-- ---------------------------------------------------------------------------
alter table public.desc_imports enable row level security;
alter table public.desc_products enable row level security;
alter table public.desc_product_images enable row level security;
alter table public.desc_content enable row level security;
alter table public.desc_voice_profiles enable row level security;
alter table public.desc_enrichment enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'desc_imports','desc_products','desc_product_images',
    'desc_content','desc_voice_profiles','desc_enrichment'
  ] loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format(
      'create policy %I_select on public.%I for select using (public.is_active_internal_or_admin())',
      t, t);
    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format(
      'create policy %I_insert on public.%I for insert with check (public.is_active_internal_or_admin())',
      t, t);
    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format(
      'create policy %I_update on public.%I for update using (public.is_active_internal_or_admin()) with check (public.is_active_internal_or_admin())',
      t, t);
    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format(
      'create policy %I_delete on public.%I for delete using (public.is_admin())',
      t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Voice profile seeds — one row per brand+collection tab. Text mirrors
-- packages/shared/src/descriptions/voiceDefaults.ts EXACTLY.
-- ---------------------------------------------------------------------------
insert into public.desc_voice_profiles (brand, collection, prompt, voice_guidance)
values
  ('WAC Lighting', 'Dweled', $prompt$Write 75-word marketing catalog copy for this product, based on the product fact sheet provided.

Describe the design details a shopper can see, and weave in the specific product facts supplied (LED color temperature, finishes, sizes, materials, features). Never invent specifications; only use the attributes provided.

Plain text only: no markdown, no headings, no exclamation marks, no hype words. No em dashes. When referring to the company, always write WAC Group, never WAC alone.

HARD RULE: capture the same kinds of information for every product, but never the same shape: vary the opening, sentence order, and rhythm from product to product. Do not start two descriptions the same way.$prompt$,
   $voice$Seeded default, refine me. Dweled is accessible decorative LED lighting from WAC Lighting: warm, inviting, design-forward but approachable. Lead with how the fixture lives in the home, support with the light quality and finish details. Friendly and confident, never gushing.$voice$),
  ('WAC Lighting', 'Limited', $prompt$Write 75-word marketing catalog copy for this product, based on the product fact sheet provided.

Describe the design details a shopper can see, and weave in the specific product facts supplied (LED color temperature, finishes, sizes, materials, features). Never invent specifications; only use the attributes provided.

Plain text only: no markdown, no headings, no exclamation marks, no hype words. No em dashes. When referring to the company, always write WAC Group, never WAC alone.

HARD RULE: capture the same kinds of information for every product, but never the same shape: vary the opening, sentence order, and rhythm from product to product. Do not start two descriptions the same way.$prompt$,
   $voice$Seeded default, refine me. WAC Lighting Limited is elevated, limited-run decorative lighting. Precise and quietly premium: emphasize craftsmanship, materials, and the character of the light. Concrete specifics over adjectives.$voice$),
  ('Modern Forms', 'Fans', $prompt$Write 75-word marketing catalog copy for this product, based on the product fact sheet provided.

Describe the design details a shopper can see, and weave in the specific product facts supplied (LED color temperature, finishes, sizes, materials, features). Never invent specifications; only use the attributes provided.

Plain text only: no markdown, no headings, no exclamation marks, no hype words. No em dashes. When referring to the company, always write WAC Group, never WAC alone.

HARD RULE: capture the same kinds of information for every product, but never the same shape: vary the opening, sentence order, and rhythm from product to product. Do not start two descriptions the same way.$prompt$,
   $voice$Seeded default, refine me. Modern Forms smart fans are sculptural, architectural, and engineered. Clean modern vocabulary: silhouette, airflow, finish, integrated LED light. Technical confidence without jargon dumps.$voice$),
  ('Modern Forms', 'Luminaires', $prompt$Write 75-word marketing catalog copy for this product, based on the product fact sheet provided.

Describe the design details a shopper can see, and weave in the specific product facts supplied (LED color temperature, finishes, sizes, materials, features). Never invent specifications; only use the attributes provided.

Plain text only: no markdown, no headings, no exclamation marks, no hype words. No em dashes. When referring to the company, always write WAC Group, never WAC alone.

HARD RULE: capture the same kinds of information for every product, but never the same shape: vary the opening, sentence order, and rhythm from product to product. Do not start two descriptions the same way.$prompt$,
   $voice$Seeded default, refine me. Modern Forms luminaires are minimalist, architectural, art-adjacent. Speak to form and shadow, luminous surfaces, and how the piece anchors a modern space. Spare, assured sentences.$voice$),
  ('Schonbek', 'Beyond', $prompt$Write 75-word marketing catalog copy for this product, based on the product fact sheet provided.

Describe the design details a shopper can see, and weave in the specific product facts supplied (LED color temperature, finishes, sizes, materials, features). Never invent specifications; only use the attributes provided.

Plain text only: no markdown, no headings, no exclamation marks, no hype words. No em dashes. When referring to the company, always write WAC Group, never WAC alone.

HARD RULE: capture the same kinds of information for every product, but never the same shape: vary the opening, sentence order, and rhythm from product to product. Do not start two descriptions the same way.$prompt$,
   $voice$Seeded default, refine me. Schonbek Beyond brings crystal artistry into contemporary silhouettes. Blend the heritage of Schonbek crystal with modern, livable design language: refraction, sparkle, and light as a material.$voice$),
  ('Schonbek', 'Forever', $prompt$Write 75-word marketing catalog copy for this product, based on the product fact sheet provided.

Describe the design details a shopper can see, and weave in the specific product facts supplied (LED color temperature, finishes, sizes, materials, features). Never invent specifications; only use the attributes provided.

Plain text only: no markdown, no headings, no exclamation marks, no hype words. No em dashes. When referring to the company, always write WAC Group, never WAC alone.

HARD RULE: capture the same kinds of information for every product, but never the same shape: vary the opening, sentence order, and rhythm from product to product. Do not start two descriptions the same way.$prompt$,
   $voice$Seeded default, refine me. Schonbek Forever celebrates timeless crystal classics. Luxurious, heritage-rich voice: hand-set crystal, generations of craft, rooms made for occasions. Elegant, never stuffy.$voice$),
  ('Schonbek', 'Signature', $prompt$Write 75-word marketing catalog copy for this product, based on the product fact sheet provided.

Describe the design details a shopper can see, and weave in the specific product facts supplied (LED color temperature, finishes, sizes, materials, features). Never invent specifications; only use the attributes provided.

Plain text only: no markdown, no headings, no exclamation marks, no hype words. No em dashes. When referring to the company, always write WAC Group, never WAC alone.

HARD RULE: capture the same kinds of information for every product, but never the same shape: vary the opening, sentence order, and rhythm from product to product. Do not start two descriptions the same way.$prompt$,
   $voice$Seeded default, refine me. Schonbek Signature is the pinnacle of luxury crystal lighting. Write with reverence for craftsmanship and heritage: precision-cut crystal, statement scale, light that performs. Rich but controlled prose.$voice$)
on conflict (brand, collection) do nothing;
