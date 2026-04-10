const LS_BASE = 'kivanaAdmin/baseUrl'
const LS_ACCESS = 'kivanaAdmin/accessToken'
const LS_REFRESH = 'kivanaAdmin/refreshToken'
const LS_EMAIL = 'kivanaAdmin/email'

const els = {
  baseUrl: document.getElementById('baseUrl'),
  email: document.getElementById('email'),
  password: document.getElementById('password'),
  login: document.getElementById('login'),
  logout: document.getElementById('logout'),
  refresh: document.getElementById('refresh'),
  authCard: document.getElementById('authCard'),
  panel: document.getElementById('panel'),
  usersBody: document.getElementById('usersBody'),
  authStatus: document.getElementById('authStatus'),
  panelStatus: document.getElementById('panelStatus'),
  me: document.getElementById('me'),
  bootstrapEmail: document.getElementById('bootstrapEmail'),
  bootstrapToken: document.getElementById('bootstrapToken'),
  bootstrapBtn: document.getElementById('bootstrapBtn'),
  bootstrapStatus: document.getElementById('bootstrapStatus'),
}

function normalizeBaseUrl(v) {
  const s = String(v || '').trim().replace(/\/+$/, '')
  return s
}

function setStatus(el, msg) {
  el.textContent = msg || ''
}

function getAccessToken() {
  return localStorage.getItem(LS_ACCESS) || ''
}

function getRefreshToken() {
  return localStorage.getItem(LS_REFRESH) || ''
}

function setTokens(access, refresh) {
  if (access) localStorage.setItem(LS_ACCESS, access)
  if (refresh) localStorage.setItem(LS_REFRESH, refresh)
}

function clearTokens() {
  localStorage.removeItem(LS_ACCESS)
  localStorage.removeItem(LS_REFRESH)
}

function apiUrl(path) {
  const base = normalizeBaseUrl(els.baseUrl.value)
  if (!base) throw new Error('Missing backend URL')
  return base + path
}

function fmtDateTime(v) {
  return String(v || '').replace('T', ' ').replace('Z', '')
}

function computeEndsAt(durationCode) {
  const now = new Date()
  if (durationCode === 'lifetime') return null
  if (durationCode === 'month') {
    const d = new Date(now.getTime())
    d.setMonth(d.getMonth() + 1)
    return d.toISOString()
  }
  if (durationCode === 'year') {
    const d = new Date(now.getTime())
    d.setFullYear(d.getFullYear() + 1)
    return d.toISOString()
  }
  if (durationCode === 'custom') {
    const s = prompt('Ends at (YYYY-MM-DD). Leave empty to cancel.')
    if (!s) return undefined
    const d = new Date(`${s}T23:59:59Z`)
    if (Number.isNaN(d.getTime())) throw new Error('Invalid date')
    return d.toISOString()
  }
  return null
}

async function apiFetch(path, init = {}) {
  const access = getAccessToken()
  const headers = new Headers(init.headers || {})
  headers.set('content-type', 'application/json')
  if (access) headers.set('authorization', `Bearer ${access}`)
  const res = await fetch(apiUrl(path), { ...init, headers })
  if (res.ok) return res
  let err = `HTTP ${res.status}`
  try {
    const j = await res.json()
    if (j && j.error) err = String(j.error)
  } catch {
  }
  throw new Error(err)
}

async function refreshAccessToken() {
  const refreshToken = getRefreshToken()
  if (!refreshToken) return
  const res = await apiFetch('/v1/auth/refresh', { method: 'POST', body: JSON.stringify({ refresh_token: refreshToken }) })
  const json = await res.json()
  setTokens(json.accessToken, json.refreshToken)
}

async function loadMe() {
  const res = await apiFetch('/v1/me', { method: 'GET', headers: {} })
  const me = await res.json()
  els.me.textContent = me?.email ? `Signed in: ${me.email}` : ''
}

async function loadUsers() {
  setStatus(els.panelStatus, 'Loading…')
  const res = await apiFetch('/v1/admin/users', { method: 'GET', headers: {} })
  const json = await res.json()
  const users = Array.isArray(json.users) ? json.users : []
  els.usersBody.innerHTML = ''

  for (const u of users) {
    const tr = document.createElement('tr')

    const emailTd = document.createElement('td')
    emailTd.textContent = u.email || ''
    tr.appendChild(emailTd)

    const createdTd = document.createElement('td')
    createdTd.textContent = fmtDateTime(u.createdAt || '')
    tr.appendChild(createdTd)

    const ipTd = document.createElement('td')
    ipTd.textContent = u.lastIp || 'Unknown'
    tr.appendChild(ipTd)

    const adminTd = document.createElement('td')
    adminTd.innerHTML = u.isAdmin ? '<span class="pill">Yes</span>' : '<span class="pill">No</span>'
    tr.appendChild(adminTd)

    const planTd = document.createElement('td')
    planTd.textContent = u.kivanaPlanName ? `kivana / ${u.kivanaPlanName}` : '—'
    tr.appendChild(planTd)

    const endsTd = document.createElement('td')
    if (!u.kivanaEndsAt) {
      endsTd.textContent = '—'
    } else {
      const t = new Date(u.kivanaEndsAt)
      if (!Number.isNaN(t.getTime()) && t.getTime() <= Date.now()) {
        endsTd.textContent = `Expired (${fmtDateTime(u.kivanaEndsAt)})`
      } else {
        endsTd.textContent = fmtDateTime(u.kivanaEndsAt)
      }
    }
    tr.appendChild(endsTd)

    const setTd = document.createElement('td')
    const sel = document.createElement('select')
    sel.className = 'select'
    const plans = [
      { code: 'basic', name: 'Basic' },
      { code: 'standard', name: 'Standard' },
      { code: 'pro', name: 'Pro' },
      { code: 'lifetime_pro', name: 'Lifetime (Pro)' },
    ]
    for (const p of plans) {
      const opt = document.createElement('option')
      opt.value = p.code
      opt.textContent = p.name
      sel.appendChild(opt)
    }
    sel.value = u.kivanaPlanCode || 'basic'

    const durationTd = document.createElement('td')
    const durationSel = document.createElement('select')
    durationSel.className = 'select'
    const durations = [
      { code: 'month', name: '1 month' },
      { code: 'year', name: '1 year' },
      { code: 'lifetime', name: 'No expiry' },
      { code: 'custom', name: 'Custom…' },
    ]
    for (const d of durations) {
      const opt = document.createElement('option')
      opt.value = d.code
      opt.textContent = d.name
      durationSel.appendChild(opt)
    }
    durationSel.value = 'lifetime'
    durationTd.appendChild(durationSel)
    tr.appendChild(durationTd)

    const btn = document.createElement('button')
    btn.className = 'btn'
    btn.textContent = 'Apply'
    btn.addEventListener('click', async () => {
      setStatus(els.panelStatus, 'Applying…')
      try {
        const endsAt = computeEndsAt(String(durationSel.value || 'lifetime'))
        if (endsAt === undefined) {
          setStatus(els.panelStatus, 'Cancelled.')
          return
        }
        await apiFetch('/v1/admin/grant', {
          method: 'POST',
          body: JSON.stringify({
            email: u.email,
            productCode: 'kivana',
            planCode: String(sel.value || '').trim(),
            endsAt,
          }),
        })
        await loadUsers()
        setStatus(els.panelStatus, 'Updated.')
      } catch (e) {
        setStatus(els.panelStatus, `Failed: ${String(e?.message || e)}`)
      }
    })

    const wrap = document.createElement('div')
    wrap.style.display = 'flex'
    wrap.style.gap = '8px'
    wrap.style.alignItems = 'center'
    wrap.appendChild(sel)
    wrap.appendChild(btn)
    setTd.appendChild(wrap)
    tr.appendChild(setTd)

    const actionsTd = document.createElement('td')
    const pwBtn = document.createElement('button')
    pwBtn.className = 'btn'
    pwBtn.textContent = 'Reset password'
    pwBtn.onclick = async () => {
      const pw = prompt(`New password for ${u.email} (min 8 chars). Leave empty to cancel.`)
      if (!pw) return
      if (String(pw).length < 8) {
        alert('Password too short.')
        return
      }
      pwBtn.disabled = true
      pwBtn.textContent = '...'
      try {
        await apiFetch(`/v1/admin/users/${u.id}/password`, {
          method: 'POST',
          body: JSON.stringify({ password: String(pw) }),
        })
        await loadUsers()
      } catch (e) {
        alert(String(e))
      } finally {
        pwBtn.disabled = false
        pwBtn.textContent = 'Reset password'
      }
    }

    const delBtn = document.createElement('button')
    delBtn.className = 'btn'
    delBtn.style.color = 'var(--text)'
    delBtn.style.backgroundColor = '#441111'
    delBtn.textContent = 'Delete'
    delBtn.onclick = async () => {
      if (!confirm(`Are you sure you want to delete ${u.email}?`)) return
      delBtn.disabled = true
      delBtn.textContent = '...'
      try {
        await apiFetch(`/v1/admin/users/${u.id}`, { method: 'DELETE' })
        await loadUsers()
      } catch (e) {
        alert(String(e))
        delBtn.disabled = false
        delBtn.textContent = 'Delete'
      }
    }
    actionsTd.appendChild(pwBtn)
    actionsTd.appendChild(delBtn)
    tr.appendChild(actionsTd)

    els.usersBody.appendChild(tr)
  }

  setStatus(els.panelStatus, `${users.length} users`)
}

async function showAuthed() {
  els.authCard.style.display = 'none'
  els.panel.style.display = 'block'
  try {
    await loadMe()
  } catch {
  }
  await loadUsers()
}

async function showLoggedOut() {
  els.me.textContent = ''
  els.panel.style.display = 'none'
  els.authCard.style.display = 'block'
}

async function signIn() {
  setStatus(els.authStatus, '')
  const email = String(els.email.value || '').trim()
  const password = String(els.password.value || '')
  if (!email || !password) {
    setStatus(els.authStatus, 'Missing email or password.')
    return
  }
  localStorage.setItem(LS_EMAIL, email)

  const res = await apiFetch('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  const json = await res.json()
  setTokens(json.accessToken, json.refreshToken)
  await showAuthed()
}

async function signOut() {
  try {
    const refreshToken = getRefreshToken()
    clearTokens()
    await apiFetch('/v1/auth/logout', { method: 'POST', body: JSON.stringify({ refresh_token: refreshToken }) })
  } catch {
  }
  await showLoggedOut()
}

async function bootstrapAdmin() {
  setStatus(els.bootstrapStatus, '')
  const email = String(els.bootstrapEmail.value || '').trim()
  const token = String(els.bootstrapToken.value || '').trim()
  if (!email || !token) {
    setStatus(els.bootstrapStatus, 'Missing email or token.')
    return
  }
  try {
    const base = normalizeBaseUrl(els.baseUrl.value)
    const res = await fetch(base + '/v1/admin/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify({ email }),
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const j = await res.json()
        if (j?.error) msg = String(j.error)
      } catch {
      }
      throw new Error(msg)
    }
    setStatus(els.bootstrapStatus, 'Admin granted. Now sign in.')
  } catch (e) {
    setStatus(els.bootstrapStatus, `Failed: ${String(e?.message || e)}`)
  }
}

function loadDefaults() {
  const savedBase = localStorage.getItem(LS_BASE) || ''
  const savedEmail = localStorage.getItem(LS_EMAIL) || ''
  els.baseUrl.value = savedBase || window.location.origin.replace(/\/admin\/?$/, '')
  els.email.value = savedEmail
  els.bootstrapEmail.value = savedEmail
}

els.baseUrl.addEventListener('change', () => localStorage.setItem(LS_BASE, normalizeBaseUrl(els.baseUrl.value)))
els.login.addEventListener('click', () => void signIn())
els.logout.addEventListener('click', () => void signOut())
els.refresh.addEventListener('click', async () => {
  try {
    await refreshAccessToken()
    await showAuthed()
  } catch (e) {
    setStatus(els.panelStatus, `Failed: ${String(e?.message || e)}`)
  }
})
els.bootstrapBtn.addEventListener('click', () => void bootstrapAdmin())

loadDefaults()

;(async () => {
  if (getAccessToken()) {
    try {
      await refreshAccessToken()
      await showAuthed()
      return
    } catch {
      clearTokens()
    }
  }
  await showLoggedOut()
})()
