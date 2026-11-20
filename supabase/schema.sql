-- =============================================================================
-- Biblioteca do Convento — Schema Postgres & Row Level Security (Supabase)
-- =============================================================================
-- Como usar:
-- 1. No painel do Supabase, abra "SQL Editor" -> "New query".
-- 2. Cole todo este script e clique em "Run".
-- 3. Em "Authentication" -> "Providers" -> "Google", ative o provedor Google
--    e informe o mesmo Google Client ID configurado no site (marque
--    "Skip nonce checks" se usar login via Google Identity Services / ID Token).
-- =============================================================================

-- 1. Schema privado para funções internas de segurança e auditoria
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

-- 2. Tabela opcional de controle de acesso por e-mail (allowlist)
-- Enquanto estiver vazia, qualquer conta Google autenticada pode acessar o acervo.
-- Assim que você inserir e-mails nela, apenas os e-mails cadastrados terão acesso.
create table if not exists public.membros_autorizados (
  email text primary key,
  nome text,
  papel text not null default 'membro',
  criado_em timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'membros_autorizados_email_chk'
      and conrelid = 'public.membros_autorizados'::regclass
  ) then
    alter table public.membros_autorizados
      add constraint membros_autorizados_email_chk
      check (email = lower(btrim(email)) and char_length(email) between 3 and 254);
  end if;
end $$;

-- 3. Tabela principal do acervo (livros)
create table if not exists public.livros (
  id text primary key,
  data jsonb not null,
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  updated_by uuid references auth.users(id) on delete set null default auth.uid()
);

alter table public.livros
  add column if not exists updated_by uuid references auth.users(id) on delete set null default auth.uid();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'livros_id_len_chk'
      and conrelid = 'public.livros'::regclass
  ) then
    alter table public.livros
      add constraint livros_id_len_chk
      check (char_length(id) between 1 and 120);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'livros_data_valid_chk'
      and conrelid = 'public.livros'::regclass
  ) then
    alter table public.livros
      add constraint livros_data_valid_chk
      check (
        jsonb_typeof(data) = 'object'
        and char_length(btrim(coalesce(data->>'titulo', ''))) between 1 and 300
        and octet_length(data::text) <= 250000
      );
  end if;
end $$;

-- 4. Tabela de histórico de auditoria (logs — somente leitura e inserção / append-only)
create table if not exists public.logs (
  id text primary key,
  data jsonb not null,
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  created_by uuid references auth.users(id) on delete set null default auth.uid()
);

alter table public.logs
  add column if not exists created_by uuid references auth.users(id) on delete set null default auth.uid();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'logs_id_len_chk'
      and conrelid = 'public.logs'::regclass
  ) then
    alter table public.logs
      add constraint logs_id_len_chk
      check (char_length(id) between 1 and 120);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'logs_data_valid_chk'
      and conrelid = 'public.logs'::regclass
  ) then
    alter table public.logs
      add constraint logs_data_valid_chk
      check (
        jsonb_typeof(data) = 'object'
        and char_length(btrim(coalesce(data->>'acao', ''))) between 1 and 80
        and octet_length(data::text) <= 32000
      );
  end if;
end $$;

-- 5. Índices para performance de sincronização e buscas JSONB
create index if not exists livros_updated_at_idx on public.livros (updated_at desc);
create index if not exists livros_data_gin_idx on public.livros using gin (data jsonb_path_ops);
create index if not exists logs_updated_at_idx on public.logs (updated_at desc);

-- 6. Função de verificação de acesso em schema privado (SECURITY DEFINER com search_path fixo)
create or replace function private.is_authorized_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select auth.uid()) is not null
    and (
      not exists (select 1 from public.membros_autorizados)
      or exists (
        select 1
        from public.membros_autorizados m
        where m.email = lower(btrim(coalesce((select auth.jwt() ->> 'email'), '')))
      )
    );
$$;

revoke all on function private.is_authorized_member() from public, anon;
grant execute on function private.is_authorized_member() to authenticated, service_role;

-- 7. Trigger de auditoria para carimbar updated_at e autoria no servidor
create or replace function private.enforce_audit_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  if new.updated_at is null or new.updated_at <= 0 or new.updated_at > (now_ms + 60000) then
    new.updated_at := now_ms;
  end if;
  if tg_table_name = 'livros' then
    new.updated_by := (select auth.uid());
  elsif tg_table_name = 'logs' then
    new.created_by := (select auth.uid());
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_audit_fields() from public, anon, authenticated;

drop trigger if exists trg_livros_audit on public.livros;
create trigger trg_livros_audit
  before insert or update on public.livros
  for each row execute function private.enforce_audit_fields();

drop trigger if exists trg_logs_audit on public.logs;
create trigger trg_logs_audit
  before insert on public.logs
  for each row execute function private.enforce_audit_fields();

-- 8. Privilégios mínimos por role (Least Privilege)
revoke all on public.membros_autorizados from public, anon, authenticated;
revoke all on public.livros from public, anon;
revoke all on public.logs from public, anon;
revoke update, delete, truncate on public.logs from authenticated;

grant select on public.membros_autorizados to authenticated;
grant select, insert, update, delete on public.livros to authenticated;
grant select, insert on public.logs to authenticated;

-- 9. Habilitar e forçar Row Level Security (RLS) em todas as tabelas
alter table public.membros_autorizados enable row level security;
alter table public.membros_autorizados force row level security;

alter table public.livros enable row level security;
alter table public.livros force row level security;

alter table public.logs enable row level security;
alter table public.logs force row level security;

-- Remover políticas antigas inseguras caso existam
drop policy if exists "livros_all" on public.livros;
drop policy if exists "logs_all" on public.logs;
drop policy if exists "livros_select_auth" on public.livros;
drop policy if exists "livros_insert_auth" on public.livros;
drop policy if exists "livros_update_auth" on public.livros;
drop policy if exists "livros_delete_auth" on public.livros;
drop policy if exists "logs_select_auth" on public.logs;
drop policy if exists "logs_insert_auth" on public.logs;
drop policy if exists "membros_select_self" on public.membros_autorizados;

-- Políticas de RLS para public.membros_autorizados
create policy "membros_select_self"
  on public.membros_autorizados
  for select
  to authenticated
  using (email = lower(btrim(coalesce((select auth.jwt() ->> 'email'), ''))));

-- Políticas de RLS para public.livros (somente membros autenticados e autorizados)
create policy "livros_select_auth"
  on public.livros
  for select
  to authenticated
  using ((select private.is_authorized_member()));

create policy "livros_insert_auth"
  on public.livros
  for insert
  to authenticated
  with check ((select private.is_authorized_member()));

create policy "livros_update_auth"
  on public.livros
  for update
  to authenticated
  using ((select private.is_authorized_member()))
  with check ((select private.is_authorized_member()));

create policy "livros_delete_auth"
  on public.livros
  for delete
  to authenticated
  using ((select private.is_authorized_member()));

-- Políticas de RLS para public.logs (imutável: apenas SELECT e INSERT, nunca UPDATE/DELETE)
create policy "logs_select_auth"
  on public.logs
  for select
  to authenticated
  using ((select private.is_authorized_member()));

create policy "logs_insert_auth"
  on public.logs
  for insert
  to authenticated
  with check ((select private.is_authorized_member()));
