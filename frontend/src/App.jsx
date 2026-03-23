import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import './App.css'

const API = 'https://lead-tracker-production.up.railway.app'

function App() {
  const [userId, setUserId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [properties, setProperties] = useState([])
  const [selectedProp, setSelectedProp] = useState(null)
  const [leads, setLeads] = useState([])
  const [view, setView] = useState('properties')
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [newProp, setNewProp] = useState({ name: '', address: '' })
  const [newLead, setNewLead] = useState({ name: '', phone: '', email: '', notes: '' })
  const [showAddProp, setShowAddProp] = useState(false)
  const [showAddLead, setShowAddLead] = useState(false)
  const tokenRef = useRef(null)

  // Helper to make authenticated requests
  function authHeaders() {
    return tokenRef.current 
      ? { Authorization: `Bearer ${tokenRef.current}` }
      : {}
  }

  useEffect(() => {
    async function checkAuth() {
      // Check URL for token first
      const params = new URLSearchParams(window.location.search)
      const urlToken = params.get('token')
      
      if (urlToken) {
        tokenRef.current = urlToken
        sessionStorage.setItem('token', urlToken)
        window.history.replaceState({}, '', '/')
      } else {
        // Check sessionStorage
        const stored = sessionStorage.getItem('token')
        if (stored) tokenRef.current = stored
      }

      if (tokenRef.current) {
        try {
          const res = await axios.get(`${API}/auth/me`, {
            headers: authHeaders()
          })
          setUserId(res.data.userId)
        } catch {
          tokenRef.current = null
          sessionStorage.removeItem('token')
          setUserId(null)
        }
      } else {
        setUserId(null)
      }
      setLoading(false)
    }
    checkAuth()
  }, [])

  useEffect(() => {
    if (userId) loadProperties()
  }, [userId])

  async function loadProperties() {
    try {
      const res = await axios.get(`${API}/properties`, {
        headers: authHeaders()
      })
      setProperties(res.data)
    } catch (err) {
      if (err.response?.status === 401) {
        setUserId(null)
        sessionStorage.removeItem('token')
      }
    }
  }

  async function loadLeads(propId) {
    try {
      const res = await axios.get(`${API}/properties/${propId}/leads`, {
        headers: authHeaders()
      })
      setLeads(res.data)
    } catch (err) {
      console.error(err)
    }
  }

  async function syncEmails() {
    setSyncing(true)
    setSyncMsg('')
    try {
      const res = await axios.post(`${API}/sync-emails`, {}, {
        headers: authHeaders()
      })
      setSyncMsg(res.data.message)
      loadProperties()
    } catch (err) {
      if (err.response?.status === 401) {
        setSyncMsg('Session expired. Please log in again.')
        setUserId(null)
        sessionStorage.removeItem('token')
      } else {
        setSyncMsg('Sync failed. Try again.')
      }
    }
    setSyncing(false)
  }

  async function addProperty() {
    if (!newProp.name) return
    await axios.post(`${API}/properties`, newProp, {
      headers: authHeaders()
    })
    setNewProp({ name: '', address: '' })
    setShowAddProp(false)
    loadProperties()
  }

  async function addLead() {
    if (!newLead.name) return
    await axios.post(`${API}/properties/${selectedProp.id}/leads`, newLead, {
      headers: authHeaders()
    })
    setNewLead({ name: '', phone: '', email: '', notes: '' })
    setShowAddLead(false)
    loadLeads(selectedProp.id)
  }

  async function logout() {
    tokenRef.current = null
    sessionStorage.removeItem('token')
    setUserId(null)
    setProperties([])
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
            </div>
          ))}
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