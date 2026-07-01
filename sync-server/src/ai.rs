//! AI-ассистент команд для NexuSSH.
//!
//! Прокси к Claude API с gating и лимитами. Клиент шлёт запрос на естественном
//! языке → сервер проверяет доступ (allowlist `ai_access`), лимиты (rate / daily
//! per-user / глобальный hard-cap), вызывает Claude и возвращает список команд.
//! Сам ключ Claude на сервере — клиент его не видит.
//!
//! ВАЖНО: `api.anthropic.com` гео-заблокирован из РФ, поэтому исходящий вызов
//! идёт через наш VPN-прокси (env `NEXUSSH_AI_PROXY`, socks5/http). Если прокси
//! не задан — прямой вызов (для не-РФ размещения).
//!
//! hipocrisle — админ: доступ без approve, без лимитов, любые модели, контекст.

use axum::http::{HeaderMap, StatusCode};
use axum::{extract::State, response::IntoResponse, Extension, Json};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::handlers::{db_err, ApiError, AuthUser};
use crate::AppState;

type ApiResult<T> = Result<T, ApiError>;

/// Логин-администратор: полный доступ без approve и без лимитов.
const ADMIN_USERNAME: &str = "hipocrisle";
/// Максимальная длина пользовательского запроса (символы). Защита от гигантских
/// пейлоадов, которые сожгли бы токены.
const INPUT_CAP: usize = 2000;
/// Глобальный дневной потолок токенов по умолчанию (переопределяется env
/// `NEXUSSH_AI_GLOBAL_DAILY_CAP`). Предохранитель: при достижении AI выключается
/// для всех до конца суток.
const GLOBAL_DAILY_CAP_DEFAULT: i64 = 3_000_000;

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Номер UTC-суток (для посуточного учёта).
fn today() -> i64 {
    now() / 86_400
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.is_empty())
}

/// Дневной лимит запросов по тиру. None = без лимита.
fn daily_request_limit(tier: &str) -> Option<i64> {
    match tier {
        "unlimited" => None,
        "full" => Some(300),
        _ => Some(50), // standard
    }
}

fn global_daily_cap() -> i64 {
    env("NEXUSSH_AI_GLOBAL_DAILY_CAP")
        .and_then(|s| s.parse().ok())
        .unwrap_or(GLOBAL_DAILY_CAP_DEFAULT)
}

// ─────────────────────────────────────────────────────────────────────────────
// Разрешение доступа
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct Access {
    username: String,
    status: String,
    tier: String,
    model: String,
    context_allowed: bool,
}

/// Достаём username + запись доступа. hipocrisle всегда админ (granted/unlimited/
/// opus/context) даже без строки в ai_access.
fn resolve_access(conn: &rusqlite::Connection, user_id: &str) -> Result<Access, ApiError> {
    let username: String = conn
        .query_row("SELECT username FROM users WHERE id=?1", [user_id], |r| {
            r.get(0)
        })
        .map_err(db_err)?;

    if username == ADMIN_USERNAME {
        return Ok(Access {
            username,
            status: "granted".into(),
            tier: "unlimited".into(),
            model: "opus".into(),
            context_allowed: true,
        });
    }

    let row = conn
        .query_row(
            "SELECT status, tier, model, context_allowed, expires_at
               FROM ai_access WHERE user_id=?1",
            [user_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(db_err)?;

    match row {
        None => Ok(Access {
            username,
            status: "none".into(),
            tier: "standard".into(),
            model: "haiku".into(),
            context_allowed: false,
        }),
        Some((mut status, tier, model, ctx, expires)) => {
            // Истёкший грант → трактуем как отсутствие доступа.
            if status == "granted" {
                if let Some(exp) = expires {
                    if exp <= now() {
                        status = "expired".into();
                    }
                }
            }
            Ok(Access {
                username,
                status,
                tier,
                model,
                context_allowed: ctx != 0,
            })
        }
    }
}

/// Сколько запросов юзер уже сделал сегодня.
fn requests_today(conn: &rusqlite::Connection, user_id: &str) -> i64 {
    conn.query_row(
        "SELECT requests FROM ai_ledger WHERE user_id=?1 AND day=?2",
        rusqlite::params![user_id, today()],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or(0)
}

fn global_tokens_today(conn: &rusqlite::Connection) -> i64 {
    conn.query_row("SELECT tokens FROM ai_global WHERE day=?1", [today()], |r| {
        r.get(0)
    })
    .optional()
    .ok()
    .flatten()
    .unwrap_or(0)
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/ai/status — что доступно этому юзеру
// ─────────────────────────────────────────────────────────────────────────────

pub async fn status(
    State(state): State<AppState>,
    user: Extension<AuthUser>,
) -> ApiResult<impl IntoResponse> {
    let conn = state.db.conn.lock().unwrap();
    let acc = resolve_access(&conn, &user.user_id)?;
    let used = requests_today(&conn, &user.user_id);
    let limit = daily_request_limit(&acc.tier);
    let remaining = limit.map(|l| (l - used).max(0));
    Ok(Json(json!({
        "status": acc.status,                 // none|pending|granted|denied|expired
        "tier": acc.tier,
        "model": acc.model,
        "context_allowed": acc.context_allowed,
        "used_today": used,
        "daily_limit": limit,                 // null = unlimited
        "remaining": remaining,               // null = unlimited
    })))
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/ai/request — запросить доступ (уведомление админу в Telegram)
// ─────────────────────────────────────────────────────────────────────────────

pub async fn request_access(
    State(state): State<AppState>,
    user: Extension<AuthUser>,
) -> ApiResult<impl IntoResponse> {
    let (username, already) = {
        let conn = state.db.conn.lock().unwrap();
        let acc = resolve_access(&conn, &user.user_id)?;
        if acc.status == "granted" {
            return Ok(Json(json!({ "status": "granted" })));
        }
        // upsert pending
        conn.execute(
            "INSERT INTO ai_access(user_id, username, status, requested_at)
             VALUES(?1, ?2, 'pending', ?3)
             ON CONFLICT(user_id) DO UPDATE SET status='pending', requested_at=?3
             WHERE ai_access.status NOT IN ('granted')",
            rusqlite::params![user.user_id, acc.username, now()],
        )
        .map_err(db_err)?;
        (acc.username, acc.status == "pending")
    };

    if !already {
        // Уведомляем админа с inline-кнопками. Ошибку TG не роняем на клиента.
        let uid = user.user_id.clone();
        let uname = username.clone();
        tokio::spawn(async move {
            if let Err(e) = notify_admin_request(&uid, &uname).await {
                tracing::warn!("ai request TG notify failed: {e}");
            }
        });
    }
    Ok(Json(json!({ "status": "pending" })))
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/ai/suggest — основной эндпоинт: запрос → команды
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SuggestReq {
    query: String,
    /// Платформа: "linux" | "cisco-ios" | "esxi" | ... (подсказка для модели).
    #[serde(default)]
    os: Option<String>,
}

#[derive(Serialize)]
struct Suggestion {
    cmd: String,
    explain: String,
    danger: bool,
}

pub async fn suggest(
    State(state): State<AppState>,
    user: Extension<AuthUser>,
    Json(req): Json<SuggestReq>,
) -> ApiResult<impl IntoResponse> {
    let q = req.query.trim();
    if q.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "empty query"));
    }
    if q.chars().count() > INPUT_CAP {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "query too long",
        ));
    }
    // Rate-limit (переиспользуем токен-бакет; ключ — юзер).
    if !state.ratelimit.check(&format!("ai:{}", user.user_id)) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate limited",
        ));
    }

    // Проверки доступа/лимитов под локом; вызов Claude — уже без лока.
    let (model, _tier) = {
        let conn = state.db.conn.lock().unwrap();
        let acc = resolve_access(&conn, &user.user_id)?;
        if acc.status != "granted" {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "ai not enabled"));
        }
        if let Some(limit) = daily_request_limit(&acc.tier) {
            if requests_today(&conn, &user.user_id) >= limit {
                return Err(ApiError::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    "daily limit reached",
                ));
            }
        }
        if global_tokens_today(&conn) >= global_daily_cap() {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "ai temporarily unavailable (global cap)",
            ));
        }
        (acc.model.clone(), acc.tier.clone())
    };

    let os = req.os.as_deref().unwrap_or("linux");
    let system = format!(
        "Ты помощник по командной строке для SSH-сессий. Платформа: {os}. \
         Пользователь описывает что хочет сделать. Верни ТОЛЬКО JSON-массив \
         вариантов команд (1-5 штук), самый подходящий первым, в формате: \
         [{{\"cmd\":\"...\",\"explain\":\"кратко на русском что делает\",\"danger\":true|false}}]. \
         danger=true для разрушительных/необратимых команд (удаление, перезагрузка, \
         форматирование, сброс конфига). Без markdown, без пояснений вне JSON."
    );

    let (text, tokens) = call_claude(&model, &system, q)
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, &format!("ai upstream: {e}")))?;

    let suggestions = parse_suggestions(&text);

    // Учёт расхода.
    {
        let conn = state.db.conn.lock().unwrap();
        let d = today();
        let _ = conn.execute(
            "INSERT INTO ai_ledger(user_id, day, requests, tokens) VALUES(?1,?2,1,?3)
             ON CONFLICT(user_id, day) DO UPDATE SET
               requests = requests + 1, tokens = tokens + ?3",
            rusqlite::params![user.user_id, d, tokens],
        );
        let _ = conn.execute(
            "INSERT INTO ai_global(day, tokens) VALUES(?1,?2)
             ON CONFLICT(day) DO UPDATE SET tokens = tokens + ?2",
            rusqlite::params![d, tokens],
        );
    }

    Ok(Json(json!({ "suggestions": suggestions })))
}

/// Дополнительная страховка: помечаем danger по эвристике, даже если модель не.
fn danger_heuristic(cmd: &str) -> bool {
    let c = cmd.to_lowercase();
    const PATTERNS: &[&str] = &[
        "rm -rf", "mkfs", "dd ", ":(){", "reload", "wr erase", "write erase",
        "erase startup", "format ", "shutdown", "reboot", "halt", "> /dev/",
        "drop table", "drop database", "iptables -f", "flushall",
    ];
    PATTERNS.iter().any(|p| c.contains(p))
}

/// Достаём JSON-массив из ответа модели (терпимо к обёрткам/markdown).
fn parse_suggestions(text: &str) -> Vec<Suggestion> {
    let start = text.find('[');
    let end = text.rfind(']');
    let slice = match (start, end) {
        (Some(s), Some(e)) if e > s => &text[s..=e],
        _ => return Vec::new(),
    };
    let raw: Vec<serde_json::Value> = serde_json::from_str(slice).unwrap_or_default();
    raw.into_iter()
        .filter_map(|v| {
            let cmd = v.get("cmd")?.as_str()?.to_string();
            if cmd.is_empty() {
                return None;
            }
            let explain = v
                .get("explain")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let danger =
                v.get("danger").and_then(|x| x.as_bool()).unwrap_or(false) || danger_heuristic(&cmd);
            Some(Suggestion {
                cmd,
                explain,
                danger,
            })
        })
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/ai/admin/grant — управление доступом из бота (по admin-токену)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct AdminGrantReq {
    user_id: String,
    /// grant | deny | revoke
    action: String,
    #[serde(default)]
    tier: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    context: Option<bool>,
    /// Срок гранта в днях (для trial). None = бессрочно.
    #[serde(default)]
    days: Option<i64>,
}

pub async fn admin_grant(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<AdminGrantReq>,
) -> ApiResult<impl IntoResponse> {
    let expected = env("NEXUSSH_AI_ADMIN_TOKEN")
        .ok_or_else(|| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "admin not configured"))?;
    let got = headers
        .get("X-Admin-Token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !constant_eq(got, &expected) {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "bad admin token"));
    }

    let conn = state.db.conn.lock().unwrap();
    match req.action.as_str() {
        "grant" => {
            let tier = req.tier.as_deref().unwrap_or("standard").to_string();
            let model = req.model.as_deref().unwrap_or("haiku").to_string();
            let ctx = req.context.unwrap_or(false) as i64;
            let expires = req.days.map(|d| now() + d * 86_400);
            conn.execute(
                "UPDATE ai_access SET status='granted', tier=?2, model=?3,
                    context_allowed=?4, granted_at=?5, expires_at=?6
                 WHERE user_id=?1",
                rusqlite::params![req.user_id, tier, model, ctx, now(), expires],
            )
            .map_err(db_err)?;
        }
        "deny" => {
            conn.execute(
                "UPDATE ai_access SET status='denied' WHERE user_id=?1",
                [&req.user_id],
            )
            .map_err(db_err)?;
        }
        "revoke" => {
            conn.execute(
                "UPDATE ai_access SET status='denied', expires_at=?2 WHERE user_id=?1",
                rusqlite::params![req.user_id, now()],
            )
            .map_err(db_err)?;
        }
        _ => return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad action")),
    }
    Ok(Json(json!({ "ok": true })))
}

fn constant_eq(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq;
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

// ─────────────────────────────────────────────────────────────────────────────
// Исходящие вызовы: Claude API + Telegram (через reqwest, опц. VPN-прокси)
// ─────────────────────────────────────────────────────────────────────────────

/// reqwest-клиент с опциональным прокси (`NEXUSSH_AI_PROXY`, socks5:// или http://).
fn http_client() -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder().timeout(std::time::Duration::from_secs(45));
    if let Some(p) = env("NEXUSSH_AI_PROXY") {
        b = b.proxy(reqwest::Proxy::all(&p).map_err(|e| e.to_string())?);
    }
    b.build().map_err(|e| e.to_string())
}

/// Возвращает (текст-ответ, всего токенов). Проксирует на DE-1 headless-endpoint
/// (`claude --print` на ПОДПИСКЕ владельца — у нас подписка, а не API-ключ).
/// Anthropic вызывается уже с DE-1 (не из РФ), так что здесь прокси не нужен.
async fn call_claude(
    model: &str,
    system: &str,
    user_query: &str,
) -> Result<(String, i64), String> {
    let upstream = env("NEXUSSH_AI_UPSTREAM").ok_or("ai upstream not configured")?;
    let token = env("NEXUSSH_AI_UPSTREAM_TOKEN").unwrap_or_default();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(70))
        .build()
        .map_err(|e| e.to_string())?;
    let body = json!({ "system": system, "query": user_query, "model": model });
    let resp = client
        .post(&upstream)
        .header("X-Alert-Token", token)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = v.get("error").and_then(|m| m.as_str()).unwrap_or("upstream error");
        return Err(format!("{status}: {msg}"));
    }
    let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
    let toks = v.get("tokens").and_then(|t| t.as_i64()).unwrap_or(0);
    Ok((text, toks))
}

/// Уведомляем админа о запросе доступа с inline-кнопками approve.
async fn notify_admin_request(user_id: &str, username: &str) -> Result<(), String> {
    let token = env("NEXUSSH_BOT_TOKEN").ok_or("no bot token")?;
    let chat = env("NEXUSSH_AI_CHAT_ID").ok_or("no chat id")?;
    let api_base =
        env("NEXUSSH_TG_API").unwrap_or_else(|| "https://api.telegram.org".to_string());
    let client = http_client()?;

    // callback_data лимит 64 байта → короткие коды: aig:<action>:<code>:<user_id>
    // код тира/модели/контекста кодируем одной буквой; бот разбирает.
    let btns = |label: &str, data: String| json!({ "text": label, "callback_data": data });
    let kb = json!({
        "inline_keyboard": [
            [ btns("✅ Standard/Haiku", format!("aig:g:sh0:{user_id}")),
              btns("⚡ Full/Sonnet",    format!("aig:g:fs0:{user_id}")) ],
            [ btns("🧠 Full/Opus+ctx",  format!("aig:g:fo1:{user_id}")) ],
            [ btns("⛔ Deny",           format!("aig:d:x:{user_id}")) ],
        ]
    });
    let text = format!(
        "🤖 <b>Запрос AI-доступа NexuSSH</b>\n\nПользователь: <code>{username}</code>\nВыдать доступ?"
    );
    let url = format!("{api_base}/bot{token}/sendMessage");
    let body = json!({
        "chat_id": chat,
        "text": text,
        "parse_mode": "HTML",
        "reply_markup": kb,
    });
    let resp = client.post(&url).json(&body).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("tg {}", resp.status()));
    }
    Ok(())
}
