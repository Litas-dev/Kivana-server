use std::net::SocketAddr;
use anyhow::Context;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::{ConnectInfo, FromRef, State};
use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::response::Redirect;
use axum::{Json, Router};
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;
use tracing::Level;
use uuid::Uuid;

#[derive(Clone)]
struct AppConfig {
  database_url: String,
  jwt_secret: String,
  access_token_ttl_seconds: i64,
  refresh_token_ttl_days: i64,
  bind_addr: SocketAddr,
}

#[derive(Clone)]
struct AppState {
  pool: PgPool,
  jwt: JwtKeys,
  cfg: AppConfig,
  tx_events: broadcast::Sender<UserEvent>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UserEvent {
  user_id: String,
  event_type: String,
}

#[derive(Clone)]
struct JwtKeys {
  enc: EncodingKey,
  dec: DecodingKey,
}

impl FromRef<AppState> for PgPool {
  fn from_ref(state: &AppState) -> Self {
    state.pool.clone()
  }
}

#[derive(Serialize, Deserialize)]
struct AccessClaims {
  sub: String,
  email: String,
  exp: usize,
  iat: usize,
}

#[derive(Deserialize)]
struct SignupRequest {
  email: String,
  password: String,
}

#[derive(Deserialize)]
struct LoginRequest {
  email: String,
  password: String,
}

#[derive(Deserialize)]
struct RefreshRequest {
  refresh_token: String,
}

#[derive(Deserialize)]
struct LogoutRequest {
  refresh_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthResponse {
  access_token: String,
  refresh_token: String,
  user: UserInfo,
}

#[derive(Serialize)]
struct UserInfo {
  id: String,
  email: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntitlementsResponse {
  products: Vec<ProductEntitlement>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductEntitlement {
  product_code: String,
  plan_code: String,
  plan_name: String,
  status: String,
  ends_at: Option<String>,
  features: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminGrantRequest {
  email: String,
  product_code: String,
  plan_code: String,
  ends_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminBootstrapRequest {
  email: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminUsersResponse {
  users: Vec<AdminUserRow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminSetPasswordRequest {
  password: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminUserRow {
  id: String,
  email: String,
  created_at: String,
  is_admin: bool,
  last_ip: Option<String>,
  kivana_plan_code: Option<String>,
  kivana_plan_name: Option<String>,
  kivana_ends_at: Option<String>,
}

#[derive(Serialize)]
struct ErrorResponse {
  error: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
  dotenvy::dotenv().ok();
  tracing_subscriber::fmt()
    .with_max_level(Level::INFO)
    .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
    .init();

  let cfg = load_config().context("load config")?;
  let pool = sqlx::postgres::PgPoolOptions::new()
    .max_connections(10)
    .connect(&cfg.database_url)
    .await
    .context("connect postgres")?;

  sqlx::migrate!("./migrations").run(&pool).await.context("run migrations")?;

  let jwt = JwtKeys {
    enc: EncodingKey::from_secret(cfg.jwt_secret.as_bytes()),
    dec: DecodingKey::from_secret(cfg.jwt_secret.as_bytes()),
  };

  let (tx_events, _) = broadcast::channel(100);

  let state = AppState { pool, jwt, cfg: cfg.clone(), tx_events };

  let cors = CorsLayer::new()
    .allow_origin(Any)
    .allow_headers(Any)
    .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
    .allow_credentials(false);

  let app = Router::new()
    .route("/healthz", get(healthz))
    .route("/v1/auth/signup", post(signup))
    .route("/v1/auth/login", post(login))
    .route("/v1/auth/refresh", post(refresh))
    .route("/v1/auth/logout", post(logout))
    .route("/v1/me", get(me))
    .route("/v1/entitlements", get(entitlements))
    .route("/v1/admin/bootstrap", post(admin_bootstrap))
    .route("/v1/admin/users", get(admin_users))
    .route("/v1/admin/users/:id", delete(admin_delete_user))
    .route("/v1/admin/users/:id/password", post(admin_set_password))
    .route("/v1/admin/grant", post(admin_grant))
    .route("/v1/portal/select-plan", post(portal_select_plan))
    .route("/v1/events/poll", get(poll_events))
    .route("/admin", get(|| async { Redirect::permanent("/admin/") }))
    .nest_service("/admin/", ServeDir::new("kivana-admin"))
    .route("/", get(|| async { Redirect::permanent("/portal/") }))
    .nest_service("/portal/", ServeDir::new("kivana-portal"))
    .layer(cors)
    .layer(TraceLayer::new_for_http())
    .with_state(state);

  let listener = tokio::net::TcpListener::bind(cfg.bind_addr).await?;
  axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await?;
  Ok(())
}

async fn healthz() -> impl IntoResponse {
  (StatusCode::OK, "ok")
}

async fn signup(
  State(state): State<AppState>,
  headers: axum::http::HeaderMap,
  connect_info: Option<ConnectInfo<SocketAddr>>,
  Json(req): Json<SignupRequest>,
) -> axum::response::Response {
  let email = normalize_email(&req.email);
  if !is_valid_email(&email) {
    return err(StatusCode::BAD_REQUEST, "invalid_email").into_response();
  }
  if req.password.len() < 8 {
    return err(StatusCode::BAD_REQUEST, "weak_password").into_response();
  }

  let user_id = Uuid::new_v4();
  let password_hash = hash_password(&req.password).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
  let password_hash = match password_hash {
    Ok(v) => v,
    Err(code) => return err(code, "hash_failed").into_response(),
  };

  let client_ip = get_client_ip(&headers, connect_info);

  let inserted = sqlx::query(
    r#"
      INSERT INTO users (id, email, password_hash, last_ip)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (email) DO NOTHING
      RETURNING id
    "#,
  )
  .bind(user_id)
  .bind(&email)
  .bind(&password_hash)
  .bind(&client_ip)
  .fetch_optional(&state.pool)
  .await;

  match inserted {
    Ok(Some(_)) => {}
    Ok(None) => return err(StatusCode::CONFLICT, "email_in_use").into_response(),
    Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response(),
  }

  if ensure_free_plan(&state.pool, user_id).await.is_err() {
    return err(StatusCode::INTERNAL_SERVER_ERROR, "licensing_error").into_response();
  }

  let tokens = issue_tokens(&state, user_id, &email).await;
  match tokens {
    Ok(v) => (StatusCode::OK, Json(v)).into_response(),
    Err(_) => err(StatusCode::INTERNAL_SERVER_ERROR, "token_error").into_response(),
  }
}

async fn login(
  State(state): State<AppState>,
  headers: axum::http::HeaderMap,
  connect_info: Option<ConnectInfo<SocketAddr>>,
  Json(req): Json<LoginRequest>,
) -> axum::response::Response {
  let email = normalize_email(&req.email);
  if !is_valid_email(&email) {
    return err(StatusCode::BAD_REQUEST, "invalid_email").into_response();
  }

  let row = sqlx::query("SELECT id, password_hash FROM users WHERE email = $1")
    .bind(&email)
    .fetch_optional(&state.pool)
    .await;

  let row = match row {
    Ok(Some(r)) => r,
    Ok(None) => return err(StatusCode::UNAUTHORIZED, "invalid_credentials").into_response(),
    Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response(),
  };

  let user_id: Uuid = row.get("id");
  let password_hash: String = row.get("password_hash");
  if !verify_password(&req.password, &password_hash) {
    return err(StatusCode::UNAUTHORIZED, "invalid_credentials").into_response();
  }

  let client_ip = get_client_ip(&headers, connect_info);
  if let Some(ip) = client_ip {
    let _ = sqlx::query("UPDATE users SET last_ip = $1 WHERE id = $2")
      .bind(ip)
      .bind(user_id)
      .execute(&state.pool)
      .await;
  }

  let tokens = issue_tokens(&state, user_id, &email).await;
  match tokens {
    Ok(v) => (StatusCode::OK, Json(v)).into_response(),
    Err(_) => err(StatusCode::INTERNAL_SERVER_ERROR, "token_error").into_response(),
  }
}

async fn refresh(State(state): State<AppState>, Json(req): Json<RefreshRequest>) -> axum::response::Response {
  if req.refresh_token.trim().is_empty() {
    return err(StatusCode::BAD_REQUEST, "invalid_refresh_token").into_response();
  }

  let now = OffsetDateTime::now_utc();
  let hash = sha256_hex(req.refresh_token.as_bytes());

  let row = sqlx::query(
    r#"
      SELECT s.id, s.user_id, u.email
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.refresh_token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
      LIMIT 1
    "#,
  )
  .bind(&hash)
  .fetch_optional(&state.pool)
  .await;

  let row = match row {
    Ok(Some(r)) => r,
    Ok(None) => return err(StatusCode::UNAUTHORIZED, "invalid_refresh_token").into_response(),
    Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response(),
  };

  let session_id: Uuid = row.get("id");
  let user_id: Uuid = row.get("user_id");
  let email: String = row.get("email");

  let new_refresh = random_token_urlsafe(48);
  let new_hash = sha256_hex(new_refresh.as_bytes());
  let expires_at = now + Duration::days(state.cfg.refresh_token_ttl_days);

  let updated = sqlx::query(
    r#"
      UPDATE sessions
      SET refresh_token_hash = $1, last_used_at = $2, expires_at = $3
      WHERE id = $4
    "#,
  )
  .bind(&new_hash)
  .bind(now)
  .bind(expires_at)
  .bind(session_id)
  .execute(&state.pool)
  .await;

  if updated.is_err() {
    return err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response();
  }

  let access = issue_access_token(&state, user_id, &email);
  match access {
    Ok(access_token) => (
      StatusCode::OK,
      Json(AuthResponse {
        access_token,
        refresh_token: new_refresh,
        user: UserInfo { id: user_id.to_string(), email },
      }),
    )
      .into_response(),
    Err(_) => err(StatusCode::INTERNAL_SERVER_ERROR, "token_error").into_response(),
  }
}

async fn logout(State(state): State<AppState>, Json(req): Json<LogoutRequest>) -> axum::response::Response {
  if req.refresh_token.trim().is_empty() {
    return err(StatusCode::BAD_REQUEST, "invalid_refresh_token").into_response();
  }
  let hash = sha256_hex(req.refresh_token.as_bytes());
  let now = OffsetDateTime::now_utc();

  let res = sqlx::query("UPDATE sessions SET revoked_at = $1 WHERE refresh_token_hash = $2 AND revoked_at IS NULL")
    .bind(now)
    .bind(hash)
    .execute(&state.pool)
    .await;

  match res {
    Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response(),
    Err(_) => err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response(),
  }
}

async fn me(State(state): State<AppState>, headers: axum::http::HeaderMap) -> axum::response::Response {
  let token = match bearer_token(&headers) {
    Some(t) => t,
    None => return err(StatusCode::UNAUTHORIZED, "missing_token").into_response(),
  };

  let claims = match decode_access_token(&state, &token) {
    Ok(c) => c,
    Err(code) => return err(code, "invalid_token").into_response(),
  };

  let user_id = match Uuid::parse_str(&claims.sub) {
    Ok(v) => v,
    Err(_) => return err(StatusCode::UNAUTHORIZED, "invalid_token").into_response(),
  };

  let row = sqlx::query("SELECT id, email FROM users WHERE id = $1")
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await;

  let row = match row {
    Ok(Some(r)) => r,
    Ok(None) => return err(StatusCode::UNAUTHORIZED, "invalid_token").into_response(),
    Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response(),
  };

  let id: Uuid = row.get("id");
  let email: String = row.get("email");
  (StatusCode::OK, Json(UserInfo { id: id.to_string(), email })).into_response()
}

async fn entitlements(State(state): State<AppState>, headers: axum::http::HeaderMap) -> axum::response::Response {
  let user_id = match access_user_id(&state, &headers) {
    Ok(v) => v,
    Err(r) => return r,
  };

  let now = OffsetDateTime::now_utc();
  let _ = sqlx::query(
    "UPDATE subscriptions SET status = 'expired', canceled_at = $1 WHERE user_id = $2 AND status = 'active' AND ends_at IS NOT NULL AND ends_at <= $1",
  )
  .bind(now)
  .bind(user_id)
  .execute(&state.pool)
  .await;

  let rows = sqlx::query(
    r#"
      SELECT
        p.code AS product_code,
        pl.code AS plan_code,
        pl.name AS plan_name,
        s.status AS status,
        s.ends_at AS ends_at
      FROM subscriptions s
      JOIN products p ON p.id = s.product_id
      JOIN plans pl ON pl.id = s.plan_id
      WHERE s.user_id = $1
        AND s.status = 'active'
        AND (s.ends_at IS NULL OR s.ends_at > now())
      ORDER BY p.code ASC
    "#,
  )
  .bind(user_id)
  .fetch_all(&state.pool)
  .await;

  let rows = match rows {
    Ok(v) => v,
    Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response(),
  };

  let mut products: Vec<ProductEntitlement> = Vec::new();
  for r in rows {
    let product_code: String = r.get("product_code");
    let plan_code: String = r.get("plan_code");
    let plan_name: String = r.get("plan_name");
    let status: String = r.get("status");
    let ends_at: Option<sqlx::types::time::OffsetDateTime> = r.try_get("ends_at").ok();
    let feature_rows = sqlx::query(
      r#"
        SELECT f.code AS code
        FROM plan_features pf
        JOIN features f ON f.id = pf.feature_id
        JOIN plans pl ON pl.id = pf.plan_id
        JOIN products p ON p.id = pl.product_id
        WHERE p.code = $1 AND pl.code = $2
        ORDER BY f.code ASC
      "#,
    )
    .bind(&product_code)
    .bind(&plan_code)
    .fetch_all(&state.pool)
    .await;

    let features: Vec<String> = match feature_rows {
      Ok(v) => v.into_iter().map(|x| x.get::<String, _>("code")).collect(),
      Err(_) => Vec::new(),
    };

    products.push(ProductEntitlement {
      product_code,
      plan_code,
      plan_name,
      status,
      ends_at: ends_at.map(|t| t.format(&time::format_description::well_known::Rfc3339).unwrap_or_default()),
      features,
    });
  }

  (StatusCode::OK, Json(EntitlementsResponse { products })).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectPlanRequest {
  plan_code: String,
  billing_cycle: Option<String>,
}

async fn portal_select_plan(
  State(state): State<AppState>,
  headers: axum::http::HeaderMap,
  Json(req): Json<SelectPlanRequest>,
) -> axum::response::Response {
  let user_id = match access_user_id(&state, &headers) {
    Ok(v) => v,
    Err(e) => return e,
  };

  let valid_plans = ["basic", "standard", "pro", "lifetime_pro"];
  if !valid_plans.contains(&req.plan_code.as_str()) {
    return err(StatusCode::BAD_REQUEST, "invalid_plan").into_response();
  }

  let product_code = "kivana";
  let plan_code = req.plan_code.trim().to_lowercase();
  let billing_cycle = req
    .billing_cycle
    .clone()
    .unwrap_or_else(|| "monthly".to_string())
    .trim()
    .to_lowercase();
  let valid_cycles = ["monthly", "yearly"];
  if !valid_cycles.contains(&billing_cycle.as_str()) {
    return err(StatusCode::BAD_REQUEST, "invalid_billing_cycle").into_response();
  }

  let prod_row = sqlx::query("SELECT id FROM products WHERE code = $1")
    .bind(product_code)
    .fetch_optional(&state.pool)
    .await;
  let product_id: Uuid = match prod_row {
    Ok(Some(r)) => r.get("id"),
    _ => return err(StatusCode::NOT_FOUND, "product_not_found").into_response(),
  };

  let plan_row = sqlx::query("SELECT id FROM plans WHERE product_id = $1 AND code = $2")
    .bind(product_id)
    .bind(&plan_code)
    .fetch_optional(&state.pool)
    .await;
  let plan_id: Uuid = match plan_row {
    Ok(Some(r)) => r.get("id"),
    _ => return err(StatusCode::NOT_FOUND, "plan_not_found").into_response(),
  };

  // Set the end date appropriately
  let ends_at = match req.plan_code.as_str() {
    "basic" | "lifetime_pro" => None,
    "standard" | "pro" => {
      let days = if billing_cycle == "yearly" { 365 } else { 30 };
      Some(OffsetDateTime::now_utc() + Duration::days(days))
    }
    _ => None,
  };

  let tx = state.pool.begin().await;
  let mut tx = match tx {
    Ok(v) => v,
    Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response(),
  };

  let now = OffsetDateTime::now_utc();
  let _ = sqlx::query("UPDATE subscriptions SET status = 'canceled', canceled_at = $1 WHERE user_id = $2 AND product_id = $3 AND status = 'active'")
    .bind(now)
    .bind(user_id)
    .bind(product_id)
    .execute(&mut *tx)
    .await;

  let sub_id = Uuid::new_v4();
  let inserted = sqlx::query(
    "INSERT INTO subscriptions (id, user_id, product_id, plan_id, status, started_at, ends_at) VALUES ($1,$2,$3,$4,'active',$5,$6)",
  )
  .bind(sub_id)
  .bind(user_id)
  .bind(product_id)
  .bind(plan_id)
  .bind(now)
  .bind(ends_at)
  .execute(&mut *tx)
  .await;

  if inserted.is_err() {
    return err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response();
  }

  if tx.commit().await.is_err() {
    return err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response();
  }

  // Send real-time event to the desktop app
  let _ = state.tx_events.send(UserEvent {
    user_id: user_id.to_string(),
    event_type: "entitlements_updated".to_string(),
  });

  (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response()
}

async fn poll_events(
  State(state): State<AppState>,
  headers: axum::http::HeaderMap,
) -> axum::response::Response {
  let user_id = match access_user_id(&state, &headers) {
    Ok(v) => v,
    Err(e) => return e,
  };
  let user_id_str = user_id.to_string();

  let mut rx = state.tx_events.subscribe();
  let timeout = tokio::time::sleep(std::time::Duration::from_secs(30));
  tokio::pin!(timeout);

  loop {
    tokio::select! {
      _ = &mut timeout => {
        return StatusCode::NO_CONTENT.into_response();
      }
      res = rx.recv() => {
        match res {
          Ok(event) => {
            if event.user_id == user_id_str {
              return Json(event).into_response();
            }
          }
          Err(_) => {
            return StatusCode::NO_CONTENT.into_response();
          }
        }
      }
    }
  }
}

async fn admin_grant(State(state): State<AppState>, headers: axum::http::HeaderMap, Json(req): Json<AdminGrantRequest>) -> axum::response::Response {
  if let Err(r) = require_admin(&state, &headers).await {
    return r;
  }

  let email = normalize_email(&req.email);
  if !is_valid_email(&email) {
    return err(StatusCode::BAD_REQUEST, "invalid_email").into_response();
  }

  let user_row = sqlx::query("SELECT id FROM users WHERE email = $1")
    .bind(&email)
    .fetch_optional(&state.pool)
    .await;
  let user_id: Uuid = match user_row {
    Ok(Some(r)) => r.get("id"),
    Ok(None) => return err(StatusCode::NOT_FOUND, "user_not_found").into_response(),
    Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response(),
  };

  let product_code = req.product_code.trim().to_lowercase();
  let plan_code = req.plan_code.trim().to_lowercase();

  let prod_row = sqlx::query("SELECT id FROM products WHERE code = $1")
    .bind(&product_code)
    .fetch_optional(&state.pool)
    .await;
  let product_id: Uuid = match prod_row {
    Ok(Some(r)) => r.get("id"),
    Ok(None) => return err(StatusCode::NOT_FOUND, "product_not_found").into_response(),
    Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response(),
  };

  let plan_row = sqlx::query("SELECT id FROM plans WHERE product_id = $1 AND code = $2")
    .bind(product_id)
    .bind(&plan_code)
    .fetch_optional(&state.pool)
    .await;
  let plan_id: Uuid = match plan_row {
    Ok(Some(r)) => r.get("id"),
    Ok(None) => return err(StatusCode::NOT_FOUND, "plan_not_found").into_response(),
    Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response(),
  };

  let ends_at = match req.ends_at.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
    None => None,
    Some(s) => match OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339) {
      Ok(v) => Some(v),
      Err(_) => return err(StatusCode::BAD_REQUEST, "invalid_ends_at").into_response(),
    },
  };

  let tx = state.pool.begin().await;
  let mut tx = match tx {
    Ok(v) => v,
    Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response(),
  };

  let now = OffsetDateTime::now_utc();
  let _ = sqlx::query("UPDATE subscriptions SET status = 'canceled', canceled_at = $1 WHERE user_id = $2 AND product_id = $3 AND status = 'active'")
    .bind(now)
    .bind(user_id)
    .bind(product_id)
    .execute(&mut *tx)
    .await;

  let sub_id = Uuid::new_v4();
  let inserted = sqlx::query(
    "INSERT INTO subscriptions (id, user_id, product_id, plan_id, status, started_at, ends_at) VALUES ($1,$2,$3,$4,'active',$5,$6)",
  )
  .bind(sub_id)
  .bind(user_id)
  .bind(product_id)
  .bind(plan_id)
  .bind(now)
  .bind(ends_at)
  .execute(&mut *tx)
  .await;

  if inserted.is_err() {
    return err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response();
  }

  if tx.commit().await.is_err() {
    return err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response();
  }

  // Send real-time event to the desktop app
  let _ = state.tx_events.send(UserEvent {
    user_id: user_id.to_string(),
    event_type: "entitlements_updated".to_string(),
  });

  (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
}

async fn admin_bootstrap(
  State(state): State<AppState>,
  headers: axum::http::HeaderMap,
  Json(req): Json<AdminBootstrapRequest>,
) -> axum::response::Response {
  let admin_token = match std::env::var("ADMIN_TOKEN").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
    Some(v) => v,
    None => return err(StatusCode::NOT_FOUND, "not_found").into_response(),
  };

  let provided = headers
    .get("x-admin-token")
    .and_then(|v| v.to_str().ok())
    .map(|s| s.trim().to_string())
    .unwrap_or_default();
  if provided.is_empty() || provided != admin_token {
    return err(StatusCode::UNAUTHORIZED, "unauthorized").into_response();
  }

  let email = normalize_email(&req.email);
  if !is_valid_email(&email) {
    return err(StatusCode::BAD_REQUEST, "invalid_email").into_response();
  }

  let updated = sqlx::query("UPDATE users SET is_admin = TRUE WHERE email = $1")
    .bind(&email)
    .execute(&state.pool)
    .await;
  match updated {
    Ok(r) if r.rows_affected() > 0 => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response(),
    Ok(_) => err(StatusCode::NOT_FOUND, "user_not_found").into_response(),
    Err(_) => err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response(),
  }
}

async fn admin_users(State(state): State<AppState>, headers: axum::http::HeaderMap) -> axum::response::Response {
  if let Err(r) = require_admin(&state, &headers).await {
    return r;
  }

  let rows = sqlx::query(
    r#"
      SELECT
        u.id AS id,
        u.email AS email,
        u.created_at AS created_at,
        u.is_admin AS is_admin,
        u.last_ip AS last_ip,
        pl.code AS plan_code,
        pl.name AS plan_name,
        s.ends_at AS ends_at
      FROM users u
      LEFT JOIN subscriptions s
        ON s.user_id = u.id
       AND s.status = 'active'
       AND (s.ends_at IS NULL OR s.ends_at > now())
       AND s.product_id = (SELECT id FROM products WHERE code = 'kivana' LIMIT 1)
      LEFT JOIN plans pl ON pl.id = s.plan_id
      ORDER BY u.created_at DESC
      LIMIT 500
    "#,
  )
  .fetch_all(&state.pool)
  .await;

  let rows = match rows {
    Ok(v) => v,
    Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response(),
  };

  let mut users: Vec<AdminUserRow> = Vec::with_capacity(rows.len());
  for r in rows {
    let id: Uuid = r.get("id");
    let email: String = r.get("email");
    let created_at: sqlx::types::time::OffsetDateTime = r.get("created_at");
    let is_admin: bool = r.get("is_admin");
    let last_ip: Option<String> = r.try_get("last_ip").ok().flatten();
    let plan_code: Option<String> = r.try_get("plan_code").ok();
    let plan_name: Option<String> = r.try_get("plan_name").ok();
    let ends_at: Option<sqlx::types::time::OffsetDateTime> = r.try_get("ends_at").ok();

    users.push(AdminUserRow {
      id: id.to_string(),
      email,
      created_at: created_at.format(&time::format_description::well_known::Rfc3339).unwrap_or_default(),
      is_admin,
      last_ip,
      kivana_plan_code: plan_code,
      kivana_plan_name: plan_name,
      kivana_ends_at: ends_at.map(|t| t.format(&time::format_description::well_known::Rfc3339).unwrap_or_default()),
    });
  }

  (StatusCode::OK, Json(AdminUsersResponse { users })).into_response()
}

async fn admin_delete_user(
  State(state): State<AppState>,
  headers: axum::http::HeaderMap,
  axum::extract::Path(id): axum::extract::Path<Uuid>,
) -> axum::response::Response {
  if let Err(r) = require_admin(&state, &headers).await {
    return r;
  }

  let res = sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(id)
    .execute(&state.pool)
    .await;

  match res {
    Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response(),
    Err(_) => err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response(),
  }
}

async fn admin_set_password(
  State(state): State<AppState>,
  headers: axum::http::HeaderMap,
  axum::extract::Path(id): axum::extract::Path<Uuid>,
  Json(req): Json<AdminSetPasswordRequest>,
) -> axum::response::Response {
  if let Err(r) = require_admin(&state, &headers).await {
    return r;
  }
  if req.password.len() < 8 {
    return err(StatusCode::BAD_REQUEST, "weak_password").into_response();
  }

  let password_hash = match hash_password(&req.password) {
    Ok(v) => v,
    Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "hash_failed").into_response(),
  };

  let updated = sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
    .bind(password_hash)
    .bind(id)
    .execute(&state.pool)
    .await;

  match updated {
    Ok(r) if r.rows_affected() > 0 => {
      let now = OffsetDateTime::now_utc();
      let _ = sqlx::query("UPDATE sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL")
        .bind(now)
        .bind(id)
        .execute(&state.pool)
        .await;
      (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
    }
    Ok(_) => err(StatusCode::NOT_FOUND, "user_not_found").into_response(),
    Err(_) => err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response(),
  }
}

fn err(status: StatusCode, code: &str) -> impl IntoResponse {
  (status, Json(ErrorResponse { error: code.to_string() }))
}

fn normalize_email(email: &str) -> String {
  email.trim().to_lowercase()
}

fn is_valid_email(email: &str) -> bool {
  let s = email.trim();
  if s.len() < 3 || s.len() > 320 {
    return false;
  }
  let at = match s.find('@') {
    Some(v) => v,
    None => return false,
  };
  at > 0 && at < s.len() - 1
}

fn hash_password(password: &str) -> anyhow::Result<String> {
  let salt = SaltString::generate(&mut rand::thread_rng());
  let argon2 = Argon2::default();
  let hash = argon2
    .hash_password(password.as_bytes(), &salt)
    .map_err(|e| anyhow::anyhow!(e.to_string()))?
    .to_string();
  Ok(hash)
}

fn verify_password(password: &str, password_hash: &str) -> bool {
  let parsed = match PasswordHash::new(password_hash) {
    Ok(v) => v,
    Err(_) => return false,
  };
  Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok()
}

fn access_user_id(state: &AppState, headers: &axum::http::HeaderMap) -> Result<Uuid, axum::response::Response> {
  let token = match bearer_token(headers) {
    Some(t) => t,
    None => return Err(err(StatusCode::UNAUTHORIZED, "missing_token").into_response()),
  };
  let claims = match decode_access_token(state, &token) {
    Ok(c) => c,
    Err(code) => return Err(err(code, "invalid_token").into_response()),
  };
  let user_id = match Uuid::parse_str(&claims.sub) {
    Ok(v) => v,
    Err(_) => return Err(err(StatusCode::UNAUTHORIZED, "invalid_token").into_response()),
  };
  Ok(user_id)
}

async fn require_admin(state: &AppState, headers: &axum::http::HeaderMap) -> Result<(), axum::response::Response> {
  let user_id = match access_user_id(state, headers) {
    Ok(v) => v,
    Err(r) => return Err(r),
  };

  let row = sqlx::query("SELECT is_admin FROM users WHERE id = $1")
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await;

  let is_admin: bool = match row {
    Ok(Some(r)) => r.get("is_admin"),
    Ok(None) => return Err(err(StatusCode::UNAUTHORIZED, "invalid_token").into_response()),
    Err(_) => return Err(err(StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response()),
  };

  if !is_admin {
    return Err(err(StatusCode::FORBIDDEN, "forbidden").into_response());
  }
  Ok(())
}

async fn ensure_free_plan(pool: &PgPool, user_id: Uuid) -> anyhow::Result<()> {
  let product_code = "kivana";
  let plan_code = "basic";

  let r = sqlx::query(
    r#"
      SELECT p.id AS product_id, pl.id AS plan_id
      FROM products p
      JOIN plans pl ON pl.product_id = p.id
      WHERE p.code = $1 AND pl.code = $2
      LIMIT 1
    "#,
  )
  .bind(product_code)
  .bind(plan_code)
  .fetch_one(pool)
  .await?;

  let product_id: Uuid = r.get("product_id");
  let plan_id: Uuid = r.get("plan_id");

  let now = OffsetDateTime::now_utc();
  let sub_id = Uuid::new_v4();
  let _ = sqlx::query(
    r#"
      INSERT INTO subscriptions (id, user_id, product_id, plan_id, status, started_at)
      VALUES ($1, $2, $3, $4, 'active', $5)
      ON CONFLICT (user_id, product_id) WHERE status = 'active' DO NOTHING
    "#,
  )
  .bind(sub_id)
  .bind(user_id)
  .bind(product_id)
  .bind(plan_id)
  .bind(now)
  .execute(pool)
  .await?;

  Ok(())
}

async fn issue_tokens(state: &AppState, user_id: Uuid, email: &str) -> anyhow::Result<AuthResponse> {
  let now = OffsetDateTime::now_utc();
  let access_token = issue_access_token(state, user_id, email)?;

  let refresh = random_token_urlsafe(48);
  let refresh_hash = sha256_hex(refresh.as_bytes());
  let expires_at = now + Duration::days(state.cfg.refresh_token_ttl_days);

  let session_id = Uuid::new_v4();
  sqlx::query(
    r#"
      INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at)
      VALUES ($1, $2, $3, $4)
    "#,
  )
  .bind(session_id)
  .bind(user_id)
  .bind(refresh_hash)
  .bind(expires_at)
  .execute(&state.pool)
  .await?;

  Ok(AuthResponse {
    access_token,
    refresh_token: refresh,
    user: UserInfo { id: user_id.to_string(), email: email.to_string() },
  })
}

fn issue_access_token(state: &AppState, user_id: Uuid, email: &str) -> anyhow::Result<String> {
  let now = OffsetDateTime::now_utc().unix_timestamp();
  let exp = now + state.cfg.access_token_ttl_seconds;
  let claims = AccessClaims {
    sub: user_id.to_string(),
    email: email.to_string(),
    iat: now as usize,
    exp: exp as usize,
  };
  let token = jsonwebtoken::encode(&Header::default(), &claims, &state.jwt.enc)?;
  Ok(token)
}

fn decode_access_token(state: &AppState, token: &str) -> Result<AccessClaims, StatusCode> {
  let mut validation = Validation::default();
  validation.validate_exp = true;
  let data =
    jsonwebtoken::decode::<AccessClaims>(token, &state.jwt.dec, &validation).map_err(|_| StatusCode::UNAUTHORIZED)?;
  Ok(data.claims)
}

fn bearer_token(headers: &axum::http::HeaderMap) -> Option<String> {
  let v = headers.get(axum::http::header::AUTHORIZATION)?;
  let s = v.to_str().ok()?;
  let s = s.trim();
  if !s.to_ascii_lowercase().starts_with("bearer ") {
    return None;
  }
  Some(s[7..].trim().to_string())
}

fn random_token_urlsafe(bytes: usize) -> String {
  let mut buf = vec![0u8; bytes];
  rand::thread_rng().fill_bytes(&mut buf);
  base64_url(&buf)
}

fn base64_url(data: &[u8]) -> String {
  const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let mut out = String::new();
  let mut i = 0;
  while i < data.len() {
    let b0 = data[i] as u32;
    let b1 = if i + 1 < data.len() { data[i + 1] as u32 } else { 0 };
    let b2 = if i + 2 < data.len() { data[i + 2] as u32 } else { 0 };
    let triple = (b0 << 16) | (b1 << 8) | b2;
    out.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
    out.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
    if i + 1 < data.len() {
      out.push(TABLE[((triple >> 6) & 0x3f) as usize] as char);
    }
    if i + 2 < data.len() {
      out.push(TABLE[(triple & 0x3f) as usize] as char);
    }
    i += 3;
  }
  out
}

fn sha256_hex(bytes: &[u8]) -> String {
  let mut hasher = Sha256::new();
  hasher.update(bytes);
  let digest = hasher.finalize();
  hex::encode(digest)
}

fn load_config() -> anyhow::Result<AppConfig> {
  let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL")?;
  let jwt_secret = std::env::var("JWT_SECRET").context("JWT_SECRET")?;
  let access_token_ttl_seconds = std::env::var("ACCESS_TOKEN_TTL_SECONDS")
    .ok()
    .and_then(|v| v.parse::<i64>().ok())
    .unwrap_or(15 * 60);
  let refresh_token_ttl_days = std::env::var("REFRESH_TOKEN_TTL_DAYS")
    .ok()
    .and_then(|v| v.parse::<i64>().ok())
    .unwrap_or(30);
  let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
  let bind_addr = bind.parse::<SocketAddr>().context("BIND_ADDR")?;

  Ok(AppConfig { database_url, jwt_secret, access_token_ttl_seconds, refresh_token_ttl_days, bind_addr })
}

fn get_client_ip(headers: &axum::http::HeaderMap, connect_info: Option<ConnectInfo<SocketAddr>>) -> Option<String> {
  if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
    if let Some(first) = xff.split(',').next() {
      let ip = first.trim();
      if !ip.is_empty() {
        return Some(ip.to_string());
      }
    }
  }
  if let Some(xrip) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
    let ip = xrip.trim();
    if !ip.is_empty() {
      return Some(ip.to_string());
    }
  }
  if let Some(ConnectInfo(addr)) = connect_info {
    return Some(addr.ip().to_string());
  }
  None
}
