//! Scoped, path-validated filesystem access for the workspace console.
//!
//! Every command takes a `workspace_root` (the selected workspace's
//! `locator`, e.g. `/home/justin/work` on Linux or `C:\Users\justin\work` on
//! Windows) and a relative path. We resolve the relative path against the
//! root and refuse to touch anything that escapes the root — via `..`
//! traversal, an absolute path override, or a symlink that points outside.
//!
//! This module is intentionally free of `tauri::command` macros on the
//! validation function itself so it can be unit tested without spinning up
//! a Tauri runtime.

use base64::Engine;
use std::fs;
use std::path::{Component, Path, PathBuf};

const MAX_PREVIEW_BYTES: usize = 20 * 1024 * 1024;

fn preview_media_type(path: &str) -> Option<&'static str> {
    match Path::new(path)
        .extension()?
        .to_string_lossy()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

/// Errors returned to the frontend. Kept as plain strings since that's what
/// crosses the Tauri IPC boundary by default (serialized via `Display`).
#[derive(Debug, thiserror::Error)]
pub enum FsError {
    #[error("path escapes workspace root: {0}")]
    PathEscapesRoot(String),
    #[error("workspace root does not exist: {0}")]
    RootNotFound(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Strip Windows' `\\?\` extended-length verbatim prefix so comparisons
/// between a canonicalized root and a canonicalized child path behave the
/// same on Windows as they do on Linux/macOS. `std::fs::canonicalize` on
/// Windows returns verbatim paths (e.g. `\\?\C:\Users\...`); without
/// stripping this, a root and a sub-path can both be "under" each other in
/// spirit but fail a naive `starts_with` due to prefix differences, or
/// (more importantly) we just want a normalized, comparable form.
fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\UNC\") {
        // \\?\UNC\server\share\... -> \\server\share\...
        PathBuf::from(format!(r"\\{}", stripped))
    } else if let Some(stripped) = s.strip_prefix(r"\\?\") {
        // \\?\C:\... -> C:\...
        PathBuf::from(stripped)
    } else {
        path.to_path_buf()
    }
}

/// Lexically reject any relative path containing `..`, a root component, or
/// a Windows path prefix (drive letter / UNC) before we even touch the
/// filesystem. This catches the common traversal payloads
/// (`../../etc/passwd`, `..\\..\\windows\\system32`, `C:\Windows`,
/// `/etc/passwd`) regardless of platform, since `Path::components()`
/// understands both `/` and `\` separators on the platform it runs on — but
/// we also defend against the *other* platform's separator showing up in a
/// string that was typed on a different OS (e.g. a path containing a
/// literal backslash arriving on Linux), by checking for `..` segments
/// split on both separators explicitly.
fn has_traversal_or_absolute(rel_path: &str) -> bool {
    // Reject backslash or forward-slash separated ".." segments explicitly,
    // so a Windows-style traversal string is still caught when validated on
    // a Linux host (and vice versa) — relevant because the frontend may run
    // on a different OS than future test/CI hosts.
    let normalized = rel_path.replace('\\', "/");
    if normalized.split('/').any(|seg| seg == "..") {
        return true;
    }

    let candidate = Path::new(rel_path);
    for component in candidate.components() {
        match component {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return true,
            Component::CurDir | Component::Normal(_) => {}
        }
    }

    // Also reject a leading drive-letter-like prefix typed as a plain
    // string on a non-Windows host, e.g. "C:\\Windows\\System32", which
    // `Path::components()` on Linux would otherwise treat as a single
    // opaque `Normal` segment.
    if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
        return true;
    }

    false
}

/// Resolve `rel_path` against `workspace_root`, guaranteeing the result is
/// lexically and (where the path exists) physically contained within the
/// root. Returns the resolved absolute path on success.
///
/// - Rejects traversal/absolute/drive-prefixed relative paths up front.
/// - If the resulting path already exists, canonicalizes both root and
///   target (resolving symlinks) and re-checks containment, so a symlink
///   inside the workspace that points outside it is also rejected.
/// - If the target does not yet exist (e.g. a new file about to be
///   written), canonicalizes the root and the *nearest existing ancestor*
///   of the target, and checks that ancestor is contained in the root —
///   this still defeats a symlinked ancestor directory escaping the root
///   while allowing genuinely new files/dirs to be created.
pub fn resolve_within_root(workspace_root: &str, rel_path: &str) -> Result<PathBuf, FsError> {
    let root = Path::new(workspace_root);
    if !root.exists() {
        return Err(FsError::RootNotFound(workspace_root.to_string()));
    }

    if rel_path.trim().is_empty() {
        return Err(FsError::PathEscapesRoot(rel_path.to_string()));
    }

    if has_traversal_or_absolute(rel_path) {
        return Err(FsError::PathEscapesRoot(rel_path.to_string()));
    }

    let joined = root.join(rel_path);

    let canonical_root = strip_verbatim_prefix(&fs::canonicalize(root)?);

    if joined.exists() {
        let canonical_target = strip_verbatim_prefix(&fs::canonicalize(&joined)?);
        if !canonical_target.starts_with(&canonical_root) {
            return Err(FsError::PathEscapesRoot(rel_path.to_string()));
        }
        return Ok(canonical_target);
    }

    // Target doesn't exist yet (e.g. write_file creating a new file).
    // Walk up to the nearest existing ancestor and verify *that* is
    // contained in the root — defeats a symlinked ancestor dir escaping,
    // while still allowing new files/parent dirs to be created.
    let mut ancestor = joined.as_path();
    let mut nearest_existing: Option<&Path> = None;
    while let Some(parent) = ancestor.parent() {
        if parent.exists() {
            nearest_existing = Some(parent);
            break;
        }
        ancestor = parent;
    }

    if let Some(existing_ancestor) = nearest_existing {
        let canonical_ancestor = strip_verbatim_prefix(&fs::canonicalize(existing_ancestor)?);
        if !canonical_ancestor.starts_with(&canonical_root) {
            return Err(FsError::PathEscapesRoot(rel_path.to_string()));
        }
    } else {
        // No existing ancestor at all below the root — shouldn't happen
        // since root itself exists, but fail closed if it does.
        return Err(FsError::PathEscapesRoot(rel_path.to_string()));
    }

    Ok(joined)
}

/// List `.floe/agents/*.md` files under the workspace root, as relative
/// (forward-slash, root-relative) path strings.
#[tauri::command]
pub fn list_agent_files(workspace_root: String) -> Result<Vec<String>, String> {
    let agents_dir =
        resolve_within_root(&workspace_root, ".floe/agents").map_err(|e| e.to_string())?;

    if !agents_dir.exists() {
        return Ok(Vec::new());
    }

    let root = Path::new(&workspace_root);
    let canonical_root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let canonical_root = strip_verbatim_prefix(&canonical_root);

    let mut results = Vec::new();
    collect_md_files(&agents_dir, &canonical_root, &mut results).map_err(|e| e.to_string())?;
    results.sort();
    Ok(results)
}

fn collect_md_files(
    dir: &Path,
    canonical_root: &Path,
    out: &mut Vec<String>,
) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_md_files(&path, canonical_root, out)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            let canonical_path = strip_verbatim_prefix(&fs::canonicalize(&path)?);
            if let Ok(rel) = canonical_path.strip_prefix(canonical_root) {
                let rel_str = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join("/");
                out.push(rel_str);
            }
        }
    }
    Ok(())
}

/// Read a UTF-8 text file at `rel_path` under `workspace_root`.
#[tauri::command]
pub fn read_file(workspace_root: String, rel_path: String) -> Result<String, String> {
    let resolved = resolve_within_root(&workspace_root, &rel_path).map_err(|e| e.to_string())?;
    fs::read_to_string(&resolved).map_err(|e| e.to_string())
}

/// Read a workspace-contained raster image as a browser-safe data URL.
#[tauri::command]
pub fn read_media_file(workspace_root: String, rel_path: String) -> Result<String, String> {
    let media_type = preview_media_type(&rel_path)
        .ok_or_else(|| "Only raster image previews are supported.".to_string())?;
    let resolved = resolve_within_root(&workspace_root, &rel_path).map_err(|e| e.to_string())?;
    let size = fs::metadata(&resolved).map_err(|e| e.to_string())?.len();
    if size > MAX_PREVIEW_BYTES as u64 {
        return Err("The image exceeds the 20MB preview limit.".to_string());
    }
    let bytes = fs::read(&resolved).map_err(|e| e.to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{media_type};base64,{encoded}"))
}

/// Write `contents` to `rel_path` under `workspace_root`, creating parent
/// directories as needed.
#[tauri::command]
pub fn write_file(
    workspace_root: String,
    rel_path: String,
    contents: String,
) -> Result<(), String> {
    let resolved = resolve_within_root(&workspace_root, &rel_path).map_err(|e| e.to_string())?;

    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    fs::write(&resolved, contents).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_workspace() -> PathBuf {
        let mut dir = std::env::temp_dir();
        let unique = format!(
            "floe-fs-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        dir.push(unique);
        fs::create_dir_all(&dir).expect("create temp workspace");
        dir
    }

    #[test]
    fn rejects_unix_style_traversal_escaping_root() {
        let root = temp_workspace();
        let result = resolve_within_root(root.to_str().unwrap(), "../../etc/passwd");
        assert!(matches!(result, Err(FsError::PathEscapesRoot(_))));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_windows_style_traversal_escaping_root() {
        let root = temp_workspace();
        // Backslash-separated traversal, as would arrive from a Windows
        // frontend, must be rejected even though this test runs on Linux.
        let result = resolve_within_root(
            root.to_str().unwrap(),
            "..\\..\\Windows\\System32\\config\\SAM",
        );
        assert!(matches!(result, Err(FsError::PathEscapesRoot(_))));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_absolute_unix_path() {
        let root = temp_workspace();
        let result = resolve_within_root(root.to_str().unwrap(), "/etc/passwd");
        assert!(matches!(result, Err(FsError::PathEscapesRoot(_))));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_windows_drive_prefixed_path() {
        let root = temp_workspace();
        let result = resolve_within_root(root.to_str().unwrap(), "C:\\Windows\\System32");
        assert!(matches!(result, Err(FsError::PathEscapesRoot(_))));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_symlink_escaping_root() {
        let root = temp_workspace();
        let outside = temp_workspace();
        fs::write(outside.join("secret.txt"), "nope").unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
            let result = resolve_within_root(root.to_str().unwrap(), "escape/secret.txt");
            assert!(matches!(result, Err(FsError::PathEscapesRoot(_))));
        }

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn accepts_simple_relative_path_within_root() {
        let root = temp_workspace();
        fs::create_dir_all(root.join(".floe/agents")).unwrap();
        fs::write(root.join(".floe/agents/floe.md"), "hello").unwrap();

        let result = resolve_within_root(root.to_str().unwrap(), ".floe/agents/floe.md");
        assert!(result.is_ok());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn accepts_new_file_path_not_yet_existing() {
        let root = temp_workspace();
        fs::create_dir_all(root.join(".floe/agents")).unwrap();

        let result = resolve_within_root(root.to_str().unwrap(), ".floe/agents/new-agent.md");
        assert!(result.is_ok());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_empty_relative_path() {
        let root = temp_workspace();
        let result = resolve_within_root(root.to_str().unwrap(), "");
        assert!(matches!(result, Err(FsError::PathEscapesRoot(_))));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_agent_files_finds_markdown_recursively() {
        let root = temp_workspace();
        fs::create_dir_all(root.join(".floe/agents/floe/worklogs")).unwrap();
        fs::write(root.join(".floe/agents/floe.md"), "x").unwrap();
        fs::write(root.join(".floe/agents/floe/worklogs/2026-06-16.md"), "y").unwrap();
        fs::write(root.join(".floe/agents/notes.txt"), "not markdown").unwrap();

        let files = list_agent_files(root.to_str().unwrap().to_string()).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|f| f == ".floe/agents/floe.md"));
        assert!(files
            .iter()
            .any(|f| f == ".floe/agents/floe/worklogs/2026-06-16.md"));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_agent_files_returns_empty_when_dir_missing() {
        let root = temp_workspace();
        let files = list_agent_files(root.to_str().unwrap().to_string()).unwrap();
        assert!(files.is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn write_then_read_round_trip() {
        let root = temp_workspace();
        write_file(
            root.to_str().unwrap().to_string(),
            ".floe/agents/sub/agent.md".to_string(),
            "# Agent\ncontent".to_string(),
        )
        .unwrap();

        let read_back = read_file(
            root.to_str().unwrap().to_string(),
            ".floe/agents/sub/agent.md".to_string(),
        )
        .unwrap();
        assert_eq!(read_back, "# Agent\ncontent");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn write_file_rejects_traversal() {
        let root = temp_workspace();
        let result = write_file(
            root.to_str().unwrap().to_string(),
            "../escape.md".to_string(),
            "pwned".to_string(),
        );
        assert!(result.is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reads_workspace_image_as_data_url() {
        let root = temp_workspace();
        fs::write(root.join("preview.png"), b"png bytes").unwrap();
        let preview = read_media_file(
            root.to_str().unwrap().to_string(),
            "preview.png".to_string(),
        )
        .unwrap();
        assert_eq!(preview, "data:image/png;base64,cG5nIGJ5dGVz");
        assert!(read_media_file(
            root.to_str().unwrap().to_string(),
            "../outside.png".to_string(),
        )
        .is_err());
        assert!(
            read_media_file(root.to_str().unwrap().to_string(), "notes.md".to_string(),).is_err()
        );
        fs::remove_dir_all(&root).ok();
    }
}
