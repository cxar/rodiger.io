use vercel_runtime::{run, Body, Error, Request, Response};
use rodiger_vercel::common::{document_to_html, html_response, render_template, GoogleClient};

async fn handler(_req: Request) -> Result<Response<Body>, Error> {
    let doc_id = std::env::var("ROOT_DOC_ID").map_err(|e| -> Error { Box::new(e) })?;

    let client = GoogleClient::new_from_env().await?;
    let doc = client.fetch_document(&doc_id).await?;
    let html = document_to_html(&doc);
    let page = render_template(&html);
    html_response(page)
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    run(handler).await
}
