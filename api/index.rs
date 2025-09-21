use vercel_runtime::{run, Body, Error, Request, Response};

mod common;
use common::{document_to_html, html_response, render_template, GoogleClient};

async fn handler(_req: Request) -> Result<Response<Body>, Error> {
    let doc_id = std::env::var("ROOT_DOC_ID").map_err(|e| format!("ROOT_DOC_ID not set: {}", e))?;

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

