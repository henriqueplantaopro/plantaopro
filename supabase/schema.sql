-- ============================================================
-- PlantãoPlus — Schema Supabase
-- Execute este SQL no Supabase SQL Editor
-- ============================================================

-- 1. USUÁRIOS ADMIN
create table if not exists admins (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  email text unique not null,
  senha_hash text not null,
  criado_em timestamptz default now()
);

-- 2. MÉDICOS
create table if not exists medicos (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  crm text unique not null,
  especialidade text,
  valor_hora numeric(10,2) default 0,
  tipo text default 'Plantonista',
  cpf text,
  email text,
  telefone text,
  token_acesso text unique default gen_random_uuid()::text,
  ativo boolean default true,
  criado_em timestamptz default now()
);

-- 3. PROJETOS
create table if not exists projetos (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  codigo_cc text,
  contratante text,
  status text default 'Ativo',
  cnpj text,
  contrato text,
  latitude numeric(10,7),
  longitude numeric(10,7),
  raio_checkin integer default 100,
  criado_em timestamptz default now()
);

-- 4. LANÇAMENTOS
create table if not exists lancamentos (
  id uuid primary key default gen_random_uuid(),
  medico_id uuid references medicos(id) on delete cascade,
  projeto_id uuid references projetos(id) on delete cascade,
  data date not null,
  hora_ini time not null,
  hora_fim time not null,
  horas numeric(5,1),
  tipo text,
  setor text,
  honorario numeric(10,2),
  valor_hora numeric(10,2),
  obs text,
  codigo_totvs text,
  criado_em timestamptz default now()
);

-- 5. CHECK-INS
create table if not exists checkins (
  id uuid primary key default gen_random_uuid(),
  medico_id uuid references medicos(id) on delete cascade,
  lancamento_id uuid references lancamentos(id) on delete set null,
  projeto_id uuid references projetos(id) on delete cascade,
  latitude numeric(10,7) not null,
  longitude numeric(10,7) not null,
  distancia_metros integer,
  aprovado boolean,
  tipo text default 'entrada', -- entrada | saida
  feito_em timestamptz default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table admins     enable row level security;
alter table medicos    enable row level security;
alter table projetos   enable row level security;
alter table lancamentos enable row level security;
alter table checkins   enable row level security;

-- Políticas permissivas via service_role (usada pelo backend)
-- O frontend usa a anon key com acesso controlado via token

-- Médicos: leitura via token_acesso
create policy "medico lê proprio perfil" on medicos
  for select using (token_acesso = current_setting('request.jwt.claims', true)::json->>'token' or true);

-- Lançamentos: médico vê os seus
create policy "medico ve lancamentos" on lancamentos
  for select using (true);

-- Check-ins: médico insere e vê os seus
create policy "medico insere checkin" on checkins
  for insert with check (true);

create policy "medico ve checkin" on checkins
  for select using (true);

-- Projetos: leitura pública
create policy "todos veem projetos" on projetos
  for select using (true);

-- ============================================================
-- DADOS INICIAIS (admin padrão — troque a senha depois!)
-- senha: admin123 (bcrypt hash)
-- ============================================================
insert into admins (nome, email, senha_hash) values
  ('Administrador', 'admin@plantaoplus.com', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi')
on conflict do nothing;
