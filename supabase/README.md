# Supabase

Schema, RLS policies, and seed data for the WAC Marketing app.

## Project

- URL: `https://stmphhslrjhtzmvqilqu.supabase.co`
- Anon key: project Settings → API → `anon` `public` (frontend-safe)
- Service-role key: project Settings → API → `service_role` (server-only)

## Applying migrations

The easiest path during dev is to paste each migration file (in numeric order) into the Supabase SQL editor and run it.

Order:

1. `migrations/0001_extensions.sql`
2. `migrations/0002_schema.sql`
3. `migrations/0003_rls.sql`
4. `migrations/0004_search.sql`
5. `migrations/0005_seed.sql`

To apply via the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
supabase link --project-ref stmphhslrjhtzmvqilqu
supabase db push
```

## Auth setup

1. Auth → Providers → Google: ensure the OAuth client points back to `https://stmphhslrjhtzmvqilqu.supabase.co/auth/v1/callback`.
2. Auth → URL Configuration → add `http://localhost:5173` (dev) and the production URL (e.g. `https://marketing.wacgroup.com`) to the **Site URL** + **Additional Redirect URLs** list.
3. Approved corporate domains seeded in `0005_seed.sql`:
   - waclighting.com
   - wacgroup.com
   - modernforms.com
   - schonbek.com
   - waclighting.com.cn

You can edit `approved_domains` directly in the dashboard later.
