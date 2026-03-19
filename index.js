require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const msal = require('@azure/msal-node');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json());

// ---- SUPABASE ----
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ---- RATE LIMITING ----
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, slow down.' }
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
const tokenCache = {}; // stores tokens per user

// ---- STEP 1: Login redirect ----
app.get('/auth/login', (req, res) => {
  const authUrl = pca.getAuthCodeUrl({
    scopes: ['Mail.Read', 'User.Read'],
    redirectUri: 'http://localhost:3000/auth/callback',
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
      redirectUri: 'http://localhost:3000/auth/callback',
    });

    const userId = result.account.homeAccountId;
    const userEmail = result.account.username;
    tokenCache[userId] = result.accessToken;

    // Save user to Supabase if they don't exist
    await supabase.from('properties').select('id').eq('user_id', userId).limit(1);

    res.json({
      message: 'Login successful!',
      userId,
      userEmail,
      note: 'Save your userId — you need it to make API calls'
    });
  } catch (err) {
    res.status(500).send('Auth failed: ' + err.message);
  }
});

// ---- IDOR PROTECTION ----
async function verifyPropertyOwner(propertyId, userId) {
  const { data, error } = await supabase
    .from('properties')
    .select('id')
    .eq('id', propertyId)
    .eq('user_id', userId)
    .single();
  return !error && data;
}

// ---- EMAIL SCRAPER ----
function extractLeadInfo(email) {
  const body = email.body?.content || '';
  const subject = email.subject || '';
  const fullText = subject + ' ' + body;

  // Extract phone numbers
  const phoneMatch = fullText.match(/(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/);
  const phone = phoneMatch ? phoneMatch[0] : null;

  // Extract email addresses
  const emailMatch = fullText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const senderEmail = emailMatch ? emailMatch[0] : email.from?.emailAddress?.address;

  // Extract property address (looks for street patterns)
  const addressMatch = fullText.match(/\d+\s+[A-Z][a-zA-Z]+\s+(Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Blvd|Boulevard|Way|Court|Ct)/i);
  const property = addressMatch ? addressMatch[0] : null;

  // Sender name
  const senderName = email.from?.emailAddress?.name || 'Unknown';

  return { senderName, senderEmail, phone, property, subject };
}

// ---- SYNC EMAILS ----
app.post('/sync-emails', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Missing user ID' });

  const token = tokenCache[userId];
  if (!token) return res.status(401).json({ error: 'Not logged in. Visit /auth/login first' });

  try {
    // Fetch last 50 emails from Outlook
    const response = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=50&$orderby=receivedDateTime desc&$select=subject,from,body,receivedDateTime', {
      headers: { Authorization: `Bearer ${token}` }
    });

    const data = await response.json();
    if (!data.value) return res.status(500).json({ error: 'Could not fetch emails', details: data });

    const emails = data.value;
    const results = [];

    for (const email of emails) {
      const lead = extractLeadInfo(email);

      // Only process emails that look like property inquiries
      const keywords = ['property', 'house', 'home', 'listing', 'interested', 'real estate', 'viewing', 'tour', 'offer', 'bedroom', 'bathroom', 'price', 'address'];
      const isRelevant = keywords.some(k => (email.subject + email.body?.content).toLowerCase().includes(k));
      if (!isRelevant) continue;

      // Find or create property
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

      // Save lead
      if (propertyId && lead.senderEmail) {
        // Check if lead already exists to avoid duplicates
        const { data: existingLead } = await supabase
          .from('leads')
          .select('id')
          .eq('property_id', propertyId)
          .eq('email', lead.senderEmail)
          .single();

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
app.get('/properties', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Missing user ID' });

  const { data, error } = await supabase
    .from('properties')
    .select('*')
    .eq('user_id', userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/properties', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Missing user ID' });

  const { name, address } = req.body;
  if (!name) return res.status(400).json({ error: 'Property name is required' });

  const { data, error } = await supabase
    .from('properties')
    .insert({ name, address, user_id: userId })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---- LEADS ----
app.get('/properties/:propertyId/leads', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Missing user ID' });

  const owns = await verifyPropertyOwner(req.params.propertyId, userId);
  if (!owns) return res.status(403).json({ error: 'Access denied' });

  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('property_id', req.params.propertyId);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/properties/:propertyId/leads', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Missing user ID' });

  const owns = await verifyPropertyOwner(req.params.propertyId, userId);
  if (!owns) return res.status(403).json({ error: 'Access denied' });

  const { name, phone, email, notes, date_contacted } = req.body;

  const { data, error } = await supabase
    .from('leads')
    .insert({
      property_id: req.params.propertyId,
      user_id: userId,
      name, phone, email, notes, date_contacted
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/leads/:leadId', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Missing user ID' });

  const { data: lead, error: leadError } = await supabase
    .from('leads')
    .select('id')
    .eq('id', req.params.leadId)
    .eq('user_id', userId)
    .single();

  if (leadError || !lead) return res.status(403).json({ error: 'Access denied' });

  const { error } = await supabase
    .from('leads')
    .delete()
    .eq('id', req.params.leadId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ---- START ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Login at: http://localhost:${PORT}/auth/login`);
});