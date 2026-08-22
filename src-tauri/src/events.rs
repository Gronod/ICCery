use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
pub struct ProcessEventPayload {
    pub id: String,
    pub line: Option<String>,
    pub code: Option<i32>,
    pub error: Option<String>,
}

pub fn emit_stdout(app: &AppHandle, id: &str, line: String) {
    let _ = app.emit("process:stdout", ProcessEventPayload {
        id: id.to_string(),
        line: Some(line),
        code: None,
        error: None,
    });
}

pub fn emit_stderr(app: &AppHandle, id: &str, line: String) {
    let _ = app.emit("process:stderr", ProcessEventPayload {
        id: id.to_string(),
        line: Some(line),
        code: None,
        error: None,
    });
}

pub fn emit_exit(app: &AppHandle, id: &str, code: i32) {
    let _ = app.emit("process:exit", ProcessEventPayload {
        id: id.to_string(),
        line: None,
        code: Some(code),
        error: None,
    });
}

pub fn emit_error(app: &AppHandle, id: &str, error: String) {
    let _ = app.emit("process:error", ProcessEventPayload {
        id: id.to_string(),
        line: None,
        code: None,
        error: Some(error),
    });
}
