use rodiger_vercel::common::{document_to_html_with_links, render_template, GoogleClient};
use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

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
        let (html, links) = document_to_html_with_links(&doc);
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
