//! Bearer-token auth extractor. Tokens are opaque strings stored in the
//! `users` table; a request is authenticated by looking the token up.

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use sqlx::SqlitePool;

use crate::db::{find_user_by_token, UserRow};
use crate::models::AccountInfo;

/// Extract a bearer token from an `Authorization: Bearer <token>` header.
fn bearer_token(req: &Request) -> Option<&str> {
    let header = req.headers().get(axum::http::header::AUTHORIZATION)?;
    let value = header.to_str().ok()?;
    let trimmed = value.trim();
    let prefix = trimmed.strip_prefix("Bearer ").or_else(|| trimmed.strip_prefix("bearer "))?;
    let token = prefix.trim();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

/// Middleware that requires a valid bearer token. On success it injects the
/// resolved `UserRow` into request extensions so handlers can read it.
pub async fn require_auth(
    State(pool): State<SqlitePool>,
    mut req: Request,
    next: Next,
) -> Response {
    let Some(token) = bearer_token(&req) else {
        return (StatusCode::UNAUTHORIZED, "缺少认证令牌").into_response();
    };
    let user = match find_user_by_token(&pool, token).await {
        Ok(Some(user)) => user,
        Ok(None) => return (StatusCode::UNAUTHORIZED, "令牌无效或已失效").into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };
    req.extensions_mut().insert(user);
    next.run(req).await
}

pub fn account_info(user: &UserRow) -> AccountInfo {
    AccountInfo {
        user_id: user.id.clone(),
        username: user.username.clone(),
        display_name: user.display_name.clone(),
        token: user.token.clone(),
    }
}
