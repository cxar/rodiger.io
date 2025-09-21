use include_dir::{include_dir, Dir};
use std::path::Path;
use vercel_runtime::{run, Body, Error, Request, Response};

static STATIC_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/../static");

async fn handler(req: Request) -> Result<Response<Body>, Error> {
    let full_path = req.uri().path().to_string();
    // Expect /api/static/<path>
    let prefix = "/api/static/";
    let rel = full_path
        .strip_prefix(prefix)
        .unwrap_or("")
        .trim_start_matches('/');

    if rel.is_empty() {
        return not_found();
    }

    if let Some(file) = STATIC_DIR.get_file(rel) {
        let bytes = file.contents();
        let ct = content_type_from_ext(Path::new(rel).extension().and_then(|s| s.to_str()).unwrap_or(""));
        let resp = Response::builder()
            .status(200)
            .header("Content-Type", ct)
            .header("Cache-Control", "public, max-age=31536000, immutable")
            .body(Body::Binary(bytes.into()))?;
        return Ok(resp);
    }
    not_found()
}

fn not_found() -> Result<Response<Body>, Error> {
    let resp = Response::builder()
        .status(404)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(Body::Text("Not found".into()))?;
    Ok(resp)
}

fn content_type_from_ext(ext: &str) -> &'static str {
    match ext {
        "css" => "text/css; charset=utf-8",
        "js" => "application/javascript",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn main() -> Result<(), Error> {
    run(handler)
}

