# Lead Tracker

A full-stack real estate CRM built for a sub-team at commercial real estate firm. Lead Tracker allows real estate agents to track buyer leads organized by property, with automatic lead capture from Outlook emails via Microsoft Graph API.

## Live Demo
[Lead Tracker.vercel.app](https://lead-tracker-wine.vercel.app)

## Features

- **Microsoft OAuth Login** — agents sign in with their existing Microsoft/Outlook account via Azure Active Directory
- **Automatic Email Scraping** — syncs the agent's Outlook inbox and automatically extracts buyer leads from property inquiry emails
- **Property Management** — add and organize properties by name and address
- **Lead Tracking** — log buyer contact info (name, phone, email, notes) linked to specific properties
- **Multi-Agent Support** — each agent only sees their own properties and leads
- **Secure by Design** — JWT authentication, IDOR protection, rate limiting, and input sanitization

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React, Vite, Axios |
| Backend | Node.js, Express.js |
| Database | PostgreSQL (Supabase) |
| Auth | Microsoft Azure AD, JWT |
| Email | Microsoft Graph API |
| Deployment | Railway (backend), Vercel (frontend) |

## Security

- **httpOnly Session Cookies** — JWT stored in `httpOnly`, `Secure`, `SameSite` cookies (never in `localStorage`/`sessionStorage`)
- **IDOR Protection** — every request verifies the resource belongs to the requesting user
- **Server-side session auth** — JWT re-verified from httpOnly cookie on every protected route; role checked via `requireRole`
- **Supabase RLS** — anon key blocked at the database layer (`supabase/rls.sql`); API uses service role key
- **Rate Limiting** — max 100 requests per 15 minutes per IP
- **Input Sanitization** — all user inputs validated and escaped via express-validator
- **CORS** — restricted to the production frontend domain only

## Architecture
Browser (Vercel)
↓ HTTPS
Express API (Railway)
↓
Supabase PostgreSQL
↓
Microsoft Graph API (Outlook)

## Getting Started

### Prerequisites
- Node.js v18+
- Supabase account
- Microsoft Azure account (for OAuth)

### Environment Variables

Create a `.env` file in the root:

```env
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
AZURE_CLIENT_ID=your_azure_client_id
AZURE_TENANT_ID=your_azure_tenant_id
AZURE_CLIENT_SECRET=your_azure_client_secret
JWT_SECRET=your_random_secret
REQUIRE_EMAIL_VERIFICATION=true
RESEND_API_KEY=your_resend_api_key
EMAIL_FROM=Lead Tracker <noreply@yourdomain.com>
PORT=3000
NODE_ENV=development
```

### Installation

```bash
# Install backend dependencies
npm install

# Install frontend dependencies
cd frontend
npm install
```

### Running Locally

```bash
# Start backend (from root)
node index.js

# Start frontend (from frontend/)
npm run dev
```

## Database Schema

```sql
-- Properties table
create table properties (
  id uuid default gen_random_uuid() primary key,
  user_id text not null,
  name text not null,
  address text,
  owner_name text,
  owner_phone text,
  owner_email text,
  owner_notes text,
  created_at timestamp default now()
);

-- Leads table
create table leads (
  id uuid default gen_random_uuid() primary key,
  property_id uuid references properties(id) on delete cascade,
  user_id text not null,
  name text,
  phone text,
  email text,
  notes text,
  date_contacted date,
  created_at timestamp default now()
);
```

Apply row-level security in Supabase (SQL Editor):

```bash
# Paste and run supabase/rls.sql
# Paste and run supabase/users.sql
```

### Email verification

This app uses **Microsoft OAuth** (not Supabase Auth or Clerk). Required email verification is enforced server-side via the `users.email_confirmed_at` column.

**Setting to enable/disable:** set `REQUIRE_EMAIL_VERIFICATION=true` in Railway (default). Set to `false` only for local dev without email delivery.

**Send verification emails:** set `RESEND_API_KEY` and `EMAIL_FROM` in Railway. Without Resend, the verification link is logged to the server console.

## Deployment

- **Backend** — push to GitHub, Railway auto-deploys
- **Frontend** — push to GitHub, Vercel auto-deploys
- **Environment variables** — set in Railway and Vercel dashboards separately from code

## Author

Humza Hassan — [github.com/humzahassan1](https://github.com/humzahassan1)
