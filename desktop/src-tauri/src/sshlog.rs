// In-memory ring buffer that captures russh's `tracing` output (KEX, host-key,
// auth, disconnect reasons). A failed connect can then surface the last lines so
// the user — and we — can see WHERE it died instead of a generic "Channel send
// error". Think `ssh -vvv`, kept in RAM, never written to disk.

use std::collections::VecDeque;
use std::fmt::Write as _;
use std::sync::Mutex;

use tracing::field::{Field, Visit};
use tracing_subscriber::layer::{Context, Layer};

const CAP: usize = 400;

static LOG: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

struct LineVisitor(String);
impl Visit for LineVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.0, "{value:?}");
        } else {
            let _ = write!(self.0, " {}={value:?}", field.name());
        }
    }
}

/// tracing Layer that formats each event to one line and pushes it into the ring.
pub struct RingLayer;

impl<S: tracing::Subscriber> Layer<S> for RingLayer {
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
        let meta = event.metadata();
        let mut v = LineVisitor(String::new());
        event.record(&mut v);
        let line = format!("{:>5} {}: {}", meta.level(), meta.target(), v.0.trim());
        if let Ok(mut q) = LOG.lock() {
            if q.len() >= CAP {
                q.pop_front();
            }
            q.push_back(line);
        }
    }
}

/// Drop everything — called at the start of a connect so the captured trace is
/// just that attempt.
pub fn clear() {
    if let Ok(mut q) = LOG.lock() {
        q.clear();
    }
}

/// The last `n` captured lines, newest last.
pub fn tail(n: usize) -> String {
    LOG.lock()
        .map(|q| {
            let skip = q.len().saturating_sub(n);
            q.iter().skip(skip).cloned().collect::<Vec<_>>().join("\n")
        })
        .unwrap_or_default()
}

/// Frontend hook — fetch the recent SSH protocol log (e.g. after a failed
/// connect) so it can be shown / shared.
#[tauri::command]
pub fn ssh_debug_log() -> String {
    tail(200)
}
