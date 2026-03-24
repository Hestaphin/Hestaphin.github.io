create extension if not exists pgcrypto;

create type public.puco_role as enum ('admin', 'internal', 'member');
create type public.membership_status as enum ('pending', 'active', 'expired', 'cancelled');
create type public.payment_status as enum ('pending', 'paid', 'failed', 'cancelled');

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text,
  role public.puco_role not null default 'member',
  membership_tier text,
  membership_status public.membership_status,
  paid_through timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.membership_plans (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  price_cents integer not null check (price_cents > 0),
  currency text not null default 'cny',
  stripe_price_id text not null unique,
  duration_months integer not null default 12,
  active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.membership_checkout_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  plan_id uuid not null references public.membership_plans(id),
  plan_name text not null,
  amount_cents integer not null,
  currency text not null default 'cny',
  stripe_checkout_session_id text unique,
  payment_status public.payment_status not null default 'pending',
  fulfilled_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.membership_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  plan_id uuid not null references public.membership_plans(id),
  plan_name text not null,
  amount_cents integer not null,
  currency text not null default 'cny',
  payment_status public.payment_status not null default 'pending',
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  paid_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.internal_messages (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text,
  from_user_id uuid not null references public.profiles(user_id) on delete cascade,
  from_email text not null,
  broadcast boolean not null default false,
  attachment_path text,
  attachment_name text,
  attachment_type text,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.internal_message_recipients (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.internal_messages(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  unique (message_id, user_id)
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.membership_plans enable row level security;
alter table public.membership_checkout_requests enable row level security;
alter table public.membership_orders enable row level security;
alter table public.internal_messages enable row level security;
alter table public.internal_message_recipients enable row level security;

create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.profiles
    where user_id = uid
      and role = 'admin'
  );
$$;

create policy "profiles_select_self_or_admin"
on public.profiles
for select
to authenticated
using (
  auth.uid() = user_id
  or public.is_admin(auth.uid())
);

create policy "profiles_insert_self"
on public.profiles
for insert
to authenticated
with check (
  auth.uid() = user_id
  and email = auth.email()
  and role = 'member'
);

create policy "membership_plans_select_active"
on public.membership_plans
for select
to anon, authenticated
using (active = true);

create policy "membership_orders_select_self_or_admin"
on public.membership_orders
for select
to authenticated
using (
  auth.uid() = user_id
  or public.is_admin(auth.uid())
);

create policy "internal_messages_select_visible"
on public.internal_messages
for select
to authenticated
using (
  public.is_admin(auth.uid())
  or broadcast = true
  or exists (
    select 1
    from public.internal_message_recipients r
    where r.message_id = id
      and r.user_id = auth.uid()
  )
);

create policy "internal_messages_insert_admin_only"
on public.internal_messages
for insert
to authenticated
with check (public.is_admin(auth.uid()));

create policy "internal_message_recipients_select_self_or_admin"
on public.internal_message_recipients
for select
to authenticated
using (
  public.is_admin(auth.uid())
  or user_id = auth.uid()
);

create policy "internal_message_recipients_insert_admin_only"
on public.internal_message_recipients
for insert
to authenticated
with check (public.is_admin(auth.uid()));

insert into public.membership_plans (slug, name, description, price_cents, currency, stripe_price_id, duration_months)
values
  ('Membership Standard', 'Membership Standard', 'Annual PUCO membership with magazine and shop discount.', 19900, 'cny', 'price_STANDARD_REPLACE_ME', 12),
  ('Membership Supporter', 'Membership Supporter', 'Annual supporter tier with additional souvenirs and benefits.', 39900, 'cny', 'price_SUPPORTER_REPLACE_ME', 12),
  ('Membership Patron', 'Membership Patron', 'Annual patron tier for highest supporter level.', 99900, 'cny', 'price_PATRON_REPLACE_ME', 12)
on conflict (slug) do nothing;

insert into storage.buckets (id, name, public)
values ('internal-files', 'internal-files', false)
on conflict (id) do nothing;

create policy "internal_files_admin_upload"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'internal-files'
  and public.is_admin(auth.uid())
);

create policy "internal_files_admin_delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'internal-files'
  and public.is_admin(auth.uid())
);

create policy "internal_files_visible_to_recipient"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'internal-files'
  and (
    public.is_admin(auth.uid())
    or exists (
      select 1
      from public.internal_messages m
      left join public.internal_message_recipients r on r.message_id = m.id
      where m.attachment_path = storage.objects.name
        and (
          m.broadcast = true
          or r.user_id = auth.uid()
        )
    )
  )
);
