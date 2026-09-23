use std::net::SocketAddr;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use tower_http::services::ServeDir;

use crate::bifrost;
use crate::bifrost::http::{
    create_named, create_unlisted, meta_unlisted, names_resolve, restore_room, version,
};
use crate::AppState;

pub async fn ws_route(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(room_id): Path<String>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let ip = crate::heimdall::clientip::rate_limit_key(state.cfg.trusted_proxy, &headers, addr);
    // Without this the websocket layer will happily buffer its own default
    // (64 MiB) before the application ever gets to compare against
    // `max_frame_bytes`, so one socket could pin two orders of magnitude more
    // memory than the configured frame limit allows.
    // Twice the application limit: modest overshoot still reaches the handler
    // and gets a semantic 4004 FRAME_TOO_LARGE, while anything wilder is cut
    // off by the transport instead of being buffered.
    let cap = state.cfg.max_frame_bytes.saturating_mul(2);
    ws.max_message_size(cap)
        .max_frame_size(cap)
        .on_upgrade(move |socket| bifrost::handle_socket(socket, state, room_id, ip))
}

/// Whether a request was made by a page on another site.
///
/// Nothing here rides on cookies, so another site gains nothing by reading
/// RÚNA's answers. What it could do was spend the visitor's own limits: a page
/// anywhere could have the browser of whoever opened it send bad joins to
/// RÚNA, using up that address's guess budget, and the visitor's real rooms
/// would then be refused with the same answer as a room that does not exist.
///
/// Browsers send `Origin` on every WebSocket handshake and every POST, and
/// `Sec-Fetch-Site` on everything else they can; a page cannot forge either.
/// Clients that are not browsers send neither and are not a way for one site
/// to act through another's visitors, so they pass.
pub fn cross_site(headers: &HeaderMap, authority: Option<&str>) -> bool {
    if let Some(origin) = headers.get(header::ORIGIN) {
        let host = headers
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .or(authority)
            .unwrap_or("");
        let origin_host = origin
            .to_str()
            .ok()
            .and_then(|o| o.split_once("://"))
            .map(|(_, rest)| rest)
            .unwrap_or("");
        // "null" — a sandboxed frame or a local file — has no "://" at all.
        return origin_host.is_empty() || !origin_host.eq_ignore_ascii_case(host);
    }
    matches!(
        headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()),
        Some("cross-site") | Some("same-site")
    )
}

async fn same_site_only(req: axum::extract::Request, next: Next) -> Response {
    let path = req.uri().path();
    let guarded = path.starts_with("/api/") || path.starts_with("/socket/");
    let authority = req.uri().authority().map(|a| a.as_str().to_string());
    if guarded && cross_site(req.headers(), authority.as_deref()) {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({ "code": "CROSS_SITE" })),
        )
            .into_response();
    }
    next.run(req).await
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
    // `trusted-types *` accepted a policy under any name, which combined with
    // a pass-through `default` policy made the directive decorative. The
    // allow-list is `default` (the compatibility shim in web/src/trusted-types.ts)
    // plus the nine policies monaco-editor creates for its own DOM writes —
    // enumerated from `createTrustedTypesPolicy` call sites in the package.
    // web/scripts/e2e-browser.mjs fails on any Trusted Types violation, so a
    // Monaco upgrade that adds a policy name is caught in CI rather than in
    // production.
    //
    // `'wasm-unsafe-eval'` lets the page compile WebAssembly and nothing else:
    // JavaScript `eval` and `new Function` stay forbidden. Without it every
    // browser refused to compile the Argon2id module, and the client fell back
    // to PBKDF2 without anyone noticing — so every passphrase room was guarded
    // by a far cheaper derivation than the one it claimed. The fallback is gone
    // now, so this is what lets a passphrase room be created at all.
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types default defaultWorkerFactory diffEditorWidget diffReview domLineBreaksComputer editorGhostText editorViewLayer standaloneColorizer stickyScrollViewLayer tokenizeToString;",
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

    // Serving an empty 200 for the SPA shell turns a missing/mis-pointed
    // RUNA_DIST into a blank white page with no diagnostic anywhere. Fail
    // loudly at boot instead — this is the single most common deploy mistake.
    let index_html = match std::fs::read_to_string(&index_path) {
        Ok(html) if !html.trim().is_empty() => html,
        Ok(_) => {
            tracing::error!(path = %index_path.display(), "index.html is empty");
            String::new()
        }
        Err(e) => {
            tracing::error!(
                path = %index_path.display(),
                error = %e,
                "cannot read index.html — set RUNA_DIST to the built web bundle \
                 (`web/dist`). The API and websocket still work; the UI will not."
            );
            String::new()
        }
    };

    /// Serves the SPA shell for anything that could be a room name, and a
    /// plain 404 otherwise. Reached only after ServeDir has failed to find a
    /// file, so it can never shadow a real asset.
    async fn spa_shell(
        axum::extract::State(html): axum::extract::State<std::sync::Arc<String>>,
        uri: axum::http::Uri,
    ) -> Response {
        let path = uri.path().trim_start_matches('/').trim_end_matches('/');
        if !path.contains('/') && crate::runar::names::validate(path).is_ok() {
            return (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                (*html).clone(),
            )
                .into_response();
        }
        (StatusCode::NOT_FOUND, "not found").into_response()
    }

    async fn index_page(axum::extract::State(html): axum::extract::State<std::sync::Arc<String>>) -> Response {
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            (*html).clone(),
        )
            .into_response()
    }

    let index_state = std::sync::Arc::new(index_html);

    // A named room is reachable at the root: /copper-lantern rather than
    // /n/copper-lantern. ServeDir answers first, so a real file always wins;
    // only when nothing matches do we consider whether the path could be a
    // room name. Names cannot contain a dot or a slash and must carry a
    // hyphen or digit, so /gone.html, /assets/x.js and every reserved single
    // word are excluded before this is reached.
    let static_service =
        ServeDir::new(&dist).fallback(get(spa_shell).with_state(index_state.clone()));

    Router::new()
        .route("/", get(index_page).with_state(index_state.clone()))
        .route("/r/{room_id}", get(index_page).with_state(index_state.clone()))
        .route("/n/{name}", get(index_page).with_state(index_state))
        .route("/socket/{room_id}", get(ws_route))
        .route("/api/meta/id/{room_id}", get(meta_unlisted))
        .route("/api/names/resolve", post(names_resolve))
        .route("/api/rooms/unlisted", post(create_unlisted))
        .route("/api/rooms/named", post(create_named))
        .route("/api/rooms/restore", post(restore_room))
        .route("/version", get(version))
        .fallback_service(static_service)
        .layer(middleware::from_fn(same_site_only))
        .layer(middleware::from_fn(security_headers))
        .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024))
        .with_state(state)
}
