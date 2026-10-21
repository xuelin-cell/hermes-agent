create table marketplace_config (
  id integer primary key check (id = 1),
  value text not null
);

create table provider_preferences (
  service text primary key,
  enabled integer not null check (enabled in (0, 1)),
  created_at text not null,
  updated_at text not null
);
