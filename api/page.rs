use vercel_runtime::{run, Body, Error, Request, Response};
use rodiger_vercel::common::{document_to_html, html_response, render_template, GoogleClient};

async fn handler(req: Request) -> Result<Response<Body>, Error> {
    let query = req.uri().query().unwrap_or("");
    let doc_id = query
        .split('&')
        .find_map(|kv| {
            let mut it = kv.splitn(2, '=');
            match (it.next(), it.next()) {
                (Some("id"), Some(v)) => Some(v.to_string()),
                _ => None,
            }
        })
        .ok_or_else(|| "missing id query param")
        .map_err(|e| format!("{}", e))?;

    let client = GoogleClient::new_from_env().await.map_err(|e| format!("auth error: {}", e))?;
    let doc = client
        .fetch_document(&doc_id)
        .await
        .map_err(|e| format!("docs fetch error: {}", e))?;
    let html = document_to_html(&doc);
    let page = render_template(&html);
    html_response(page)
}

fn main() -> Result<(), Error> {
    run(handler)
}
