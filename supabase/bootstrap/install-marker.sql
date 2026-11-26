-- Durable identity for databases initialized by this installer.
create schema social_install;
revoke all on schema social_install from public, anon, authenticated;
create table social_install.installation (
  singleton boolean primary key default true check (singleton),
  project_ref text not null check (project_ref ~ '^[a-z0-9]{20}$')
);
insert into social_install.installation(project_ref) values (:'project_ref');
