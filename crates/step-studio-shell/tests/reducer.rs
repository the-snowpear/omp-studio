//! The reducer, driven with the exact event sequence a real turn produces.
//! Captured from the adapter against the real Step CLI, so a drift in either
//! the adapter or this mapping fails here.

use step_studio_shell::app::App;
use step_studio_shell::bridge_client::Event;

fn app_without_runtime() -> App {
    // `connect` spawns a thread; these tests only exercise the pure reducer, so
    // build the state directly instead.
    step_studio_shell::app::app_for_test()
}

#[test]
fn a_full_turn_lands_in_order() {
    let mut app = app_without_runtime();
    app.apply(Event::Ready {
        session_id: "01abc".to_string(),
        model: Some("local-gateway/stepfun-cn/step-3.7-flash".to_string()),
    });
    app.send("reply with exactly: PONG".to_string());

    // The order the adapter emitted them in.
    app.apply(Event::Thinking("The".to_string()));
    app.apply(Event::Thinking(" user wants".to_string()));
    app.apply(Event::ToolStarted {
        call_id: "c1".to_string(),
        name: "list_directory".to_string(),
        arguments: "{}".to_string(),
    });
    app.apply(Event::ToolCompleted {
        call_id: "c1".to_string(),
        output: "dir apps/".to_string(),
        is_error: false,
    });
    app.apply(Event::Text("PONG".to_string()));
    app.apply(Event::TurnCompleted);

    assert_eq!(app.turns.len(), 1);
    let turn = &app.turns[0];
    assert_eq!(turn.user, "reply with exactly: PONG");
    assert_eq!(turn.assistant.thinking, "The user wants");
    assert_eq!(turn.assistant.text, "PONG");
    assert!(turn.assistant.done);
    assert!(turn.assistant.error.is_none());
    assert_eq!(turn.assistant.tools.len(), 1);
    assert_eq!(turn.assistant.tools[0].name, "list_directory");
    assert_eq!(turn.assistant.tools[0].output, "dir apps/");
    assert!(turn.assistant.tools[0].done);
    assert!(!app.streaming(), "the turn is finished");
}

#[test]
fn a_provider_failure_marks_the_turn_and_the_shell() {
    let mut app = app_without_runtime();
    app.apply(Event::Ready {
        session_id: "01abc".to_string(),
        model: None,
    });
    app.send("hello".to_string());
    app.apply(Event::TurnFailed("429: Credits exhausted".to_string()));

    let turn = &app.turns[0];
    assert!(turn.assistant.done);
    assert_eq!(
        turn.assistant.error.as_deref(),
        Some("429: Credits exhausted")
    );
    // The shell must report the failure too, or the chrome still reads "ready".
    assert_eq!(app.status, step_studio_shell::app::Status::Failed);
    assert_eq!(app.status_detail, "429: Credits exhausted");
}

#[test]
fn a_disconnect_is_reported_rather_than_silently_hanging() {
    let mut app = app_without_runtime();
    app.apply(Event::Disconnected("step runtime could not start: spawn step ENOENT".to_string()));
    assert_eq!(app.status, step_studio_shell::app::Status::Failed);
    assert!(app.status_detail.contains("ENOENT"));
}

/// Paired by call id, not by name. A turn can run the same tool twice, and two
/// calls of one tool can be in flight together — matching by name put the first
/// result on whichever call happened to be listed first.
#[test]
fn tool_results_are_paired_by_call_id_not_name() {
    let mut app = app_without_runtime();
    app.apply(Event::Ready {
        session_id: "s".to_string(),
        model: None,
    });
    app.send("go".to_string());
    app.apply(Event::ToolStarted {
        call_id: "c1".to_string(),
        name: "read".to_string(),
        arguments: "{}".to_string(),
    });
    app.apply(Event::ToolStarted {
        call_id: "c2".to_string(),
        name: "read".to_string(),
        arguments: "{}".to_string(),
    });
    // Out of order, which is what a concurrent pair looks like on the wire.
    app.apply(Event::ToolCompleted {
        call_id: "c2".to_string(),
        output: "second".to_string(),
        is_error: false,
    });
    app.apply(Event::ToolCompleted {
        call_id: "c1".to_string(),
        output: "first".to_string(),
        is_error: true,
    });

    let tools = &app.turns[0].assistant.tools;
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0].output, "first");
    assert!(tools[0].is_error);
    assert_eq!(tools[1].output, "second");
    assert!(!tools[1].is_error);
    assert!(tools.iter().all(|tool| tool.done));
}

/// A restored transcript pairs its results the same way, by the id Step stores
/// on both the call and the result.
#[test]
fn a_restored_transcript_fills_in_tool_results() {
    let mut app = app_without_runtime();
    app.restore(&[
        serde_json::json!({ "role": "user", "content": [{ "type": "text", "text": "list /tmp" }] }),
        serde_json::json!({ "role": "assistant", "content": [
            { "type": "toolCall", "toolCallId": "c1", "toolName": "list_directory" },
            { "type": "toolCall", "toolCallId": "c2", "toolName": "read" },
        ]}),
        serde_json::json!({ "role": "toolResult", "toolCallId": "c2", "toolName": "read", "isError": false,
                            "content": [{ "type": "text", "text": "the second file" }] }),
        serde_json::json!({ "role": "toolResult", "toolCallId": "c1", "toolName": "list_directory", "isError": true,
                            "content": [{ "type": "text", "text": "no such directory" }] }),
    ]);

    let tools = &app.turns[0].assistant.tools;
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0].name, "list_directory");
    assert_eq!(tools[0].output, "no such directory");
    assert!(tools[0].is_error, "a failed call must restore as failed");
    assert_eq!(tools[1].name, "read");
    assert_eq!(tools[1].output, "the second file");
    assert!(!tools[1].is_error);
    assert!(tools.iter().all(|tool| tool.done));
}

/// Aborting is the one command the reducer must *not* act on: the runtime
/// settles the turn and sends the receipt, so marking it done here would race
/// the real outcome and hide a turn that was still streaming.
#[test]
fn an_abort_leaves_the_turn_streaming_until_the_runtime_settles_it() {
    let mut app = app_without_runtime();
    app.apply(Event::Ready {
        session_id: "s".to_string(),
        model: None,
    });
    app.send("hello".to_string());
    app.apply(Event::Text("partial".to_string()));

    app.abort();
    assert!(app.streaming(), "the runtime owns the turn's receipt, not the reducer");
    assert_eq!(app.turns[0].assistant.text, "partial", "abort must not discard what streamed");

    app.apply(Event::TurnCompleted);
    assert!(!app.streaming());
    assert_eq!(app.turns[0].assistant.text, "partial");
}

/// The runtime drops the transcript when a new session starts, so the local
/// copy has to go with it — otherwise the shell keeps showing a conversation
/// the runtime no longer has.
#[test]
fn a_new_session_drops_the_local_transcript() {
    let mut app = app_without_runtime();
    app.apply(Event::Ready {
        session_id: "01aaa".to_string(),
        model: Some("local-gateway/stepfun-cn/step-3.7-flash".to_string()),
    });
    app.send("first".to_string());
    app.apply(Event::Text("an answer".to_string()));
    app.apply(Event::TurnCompleted);
    assert_eq!(app.turns.len(), 1);

    app.apply(Event::NewSession {
        session_id: "01bbb".to_string(),
    });
    assert!(app.turns.is_empty(), "the transcript must go with the session");
    assert!(app.composer.is_empty());
    assert_eq!(app.session_id, "01bbb");
    assert_eq!(app.status, step_studio_shell::app::Status::Ready);
    assert!(!app.streaming());
}

/// The frame loop keeps running only while a command is outstanding. egui
/// stops calling `update` once nothing asks for a repaint, so a reply that
/// lands after the app idles is never read — which is how the New button
/// silently did nothing for a while.
#[test]
fn the_app_stays_busy_until_a_command_answers() {
    let mut app = app_without_runtime();
    app.apply(Event::Ready {
        session_id: "s".to_string(),
        model: None,
    });
    assert!(!app.busy(), "nothing is outstanding at rest");

    app.new_session();
    assert!(app.busy(), "a command went out, so the loop must keep running");

    app.apply(Event::NewSession {
        session_id: "s2".to_string(),
    });
    assert!(!app.busy(), "the reply landed, so the loop may idle again");

    app.send("hello".to_string());
    assert!(app.busy());
    app.apply(Event::TurnCompleted);
    assert!(!app.busy());

    // A failure has to clear it too, or a failed turn pins the loop open.
    app.send("again".to_string());
    app.apply(Event::TurnFailed("boom".to_string()));
    assert!(!app.busy());
}

/// A resumed session arrives as a transcript page, and the runtime is the only
/// place that history lives. Without the fold the conversation reappears empty
/// after a relaunch.
#[test]
fn a_transcript_page_rebuilds_the_turns() {
    let mut app = app_without_runtime();
    app.restore(&[
        // A reply split across entries, the way Step stores it: thinking, then
        // text, then a tool call. All three belong to one turn.
        serde_json::json!({ "role": "user", "content": [{ "type": "text", "text": "what files are here?" }] }),
        serde_json::json!({ "role": "assistant", "content": [{ "type": "thinking", "text": "let me look" }] }),
        serde_json::json!({ "role": "assistant", "content": [{ "type": "text", "text": "Listing." }] }),
        serde_json::json!({ "role": "assistant", "content": [{ "type": "toolCall", "toolCallId": "c1", "toolName": "list_directory" }] }),
        serde_json::json!({ "role": "user", "content": [{ "type": "text", "text": "thanks" }] }),
        serde_json::json!({ "role": "assistant", "content": [{ "type": "text", "text": "You are welcome." }] }),
    ]);

    assert_eq!(app.turns.len(), 2, "two user messages, two turns");
    let first = &app.turns[0];
    assert_eq!(first.user, "what files are here?");
    assert_eq!(first.assistant.thinking, "let me look");
    assert_eq!(first.assistant.text, "Listing.");
    assert_eq!(first.assistant.tools.len(), 1);
    assert_eq!(first.assistant.tools[0].name, "list_directory");
    assert!(first.assistant.done, "a restored turn is not still streaming");
    assert_eq!(app.turns[1].assistant.text, "You are welcome.");
    assert!(!app.streaming());
}

/// The fold replaces rather than merges, so a stale local turn cannot survive
/// next to the restored history.
#[test]
fn restoring_replaces_what_was_already_there() {
    let mut app = app_without_runtime();
    app.send("a turn that never reached the runtime".to_string());
    app.apply(Event::Text("half an answer".to_string()));

    app.restore(&[serde_json::json!({ "role": "user", "content": [{ "type": "text", "text": "from the session" }] })]);

    assert_eq!(app.turns.len(), 1);
    assert_eq!(app.turns[0].user, "from the session");
    assert!(app.turns[0].assistant.text.is_empty());
}

/// A prompt sent before the history arrives would be wiped by the restore that
/// follows, so it has to wait. `--prompt` fires before the first frame, which is
/// exactly that window.
#[test]
fn a_prompt_sent_before_the_history_waits_for_it() {
    let mut app = step_studio_shell::app::app_loading();
    app.apply(Event::Ready {
        session_id: "s".to_string(),
        model: None,
    });
    app.send("asked too early".to_string());
    assert!(app.turns.is_empty(), "the restore has not run yet, so nothing may show");

    app.apply(Event::Transcript {
        items: vec![serde_json::json!({ "role": "user", "content": [{ "type": "text", "text": "from the session" }] })],
    });

    assert_eq!(app.turns.len(), 2, "the history, then the held prompt");
    assert_eq!(app.turns[0].user, "from the session");
    assert_eq!(app.turns[1].user, "asked too early");
    assert_eq!(app.turns[1].assistant.text, "");
}

#[test]
fn an_empty_prompt_is_not_sent() {
    let mut app = app_without_runtime();
    app.apply(Event::Ready {
        session_id: "s".to_string(),
        model: None,
    });
    app.send("   ".to_string());
    assert!(app.turns.is_empty(), "whitespace must not open a turn");
}
