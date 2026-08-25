use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::events::{emit_error, emit_stderr, emit_stdout};

pub struct ProcessManager {
    processes: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn spawn(
        &self,
        app: AppHandle,
        id: String,
        binary: String,
        args: Vec<String>,
        cwd: Option<String>,
    ) -> Result<(), String> {
        let mut command = Command::new(&binary);
        command.args(args);
        if let Some(dir) = cwd {
            command.current_dir(dir);
        }
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.stdin(Stdio::piped());

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        match command.spawn() {
            Ok(mut child) => {
                let stdout = child.stdout.take().expect("Failed to open stdout");
                let stderr = child.stderr.take().expect("Failed to open stderr");

                let id_clone = id.clone();
                let app_clone = app.clone();
                tokio::spawn(async move {
                    const JSON_ROW_PREFIX: &str = "ROW_COLORS_JSON: ";
                    let mut reader = BufReader::new(stdout).lines();
                    while let Ok(Some(line)) = reader.next_line().await {
                        if line.starts_with(JSON_ROW_PREFIX) {
                            let json_str = line[JSON_ROW_PREFIX.len()..].to_string();
                            crate::events::emit_json_row(&app_clone, &id_clone, json_str);
                        } else {
                            emit_stdout(&app_clone, &id_clone, line);
                        }
                    }
                });

                let id_clone2 = id.clone();
                let app_clone2 = app.clone();
                tokio::spawn(async move {
                    let mut reader = BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = reader.next_line().await {
                        emit_stderr(&app_clone2, &id_clone2, line);
                    }
                });

                let child_arc = Arc::new(Mutex::new(child));
                {
                    let mut processes = self.processes.lock().await;
                    processes.insert(id.clone(), child_arc.clone());
                }

                let id_clone_exit = id.clone();
                let app_clone_exit = app.clone();
                let processes_clone = self.processes.clone();
                tokio::spawn(async move {
                    let exit_code = {
                        let mut c = child_arc.lock().await;
                        match c.wait().await {
                            Ok(status) => status.code().unwrap_or(0),
                            Err(_) => 1,
                        }
                    };

                    // Reap child from process manager map upon exit
                    {
                        let mut processes = processes_clone.lock().await;
                        processes.remove(&id_clone_exit);
                    }

                    crate::events::emit_exit(&app_clone_exit, &id_clone_exit, exit_code);
                });

                Ok(())
            }
            Err(e) => {
                emit_error(&app, &id, e.to_string());
                Err(e.to_string())
            }
        }
    }

    pub async fn send_stdin(&self, id: &str, input: &str) -> Result<(), String> {
        let processes = self.processes.lock().await;
        if let Some(child_arc) = processes.get(id) {
            let mut child = child_arc.lock().await;
            if let Some(stdin) = child.stdin.as_mut() {
                stdin.write_all(input.as_bytes()).await.map_err(|e| e.to_string())?;
                stdin.flush().await.map_err(|e| e.to_string())?;
                return Ok(());
            }
        }
        Err("Process not found or stdin not available".to_string())
    }

    pub async fn kill(&self, id: &str) -> Result<(), String> {
        let mut processes = self.processes.lock().await;
        if let Some(child_arc) = processes.remove(id) {
            let mut child = child_arc.lock().await;
            child.kill().await.map_err(|e| e.to_string())?;
            return Ok(());
        }
        Err("Process not found".to_string())
    }
}
