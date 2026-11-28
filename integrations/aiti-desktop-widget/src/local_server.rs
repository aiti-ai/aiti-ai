//! Tiny loopback static file server used by `--html`.
//!
//! The shell loads content over `http(s)` only (WebView `External` URLs, no custom
//! schemes, no `data:`), so a local page needs an origin. This server binds an
//! ephemeral port on `127.0.0.1`, never leaves the loopback interface, and only
//! serves files below the configured root (the HTML file's directory by default).
//!
//! Deliberately tiny: GET/HEAD only, single-range requests (video seeking), no
//! directory listing, no caching. Requests that escape the root — via `..`, `%2e%2e`,
//! backslashes or symlinks — are rejected after canonicalization.

use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const MAX_REQUEST_LINE: usize = 8 * 1024;
const MAX_HEADERS: usize = 32 * 1024;
const CHUNK: usize = 64 * 1024;

/// A running static server and the URL of the requested page.
#[derive(Debug)]
pub struct LocalPage {
    pub port: u16,
    pub root: PathBuf,
    pub url: String,
}

/// Start serving `html` (and its siblings under `root`, default: the HTML file's
/// directory) on a random loopback port, and return the page URL.
pub fn start_page(html: &str, root: Option<&str>) -> Result<LocalPage, String> {
    let html_path =
        fs::canonicalize(html).map_err(|e| format!("cannot open --html {html:?}: {e}"))?;
    if !html_path.is_file() {
        return Err(format!("--html {html:?} is not a file"));
    }
    let root_path = match root.map(str::trim).filter(|r| !r.is_empty()) {
        Some(dir) => {
            fs::canonicalize(dir).map_err(|e| format!("cannot open --root {dir:?}: {e}"))?
        }
        None => html_path
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| format!("--html {html:?} has no parent directory"))?,
    };
    if !root_path.is_dir() {
        return Err(format!(
            "--root {:?} is not a directory",
            root_path.display()
        ));
    }
    if !html_path.starts_with(&root_path) {
        return Err(format!(
            "--html {:?} is outside --root {:?}",
            html_path.display(),
            root_path.display()
        ));
    }
    let rel = html_path
        .strip_prefix(&root_path)
        .map_err(|_| "--html is outside --root".to_string())?;
    let page = start_dir(root_path)?;
    let url = format!("http://127.0.0.1:{}/{}", page.port, encode_path(rel));
    Ok(LocalPage {
        port: page.port,
        root: page.root,
        url,
    })
}

/// Start the server for `root` without a page URL.
pub fn start_dir(root: PathBuf) -> Result<LocalPage, String> {
    let root =
        fs::canonicalize(&root).map_err(|e| format!("cannot serve {:?}: {e}", root.display()))?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("cannot bind local page server: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("cannot read local page server address: {e}"))?
        .port();
    let shared = Arc::new(root.clone());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let root = Arc::clone(&shared);
            std::thread::spawn(move || {
                let _ = handle(stream, &root);
            });
        }
    });
    Ok(LocalPage {
        port,
        root,
        url: String::new(),
    })
}

fn handle(mut stream: TcpStream, root: &Arc<PathBuf>) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    let mut reader = BufReader::new(stream.try_clone()?);

    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(());
    }
    if line.len() > MAX_REQUEST_LINE {
        return send_text(
            &mut stream,
            431,
            "Request Header Fields Too Large",
            "request too large",
        );
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    if method.is_empty() || target.is_empty() {
        return send_text(&mut stream, 400, "Bad Request", "bad request line");
    }

    let mut range_header: Option<String> = None;
    let mut header_bytes = 0usize;
    loop {
        let mut header = String::new();
        let read = reader.read_line(&mut header)?;
        if read == 0 || header == "\r\n" || header == "\n" {
            break;
        }
        header_bytes += read;
        if header_bytes > MAX_HEADERS {
            return send_text(
                &mut stream,
                431,
                "Request Header Fields Too Large",
                "headers too large",
            );
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("range") {
                range_header = Some(value.trim().to_string());
            }
        }
    }

    if method != "GET" && method != "HEAD" {
        return send_text(
            &mut stream,
            405,
            "Method Not Allowed",
            "only GET/HEAD are supported",
        );
    }

    let path = match resolve(root, &target) {
        Ok(path) => path,
        Err(status) => return send_status(&mut stream, status, path_message(status)),
    };
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(_) => return send_status(&mut stream, 404, "not found"),
    };
    let len = match file.metadata() {
        Ok(meta) if meta.is_file() => meta.len(),
        _ => return send_status(&mut stream, 404, "not found"),
    };
    let content_type = content_type(&path);

    let range = match range_header.as_deref().and_then(|h| parse_range(h, len)) {
        Some(Ok(range)) => Some(range),
        Some(Err(())) => {
            let mut headers = common_headers(content_type, 0);
            headers.push(("content-range", format!("bytes */{len}")));
            return send_headers(&mut stream, 416, "Range Not Satisfiable", &headers);
        }
        None => None,
    };

    let (status, reason, start, end) = match range {
        Some((start, end)) => (206, "Partial Content", start, end),
        None => (200, "OK", 0, len.saturating_sub(1)),
    };
    let body_len = if len == 0 { 0 } else { end - start + 1 };

    let mut headers = common_headers(content_type, body_len);
    if status == 206 {
        headers.push(("content-range", format!("bytes {start}-{end}/{len}")));
    }
    send_headers(&mut stream, status, reason, &headers)?;
    if method == "HEAD" || body_len == 0 {
        return Ok(());
    }

    let mut file = file;
    file.seek(SeekFrom::Start(start))?;
    let mut remaining = body_len;
    let mut buffer = vec![0u8; CHUNK];
    while remaining > 0 {
        let want = remaining.min(CHUNK as u64) as usize;
        let read = file.read(&mut buffer[..want])?;
        if read == 0 {
            break;
        }
        stream.write_all(&buffer[..read])?;
        remaining -= read as u64;
    }
    Ok(())
}

fn common_headers(content_type: &'static str, content_length: u64) -> Vec<(&'static str, String)> {
    vec![
        ("content-type", content_type.to_string()),
        ("content-length", content_length.to_string()),
        ("accept-ranges", "bytes".to_string()),
        ("cache-control", "no-store".to_string()),
        ("x-content-type-options", "nosniff".to_string()),
        ("connection", "close".to_string()),
    ]
}

fn send_status(stream: &mut TcpStream, status: u16, message: &str) -> io::Result<()> {
    let reason = match status {
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    };
    send_text(stream, status, reason, message)
}

fn path_message(status: u16) -> &'static str {
    match status {
        400 => "bad path",
        403 => "forbidden",
        _ => "not found",
    }
}

fn send_text(stream: &mut TcpStream, status: u16, reason: &str, body: &str) -> io::Result<()> {
    let headers = common_headers("text/plain; charset=utf-8", body.len() as u64);
    send_headers(stream, status, reason, &headers)?;
    stream.write_all(body.as_bytes())
}

fn send_headers(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    headers: &[(&str, String)],
) -> io::Result<()> {
    let mut out = format!("HTTP/1.1 {status} {reason}\r\n");
    for (name, value) in headers {
        out.push_str(name);
        out.push_str(": ");
        out.push_str(value);
        out.push_str("\r\n");
    }
    out.push_str("\r\n");
    stream.write_all(out.as_bytes())
}

/// Resolve a request target (path + optional query) to a file below `root`.
/// Returns 400 for malformed escapes, 403 for escapes, 404 for missing files.
fn resolve(root: &Path, target: &str) -> Result<PathBuf, u16> {
    // Absolute-form request targets (`GET http://host/path`) are valid HTTP/1.1;
    // accept them by taking everything after the authority.
    let target = target
        .strip_prefix("http://")
        .or_else(|| target.strip_prefix("https://"))
        .and_then(|rest| rest.find('/').map(|i| &rest[i..]))
        .unwrap_or(target);
    let raw = target.split(['?', '#']).next().unwrap_or("/");
    let decoded = percent_decode(raw).ok_or(400u16)?;
    let normalized = decoded.replace('\\', "/");
    let mut relative = PathBuf::new();
    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(403);
        }
        if segment.contains('\0') {
            return Err(400);
        }
        if cfg!(windows) && segment.contains(':') {
            return Err(403);
        }
        relative.push(segment);
    }
    let candidate = root.join(relative);
    let mut resolved = fs::canonicalize(&candidate).map_err(|_| 404u16)?;
    if !resolved.starts_with(root) {
        return Err(403);
    }
    if resolved.is_dir() {
        resolved = fs::canonicalize(resolved.join("index.html")).map_err(|_| 404u16)?;
        if !resolved.starts_with(root) {
            return Err(403);
        }
    }
    if !resolved.is_file() {
        return Err(404);
    }
    Ok(resolved)
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = hex(bytes[i + 1])?;
            let lo = hex(bytes[i + 2])?;
            out.push(hi * 16 + lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Parse a single `bytes=` range. `None` means ignore the header (serve 200);
/// `Some(Err(()))` means the range is unsatisfiable (serve 416).
fn parse_range(header: &str, len: u64) -> Option<Result<(u64, u64), ()>> {
    let spec = header.strip_prefix("bytes=")?.trim();
    if spec.contains(',') {
        return None;
    }
    let (start_raw, end_raw) = spec.split_once('-')?;
    if len == 0 {
        return Some(Err(()));
    }
    let range = if start_raw.is_empty() {
        let suffix: u64 = end_raw.trim().parse().ok()?;
        if suffix == 0 {
            return Some(Err(()));
        }
        (len.saturating_sub(suffix), len - 1)
    } else {
        let start: u64 = start_raw.trim().parse().ok()?;
        if start >= len {
            return Some(Err(()));
        }
        let end = if end_raw.trim().is_empty() {
            len - 1
        } else {
            end_raw.trim().parse::<u64>().ok()?.min(len - 1)
        };
        if end < start {
            return Some(Err(()));
        }
        (start, end)
    };
    Some(Ok(range))
}

fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "wasm" => "application/wasm",
        "txt" | "md" => "text/plain; charset=utf-8",
        "xml" => "text/xml; charset=utf-8",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Percent-encode a relative path for use in a URL, keeping `/` separators.
fn encode_path(path: &Path) -> String {
    let mut segments = Vec::new();
    for component in path.components() {
        if let std::path::Component::Normal(segment) = component {
            segments.push(encode_segment(&segment.to_string_lossy()));
        }
    }
    segments.join("/")
}

fn encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", *byte)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "aiti-desktop-widget-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn request(port: u16, method: &str, path: &str, extra: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n{extra}\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    #[test]
    fn serves_files_index_head_and_ranges() {
        let root = temp_root("serve");
        fs::write(root.join("index.html"), "<h1>hi</h1>").unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/app.js"), "console.log(1)").unwrap();
        let page = start_dir(root.clone()).unwrap();

        let html = request(page.port, "GET", "/", "");
        assert!(html.starts_with("HTTP/1.1 200 OK"), "{html}");
        assert!(html.contains("text/html; charset=utf-8"));
        assert!(html.ends_with("<h1>hi</h1>"));

        let js = request(page.port, "GET", "/sub/app.js", "");
        assert!(js.contains("text/javascript; charset=utf-8"));
        assert!(js.ends_with("console.log(1)"));

        let head = request(page.port, "HEAD", "/index.html", "");
        assert!(head.starts_with("HTTP/1.1 200 OK"));
        assert!(head.ends_with("\r\n\r\n"));

        let body = "0123456789";
        fs::write(root.join("media.mp4"), body).unwrap();
        let ranged = request(page.port, "GET", "/media.mp4", "Range: bytes=2-5\r\n");
        assert!(
            ranged.starts_with("HTTP/1.1 206 Partial Content"),
            "{ranged}"
        );
        assert!(ranged.contains("content-range: bytes 2-5/10"));
        assert!(ranged.ends_with("2345"));

        let suffix = request(page.port, "GET", "/media.mp4", "Range: bytes=-3\r\n");
        assert!(suffix.contains("content-range: bytes 7-9/10"));
        assert!(suffix.ends_with("789"));

        let bad = request(page.port, "GET", "/media.mp4", "Range: bytes=99-\r\n");
        assert!(bad.starts_with("HTTP/1.1 416"), "{bad}");
    }

    #[test]
    fn rejects_escapes_and_unknown_paths() {
        let root = temp_root("guard");
        fs::write(root.join("index.html"), "ok").unwrap();
        let page = start_dir(root.clone()).unwrap();

        for path in [
            "/../etc/passwd",
            "/%2e%2e/etc/passwd",
            "/..%2f..%2fetc/passwd",
        ] {
            let response = request(page.port, "GET", path, "");
            assert!(
                response.starts_with("HTTP/1.1 403") || response.starts_with("HTTP/1.1 404"),
                "{path} => {response}"
            );
        }
        let missing = request(page.port, "GET", "/nope.html", "");
        assert!(missing.starts_with("HTTP/1.1 404"));
        let post = request(page.port, "POST", "/index.html", "");
        assert!(post.starts_with("HTTP/1.1 405"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_pointing_outside_root() {
        let root = temp_root("symlink-root");
        let outside = temp_root("symlink-outside");
        fs::write(root.join("index.html"), "ok").unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();
        let page = start_dir(root.clone()).unwrap();
        let escaped = request(page.port, "GET", "/link.txt", "");
        assert!(escaped.starts_with("HTTP/1.1 403"), "{escaped}");
    }

    #[test]
    fn page_url_is_encoded_and_root_checked() {
        let root = temp_root("page");
        let sub = root.join("my pages");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("hello world.html"), "hi").unwrap();
        let page = start_page(sub.join("hello world.html").to_str().unwrap(), None).unwrap();
        assert!(page.url.ends_with("/hello%20world.html"), "{}", page.url);
        let response = request(page.port, "GET", "/hello%20world.html", "");
        assert!(response.ends_with("hi"));

        let outside = root.join("outside.html");
        fs::write(&outside, "no").unwrap();
        let err = start_page(outside.to_str().unwrap(), Some(sub.to_str().unwrap())).unwrap_err();
        assert!(err.contains("outside --root"), "{err}");
    }
}
