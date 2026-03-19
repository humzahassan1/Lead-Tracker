require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ---- SUPABASE ----
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ---- RATE LIMITING ----
// Max 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, slow down.' }
});
app.use(limiter);

// ---- HELPER: set user context for Row Level Security ----
async function setUserContext(client, userId) {
  await client.rpc('set_config', {
    setting: 'app.user_id',
    value: userId,
    is_local: true
  });
}

// ---- IDOR PROTECTION: verify property belongs to user ----
async function verifyPropertyOwner(propertyId, userId) {
  const { data, error } = await supabase
    .from('properties')
    .select('id')
    .eq('id', propertyId)
    .eq('user_id', userId)
    .single();
  return !error && data;
}

// ---- ROUTES ----

// Get all properties for a user
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

// Add a property
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

// Get all leads for a property (IDOR protected)
app.get('/properties/:propertyId/leads', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Missing user ID' });

  // IDOR check: make sure this property belongs to this user
  const owns = await verifyPropertyOwner(req.params.propertyId, userId);
  if (!owns) return res.status(403).json({ error: 'Access denied' });

  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('property_id', req.params.propertyId);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Add a lead to a property (IDOR protected)
app.post('/properties/:propertyId/leads', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Missing user ID' });

  // IDOR check
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

// Delete a lead (IDOR protected)
app.delete('/leads/:leadId', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Missing user ID' });

  // IDOR check: make sure this lead belongs to this user
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

// ---- START SERVER ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});