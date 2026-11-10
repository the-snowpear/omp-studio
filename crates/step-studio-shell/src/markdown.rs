//! Line classification for the assistant's markdown.
//!
//! egui has no markdown widget and the model emits markdown constantly, so
//! without this every heading arrives as a literal `##`. Kept separate from
//! rendering so the classification can be tested without a window.

/// What one line of assistant output is.
#[derive(Debug, PartialEq, Eq)]
pub enum Line<'a> {
    /// A heading, with its level (1-6) and the text after the hashes.
    Heading(u8, &'a str),
    /// A list item, with the marker stripped.
    ListItem(&'a str),
    /// Inside a fenced code block.
    Code(&'a str),
    Blank,
    Paragraph(&'a str),
}

/// `# ` to `###### `, and nothing else: `#hashtag` is not a heading.
pub fn heading_level(line: &str) -> Option<u8> {
    let hashes = line.len() - line.trim_start_matches('#').len();
    if hashes == 0 || hashes > 6 || !line[hashes..].starts_with(' ') {
        return None;
    }
    Some(hashes as u8)
}

/// `- `, `* `, `+ ` or a numbered `1. ` marker.
pub fn list_item(line: &str) -> Option<&str> {
    for marker in ["- ", "* ", "+ "] {
        if let Some(rest) = line.strip_prefix(marker) {
            return Some(rest);
        }
    }
    let dot = line.find(". ")?;
    if dot > 0 && line[..dot].bytes().all(|b| b.is_ascii_digit()) {
        return Some(&line[dot + 2..]);
    }
    None
}

/// Classify every line. `fenced` tracks whether a ``` block is open, so the
/// caller can keep the state across calls.
pub fn classify<'a>(line: &'a str, fenced: &mut bool) -> Line<'a> {
    let trimmed = line.trim();
    if trimmed.starts_with("```") {
        *fenced = !*fenced;
        return Line::Blank;
    }
    if *fenced {
        return Line::Code(line);
    }
    if trimmed.is_empty() {
        return Line::Blank;
    }
    if let Some(level) = heading_level(trimmed) {
        return Line::Heading(level, trimmed[level as usize..].trim());
    }
    if let Some(item) = list_item(trimmed) {
        return Line::ListItem(item);
    }
    Line::Paragraph(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_need_a_space_after_the_hashes() {
        assert_eq!(heading_level("## Title"), Some(2));
        assert_eq!(heading_level("###### Six"), Some(6));
        assert_eq!(heading_level("####### Seven"), None);
        assert_eq!(heading_level("#hashtag"), None);
        assert_eq!(heading_level("No heading"), None);
    }

    #[test]
    fn list_markers_are_stripped_numbered_or_not() {
        assert_eq!(list_item("- one"), Some("one"));
        assert_eq!(list_item("* two"), Some("two"));
        assert_eq!(list_item("12. twelve"), Some("twelve"));
        assert_eq!(list_item("1.no space"), None);
        assert_eq!(list_item("a. letter"), None);
        assert_eq!(list_item("plain"), None);
    }

    #[test]
    fn a_fence_hides_everything_until_it_closes() {
        let mut fenced = false;
        assert_eq!(classify("```rust", &mut fenced), Line::Blank);
        assert!(fenced);
        // A heading inside a fence is code, not a heading.
        assert_eq!(classify("## not a heading", &mut fenced), Line::Code("## not a heading"));
        assert_eq!(classify("- not a list", &mut fenced), Line::Code("- not a list"));
        assert_eq!(classify("```", &mut fenced), Line::Blank);
        assert!(!fenced);
        assert_eq!(classify("## a heading again", &mut fenced), Line::Heading(2, "a heading again"));
    }
}
