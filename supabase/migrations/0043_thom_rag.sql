-- =============================================================================
-- Thom Bot — retrieval store (pgvector)
--
-- Thom Bot answers product, spec-sheet/manual, Help Center and general lighting
-- questions across every WAC Group brand. It runs on TWO surfaces sharing one
-- brain: an authenticated INTERNAL bot (full access) and a locked-down PUBLIC
-- embeddable bubble. `scope` is the security boundary between them and is
-- enforced here in RLS — never in the prompt.
--
-- Retrieval is HYBRID: dense vectors (pgvector) fused with the existing
-- lexical full-text search. Exact spec lookups ("lumens of X") are lexical
-- wins; "something like competitor Y" is a vector win. We need both.
--
-- Embeddings are 1024-dim to match Cloudflare Workers AI `@cf/baai/bge-m3`
-- (near-free, edge-local). The dimension is fixed per column: changing the
-- embedder later means a new migration.
--
-- Writes are service-role only (the sync/ingest pipeline); no insert/update/
-- delete policy is defined, so RLS denies writes to anon/authenticated while
-- the service role bypasses RLS entirely — same posture as `products` (0008).
--
-- NOTE on public reads: `scope = 'public'` rows are readable by the anon role
-- (the public bubble has no Supabase user). That content is already published
-- on the open web — spec sheets, manuals, Help Center articles — so anon
-- readability is intentional and not a disclosure. Anything not already public
-- MUST be written with scope = 'internal'.
-- =============================================================================

-- pgvector. On Supabase this may already exist (or be enabled from the
-- dashboard); it resolves via the default search_path either way.
create extension if not exists vector;

-- Surface visibility. Deliberately an enum, not free text: this is a security
-- boundary with exactly two legal values, and a typo must fail loudly rather
-- than silently create an unreachable-or-worse-leaky third scope.
do $$ begin
  create type public.thom_scope as enum ('public', 'internal');
exception when duplicate_object then null; end $$;

-- Document lifecycle. 'pending_extract' is set by the light in-Worker queue
-- (fetch + store + hash); the out-of-band Node CLI does the heavy PDF parse
-- and flips it to 'active'.
do $$ begin
  create type public.thom_doc_status as enum
    ('pending_extract', 'active', 'superseded', 'failed');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- kb_documents — one row per source document.
--
-- `doc_type` is open-ended text (spec_sheet, manual, zendesk_article,
-- zendesk_ticket, marketing, ... later dimming_guide/warranty) and is validated
-- at the API layer, so adding a type doesn't need a migration — same reasoning
-- as product_content.field (0015).
--
-- `content_hash` is the idempotency key for the whole ingest pipeline: an
-- unchanged document is never re-fetched, re-parsed, or re-embedded.
-- -----------------------------------------------------------------------------
create table if not exists public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  doc_type text not null,
  scope public.thom_scope not null,
  -- 'sales_layer' | 'zendesk' | 'app'
  source_system text not null,
  -- Stable upstream identity: Sales Layer file hash, ZenDesk article/ticket id,
  -- or the marketing content row id. Required so upserts are idempotent.
  external_id text not null,
  title text,
  brand text,
  -- Canonical source URL (Sales Layer CDN, Help Center article, PDP).
  url text,
  -- Cached copy of the source PDF in R2 (docs/{brand}/{sku}/{hash}.pdf).
  -- Null for non-PDF sources (articles, tickets, marketing copy).
  r2_key text,
  -- sha256 of the source bytes/body — drives change detection.
  content_hash text,
  version int not null default 1,
  status public.thom_doc_status not null default 'pending_extract',
  -- Set when the heavy extraction pass succeeds.
  extracted_at timestamptz,
  -- Last extraction failure reason, for the ingest dashboard.
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_system, external_id)
);

create index if not exists kb_documents_type_scope_idx
  on public.kb_documents (doc_type, scope);
create index if not exists kb_documents_brand_idx on public.kb_documents (brand);
create index if not exists kb_documents_hash_idx on public.kb_documents (content_hash);
-- The ingest CLI's worklist: "everything still awaiting extraction".
create index if not exists kb_documents_pending_idx
  on public.kb_documents (status) where status = 'pending_extract';

create or replace function public.kb_documents_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists kb_documents_touch_trigger on public.kb_documents;
create trigger kb_documents_touch_trigger
  before update on public.kb_documents
  for each row execute function public.kb_documents_touch();

-- -----------------------------------------------------------------------------
-- kb_chunks — embedded text chunks.
--
-- scope/doc_type/brand are DENORMALIZED from the parent so the ANN scan can
-- filter without joining back to kb_documents (the join would defeat the HNSW
-- index). The ingest pipeline is the only writer, so they can't drift.
--
-- `page` is what makes citations honest: "source: <spec sheet> p.4" with a
-- link to the actual PDF.
-- -----------------------------------------------------------------------------
create table if not exists public.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.kb_documents(id) on delete cascade,
  scope public.thom_scope not null,
  doc_type text not null,
  brand text,
  chunk_index int not null,
  -- Source page for PDFs; null for articles/tickets/marketing copy.
  page int,
  content text not null,
  token_count int,
  embedding vector(1024) not null,
  search_tsv tsvector,
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);

-- HNSW, not ivfflat: no `lists` parameter to tune, no REINDEX as the corpus
-- grows from the initial backfill to the full catalog, and better recall at
-- low latency. Cosine distance to match bge-m3's normalized embeddings.
create index if not exists kb_chunks_embedding_hnsw
  on public.kb_chunks using hnsw (embedding vector_cosine_ops);

create index if not exists kb_chunks_search_tsv_idx
  on public.kb_chunks using gin (search_tsv);
create index if not exists kb_chunks_scope_type_idx
  on public.kb_chunks (scope, doc_type);
create index if not exists kb_chunks_document_idx on public.kb_chunks (document_id);

create or replace function public.kb_chunks_search_tsv_update() returns trigger
language plpgsql as $$
begin
  new.search_tsv := to_tsvector('english', coalesce(new.content, ''));
  return new;
end;
$$;

drop trigger if exists kb_chunks_search_tsv_trigger on public.kb_chunks;
create trigger kb_chunks_search_tsv_trigger
  before insert or update of content on public.kb_chunks
  for each row execute function public.kb_chunks_search_tsv_update();

-- -----------------------------------------------------------------------------
-- product_documents — links spec sheets / manuals to SKUs and families.
--
-- A join table rather than columns on `products`: one product has many
-- documents, and one document (an install manual) often covers a whole family.
-- Deliberately NO foreign key to products(sku) — `products` is a prunable cache
-- refreshed from Sales Layer, same reasoning as product_content (0015).
--
-- This is what powers a product card's "Spec Sheet" / "Installation Manual"
-- download buttons and the citation back-link.
-- -----------------------------------------------------------------------------
create table if not exists public.product_documents (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.kb_documents(id) on delete cascade,
  -- Set for a product-level document; null when the doc covers a family.
  product_sku text,
  -- Set when the document covers a family rather than one PPID.
  family text,
  doc_type text not null,
  -- Human label for the download button ("Specification Sheet").
  label text,
  -- Direct download URL (Sales Layer CDN).
  url text not null,
  -- Denormalized from the parent document so RLS needs no subquery.
  scope public.thom_scope not null default 'public',
  created_at timestamptz not null default now()
);

-- Nulls compare as distinct in a plain unique constraint, which would let a
-- family-level doc be inserted repeatedly. Two partial indexes cover both
-- shapes properly.
create unique index if not exists product_documents_doc_sku_uniq
  on public.product_documents (document_id, product_sku)
  where product_sku is not null;
create unique index if not exists product_documents_doc_family_uniq
  on public.product_documents (document_id, family)
  where product_sku is null;

create index if not exists product_documents_sku_idx
  on public.product_documents (product_sku);
create index if not exists product_documents_family_idx
  on public.product_documents (family);

-- -----------------------------------------------------------------------------
-- products.embedding — semantic half of product search.
-- Backfilled by the ingest pipeline; lexical search_tsv (0008/0010) is unchanged.
-- -----------------------------------------------------------------------------
alter table public.products
  add column if not exists embedding vector(1024);

create index if not exists products_embedding_hnsw
  on public.products using hnsw (embedding vector_cosine_ops);

-- -----------------------------------------------------------------------------
-- RLS: read split by scope. Public rows are readable by everyone (including the
-- anon role used by the public bubble); internal rows only by active internal
-- users and admins. Writes are service-role only — no write policies.
--
-- This is layer 2 of the scope guarantee. Layer 1 is that the public Worker
-- holds no service-role key and no HubSpot credentials; layer 3 is that the
-- public agent never registers internal tools. A prompt is not a layer.
-- -----------------------------------------------------------------------------
alter table public.kb_documents enable row level security;
alter table public.kb_chunks enable row level security;
alter table public.product_documents enable row level security;

drop policy if exists kb_documents_select on public.kb_documents;
create policy kb_documents_select on public.kb_documents
  for select using (
    scope = 'public' or public.is_active_internal_or_admin()
  );

drop policy if exists kb_chunks_select on public.kb_chunks;
create policy kb_chunks_select on public.kb_chunks
  for select using (
    scope = 'public' or public.is_active_internal_or_admin()
  );

drop policy if exists product_documents_select on public.product_documents;
create policy product_documents_select on public.product_documents
  for select using (
    scope = 'public' or public.is_active_internal_or_admin()
  );

-- -----------------------------------------------------------------------------
-- kb_search — the retrieval primitive.
--
-- SECURITY INVOKER so it runs as the caller and RLS still applies: a public
-- caller physically cannot pull scope='internal' chunks, even if `scope_filter`
-- were wrong or spoofed. That is the point.
--
-- Fusion is Reciprocal Rank Fusion (RRF, k=60) over two independently-limited
-- branches rather than a weighted score blend. Two reasons: each branch keeps
-- its own index (the vector branch's ORDER BY ... <=> ... LIMIT is what lets
-- HNSW work at all — filtering into a CTE first would force a full scan), and
-- RRF needs no score normalization between cosine distance and ts_rank, which
-- are not on comparable scales.
-- -----------------------------------------------------------------------------
create or replace function public.kb_search(
  query_embedding vector(1024),
  query_text text default null,
  scope_filter text default 'public',
  doc_types text[] default null,
  brand_filter text default null,
  match_count int default 8
)
returns table (
  chunk_id uuid,
  document_id uuid,
  doc_type text,
  brand text,
  title text,
  url text,
  page int,
  content text,
  score real
)
language sql
stable
security invoker
as $$
  with vec as (
    select c.id, row_number() over (order by c.embedding <=> query_embedding) as rank
    from public.kb_chunks c
    join public.kb_documents d on d.id = c.document_id
    where d.status = 'active'
      and (scope_filter is null or c.scope::text = scope_filter)
      and (doc_types is null or c.doc_type = any (doc_types))
      and (brand_filter is null or c.brand = brand_filter)
    order by c.embedding <=> query_embedding
    limit greatest(match_count * 5, 50)
  ),
  lex as (
    select c.id,
           row_number() over (
             order by ts_rank(c.search_tsv, websearch_to_tsquery('english', query_text)) desc
           ) as rank
    from public.kb_chunks c
    join public.kb_documents d on d.id = c.document_id
    where query_text is not null and query_text <> ''
      and c.search_tsv @@ websearch_to_tsquery('english', query_text)
      and d.status = 'active'
      and (scope_filter is null or c.scope::text = scope_filter)
      and (doc_types is null or c.doc_type = any (doc_types))
      and (brand_filter is null or c.brand = brand_filter)
    order by ts_rank(c.search_tsv, websearch_to_tsquery('english', query_text)) desc
    limit greatest(match_count * 5, 50)
  ),
  fused as (
    select id, sum(1.0 / (60 + rank)) as score
    from (select id, rank from vec union all select id, rank from lex) r
    group by id
  )
  select
    c.id, c.document_id, c.doc_type, c.brand, d.title, d.url, c.page, c.content,
    f.score::real
  from fused f
  join public.kb_chunks c on c.id = f.id
  join public.kb_documents d on d.id = c.document_id
  order by f.score desc
  limit match_count;
$$;

grant execute on function
  public.kb_search(vector, text, text, text[], text, int) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- product_semantic_search — same RRF hybrid over the products catalog.
-- Lexical half reuses the existing products.search_tsv (0008/0010), so brand
-- and variant model numbers still rank as primary matches.
-- -----------------------------------------------------------------------------
create or replace function public.product_semantic_search(
  query_embedding vector(1024),
  query_text text default null,
  brand_filter text default null,
  category_filter text default null,
  match_count int default 8
)
returns table (
  id uuid,
  sku text,
  name text,
  brand text,
  category text,
  primary_image_url text,
  score real
)
language sql
stable
security invoker
as $$
  with vec as (
    select p.id, row_number() over (order by p.embedding <=> query_embedding) as rank
    from public.products p
    where p.embedding is not null
      and (brand_filter is null or p.brand = brand_filter)
      and (category_filter is null or p.category = category_filter)
    order by p.embedding <=> query_embedding
    limit greatest(match_count * 5, 50)
  ),
  lex as (
    select p.id,
           row_number() over (
             order by ts_rank(p.search_tsv, websearch_to_tsquery('english', query_text)) desc
           ) as rank
    from public.products p
    where query_text is not null and query_text <> ''
      and p.search_tsv @@ websearch_to_tsquery('english', query_text)
      and (brand_filter is null or p.brand = brand_filter)
      and (category_filter is null or p.category = category_filter)
    order by ts_rank(p.search_tsv, websearch_to_tsquery('english', query_text)) desc
    limit greatest(match_count * 5, 50)
  ),
  fused as (
    select id, sum(1.0 / (60 + rank)) as score
    from (select id, rank from vec union all select id, rank from lex) r
    group by id
  )
  select p.id, p.sku, p.name, p.brand, p.category, p.primary_image_url, f.score::real
  from fused f
  join public.products p on p.id = f.id
  order by f.score desc
  limit match_count;
$$;

grant execute on function
  public.product_semantic_search(vector, text, text, text, int) to anon, authenticated;
