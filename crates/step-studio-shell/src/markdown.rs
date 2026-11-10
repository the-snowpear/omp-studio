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

/// One run of styled text within a line.
#[derive(Debug, PartialEq, Eq)]
pub enum Span<'a> {
    Plain(&'a str),
    Bold(&'a str),
    Code(&'a str),
}

/// Split a line into `**bold**` and `` `code` `` runs. An unclosed marker is
/// emitted literally — a stray asterisk should look like one.
pub fn spans(line: &str) -> Vec<Span<'_>> {
    let mut out = Vec::new();
    let mut rest = line;
    loop {
        let bold = rest.find("**");
        let code = rest.find('`');
        let at = match (bold, code) {
            (Some(b), Some(c)) => b.min(c),
            (Some(b), None) => b,
            (None, Some(c)) => c,
            (None, None) => break,
        };
        if at > 0 {
            out.push(Span::Plain(&rest[..at]));
        }
        let marker = if rest[at..].starts_with("**") { "**" } else { "`" };
        let after = &rest[at + marker.len()..];
        // An empty run is a marker with nothing between it, which should stay
        // literal rather than disappear from the line.
        let Some(close) = after.find(marker).filter(|close| *close > 0) else {
            out.push(Span::Plain(&rest[at..at + marker.len()]));
            rest = after;
            continue;
        };
        let inner = &after[..close];
        out.push(if marker == "**" {
            Span::Bold(inner)
        } else {
            Span::Code(inner)
        });
        rest = &after[close + marker.len()..];
    }
    if !rest.is_empty() {
        out.push(Span::Plain(rest));
    }
    out
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

#[cfg(test)]
mod span_tests {
    use super::*;

    #[test]
    fn plain_text_is_one_span() {
        assert_eq!(spans("just words"), vec![Span::Plain("just words")]);
    }

    #[test]
    fn bold_and_code_split_a_line() {
        assert_eq!(
            spans("count is **2** and `x` done"),
            vec![
                Span::Plain("count is "),
                Span::Bold("2"),
                Span::Plain(" and "),
                Span::Code("x"),
                Span::Plain(" done"),
            ]
        );
    }

    #[test]
    fn an_unclosed_marker_stays_literal() {
        assert_eq!(
            spans("2 ** 3"),
            vec![Span::Plain("2 "), Span::Plain("**"), Span::Plain(" 3")]
        );
        assert_eq!(
            spans("a `b"),
            vec![Span::Plain("a "), Span::Plain("`"), Span::Plain("b")]
        );
    }

    #[test]
    fn adjacent_markers_do_not_lose_text() {
        assert_eq!(
            spans("**a****b**"),
            vec![Span::Bold("a"), Span::Bold("b")]
        );
        assert_eq!(spans("``"), vec![Span::Plain("`"), Span::Plain("`")]);
    }
}
