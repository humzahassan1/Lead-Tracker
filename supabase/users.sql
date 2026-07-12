-- Users table for email verification (Microsoft OAuth user IDs)
create table if not exists users (
  id text primary key,
  email text not null,
  email_confirmed_at timestamptz,
  verification_token text,
  verification_sent_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists users_verification_token_idx on users (verification_token);
