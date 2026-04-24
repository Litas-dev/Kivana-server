const els = {
  viewAuth: document.getElementById('viewAuth'),
  viewDashboard: document.getElementById('viewDashboard'),
  viewAccount: document.getElementById('viewAccount'),
  navUserEmail: document.getElementById('navUserEmail'),
  btnSignOut: document.getElementById('btnSignOut'),
  btnNavPlans: document.getElementById('btnNavPlans'),
  btnNavAccount: document.getElementById('btnNavAccount'),
  btnSignIn: document.getElementById('btnSignIn'),
  btnSignUp: document.getElementById('btnSignUp'),
  navFeatures: document.getElementById('navFeatures'),
  navPricing: document.getElementById('navPricing'),
  navAccountants: document.getElementById('navAccountants'),
  navSecurity: document.getElementById('navSecurity'),
  navResources: document.getElementById('navResources'),
  osToggle: document.getElementById('osToggle'),
  osMac: document.getElementById('osMac'),
  osWin: document.getElementById('osWin'),
  marketingSections: document.getElementById('marketingSections'),
  marketingFooter: document.getElementById('marketingFooter'),
  btnDownloadPrimary: document.getElementById('btnDownloadPrimary'),
  btnDownloadSecondary: document.getElementById('btnDownloadSecondary'),
  btnCtaCreate: document.getElementById('btnCtaCreate'),
  btnCtaSignIn: document.getElementById('btnCtaSignIn'),
  btnBackToWebsite: document.getElementById('btnBackToWebsite'),
  footerYear: document.getElementById('footerYear'),

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

  btnBillingYearly: document.getElementById('btnBillingYearly'),
  btnBillingMonthly: document.getElementById('btnBillingMonthly'),

  stdMainPrice: document.getElementById('stdMainPrice'),
  stdMainUnit: document.getElementById('stdMainUnit'),
  stdSubPrice: document.getElementById('stdSubPrice'),
  stdNote: document.getElementById('stdNote'),
  proMainPrice: document.getElementById('proMainPrice'),
  proMainUnit: document.getElementById('proMainUnit'),
  proSubPrice: document.getElementById('proSubPrice'),
  proNote: document.getElementById('proNote'),

  displayName: document.getElementById('displayName'),
  avatarFile: document.getElementById('avatarFile'),
  avatarPreview: document.getElementById('avatarPreview'),
  btnSaveProfile: document.getElementById('btnSaveProfile'),
  profileStatus: document.getElementById('profileStatus'),

  subPlanName: document.getElementById('subPlanName'),
  subPlanMeta: document.getElementById('subPlanMeta'),
  btnManagePlans: document.getElementById('btnManagePlans'),
  btnCancelSub: document.getElementById('btnCancelSub'),
  accountStatus: document.getElementById('accountStatus'),
}

let isLoginMode = true
let billingCycle = 'yearly'
let currentMe = null
let currentEntitlement = null
let pendingPlanSelection = null

function getAccessToken() {
  return localStorage.getItem('kivanaPortal/accessToken') || ''
}
function getRefreshToken() {
  return localStorage.getItem('kivanaPortal/refreshToken') || ''
}
function setTokens(access, refresh) {
  if (access) localStorage.setItem('kivanaPortal/accessToken', access)
  if (refresh) localStorage.setItem('kivanaPortal/refreshToken', refresh)
}
function clearTokens() {
  localStorage.removeItem('kivanaPortal/accessToken')
  localStorage.removeItem('kivanaPortal/refreshToken')
}

function normalizeApiBaseUrl(url) {
  const v = String(url || '').trim()
  if (!v) return ''
  return v.endsWith('/') ? v.slice(0, -1) : v
}

function computeApiBaseUrl() {
  const sp = new URLSearchParams(window.location.search)
  const qp = sp.get('api')
  if (qp) {
    const v = normalizeApiBaseUrl(qp)
    if (v) {
      try {
        localStorage.setItem('kivanaPortal/apiBase', v)
      } catch {
        void 0
      }
      return v
    }
  }
  const saved = normalizeApiBaseUrl(localStorage.getItem('kivanaPortal/apiBase') || '')
  if (saved) return saved
  return window.location.origin
}

const apiBaseUrl = computeApiBaseUrl()
const apiUrl = (path) => `${apiBaseUrl}${path}`

function isAuthed() {
  return !!getAccessToken()
}

async function apiFetch(path, init = {}) {
  const access = getAccessToken()
  const headers = new Headers(init.headers || {})
  headers.set('content-type', 'application/json')
  if (access) headers.set('authorization', `Bearer ${access}`)
  const res = await fetch(apiUrl(path), { ...init, headers })
  if (res.ok) return res

  let err = `HTTP ${res.status}`
  if (res.status === 501) {
    err = `Portal is running without the API. Open the portal from the API server (for example http://localhost:8080/portal/) or add ?api=http://localhost:8080 to this page URL.`
    throw new Error(err)
  }
  try {
    const j = await res.json()
    if (j && j.error) err = String(j.error)
  } catch {
    void 0
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

function profileKey(userId) {
  return `kivanaPortal/profile/${userId}`
}

function loadProfileLocal(userId) {
  try {
    const raw = localStorage.getItem(profileKey(userId))
    if (!raw) return { displayName: '', avatarDataUrl: '' }
    const v = JSON.parse(raw)
    if (!v || typeof v !== 'object') return { displayName: '', avatarDataUrl: '' }
    return {
      displayName: String(v.displayName || '').trim(),
      avatarDataUrl: String(v.avatarDataUrl || '').trim(),
    }
  } catch {
    return { displayName: '', avatarDataUrl: '' }
  }
}

function saveProfileLocal(userId, patch) {
  const cur = loadProfileLocal(userId)
  const next = {
    displayName: patch.displayName != null ? String(patch.displayName || '').trim() : cur.displayName,
    avatarDataUrl: patch.avatarDataUrl != null ? String(patch.avatarDataUrl || '').trim() : cur.avatarDataUrl,
  }
  try {
    localStorage.setItem(profileKey(userId), JSON.stringify(next))
  } catch {
    void 0
  }
  return next
}

function loadProfileMerged(me) {
  if (!me || !me.id) return { displayName: '', avatarDataUrl: '' }
  const local = loadProfileLocal(me.id)
  const displayName = me.displayName != null ? String(me.displayName || '').trim() : local.displayName
  const avatarDataUrl = me.avatarDataUrl != null ? String(me.avatarDataUrl || '').trim() : local.avatarDataUrl
  return { displayName, avatarDataUrl }
}

async function updateProfileOnServer(patch) {
  await apiFetch('/v1/profile', { method: 'POST', body: JSON.stringify(patch) })
}

function avatarPlaceholderDataUrl(text) {
  const safe = encodeURIComponent(String(text || '').slice(0, 2).toUpperCase())
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="92" height="92"><rect width="92" height="92" fill="#E5E7EB"/><text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="Inter, system-ui" font-size="28" font-weight="700" fill="#111827">${safe}</text></svg>`
  return `data:image/svg+xml;utf8,${svg}`
}

function showOnly(view) {
  els.viewAuth.classList.toggle('hidden', view !== 'auth')
  els.viewDashboard.classList.toggle('hidden', view !== 'dashboard')
  els.viewAccount.classList.toggle('hidden', view !== 'account')
  applyNav()
}

function applyNav() {
  const authed = isAuthed()
  if (els.btnSignIn) els.btnSignIn.classList.toggle('hidden', authed)
  if (els.btnSignUp) els.btnSignUp.classList.toggle('hidden', authed)
  if (els.navFeatures) els.navFeatures.classList.toggle('hidden', authed)
  if (els.navPricing) els.navPricing.classList.toggle('hidden', authed)
  if (els.navAccountants) els.navAccountants.classList.toggle('hidden', authed)
  if (els.navSecurity) els.navSecurity.classList.toggle('hidden', authed)
  if (els.navResources) els.navResources.classList.toggle('hidden', authed)
  if (els.osToggle) els.osToggle.classList.toggle('hidden', authed)
  if (els.marketingSections) els.marketingSections.classList.toggle('hidden', authed)
  if (els.marketingFooter) els.marketingFooter.classList.toggle('hidden', authed)
  els.navUserEmail.classList.toggle('hidden', !authed)
  els.btnSignOut.classList.toggle('hidden', !authed)
  els.btnNavPlans.classList.toggle('hidden', !authed)
  els.btnNavAccount.classList.toggle('hidden', !authed)
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
    els.authToggleText.textContent = 'Already have an account?'
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
    const res = await apiFetch(endpoint, { method: 'POST', body: JSON.stringify({ email, password }) })
    const json = await res.json()
    setTokens(json.accessToken, json.refreshToken)
    await showDashboard()
    if (pendingPlanSelection) {
      const payload = pendingPlanSelection
      pendingPlanSelection = null
      await handleSelectPlan(payload, els.dashboardStatus)
    }
  } catch (err) {
    els.authError.textContent = err && err.message ? err.message : 'Failed to sign in.'
  } finally {
    els.btnSubmitAuth.disabled = false
    els.btnSubmitAuth.textContent = isLoginMode ? 'Sign in' : 'Sign up'
  }
}

async function loadMe() {
  const res = await apiFetch('/v1/me', { method: 'GET' })
  return await res.json()
}

async function loadEntitlement() {
  const res = await apiFetch('/v1/entitlements', { method: 'GET' })
  const json = await res.json()
  const products = Array.isArray(json.products) ? json.products : []
  return products.find((p) => p && p.productCode === 'kivana') || null
}

function setBusy(isBusy) {
  document.querySelectorAll('.plans-grid button, .billingToggleBtn').forEach((b) => {
    b.disabled = !!isBusy
  })
  if (els.btnManagePlans) els.btnManagePlans.disabled = !!isBusy
  if (els.btnCancelSub) els.btnCancelSub.disabled = !!isBusy
  if (els.btnSaveProfile) els.btnSaveProfile.disabled = !!isBusy
}

function resetPlanButtonLabels() {
  const btnBasic = document.getElementById('btnPlanBasic')
  const btnStd = document.getElementById('btnPlanStandard')
  const btnPro = document.getElementById('btnPlanPro')
  const btnLifetime = document.getElementById('btnPlanLifetime')
  if (btnBasic) btnBasic.textContent = 'Get Basic'
  if (btnLifetime) btnLifetime.textContent = 'Get Lifetime'
  updatePricingUI()
  if (btnStd && btnStd.textContent === 'Current plan') btnStd.textContent = billingCycle === 'yearly' ? 'Get Standard (Yearly)' : 'Get Standard (Monthly)'
  if (btnPro && btnPro.textContent === 'Current plan') btnPro.textContent = billingCycle === 'yearly' ? 'Get Pro (Yearly)' : 'Get Pro (Monthly)'
}

function applyCurrentPlanUI() {
  const planCode = currentEntitlement ? String(currentEntitlement.planCode || '').trim().toLowerCase() : ''
  const planName = currentEntitlement ? String(currentEntitlement.planName || '').trim() : ''
  const status = currentEntitlement ? String(currentEntitlement.status || '').trim() : ''
  const endsAt = currentEntitlement ? currentEntitlement.endsAt : null

  if (planName && status === 'active') {
    els.currentPlanBanner.classList.remove('hidden')
    els.lblCurrentPlan.textContent = planName
  } else {
    els.currentPlanBanner.classList.add('hidden')
  }

  document.querySelectorAll('.plan-card').forEach((c) => c.classList.remove('is-current'))
  document.querySelectorAll('[data-plan]').forEach((btn) => {
    btn.disabled = false
  })

  resetPlanButtonLabels()

  if (planCode) {
    const activeBtn = document.querySelector(`[data-plan="${planCode}"]`)
    if (activeBtn) {
      activeBtn.disabled = true
      activeBtn.textContent = 'Current plan'
      const card = activeBtn.closest('.plan-card')
      if (card) card.classList.add('is-current')
    }
  }

  if (els.subPlanName) els.subPlanName.textContent = planName || 'Basic'
  if (els.subPlanMeta) {
    const parts = []
    if (status) parts.push(status)
    if (endsAt) parts.push(`Ends: ${endsAt}`)
    els.subPlanMeta.textContent = parts.length ? parts.join(' • ') : 'Active'
  }
  const isBasic = !planCode || planCode === 'basic'
  if (els.btnCancelSub) els.btnCancelSub.classList.toggle('hidden', isBasic)
}

function setBillingCycle(next) {
  const v = String(next || '').trim().toLowerCase()
  if (v !== 'yearly' && v !== 'monthly') return
  billingCycle = v
  els.btnBillingYearly.classList.toggle('active', billingCycle === 'yearly')
  els.btnBillingMonthly.classList.toggle('active', billingCycle === 'monthly')
  applyCurrentPlanUI()
}

function updatePricingUI() {
  const stdBtn = document.getElementById('btnPlanStandard')
  const proBtn = document.getElementById('btnPlanPro')

  if (billingCycle === 'yearly') {
    els.stdMainPrice.textContent = '€165'
    els.stdMainUnit.textContent = '/yr'
    els.stdSubPrice.textContent = '€15/mo'
    els.stdNote.textContent = 'Save 1 month with annual billing. €165 / year (1 month free).'
    els.proMainPrice.textContent = '€539'
    els.proMainUnit.textContent = '/yr'
    els.proSubPrice.textContent = '€49/mo'
    els.proNote.textContent = 'Save 1 month with annual billing. €539 / year (1 month free).'
    if (stdBtn && !stdBtn.disabled) stdBtn.textContent = 'Get Standard (Yearly)'
    if (proBtn && !proBtn.disabled) proBtn.textContent = 'Get Pro (Yearly)'
  } else {
    els.stdMainPrice.textContent = '€15'
    els.stdMainUnit.textContent = '/mo'
    els.stdSubPrice.textContent = '€165/yr'
    els.stdNote.textContent = 'Annual billing saves 1 month. €165 / year (1 month free).'
    els.proMainPrice.textContent = '€49'
    els.proMainUnit.textContent = '/mo'
    els.proSubPrice.textContent = '€539/yr'
    els.proNote.textContent = 'Annual billing saves 1 month. €539 / year (1 month free).'
    if (stdBtn && !stdBtn.disabled) stdBtn.textContent = 'Get Standard (Monthly)'
    if (proBtn && !proBtn.disabled) proBtn.textContent = 'Get Pro (Monthly)'
  }
}

async function syncSessionData() {
  currentMe = await loadMe()
  currentEntitlement = await loadEntitlement()
  els.navUserEmail.textContent = currentMe.email || ''
  applyCurrentPlanUI()
}

function fillAccountProfile() {
  if (!currentMe) return
  const prof = loadProfileMerged(currentMe)
  if (els.displayName) els.displayName.value = prof.displayName || ''
  const initialSource = prof.displayName || currentMe.email || ''
  if (els.avatarPreview) els.avatarPreview.src = prof.avatarDataUrl || avatarPlaceholderDataUrl(initialSource)
}

async function showDashboard() {
  showOnly('dashboard')
  els.dashboardStatus.textContent = ''
  if (isAuthed()) {
    try {
      await syncSessionData()
      return
    } catch (err) {
      console.error('Failed to load dashboard data:', err)
      clearTokens()
    }
  }
  currentMe = null
  currentEntitlement = null
  els.currentPlanBanner.classList.add('hidden')
  applyCurrentPlanUI()
  applyNav()
}

async function showAccount() {
  if (!isAuthed()) {
    pendingPlanSelection = null
    setAuthMode(true)
    await showAuth()
    return
  }
  showOnly('account')
  els.accountStatus.textContent = ''
  els.profileStatus.textContent = ''
  try {
    await syncSessionData()
    fillAccountProfile()
  } catch (err) {
    console.error('Failed to load account data:', err)
  }
}

async function showAuth() {
  showOnly('auth')
  currentMe = null
  currentEntitlement = null
}

async function handleSelectPlan(payload, statusEl) {
  if (!isAuthed()) {
    pendingPlanSelection = payload
    setAuthMode(false)
    await showAuth()
    return
  }
  const currentCode = currentEntitlement ? String(currentEntitlement.planCode || '').trim().toLowerCase() : 'basic'
  const nextCode = String(payload.planCode || '').trim().toLowerCase()
  if (!nextCode || nextCode === currentCode) return

  if (statusEl) statusEl.textContent = 'Processing...'
  setBusy(true)
  try {
    await apiFetch('/v1/portal/select-plan', { method: 'POST', body: JSON.stringify(payload) })
    if (statusEl) statusEl.textContent = 'Plan updated successfully!'
    await syncSessionData()
  } catch (err) {
    if (statusEl) statusEl.textContent = `Error: ${err && err.message ? err.message : 'Failed.'}`
  } finally {
    setBusy(false)
    if (statusEl) setTimeout(() => (statusEl.textContent = ''), 3000)
  }
}

async function handleSignOut() {
  try {
    await apiFetch('/v1/auth/logout', { method: 'POST', body: JSON.stringify({ refresh_token: getRefreshToken() }) })
  } catch {
    void 0
  }
  clearTokens()
  await showAuth()
}

async function handleAvatarFile(file) {
  if (!currentMe || !file) return
  els.profileStatus.textContent = ''
  setBusy(true)
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(new Error('Failed to read image'))
      reader.readAsDataURL(file)
    })
    if (dataUrl.length > 200_000) {
      throw new Error('Image too large. Please use a smaller image.')
    }
    saveProfileLocal(currentMe.id, { avatarDataUrl: dataUrl })
    try {
      await updateProfileOnServer({ avatarDataUrl: dataUrl })
      await syncSessionData()
    } catch {
      void 0
    }
    fillAccountProfile()
    els.profileStatus.textContent = 'Avatar saved.'
  } catch (err) {
    els.profileStatus.textContent = err && err.message ? err.message : 'Failed to save avatar.'
  } finally {
    setBusy(false)
    setTimeout(() => (els.profileStatus.textContent = ''), 2500)
  }
}

async function handleSaveProfile() {
  if (!currentMe) return
  if (!els.displayName) return
  if (els.profileStatus) els.profileStatus.textContent = ''
  setBusy(true)
  try {
    const displayName = String(els.displayName.value || '').trim()
    saveProfileLocal(currentMe.id, { displayName })
    try {
      await updateProfileOnServer({ displayName })
      await syncSessionData()
    } catch {
      void 0
    }
    fillAccountProfile()
    if (els.profileStatus) els.profileStatus.textContent = 'Profile saved.'
  } catch {
    if (els.profileStatus) els.profileStatus.textContent = 'Failed to save profile.'
  } finally {
    setBusy(false)
    if (els.profileStatus) setTimeout(() => (els.profileStatus.textContent = ''), 2500)
  }
}

async function handleCancelSubscription() {
  if (!currentEntitlement) return
  const planCode = String(currentEntitlement.planCode || '').trim().toLowerCase()
  if (planCode === 'basic') return
  if (!window.confirm('Cancel your subscription and switch to Basic?')) return
  await handleSelectPlan({ planCode: 'basic' }, els.accountStatus)
}

function setAuthMode(loginMode) {
  isLoginMode = !!loginMode
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
    els.authToggleText.textContent = 'Already have an account?'
    els.linkToggleAuth.textContent = 'Sign in'
  }
}

if (els.linkToggleAuth) els.linkToggleAuth.addEventListener('click', toggleAuthMode)
if (els.authForm) els.authForm.addEventListener('submit', handleAuthSubmit)
if (els.btnSignOut) els.btnSignOut.addEventListener('click', handleSignOut)
if (els.btnNavPlans) els.btnNavPlans.addEventListener('click', () => void showDashboard())
if (els.btnNavAccount) els.btnNavAccount.addEventListener('click', () => void showAccount())
if (els.btnSignIn) els.btnSignIn.addEventListener('click', () => {
  pendingPlanSelection = null
  setAuthMode(true)
  void showAuth()
})
if (els.btnSignUp) els.btnSignUp.addEventListener('click', () => void goToPublicSection('pricing'))

async function goToPublicSection(id) {
  if (isAuthed()) return
  pendingPlanSelection = null
  await showDashboard()
  if (window.location.hash !== `#${id}`) window.location.hash = id
  setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0)
}

if (els.navFeatures) els.navFeatures.addEventListener('click', () => void goToPublicSection('features'))
if (els.navPricing) els.navPricing.addEventListener('click', () => void goToPublicSection('pricing'))
if (els.navAccountants) els.navAccountants.addEventListener('click', () => void goToPublicSection('accountants'))
if (els.navSecurity) els.navSecurity.addEventListener('click', () => void goToPublicSection('security'))
if (els.navResources) els.navResources.addEventListener('click', () => void goToPublicSection('resources'))
if (els.btnCtaCreate) els.btnCtaCreate.addEventListener('click', () => {
  pendingPlanSelection = null
  void goToPublicSection('pricing')
})
if (els.btnCtaSignIn) els.btnCtaSignIn.addEventListener('click', () => {
  pendingPlanSelection = null
  setAuthMode(true)
  void showAuth()
})
if (els.btnBackToWebsite) els.btnBackToWebsite.addEventListener('click', () => {
  pendingPlanSelection = null
  void showDashboard()
})

let selectedOs = 'mac'
function setSelectedOs(os) {
  selectedOs = os === 'win' ? 'win' : 'mac'
  if (els.osMac) els.osMac.classList.toggle('active', selectedOs === 'mac')
  if (els.osWin) els.osWin.classList.toggle('active', selectedOs === 'win')
  if (els.btnDownloadPrimary) els.btnDownloadPrimary.textContent = selectedOs === 'mac' ? 'Download for macOS' : 'Download for Windows'
  if (els.btnDownloadSecondary) els.btnDownloadSecondary.textContent = selectedOs === 'mac' ? 'Download for Windows' : 'Download for macOS'
}

function showMarketingStatus(message) {
  els.dashboardStatus.textContent = message
  setTimeout(() => {
    if (els.dashboardStatus.textContent === message) els.dashboardStatus.textContent = ''
  }, 3500)
}

async function handleDownloadClick() {
  if (isAuthed()) return
  await goToPublicSection('pricing')
  showMarketingStatus('Downloads are coming soon. Create an account and choose a plan to get ready.')
}

if (els.osMac) els.osMac.addEventListener('click', () => setSelectedOs('mac'))
if (els.osWin) els.osWin.addEventListener('click', () => setSelectedOs('win'))
if (els.btnDownloadPrimary) els.btnDownloadPrimary.addEventListener('click', () => void handleDownloadClick())
if (els.btnDownloadSecondary) els.btnDownloadSecondary.addEventListener('click', () => void handleDownloadClick())

async function applyHashNav() {
  if (isAuthed()) return
  const id = String(window.location.hash || '').replace(/^#/, '').trim()
  if (!id) return
  const allow = new Set(['features', 'pricing', 'accountants', 'security', 'resources'])
  if (!allow.has(id)) return
  await showDashboard()
  setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0)
}

window.addEventListener('hashchange', () => void applyHashNav())

document.querySelectorAll('.faq-q').forEach((q) => {
  q.addEventListener('click', () => {
    const item = q.closest('.faq-item')
    if (item) item.classList.toggle('open')
  })
})

if (els.btnBillingYearly) els.btnBillingYearly.addEventListener('click', () => setBillingCycle('yearly'))
if (els.btnBillingMonthly) els.btnBillingMonthly.addEventListener('click', () => setBillingCycle('monthly'))

document.querySelectorAll('[data-plan]').forEach((el) => {
  el.addEventListener('click', () => {
    const planCode = String(el.getAttribute('data-plan') || '').trim()
    if (!planCode) return
    if (planCode === 'standard' || planCode === 'pro') {
      void handleSelectPlan({ planCode, billingCycle }, els.dashboardStatus)
      return
    }
    void handleSelectPlan({ planCode }, els.dashboardStatus)
  })
})

if (els.btnManagePlans) els.btnManagePlans.addEventListener('click', () => void showDashboard())
if (els.btnCancelSub) els.btnCancelSub.addEventListener('click', () => void handleCancelSubscription())
if (els.btnSaveProfile) els.btnSaveProfile.addEventListener('click', () => void handleSaveProfile())
if (els.avatarFile) {
  els.avatarFile.addEventListener('change', (e) => {
    const file = e && e.target && e.target.files ? e.target.files[0] : null
    void handleAvatarFile(file)
  })
}

;(async () => {
  setBillingCycle('yearly')
  setSelectedOs('mac')
  applyNav()
  if (els.footerYear) els.footerYear.textContent = String(new Date().getFullYear())
  if (getAccessToken()) {
    try {
      await refreshAccessToken()
      await showDashboard()
      return
    } catch {
      clearTokens()
    }
  }
  await showDashboard()
  await applyHashNav()
})()
