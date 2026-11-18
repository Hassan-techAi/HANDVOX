# HANDVOX — Supabase Setup, Ownership, Backup & Deployment Guide

HANDVOX uses **Supabase Auth** and **Supabase PostgreSQL** exclusively (no SQLite), ensuring the project owner retains full control over the source code, database, authentication, admin roles, hosting, and domain.

## 1. Required Environment Variables

Configure these variables in `.env` or your hosting provider's secret manager:

### Frontend-Safe Variables (Vite Client)
- `VITE_SUPABASE_URL` — Your Supabase Project URL (`https://<project-ref>.supabase.co`).
- `VITE_SUPABASE_PUBLISHABLE_KEY` — Your Supabase Publishable (anon) API key.

### Server-Only Variables (Express Backend — NEVER prefix with `VITE_`)
- `SUPABASE_URL` — Your Supabase Project URL (can match `VITE_SUPABASE_URL`).
- `SUPABASE_SERVICE_ROLE_KEY` — Your Supabase Service Role / Secret API key (used exclusively on the server to verify JWTs and perform privileged admin actions).
- `APP_URL` — Public URL of your deployed app.

### Recommended Owner Bootstrap Variables (Server-Only)
- `OWNER_BOOTSTRAP_EMAIL` — Email address allowed to claim initial platform ownership at `/admin`.
- `OWNER_BOOTSTRAP_SECRET` — Secret passphrase (minimum 8 characters) used to claim the initial `owner` role cleanly.

## 2. Database Schema & Row-Level Security (RLS)

1. Open your Supabase project's **SQL Editor**.
2. Execute `supabase/migrations/001_handvox_schema.sql`.
3. This creates all 10 relational PostgreSQL tables (`profiles`, `user_roles`, `translation_sessions`, `sign_vocabulary`, `learning_lessons`, `learning_progress`, `user_feedback`, `contact_submissions`, `admin_audit_logs`, `platform_settings`), enables Row-Level Security on every table, and sets up the `handle_new_user()` trigger so every new signup receives a standard `'user'` role.
4. Once `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are configured, the server automatically seeds the verified ASL & ISL datasets and default settings idempotently when empty.

## 3. Supabase Authentication Configuration

1. In Supabase **Authentication -> Providers**:
   - Ensure **Email** provider is enabled with **Confirm email** turned on.
   - Optionally enable **Google** OAuth with your Google Cloud OAuth Client ID and Secret.
2. In Supabase **Authentication -> URL Configuration**:
   - Set **Site URL** to your live `APP_URL` (for example, your published `https://...run.app` or custom domain — never a placeholder domain).
   - Add `<APP_URL>/auth/callback`, `<APP_URL>/verify-email`, `<APP_URL>/reset-password`, and `<APP_URL>/dashboard` (or `<APP_URL>/**`) to **Redirect URLs**.

## 4. Initial Owner Account Setup (Security Policy)

- **Public registration never grants admin access.**
- Register your owner account via `/register` and confirm your email.
- Either:
  - Visit `/admin` while signed in and enter `OWNER_BOOTSTRAP_SECRET`, **or**
  - Promote your account directly in the Supabase SQL Editor:
    ```sql
    update public.user_roles
    set role = 'owner'
    where user_id = (select id from public.profiles where email = 'your-owner@domain.com');
    ```

## 5. Backup & Deployment

- **Database Backup**: Use Supabase Dashboard backups or `pg_dump` against your Supabase PostgreSQL connection string.
- **Application JSON Export**: Owners can export vocabulary, lessons, and platform settings from `/admin`.
- **Production Start**: `npm run build && npm start` (runs `tsx server.ts` on `PORT`, defaulting to `3000`).
