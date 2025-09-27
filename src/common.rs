use chrono::Local;
use pulldown_cmark::{html, Options, Parser};
use regex::Regex;
use once_cell::sync::Lazy;
use reqwest::Client;
use serde_json::Value;
use std::env;
use std::borrow::Cow;
use std::io;
use base64::{engine::general_purpose, Engine as _};
use yup_oauth2::{ServiceAccountAuthenticator, ServiceAccountKey};

const TEMPLATE: &str = include_str!("../templates/page.html");

pub struct GoogleClient {
    creds_json: String,
    http: Client,
}

impl GoogleClient {
    pub async fn new_from_env() -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let creds_json = read_google_credentials_from_env()?;
        let http = Client::builder()
            .user_agent("rodiger-vercel-rust/1.0")
            .build()?;
        Ok(Self { creds_json, http })
    }

    async fn token(&self, scopes: &[&str]) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let key: ServiceAccountKey = serde_json::from_str(&self.creds_json)?;
        let auth = ServiceAccountAuthenticator::builder(key).build().await?;
        let t = auth.token(scopes).await?;
        let tok = t
            .token()
            .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "missing access token"))?
            .to_string();
        Ok(tok)
    }

    pub async fn fetch_document(&self, doc_id: &str) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        // Google Docs API
        let url = format!("https://docs.googleapis.com/v1/documents/{}", doc_id);
        let token = self.token(&["https://www.googleapis.com/auth/documents.readonly"]).await?;
        let resp = self
            .http
            .get(url)
            .bearer_auth(token)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(io::Error::new(io::ErrorKind::Other, format!("google docs error: {} {}", status, body)).into());
        }
        let val: Value = resp.json().await?;
        Ok(val)
    }

    pub async fn fetch_created_time(&self, file_id: &str) -> Result<Option<String>, Box<dyn std::error::Error + Send + Sync>> {
        // Google Drive API for metadata
        let url = format!(
            "https://www.googleapis.com/drive/v3/files/{}?fields=createdTime,modifiedTime,name",
            file_id
        );
        let token = self
            .token(&["https://www.googleapis.com/auth/drive.metadata.readonly"])
            .await?;
        let resp = self
            .http
            .get(url)
            .bearer_auth(token)
            .send()
            .await?;
        if !resp.status().is_success() {
            return Ok(None);
        }
        let v: Value = resp.json().await?;
        if let Some(s) = v.get("createdTime").and_then(|x| x.as_str()) {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                return Ok(Some(dt.format("%B %-d, %Y").to_string()));
            }
        }
        Ok(None)
    }
}

fn read_google_credentials_from_env() -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    if let Ok(b64) = env::var("GOOGLE_CREDENTIALS_B64") {
        let bytes = general_purpose::STANDARD.decode(b64)?;
        return Ok(String::from_utf8(bytes)?);
    }
    if let Ok(json) = env::var("GOOGLE_CREDENTIALS_JSON") {
        return Ok(json);
    }
    if let Ok(json) = env::var("GOOGLE_CREDENTIALS") {
        return Ok(json);
    }
    Err(io::Error::new(io::ErrorKind::Other, "Missing GOOGLE_CREDENTIALS_* env var").into())
}

pub fn document_to_html(doc: &Value) -> String {
    document_to_html_with_links(doc).0
}

pub fn document_to_html_with_links(doc: &Value) -> (String, Vec<(String, String)>) {
    // Traverse Google Docs structure -> Markdown, then to HTML, collecting Google Doc links
    let mut md = String::new();
    let mut links: Vec<(String, String)> = Vec::new();

    let inline_objects = doc
        .get("inlineObjects")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));

    if let Some(body) = doc.get("body") {
        if let Some(content) = body.get("content").and_then(|c| c.as_array()) {
            for elem in content {
                if let Some(par) = elem.get("paragraph") {
                    process_paragraph(par, &inline_objects, &mut md, &mut links);
                }
            }
        }
    }

    // Safety pass: rewrite any remaining markdown links to Google Docs
    md = rewrite_md_google_links(&md, &mut links);

    // Markdown -> HTML
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    let parser = Parser::new_ext(&md, options);
    let mut html_out = String::new();
    html::push_html(&mut html_out, parser);
    (html_out, links)
}

fn process_paragraph(
    par: &Value,
    inline_objects: &Value,
    out: &mut String,
    link_collector: &mut Vec<(String, String)>,
) {
    out.push_str(&get_paragraph_prefix(par));

    if let Some(elements) = par.get("elements").and_then(|e| e.as_array()) {
        for el in elements {
            if let Some(tr) = el.get("textRun") {
                process_text_run(tr, out, link_collector);
                continue;
            }
            if let Some(ioe) = el.get("inlineObjectElement") {
                process_inline_object(ioe, inline_objects, out);
            }
        }
    }
    out.push('\n');
}

fn get_paragraph_prefix(par: &Value) -> String {
    if par.get("bullet").is_some() {
        return "* ".to_string();
    }
    if let Some(style) = par.get("paragraphStyle") {
        if let Some(named) = style.get("namedStyleType").and_then(|s| s.as_str()) {
            return match named {
                "HEADING_1" => "# ".into(),
                "HEADING_2" => "## ".into(),
                "HEADING_3" => "### ".into(),
                _ => "".into(),
            };
        }
    }
    String::new()
}

fn process_text_run(tr: &Value, out: &mut String, link_collector: &mut Vec<(String, String)>) {
    let mut text = tr.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
    if let Some(style) = tr.get("textStyle") {
        if let Some(link) = style.get("link") {
            if let Some(url) = link.get("url").and_then(|u| u.as_str()) {
                let txt_trim = text.trim();
                let href = maybe_rewrite_google_doc_link_collect(url, txt_trim, link_collector);
                text = format!("[{}]({})", txt_trim, href);
            }
        }
    }
    out.push_str(&text);
}

fn process_inline_object(ioe: &Value, inline_objects: &Value, out: &mut String) {
    let id = ioe.get("inlineObjectId").and_then(|v| v.as_str()).unwrap_or("");
    if id.is_empty() { return; }
    if let Some(obj) = inline_objects.get(id) {
        if let Some(props) = obj.get("inlineObjectProperties") {
            if let Some(eo) = props.get("embeddedObject") {
                if let Some(img_props) = eo.get("imageProperties") {
                    if let Some(uri) = img_props.get("contentUri").and_then(|u| u.as_str()) {
                        out.push_str(&format!("\n![image]({})\n", uri));
                    }
                }
            }
        }
    }
}

fn maybe_rewrite_google_doc_link_collect(
    url: &str,
    link_text: &str,
    collector: &mut Vec<(String, String)>,
) -> String {
    // Match Google Docs document link and rewrite to internal route
    // Examples: https://docs.google.com/document/d/<id>/edit, ...
    static GOOGLE_DOC_RE: Lazy<Regex> = Lazy::new(|| {
        // Matches: /document/d/<ID> and /document/u/<n>/d/<ID>
        Regex::new(r"(?i)https?://docs\.google\.com/document/(?:u/\d+/)?d/([A-Za-z0-9_-]+)").unwrap()
    });
    if let Some(caps) = GOOGLE_DOC_RE.captures(url) {
        let id = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let mut slug = slugify(link_text);
        if slug.is_empty() { slug = id.to_string(); }
        collector.push((id.to_string(), slug.clone()));
        return format!("/p/{}/", slug);
    }
    url.to_string()
}

fn slugify(s: &str) -> String {
    let s = s.trim().to_lowercase();
    let mut out = String::new();
    let mut last_dash = false;
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else {
            if !last_dash {
                out.push('-');
                last_dash = true;
            }
        }
    }
    out.trim_matches('-').to_string()
}

fn rewrite_md_google_links(md: &str, collector: &mut Vec<(String, String)>) -> String {
    static MD_LINK_RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"\[(?P<text>[^\]]+)\]\(\s*(?P<url>https?://docs\.google\.com/document/(?:u/\d+/)?d/(?P<id>[A-Za-z0-9_-]+)[^)]*)\s*\)").unwrap()
    });

    MD_LINK_RE
        .replace_all(md, |caps: &regex::Captures| {
            let text = caps.name("text").map(|m| m.as_str()).unwrap_or("");
            let id = caps.name("id").map(|m| m.as_str()).unwrap_or("");
            let mut slug = slugify(text);
            if slug.is_empty() { slug = id.to_string(); }
            collector.push((id.to_string(), slug.clone()));
            Cow::from(format!("[{}](/p/{}/)", text, slug))
        })
        .into_owned()
}

pub fn render_template(content_html: &str, nav_html: &str) -> String {
    let now = Local::now();
    let date = now.format("%B %-d, %Y").to_string();
    TEMPLATE
        .replace("{{CONTENT}}", content_html)
        .replace("{{NAV}}", nav_html)
        .replace("{{LAST_UPDATED}}", &date)
}
