import { useState, useEffect } from 'react'
import axios from 'axios'
import './App.css'

const API = 'http://localhost:3000'

function App() {
  const [userId, setUserId] = useState(localStorage.getItem('userId') || null)
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

  // Check if coming back from Microsoft login
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const id = params.get('userId')
    if (id) {
      localStorage.setItem('userId', id)
      setUserId(id)
      window.history.replaceState({}, '', '/')
    }
  }, [])

  useEffect(() => {
    if (userId) loadProperties()
  }, [userId])

  async function loadProperties() {
    try {
      const res = await axios.get(`${API}/properties`, {
        headers: { 'x-user-id': userId }
      })
      setProperties(res.data)
    } catch (err) {
      console.error(err)
    }
  }

  async function loadLeads(propId) {
    try {
      const res = await axios.get(`${API}/properties/${propId}/leads`, {
        headers: { 'x-user-id': userId }
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
        headers: { 'x-user-id': userId }
      })
      setSyncMsg(res.data.message)
      loadProperties()
    } catch (err) {
      setSyncMsg('Sync failed. Try logging in again.')
    }
    setSyncing(false)
  }

  async function addProperty() {
    if (!newProp.name) return
    await axios.post(`${API}/properties`, newProp, {
      headers: { 'x-user-id': userId }
    })
    setNewProp({ name: '', address: '' })
    setShowAddProp(false)
    loadProperties()
  }

  async function addLead() {
    if (!newLead.name) return
    await axios.post(`${API}/properties/${selectedProp.id}/leads`, newLead, {
      headers: { 'x-user-id': userId }
    })
    setNewLead({ name: '', phone: '', email: '', notes: '' })
    setShowAddLead(false)
    loadLeads(selectedProp.id)
  }

  function openProperty(prop) {
    setSelectedProp(prop)
    loadLeads(prop.id)
    setView('leads')
  }

  function logout() {
    localStorage.removeItem('userId')
    setUserId(null)
    setProperties([])
  }

  // ---- LOGIN PAGE ----
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

  // ---- LEADS VIEW ----
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

  // ---- PROPERTIES VIEW ----
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