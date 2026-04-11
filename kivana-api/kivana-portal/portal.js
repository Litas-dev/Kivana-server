const els = {
  viewAuth: document.getElementById('viewAuth'),
  viewDashboard: document.getElementById('viewDashboard'),
  navUserEmail: document.getElementById('navUserEmail'),
  btnSignOut: document.getElementById('btnSignOut'),

  authForm: document.getElementById('authForm'),
  authTitle: document.getElementById('authTitle'),
  authSubtitle: document.getElementById('authSubtitle'),
  email: document.getElementById('email'),
  password: document.getElementById('password'),
  authError: document.getElementById('authError'),
  btnSubmitAuth: document.getElementById('btnSubmitAuth'),
  authToggleText: document.getElementById('authToggleText'),
  linkToggleAuth: document.getElementById('linkToggleAuth'),

  dashboardStatus: document.getElementById('dashboardStatus'),
  currentPlanBanner: document.getElementById('currentPlanBanner'),
  lblCurrentPlan: document.getElementById('lblCurrentPlan'),

  btnPlanBasic: document.getElementById('btnPlanBasic'),
  btnPlanLifetime: document.getElementById('btnPlanLifetime')
}

let isLoginMode = true

function getAccessToken() { return localStorage.getItem('kivanaPortal/accessToken') || '' }
function getRefreshToken() { return localStorage.getItem('kivanaPortal/refreshToken') || '' }
function setTokens(access, refresh) {
  if (access) localStorage.setItem('kivanaPortal/accessToken', access)
  if (refresh) localStorage.setItem('kivanaPortal/refreshToken', refresh)
}
function clearTokens() {
  localStorage.removeItem('kivanaPortal/accessToken')
  localStorage.removeItem('kivanaPortal/refreshToken')
}

// Ensure base URL works whether running locally or on server
const apiUrl = (path) => {
  const origin = window.location.origin;
  return `${origin}${path}`;
};

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
  } catch {}
  throw new Error(err)
}

async function refreshAccessToken() {
  const refreshToken = getRefreshToken()
  if (!refreshToken) return
  const res = await apiFetch('/v1/auth/refresh', { method: 'POST', body: JSON.stringify({ refresh_token: refreshToken }) })
  const json = await res.json()
  setTokens(json.accessToken, json.refreshToken)
}

function toggleAuthMode(e) {
  e.preventDefault()
  isLoginMode = !isLoginMode
  els.authError.textContent = ''
  if (isLoginMode) {
    els.authTitle.textContent = 'Sign in to Kivana'
    els.authSubtitle.textContent = 'Manage your Personal Finance app subscription.'
    els.btnSubmitAuth.textContent = 'Sign in'
    els.authToggleText.textContent = "Don't have an account?"
    els.linkToggleAuth.textContent = 'Create one'
  } else {
    els.authTitle.textContent = 'Create an account'
    els.authSubtitle.textContent = 'Get started with your free Kivana account.'
    els.btnSubmitAuth.textContent = 'Sign up'
    els.authToggleText.textContent = "Already have an account?"
    els.linkToggleAuth.textContent = 'Sign in'
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault()
  els.authError.textContent = ''
  const email = els.email.value.trim()
  const password = els.password.value

  if (!email || !password) {
    els.authError.textContent = 'Email and password are required.'
    return
  }

  if (!isLoginMode && password.length < 8) {
    els.authError.textContent = 'Password must be at least 8 characters.'
    return
  }

  els.btnSubmitAuth.disabled = true
  els.btnSubmitAuth.textContent = 'Please wait...'

  try {
    const endpoint = isLoginMode ? '/v1/auth/login' : '/v1/auth/signup'
    const res = await apiFetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({ email, password })
    })
    const json = await res.json()
    setTokens(json.accessToken, json.refreshToken)
    
    // Automatically select free plan on signup
    if (!isLoginMode) {
      await apiFetch('/v1/portal/select-plan', {
        method: 'POST',
        body: JSON.stringify({ planCode: 'basic' })
      }).catch(err => console.log('Auto-grant basic failed:', err))
    }

    await showDashboard()
  } catch (err) {
    els.authError.textContent = err.message
  } finally {
    els.btnSubmitAuth.disabled = false
    els.btnSubmitAuth.textContent = isLoginMode ? 'Sign in' : 'Sign up'
  }
}

async function loadMe() {
  const res = await apiFetch('/v1/me', { method: 'GET' })
  return await res.json()
}

async function loadEntitlements() {
  const res = await apiFetch('/v1/entitlements', { method: 'GET' })
  const json = await res.json()
  return json.products.find(p => p.productCode === 'kivana')
}

async function handleSelectPlan(payload) {
  els.dashboardStatus.textContent = 'Processing...'
  document.querySelectorAll('#viewDashboard button').forEach(b => b.disabled = true)
  try {
    await apiFetch('/v1/portal/select-plan', {
      method: 'POST',
      body: JSON.stringify(payload)
    })
    els.dashboardStatus.textContent = 'Plan updated successfully!'
    await showDashboard()
  } catch (err) {
    els.dashboardStatus.textContent = `Error: ${err.message}`
  } finally {
    document.querySelectorAll('#viewDashboard button').forEach(b => b.disabled = false)
    setTimeout(() => els.dashboardStatus.textContent = '', 3000)
  }
}

async function showDashboard() {
  els.viewAuth.classList.add('hidden')
  els.viewDashboard.classList.remove('hidden')
  els.navUserEmail.classList.remove('hidden')
  els.btnSignOut.classList.remove('hidden')

  try {
    const me = await loadMe()
    els.navUserEmail.textContent = me.email

    const entitlement = await loadEntitlements()
    if (entitlement && entitlement.status === 'active') {
      els.currentPlanBanner.classList.remove('hidden')
      els.lblCurrentPlan.textContent = entitlement.planName
    } else {
      els.currentPlanBanner.classList.add('hidden')
    }
  } catch (err) {
    console.error('Failed to load dashboard data:', err)
  }
}

async function showAuth() {
  els.viewAuth.classList.remove('hidden')
  els.viewDashboard.classList.add('hidden')
  els.navUserEmail.classList.add('hidden')
  els.btnSignOut.classList.add('hidden')
}

async function handleSignOut() {
  try {
    await apiFetch('/v1/auth/logout', { method: 'POST', body: JSON.stringify({ refresh_token: getRefreshToken() }) })
  } catch {}
  clearTokens()
  await showAuth()
}

// Bind Events
els.linkToggleAuth.addEventListener('click', toggleAuthMode)
els.authForm.addEventListener('submit', handleAuthSubmit)
els.btnSignOut.addEventListener('click', handleSignOut)

els.btnPlanBasic.addEventListener('click', () => handleSelectPlan({ planCode: 'basic' }))
els.btnPlanLifetime.addEventListener('click', () => handleSelectPlan({ planCode: 'lifetime_pro' }))

document.querySelectorAll('[data-plan][data-billing-cycle]').forEach((el) => {
  el.addEventListener('click', () => {
    const planCode = String(el.getAttribute('data-plan') || '').trim()
    const billingCycle = String(el.getAttribute('data-billing-cycle') || '').trim()
    if (!planCode || !billingCycle) return
    void handleSelectPlan({ planCode, billingCycle })
  })
})

// Init
;(async () => {
  if (getAccessToken()) {
    try {
      await refreshAccessToken()
      await showDashboard()
      return
    } catch {
      clearTokens()
    }
  }
  await showAuth()
})()
