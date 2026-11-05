create table if not exists runtime_installation (
  id integer primary key check (id = 1),
  client_id text not null
);
