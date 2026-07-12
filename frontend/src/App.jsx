import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import './App.css'

const API = 'https://lead-tracker-production.up.railway.app'

const api = axios.create({
  baseURL: API,
  withCredentials: true,
})

function App() {
  const [userId, setUserId] = useState(null)
  const [userEmail, setUserEmail] = useState('')
  const [emailVerified, setEmailVerified] = useState(false)
  const [emailDeliveryConfigured, setEmailDeliveryConfigured] = useState(true)
  const [devVerifyUrl, setDevVerifyUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [properties, setProperties] = useState([])
  const [selectedProp, setSelectedProp] = useState(null)
  const [leads, setLeads] = useState([])
  const [view, setView] = useState('properties')
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [verifyMsg, setVerifyMsg] = useState('')
  const [resending, setResending] = useState(false)
  const [newProp, setNewProp] = useState({ name: '', address: '', owner_name: '', owner_phone: '', owner_email: '', owner_notes: '' })
  const [newLead, setNewLead] = useState({ name: '', phone: '', email: '', notes: '' })
  const [showAddProp, setShowAddProp] = useState(false)
  const [showAddLead, setShowAddLead] = useState(false)

  const checkAuth = useCallback(async () => {
    try {
      const res = await api.get('/auth/me')
      setUserId(res.data.userId)
      setUserEmail(res.data.userEmail)
      setEmailVerified(!!res.data.emailVerified)
      setEmailDeliveryConfigured(res.data.emailDeliveryConfigured !== false)
    } catch {
      setUserId(null)
      setUserEmail('')
      setEmailVerified(false)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    sessionStorage.removeItem('token')
    localStorage.removeItem('token')

    async function bootstrap() {
      const params = new URLSearchParams(window.location.search)
      const verifyToken = params.get('verify_token')

      if (verifyToken) {
        try {
          await api.get('/auth/verify-email', { params: { token: verifyToken } })
          setVerifyMsg('Email verified! You can now use Lead Tracker.')
          window.history.replaceState({}, '', '/?verified=1')
        } catch {
          setVerifyMsg('Verification link is invalid or expired. Request a new one below.')
          window.history.replaceState({}, '', '/')
        }
      } else if (params.get('verified') === '1') {
        setVerifyMsg('Email verified! You can now use Lead Tracker.')
        window.history.replaceState({}, '', '/')
      }

      await checkAuth()
    }

    bootstrap()
  }, [checkAuth])

  useEffect(() => {
    if (userId && emailVerified) loadProperties()
  }, [userId, emailVerified])

  async function loadProperties() {
    try {
      const res = await api.get('/properties')
      setProperties(res.data)
    } catch (err) {
      if (err.response?.status === 401) {
        setUserId(null)
        setEmailVerified(false)
      }
      if (err.response?.data?.error === 'email_not_verified') {
        setEmailVerified(false)
      }
    }
  }

  async function loadLeads(propId) {
    try {
      const res = await api.get(`/properties/${propId}/leads`)
      setLeads(res.data)
    } catch (err) {
      if (err.response?.data?.error === 'email_not_verified') {
        setEmailVerified(false)
      } else {
        console.error(err)
      }
    }
  }

  async function resendVerification() {
    setResending(true)
    setVerifyMsg('')
    setDevVerifyUrl('')
    try {
      const res = await api.post('/auth/resend-verification')
      if (res.data.devVerifyUrl) {
        setDevVerifyUrl(res.data.devVerifyUrl)
      }
      setVerifyMsg(res.data.message || 'Verification email sent.')
    } catch (err) {
      if (err.response?.status === 429) {
        const retry = err.response?.data?.retryAfterSec
        setVerifyMsg(retry
          ? `Too many attempts. Try again in ${retry} seconds.`
          : 'Too many attempts. Please wait 15 minutes and try again.')
      } else {
        setVerifyMsg(err.response?.data?.error || 'Could not send verification email.')
      }
    }
    setResending(false)
  }

  async function syncEmails() {
    setSyncing(true)
    setSyncMsg('')
    try {
      const res = await api.post('/sync-emails')
      setSyncMsg(res.data.message)
      loadProperties()
    } catch (err) {
      if (err.response?.status === 401) {
        setSyncMsg('Session expired. Please log in again.')
        setUserId(null)
      } else if (err.response?.data?.error === 'email_not_verified') {
        setEmailVerified(false)
        setSyncMsg('Verify your email before syncing.')
      } else {
        setSyncMsg('Sync failed. Try again.')
      }
    }
    setSyncing(false)
  }

  async function addProperty() {
    if (!newProp.name) return
    try {
      await api.post('/properties', newProp)
      setNewProp({ name: '', address: '', owner_name: '', owner_phone: '', owner_email: '', owner_notes: '' })
      setShowAddProp(false)
      loadProperties()
    } catch (err) {
      if (err.response?.data?.error === 'email_not_verified') setEmailVerified(false)
    }
  }

  async function addLead() {
    if (!newLead.name) return
    try {
      await api.post(`/properties/${selectedProp.id}/leads`, newLead)
      setNewLead({ name: '', phone: '', email: '', notes: '' })
      setShowAddLead(false)
      loadLeads(selectedProp.id)
    } catch (err) {
      if (err.response?.data?.error === 'email_not_verified') setEmailVerified(false)
    }
  }

  async function deleteLead(leadId) {
    if (!window.confirm('Delete this lead?')) return
    try {
      await api.delete(`/leads/${leadId}`)
      loadLeads(selectedProp.id)
    } catch (err) {
      if (err.response?.data?.error === 'email_not_verified') setEmailVerified(false)
    }
  }

  async function deleteProperty(propId) {
    if (!window.confirm('Delete this property and all its leads?')) return
    try {
      await api.delete(`/properties/${propId}`)
      setView('properties')
      loadProperties()
    } catch (err) {
      if (err.response?.data?.error === 'email_not_verified') setEmailVerified(false)
    }
  }

  async function logout() {
    try {
      await api.post('/auth/logout')
    } catch {
      // ignore
    }
    setUserId(null)
    setUserEmail('')
    setEmailVerified(false)
    setProperties([])
    setVerifyMsg('')
  }

  function openProperty(prop) {
    setSelectedProp(prop)
    loadLeads(prop.id)
    setView('leads')
  }

  if (loading) {
    return (
      <div className="login-page">
        <div className="login-box">
          <p style={{ color: '#888' }}>Loading...</p>
        </div>
      </div>
    )
  }

  if (!userId) {
    return (
      <div className="login-page">
        <div className="login-box">
          <h1>🏠 Lead Tracker</h1>
          <p>Sign in with Microsoft to access your property leads</p>
          <a href={`${API}/auth/login`} className="login-btn">
            Sign in with Microsoft
          </a>
        </div>
      </div>
    )
  }

  if (!emailVerified) {
    return (
      <div className="login-page">
        <div className="login-box verify-box">
          <h1>✉ Verify your email</h1>
          {emailDeliveryConfigured ? (
            <p>We sent a verification link to:</p>
          ) : (
            <p>Email sending is not configured on the server yet. Click resend after your admin sets <code>RESEND_API_KEY</code> in Railway, or use a dev link below.</p>
          )}
          <p className="verify-email">{userEmail}</p>
          <p>Click the link in that email to unlock syncing, leads, and property edits.</p>
          {verifyMsg && <div className="sync-msg">{verifyMsg}</div>}
          {devVerifyUrl && (
            <p className="verify-dev-link">
              Dev link: <a href={devVerifyUrl}>Verify now</a>
            </p>
          )}
          <div className="verify-actions">
            <button className="login-btn" onClick={resendVerification} disabled={resending}>
              {resending ? 'Sending...' : 'Resend verification email'}
            </button>
            <button className="logout-btn" onClick={logout}>Logout</button>
          </div>
        </div>
      </div>
    )
  }

  if (view === 'leads' && selectedProp) {
    return (
      <div className="app">
        <header>
          <button className="back-btn" onClick={() => setView('properties')}>← Back</button>
          <h2>{selectedProp.name}</h2>
          <button className="add-btn" onClick={() => setShowAddLead(true)}>+ Add Lead</button>
        </header>

        {showAddLead && (
          <div className="form-card">
            <h3>Add Lead</h3>
            <input placeholder="Name" value={newLead.name} onChange={e => setNewLead({ ...newLead, name: e.target.value })} />
            <input placeholder="Phone" value={newLead.phone} onChange={e => setNewLead({ ...newLead, phone: e.target.value })} />
            <input placeholder="Email" value={newLead.email} onChange={e => setNewLead({ ...newLead, email: e.target.value })} />
            <textarea placeholder="Notes" value={newLead.notes} onChange={e => setNewLead({ ...newLead, notes: e.target.value })} />
            <div className="form-btns">
              <button onClick={() => setShowAddLead(false)}>Cancel</button>
              <button className="primary" onClick={addLead}>Save</button>
            </div>
          </div>
        )}

        <div className="list">
          {leads.length === 0 && <p className="empty">No leads yet. Add one or sync emails.</p>}
          {leads.map(lead => (
            <div className="card" key={lead.id}>
              <div className="card-name">{lead.name}</div>
              {lead.phone && <div className="card-meta">📞 {lead.phone}</div>}
              {lead.email && <div className="card-meta">✉ {lead.email}</div>}
              {lead.notes && <div className="card-notes">{lead.notes}</div>}
              <button
                onClick={() => deleteLead(lead.id)}
                style={{ marginTop: 8, background: 'none', border: '1px solid #5a1a1a', color: '#e05555', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid #222' }}>
          <button
            onClick={() => deleteProperty(selectedProp.id)}
            style={{ background: 'none', border: '1px solid #5a1a1a', color: '#e05555', borderRadius: 6, padding: '8px 16px', fontSize: 13, cursor: 'pointer', width: '100%' }}
          >
            Delete Property
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <header>
        <h1>🏠 Lead Tracker</h1>
        <div className="header-btns">
          <button className="sync-btn" onClick={syncEmails} disabled={syncing}>
            {syncing ? 'Syncing...' : '⟳ Sync Emails'}
          </button>
          <button className="add-btn" onClick={() => setShowAddProp(true)}>+ Property</button>
          <button className="logout-btn" onClick={logout}>Logout</button>
        </div>
      </header>

      {verifyMsg && <div className="sync-msg">{verifyMsg}</div>}
      {syncMsg && <div className="sync-msg">{syncMsg}</div>}

      {showAddProp && (
        <div className="form-card">
          <h3>Add Property</h3>
          <input placeholder="Property name" value={newProp.name} onChange={e => setNewProp({ ...newProp, name: e.target.value })} />
          <input placeholder="Address" value={newProp.address} onChange={e => setNewProp({ ...newProp, address: e.target.value })} />
          <div className="form-btns">
            <button onClick={() => setShowAddProp(false)}>Cancel</button>
            <button className="primary" onClick={addProperty}>Save</button>
          </div>
        </div>
      )}

      <div className="list">
        {properties.length === 0 && <p className="empty">No properties yet. Add one or sync your emails.</p>}
        {properties.map(prop => (
          <div className="card" key={prop.id} onClick={() => openProperty(prop)}>
            <div className="card-name">{prop.name}</div>
            {prop.address && <div className="card-meta">{prop.address}</div>}
            <div className="card-arrow">→</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default App
