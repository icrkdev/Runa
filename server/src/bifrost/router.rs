use std::net::SocketAddr;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use tower_http::services::ServeDir;

use crate::bifrost;
use crate::bifrost::http::{create_named, create_unlisted, meta_unlisted, names_resolve, version};
use crate::AppState;

pub async fn ws_route(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(room_id): Path<String>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    ws.on_upgrade(move |socket| {
        bifrost::handle_socket(socket, state, room_id, addr.ip().to_string())
    })
}

async fn security_headers(req: axum::extract::Request, next: Next) -> Response {
    let is_gone = req.uri().path().ends_with("/gone.html") || req.uri().path() == "/gone.html";
    let mut res = next.run(req).await;
    let is_html = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("text/html"))
        .unwrap_or(false);
    let status_ok = res.status() == StatusCode::OK;
    let headers = res.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types *;",
        ),
    );
    headers.insert(
        header::STRICT_TRANSPORT_SECURITY,
        HeaderValue::from_static("max-age=63072000; includeSubDomains; preload"),
    );
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(
        HeaderName::from_static("cross-origin-opener-policy"),
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static(
            "camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(), usb=(), serial=(), bluetooth=(), idle-detection=()",
        ),
    );
    if is_gone {
        headers.insert(
            HeaderName::from_static("clear-site-data"),
            HeaderValue::from_static("\"cache\", \"storage\""),
        );
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    } else if status_ok && is_html {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    res
}

pub fn build_router(state: AppState) -> Router {
    let dist = state.cfg.dist_dir.clone();
    let index_path = std::path::Path::new(&dist).join("index.html");

    let static_service = ServeDir::new(&dist);

    let index_html = std::fs::read_to_string(&index_path).unwrap_or_default();

    async fn index_page(axum::extract::State(html): axum::extract::State<std::sync::Arc<String>>) -> Response {
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            (*html).clone(),
        )
            .into_response()
    }

    let index_state = std::sync::Arc::new(index_html);

    Router::new()
        .route("/", get(index_page).with_state(index_state.clone()))
        .route("/r/{room_id}", get(index_page).with_state(index_state.clone()))
        .route("/n/{name}", get(index_page).with_state(index_state))
        .route("/socket/{room_id}", get(ws_route))
        .route("/api/meta/id/{room_id}", get(meta_unlisted))
        .route("/api/names/resolve", post(names_resolve))
        .route("/api/rooms/unlisted", post(create_unlisted))
        .route("/api/rooms/named", post(create_named))
        .route("/version", get(version))
        .fallback_service(static_service)
        .layer(middleware::from_fn(security_headers))
        .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024))
        .with_state(state)
}
