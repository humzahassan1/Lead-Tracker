require('dotenv').config();
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const cors = require('cors');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const msal = require('@azure/msal-node');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { authRateLimit } = require('./lib/authRateLimit');

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
const REQUIRE_EMAIL_VERIFICATION = process.env.REQUIRE_EMAIL_VERIFICATION !== 'false';
const FRONTEND_URL = isDev ? 'http://localhost:5173' : 'https://lead-tracker-wine.vercel.app';

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

async function attachUserRecord(req, res, next) {
  let { data, error } = await supabase
    .from('users')
    .select('email, email_confirmed_at')
    .eq('id', req.userId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Could not load user record' });

  if (!data) {
    try {
      await upsertUserOnLogin(req.userId, req.userEmail);
    } catch (upsertError) {
      return res.status(500).json({ error: upsertError.message });
    }
    ({ data, error } = await supabase
      .from('users')
      .select('email, email_confirmed_at')
      .eq('id', req.userId)
      .maybeSingle());
    if (error || !data) return res.status(500).json({ error: 'User record not found' });
  }

  req.userEmail = data.email;
  req.emailConfirmedAt = data.email_confirmed_at;
  req.emailVerified = !!data.email_confirmed_at;
  next();
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

function requireVerifiedEmail(req, res, next) {
  if (!REQUIRE_EMAIL_VERIFICATION) return next();
  if (!req.emailVerified) {
    return res.status(403).json({
      error: 'email_not_verified',
      message: 'Please verify your email before continuing.',
      email: req.userEmail,
    });
  }
  next();
}

async function sendVerificationEmail(email, token) {
  const verifyUrl = `${FRONTEND_URL}/?verify_token=${token}`;

  if (!process.env.RESEND_API_KEY) {
    console.log(`[email-verification] Link for ${email}: ${verifyUrl}`);
    return;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'Lead Tracker <onboarding@resend.dev>',
      to: email,
      subject: 'Verify your email — Lead Tracker',
      html: `<p>Please verify your email to use Lead Tracker.</p><p><a href="${verifyUrl}">Verify email</a></p><p>Or copy this link: ${verifyUrl}</p>`,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Failed to send verification email: ${details}`);
  }
}

async function upsertUserOnLogin(userId, userEmail) {
  const { data: existing, error } = await supabase
    .from('users')
    .select('id, email, email_confirmed_at')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;

  if (!existing) {
    const autoVerify = !REQUIRE_EMAIL_VERIFICATION;
    const verificationToken = autoVerify ? null : crypto.randomBytes(32).toString('hex');

    const { error: insertError } = await supabase.from('users').insert({
      id: userId,
      email: userEmail,
      email_confirmed_at: autoVerify ? new Date().toISOString() : null,
      verification_token: verificationToken,
      verification_sent_at: autoVerify ? null : new Date().toISOString(),
    });
    if (insertError) throw insertError;

    if (REQUIRE_EMAIL_VERIFICATION && verificationToken) {
      await sendVerificationEmail(userEmail, verificationToken);
    }
    return;
  }

  if (existing.email !== userEmail) {
    await supabase.from('users').update({ email: userEmail }).eq('id', userId);
  }
}

// ---- STEP 1: Login redirect (signup uses same Microsoft OAuth entry point) ----
app.get('/auth/login', authRateLimit('login'), (req, res) => {
  const authUrl = pca.getAuthCodeUrl({
    scopes: ['Mail.Read', 'User.Read'],
    redirectUri: 'https://lead-tracker-production.up.railway.app/auth/callback',
  });
  authUrl.then(url => res.redirect(url)).catch(err => res.status(500).send(err.message));
});

// ---- STEP 2: Auth callback ----
app.get('/auth/callback', authRateLimit('login-callback'), async (req, res) => {
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

    await upsertUserOnLogin(userId, userEmail);

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
app.get('/auth/me', requireAuth, attachUserRecord, requireRole(USER_ROLE), (req, res) => {
  res.json({
    userId: req.userId,
    userEmail: req.userEmail,
    role: req.userRole,
    emailVerified: req.emailVerified,
    email_confirmed_at: req.emailConfirmedAt,
    requireEmailVerification: REQUIRE_EMAIL_VERIFICATION,
  });
});

// ---- EMAIL VERIFICATION (password-reset equivalent) ----
app.get('/auth/verify-email', authRateLimit('verify-email', (req) => req.query.token || ''), async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Verification token required' });

  const { data: user, error } = await supabase
    .from('users')
    .select('id, email')
    .eq('verification_token', token)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!user) return res.status(400).json({ error: 'Invalid or expired verification link' });

  const { error: updateError } = await supabase
    .from('users')
    .update({
      email_confirmed_at: new Date().toISOString(),
      verification_token: null,
    })
    .eq('id', user.id);

  if (updateError) return res.status(500).json({ error: updateError.message });
  res.json({ success: true, email: user.email });
});

app.post('/auth/resend-verification', requireAuth, attachUserRecord, authRateLimit('resend-verification', (req) => req.userEmail), async (req, res) => {
  if (!REQUIRE_EMAIL_VERIFICATION) {
    return res.json({ success: true, message: 'Email verification is disabled' });
  }
  if (req.emailVerified) {
    return res.json({ success: true, message: 'Email already verified' });
  }

  const verificationToken = crypto.randomBytes(32).toString('hex');
  const { error } = await supabase
    .from('users')
    .update({
      verification_token: verificationToken,
      verification_sent_at: new Date().toISOString(),
    })
    .eq('id', req.userId);

  if (error) return res.status(500).json({ error: error.message });

  try {
    await sendVerificationEmail(req.userEmail, verificationToken);
    res.json({ success: true, message: 'Verification email sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
app.post('/sync-emails', requireAuth, attachUserRecord, requireVerifiedEmail, requireRole(USER_ROLE), async (req, res) => {
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
app.get('/properties', requireAuth, attachUserRecord, requireRole(USER_ROLE), async (req, res) => {
  const { data, error } = await supabase
    .from('properties')
    .select('*')
    .eq('user_id', req.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/properties', requireAuth, attachUserRecord, requireVerifiedEmail, requireRole(USER_ROLE), [
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
app.get('/properties/:propertyId/leads', requireAuth, attachUserRecord, requireVerifiedEmail, requireRole(USER_ROLE), async (req, res) => {
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

app.post('/properties/:propertyId/leads', requireAuth, attachUserRecord, requireVerifiedEmail, requireRole(USER_ROLE), [
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

app.delete('/leads/:leadId', requireAuth, attachUserRecord, requireVerifiedEmail, requireRole(USER_ROLE), async (req, res) => {
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

app.delete('/properties/:propertyId', requireAuth, attachUserRecord, requireVerifiedEmail, requireRole(USER_ROLE), async (req, res) => {
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