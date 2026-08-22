use std::collections::HashMap;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tauri::AppHandle;

use crate::events::{emit_error, emit_stderr, emit_stdout};

use std::sync::Arc;

pub struct ProcessManager {
    processes: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
        }
    }

    pub async fn spawn(&self, app: AppHandle, id: String, binary: String, args: Vec<String>, cwd: Option<String>) -> Result<(), String> {
        let mut command = Command::new(&binary);
        command.args(args);
        if let Some(dir) = cwd {
            command.current_dir(dir);
        }
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.stdin(Stdio::piped());

        match command.spawn() {
            Ok(mut child) => {
                let stdout = child.stdout.take().expect("Failed to open stdout");
                let stderr = child.stderr.take().expect("Failed to open stderr");
                
                let id_clone = id.clone();
                let app_clone = app.clone();
                tokio::spawn(async move {
                    let mut reader = BufReader::new(stdout).lines();
                    while let Ok(Some(line)) = reader.next_line().await {
                        emit_stdout(&app_clone, &id_clone, line);
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
                let mut processes = self.processes.lock().await;
                processes.insert(id.clone(), child_arc.clone());
                
                let id_clone_exit = id.clone();
                let app_clone_exit = app.clone();
                tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        let mut c = child_arc.lock().await;
                        if let Ok(Some(status)) = c.try_wait() {
                            crate::events::emit_exit(&app_clone_exit, &id_clone_exit, status.code().unwrap_or(1));
                            break;
                        }
                    }
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
