-- ============================================================
-- Conectado CRM — schema Supabase
-- Rode no SQL Editor do painel do Supabase.
-- Só é necessário quando você quiser usar o CRM em mais de um
-- dispositivo. Enquanto for só no seu computador, o localStorage
-- do admin já resolve.
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- leads ----------
create table if not exists leads (
  id               uuid primary key default gen_random_uuid(),
  dono             uuid references auth.users(id) default auth.uid(),

  nome             text not null,
  categoria        text,
  endereco         text,
  telefone         text,
  telefone_e164    text generated always as (
                     regexp_replace(coalesce(telefone,''), '[^0-9]', '', 'g')
                   ) stored,
  site             text,
  place_id         text,
  lat              double precision,
  lng              double precision,

  -- qualificação
  rating           numeric(2,1),
  reviews          integer,
  sem_chat         boolean default true,
  horario_limitado boolean default false,
  score            integer default 0,
  sinais           text[] default '{}',

  -- pipeline
  status           text not null default 'novo'
                   check (status in ('novo','abordado','respondeu','reuniao','cliente','perdido')),
  origem           text,
  notas            text,
  ultimo_contato   timestamptz,
  criado_em        timestamptz default now(),
  atualizado_em    timestamptz default now()
);

-- não duplica a mesma loja pro mesmo dono
create unique index if not exists leads_dono_tel_uk
  on leads (dono, telefone_e164) where telefone_e164 <> '';
create index if not exists leads_status_ix on leads (dono, status);
create index if not exists leads_score_ix  on leads (dono, score desc);

-- ---------- histórico de interações ----------
create table if not exists interacoes (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid references leads(id) on delete cascade,
  dono       uuid references auth.users(id) default auth.uid(),
  tipo       text check (tipo in ('abordagem','followup','resposta','nota','etapa','reuniao')),
  texto      text,
  criado_em  timestamptz default now()
);
create index if not exists interacoes_lead_ix on interacoes (lead_id, criado_em desc);

-- ---------- templates de mensagem ----------
create table if not exists templates (
  id         uuid primary key default gen_random_uuid(),
  dono       uuid references auth.users(id) default auth.uid(),
  nome       text not null,
  texto      text not null,
  enviados   integer default 0,
  respostas  integer default 0,
  criado_em  timestamptz default now()
);

-- ---------- controle de cadência (anti-ban) ----------
create table if not exists envios_diarios (
  dono       uuid references auth.users(id) default auth.uid(),
  dia        date default current_date,
  quantidade integer default 0,
  primary key (dono, dia)
);

-- ---------- opt-out: quem pediu pra não ser contatado ----------
-- Exigência da LGPD. Antes de disparar, o admin deve conferir esta lista.
create table if not exists opt_out (
  telefone_e164 text primary key,
  motivo        text,
  criado_em     timestamptz default now()
);

-- ---------- atualiza timestamp ----------
create or replace function toca_atualizado_em()
returns trigger language plpgsql as $$
begin
  new.atualizado_em = now();
  return new;
end $$;

drop trigger if exists leads_touch on leads;
create trigger leads_touch before update on leads
  for each row execute function toca_atualizado_em();

-- ---------- segurança: cada usuário só vê o que é dele ----------
alter table leads          enable row level security;
alter table interacoes     enable row level security;
alter table templates      enable row level security;
alter table envios_diarios enable row level security;

drop policy if exists p_leads on leads;
create policy p_leads on leads
  for all using (dono = auth.uid()) with check (dono = auth.uid());

drop policy if exists p_inter on interacoes;
create policy p_inter on interacoes
  for all using (dono = auth.uid()) with check (dono = auth.uid());

drop policy if exists p_tpl on templates;
create policy p_tpl on templates
  for all using (dono = auth.uid()) with check (dono = auth.uid());

drop policy if exists p_env on envios_diarios;
create policy p_env on envios_diarios
  for all using (dono = auth.uid()) with check (dono = auth.uid());

-- ---------- métricas do painel ----------
create or replace view v_funil as
select
  dono,
  count(*)                                             as total,
  count(*) filter (where status = 'novo')              as novos,
  count(*) filter (where status = 'abordado')          as abordados,
  count(*) filter (where status = 'respondeu')         as responderam,
  count(*) filter (where status = 'reuniao')           as reunioes,
  count(*) filter (where status = 'cliente')           as clientes,
  count(*) filter (where status = 'perdido')           as perdidos,
  round(
    100.0 * count(*) filter (where status in ('respondeu','reuniao','cliente'))
    / nullif(count(*) filter (where status <> 'novo'), 0)
  , 1)                                                 as taxa_resposta
from leads
group by dono;

-- leads abordados há 2+ dias sem retorno: fila de follow-up
create or replace view v_followup as
select id, nome, telefone, score, ultimo_contato,
       (current_date - ultimo_contato::date) as dias_parado, dono
from leads
where status = 'abordado'
  and ultimo_contato < now() - interval '2 days'
order by score desc;
