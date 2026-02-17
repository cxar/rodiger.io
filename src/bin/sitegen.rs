use rodiger_vercel::common::{document_to_html_with_links, render_template, GoogleClient};
use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use regex::Regex;
use sha2::{Digest, Sha256};
use base64::Engine as _;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let root_id = env::var("ROOT_DOC_ID").map_err(|_| io::Error::new(io::ErrorKind::Other, "ROOT_DOC_ID not set"))?;

    // Output dir
    let out_dir = PathBuf::from("dist");
    if out_dir.exists() {
        fs::remove_dir_all(&out_dir)?;
    }
    fs::create_dir_all(&out_dir)?;

    // Copy static assets
    copy_dir_all("static", out_dir.join("static"))?;

    // Copy pages (e.g. pages/fun/index.html → dist/fun/index.html)
    copy_dir_all("pages", &out_dir)?;

    // Google client
    let client = GoogleClient::new_from_env().await?;

    // BFS over docs to generate pages
    let mut queue: VecDeque<(String, Option<String>)> = VecDeque::new();
    queue.push_back((root_id.clone(), None));

    // Map doc_id -> slug chosen (first seen wins, dedup if needed)
    let mut chosen_slug: HashMap<String, String> = HashMap::new();
    let mut used_slugs: HashSet<String> = HashSet::new();

    while let Some((doc_id, slug_hint)) = queue.pop_front() {
        println!("Generating: {} (slug hint: {:?})", doc_id, slug_hint);
        // Fetch doc JSON
        let doc = client.fetch_document(&doc_id).await?;
        let (mut html, links) = document_to_html_with_links(&doc);
        // Localize images referenced in the HTML to dist/static/images
        html = localize_images(&html, &client, &out_dir.join("static").join("images")).await?;
        // Build nav
        let nav_html = if Some(&doc_id) == Some(&root_id) && slug_hint.is_none() {
            String::new()
        } else {
            let created = client.fetch_created_time(&doc_id).await?.unwrap_or_default();
            let created_span = if created.is_empty() { String::new() } else { format!(r#"<span class="created">Created: {}</span>"#, created) };
            format!(r#"<nav class="top"><a href="/" class="back" aria-label="Back to home">&larr; back</a>{}</nav>"#, created_span)
        };
        let page = render_template(&html, &nav_html);

        // Resolve path
        let output_path = if Some(&doc_id) == Some(&root_id) && slug_hint.is_none() {
            out_dir.join("index.html")
        } else {
            // pick or dedupe slug for this doc
            let base = slug_hint.unwrap_or_else(|| "page".to_string());
            let final_slug = match chosen_slug.get(&doc_id) {
                Some(s) => s.clone(),
                None => {
                    let mut s = base.clone();
                    let mut i = 2;
                    while used_slugs.contains(&s) { s = format!("{}-{}", base, i); i += 1; }
                    used_slugs.insert(s.clone());
                    chosen_slug.insert(doc_id.clone(), s.clone());
                    s
                }
            };
            out_dir.join("p").join(&final_slug).join("index.html")
        };

        if let Some(parent) = output_path.parent() { fs::create_dir_all(parent)?; }
        fs::write(&output_path, page)?;
        println!("Wrote: {}", output_path.display());

        // Enqueue discovered links, pre-assign slug to keep URLs stable
        for (linked_id, linked_slug) in links {
            println!("  found link -> id={} slug={} ", linked_id, linked_slug);
            if !chosen_slug.contains_key(&linked_id) {
                // reserve the slug if available
                let base = linked_slug.clone();
                let mut s = base.clone();
                let mut i = 2;
                while used_slugs.contains(&s) { s = format!("{}-{}", base, i); i += 1; }
                used_slugs.insert(s.clone());
                chosen_slug.insert(linked_id.clone(), s.clone());
                queue.push_back((linked_id, Some(s)));
            }
        }
    }

    Ok(())
}

fn copy_dir_all<S: AsRef<Path>, D: AsRef<Path>>(src: S, dst: D) -> io::Result<()> {
    let src = src.as_ref();
    let dst = dst.as_ref();
    if !src.exists() { return Ok(()); }
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_all(entry.path(), dst.join(entry.file_name()))?;
        } else {
            fs::copy(entry.path(), dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}

async fn localize_images(
    html: &str,
    client: &GoogleClient,
    images_dir: &Path,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    fs::create_dir_all(images_dir)?;
    let re = Regex::new(r#"<img\s+[^>]*src=\"([^\"]+)\""#)?;
    let mut out = String::with_capacity(html.len());
    let mut last = 0usize;
    let mut cache: HashMap<String, String> = HashMap::new();

    for cap in re.captures_iter(html) {
        if let Some(m) = cap.get(1) {
            let url = m.as_str();
            // copy segment before this match
            if let Some(mat) = cap.get(0) { out.push_str(&html[last..mat.start()]); }

            let local_src = if url.starts_with("/static/") {
                url.to_string()
            } else if url.starts_with("data:image/") {
                // data URI
                match save_data_uri(url, images_dir) {
                    Ok(p) => p,
                    Err(_) => url.to_string(),
                }
            } else {
                // http(s) fetch with reqwest
                match cache.get(url) {
                    Some(p) => p.clone(),
                    None => match download_image(url, client, images_dir).await {
                        Ok(p) => { cache.insert(url.to_string(), p.clone()); p }
                        Err(_) => url.to_string(),
                    }
                }
            };

            // rebuild the <img ... src="..." with local_src
            if let Some(mat) = cap.get(0) {
                let replaced = mat.as_str().replacen(url, &local_src, 1);
                out.push_str(&replaced);
                last = mat.end();
            }
        }
    }
    out.push_str(&html[last..]);
    Ok(out)
}

fn save_data_uri(data_uri: &str, images_dir: &Path) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    // format: data:<mime>;base64,<data>
    let (meta, data_b64) = data_uri.split_once(',').ok_or("invalid data uri")?;
    let mime = meta.trim_start_matches("data:").split(';').next().unwrap_or("application/octet-stream");
    let ext = match mime {
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/gif" => ".gif",
        "image/svg+xml" => ".svg",
        _ => ".bin",
    };
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_b64)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hash = format!("{:x}", hasher.finalize());
    let filename = format!("{}{}", &hash[..16], ext);
    let path = images_dir.join(&filename);
    if !path.exists() { fs::write(&path, &bytes)?; }
    Ok(format!("/static/images/{}", filename))
}

async fn download_image(
    url: &str,
    client: &GoogleClient,
    images_dir: &Path,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let resp = client
        .http_client()
        .get(url)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(io::Error::new(io::ErrorKind::Other, format!("image fetch failed {}", resp.status())).into());
    }
    let ct = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream");
    let ext = match ct {
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/gif" => ".gif",
        "image/svg+xml" => ".svg",
        _ => {
            // try to infer from url
            if let Some(ext) = Path::new(url).extension().and_then(|s| s.to_str()) {
                match ext.to_ascii_lowercase().as_str() {
                    "png" => ".png",
                    "jpg" | "jpeg" => ".jpg",
                    "gif" => ".gif",
                    "svg" => ".svg",
                    _ => ".bin",
                }
            } else { ".bin" }
        }
    };
    let bytes = resp.bytes().await?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hash = format!("{:x}", hasher.finalize());
    let filename = format!("{}{}", &hash[..16], ext);
    let path = images_dir.join(&filename);
    if !path.exists() { fs::write(&path, &bytes)?; }
    Ok(format!("/static/images/{}", filename))
}
