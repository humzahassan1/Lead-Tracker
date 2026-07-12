require('dotenv').config();
const { body, validationResult } = require('express-validator');
const cors = require('cors');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const msal = require('@azure/msal-node');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const app = express();
const isDev = process.env.NODE_ENV !== 'production';

const SESSION_COOKIE = 'session';
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

function sessionCookieOptions() {
  // Local dev (localhost:5173 → localhost:3000) is same-site, so Lax works.
  // Production Vercel frontend + Railway API are cross-site; credentialed XHR
  // requires SameSite=None with Secure (Lax blocks cross-site subrequests).
  const sameSite = isDev ? 'lax' : 'none';
  return {
    httpOnly: true,
    secure: !isDev,
    sameSite,
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  };
}

app.use(express.json());
app.use(cookieParser());
app.use(cors({
  origin: ['https://lead-tracker-wine.vercel.app', 'http://localhost:5173'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

// ---- SUPABASE ----
// Service role bypasses RLS (server-only). RLS blocks direct anon-key access from browsers.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
);

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('SUPABASE_SERVICE_ROLE_KEY not set — using SUPABASE_KEY. Apply supabase/rls.sql and set the service role key in production.');
}

// ---- RATE LIMITING ----
app.set('trust proxy', 1);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, slow down.' },
  validate: { xForwardedForHeader: false }
});
app.use(limiter);

// ---- MICROSOFT AUTH ----
const msalConfig = {
  auth: {
    clientId: process.env.AZURE_CLIENT_ID,
    authority: `https://login.microsoftonline.com/common`,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
  }
};

const pca = new msal.ConfidentialClientApplication(msalConfig);
const tokenCache = {};

const USER_ROLE = 'agent';

// ---- SESSION / AUTHORIZATION ----
function verifySessionToken(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (!decoded.userId) throw new Error('Invalid session');
  return {
    userId: decoded.userId,
    userEmail: decoded.userEmail || '',
    role: decoded.role || USER_ROLE,
  };
}

function getSessionFromRequest(req) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  try {
    const session = verifySessionToken(token);
    return { ...session, msToken: tokenCache[session.userId] };
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const session = getSessionFromRequest(req);
  if (!session) {
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    return res.status(401).json({ error: 'Not logged in' });
  }

  req.userId = session.userId;
  req.userEmail = session.userEmail;
  req.userRole = session.role;
  req.msToken = session.msToken;
  next();
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.userRole || !allowedRoles.includes(req.userRole)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// ---- STEP 1: Login redirect ----
app.get('/auth/login', (req, res) => {
  const authUrl = pca.getAuthCodeUrl({
    scopes: ['Mail.Read', 'User.Read'],
    redirectUri: 'https://lead-tracker-production.up.railway.app/auth/callback',
  });
  authUrl.then(url => res.redirect(url)).catch(err => res.status(500).send(err.message));
});

// ---- STEP 2: Auth callback ----
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code provided');

  try {
    const result = await pca.acquireTokenByCode({
      code,
      scopes: ['Mail.Read', 'User.Read'],
      redirectUri: 'https://lead-tracker-production.up.railway.app/auth/callback',
    });

    const userId = result.account.homeAccountId;
    const userEmail = result.account.username;
    tokenCache[userId] = result.accessToken;

    const jwtToken = jwt.sign(
      { userId, userEmail, role: USER_ROLE },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.cookie(SESSION_COOKIE, jwtToken, sessionCookieOptions());

    const redirectTo = isDev
      ? 'http://localhost:5173'
      : 'https://lead-tracker-wine.vercel.app';

    res.redirect(redirectTo);
  } catch (err) {
    res.status(500).send('Auth failed: ' + err.message);
  }
});

// ---- LOGOUT ----
app.post('/auth/logout', requireAuth, (req, res) => {
  delete tokenCache[req.userId];
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
  res.json({ success: true });
});

// ---- GET CURRENT USER ----
app.get('/auth/me', requireAuth, requireRole(USER_ROLE), (req, res) => {
  res.json({ userId: req.userId, userEmail: req.userEmail, role: req.userRole });
});

// ---- IDOR PROTECTION ----
async function verifyPropertyOwner(propertyId, userId) {
  const { data, error } = await supabase
    .from('properties')
    .select('id')
    .eq('id', propertyId)
    .eq('user_id', userId)
    .maybeSingle();
  return !error && !!data;
}

async function verifyLeadOwner(leadId, userId) {
  const { data, error } = await supabase
    .from('leads')
    .select('id, property_id')
    .eq('id', leadId)
    .eq('user_id', userId)
    .maybeSingle();
  return (!error && data) ? data : null;
}

// ---- EMAIL SCRAPER ----
function extractLeadInfo(email) {
  const body = email.body?.content || '';
  const subject = email.subject || '';
  const fullText = subject + ' ' + body;

  const phoneMatch = fullText.match(/(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/);
  const phone = phoneMatch ? phoneMatch[0] : null;

  const emailMatch = fullText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const senderEmail = emailMatch ? emailMatch[0] : email.from?.emailAddress?.address;

  const addressMatch = fullText.match(/\d+\s+[A-Z][a-zA-Z]+\s+(Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Blvd|Boulevard|Way|Court|Ct)/i);
  const property = addressMatch ? addressMatch[0] : null;

  const senderName = email.from?.emailAddress?.name || 'Unknown';

  return { senderName, senderEmail, phone, property, subject };
}

// ---- SYNC EMAILS ----
app.post('/sync-emails', requireAuth, requireRole(USER_ROLE), async (req, res) => {
  const userId = req.userId;
  const token = req.msToken;
  if (!token) return res.status(401).json({ error: 'Microsoft token expired, please log in again' });

  try {
    const response = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=50&$orderby=receivedDateTime desc&$select=subject,from,body,receivedDateTime', {
      headers: { Authorization: `Bearer ${token}` }
    });

    const data = await response.json();
    if (!data.value) return res.status(500).json({ error: 'Could not fetch emails', details: data });

    const emails = data.value;
    const results = [];

    for (const email of emails) {
      const lead = extractLeadInfo(email);

      const keywords = ['property', 'house', 'home', 'listing', 'interested', 'real estate', 'viewing', 'tour', 'offer', 'bedroom', 'bathroom', 'price', 'address'];
      const isRelevant = keywords.some(k => (email.subject + email.body?.content).toLowerCase().includes(k));
      if (!isRelevant) continue;

      let propertyId;
      if (lead.property) {
        const { data: existing } = await supabase
          .from('properties')
          .select('id')
          .eq('user_id', userId)
          .ilike('name', `%${lead.property}%`)
          .single();

        if (existing) {
          propertyId = existing.id;
        } else {
          const { data: newProp } = await supabase
            .from('properties')
            .insert({ name: lead.property, address: lead.property, user_id: userId })
            .select()
            .single();
          propertyId = newProp?.id;
        }
      }

      if (propertyId && lead.senderEmail) {
        const { data: existingLead } = await supabase
          .from('leads')
          .select('id')
          .eq('property_id', propertyId)
          .eq('user_id', userId)
          .eq('email', lead.senderEmail)
          .maybeSingle();

        if (!existingLead) {
          await supabase.from('leads').insert({
            property_id: propertyId,
            user_id: userId,
            name: lead.senderName,
            email: lead.senderEmail,
            phone: lead.phone,
            notes: `Auto-imported from email: "${lead.subject}"`,
            date_contacted: new Date().toISOString().slice(0, 10)
          });
          results.push({ property: lead.property, lead: lead.senderName });
        }
      }
    }

    res.json({
      message: `Synced ${emails.length} emails, found ${results.length} new leads`,
      newLeads: results
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- PROPERTIES ----
app.get('/properties', requireAuth, requireRole(USER_ROLE), async (req, res) => {
  const { data, error } = await supabase
    .from('properties')
    .select('*')
    .eq('user_id', req.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/properties', requireAuth, requireRole(USER_ROLE), [
  body('name').trim().escape().notEmpty(),
  body('address').trim().escape()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { name, address } = req.body;

  const { data, error } = await supabase
    .from('properties')
    .insert({ name, address, user_id: req.userId })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---- LEADS ----
app.get('/properties/:propertyId/leads', requireAuth, requireRole(USER_ROLE), async (req, res) => {
  const owns = await verifyPropertyOwner(req.params.propertyId, req.userId);
  if (!owns) return res.status(403).json({ error: 'Access denied' });

  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('property_id', req.params.propertyId)
    .eq('user_id', req.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/properties/:propertyId/leads', requireAuth, requireRole(USER_ROLE), [
  body('name').trim().escape().notEmpty(),
  body('phone').trim().escape(),
  body('email').trim().normalizeEmail(),
  body('notes').trim().escape()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const owns = await verifyPropertyOwner(req.params.propertyId, req.userId);
  if (!owns) return res.status(403).json({ error: 'Access denied' });

  const { name, phone, email, notes, date_contacted } = req.body;

  const { data, error } = await supabase
    .from('leads')
    .insert({
      property_id: req.params.propertyId,
      user_id: req.userId,
      name, phone, email, notes, date_contacted
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/leads/:leadId', requireAuth, requireRole(USER_ROLE), async (req, res) => {
  const lead = await verifyLeadOwner(req.params.leadId, req.userId);
  if (!lead) return res.status(403).json({ error: 'Access denied' });

  const { error } = await supabase
    .from('leads')
    .delete()
    .eq('id', req.params.leadId)
    .eq('user_id', req.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/properties/:propertyId', requireAuth, requireRole(USER_ROLE), async (req, res) => {
  const owns = await verifyPropertyOwner(req.params.propertyId, req.userId);
  if (!owns) return res.status(403).json({ error: 'Access denied' });

  const { error } = await supabase
    .from('properties')
    .delete()
    .eq('id', req.params.propertyId)
    .eq('user_id', req.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ---- START ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Login at: http://localhost:${PORT}/auth/login`);
});