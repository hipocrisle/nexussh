//! Handshake-only transport counters. Never retain packet bodies or credentials.
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Snapshot {
    pub received: usize,
    pub sent: usize,
    pub server_id: bool,
    pub eof: bool,
    pub io_error: Option<io::ErrorKind>,
}

#[derive(Default)]
struct State {
    snapshot: Snapshot,
    finished: bool,
    prefix: [u8; 9],
    line_len: usize,
}

#[derive(Clone, Default)]
pub struct Probe(Arc<Mutex<State>>);

impl Probe {
    /// Freeze BEFORE authentication; later traffic cannot change the counters.
    pub fn finish(&self) -> Snapshot {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.finished = true;
        state.prefix.fill(0);
        state.snapshot.clone()
    }
}

pub struct Observed<S> {
    inner: S,
    probe: Probe,
}

impl<S> Observed<S> {
    pub fn new(inner: S) -> (Self, Probe) {
        let probe = Probe::default();
        (
            Self {
                inner,
                probe: probe.clone(),
            },
            probe,
        )
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Observed<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        let had_room = buf.remaining() > 0;
        let result = Pin::new(&mut this.inner).poll_read(cx, buf);
        let mut state = this.probe.0.lock().unwrap_or_else(|e| e.into_inner());
        if !state.finished {
            match &result {
                Poll::Ready(Ok(())) => {
                    let bytes = &buf.filled()[before..];
                    state.snapshot.received = state.snapshot.received.saturating_add(bytes.len());
                    state.snapshot.eof |= had_room && bytes.is_empty();
                    // Only nine public protocol-prefix bytes; no banner text or packets.
                    if !state.snapshot.server_id {
                        for &byte in bytes {
                            if byte == b'\n' {
                                state.snapshot.server_id = state.prefix.starts_with(b"SSH-2.0-")
                                    || state.prefix.starts_with(b"SSH-1.99-");
                                state.line_len = 0;
                                state.prefix.fill(0);
                                if state.snapshot.server_id {
                                    break;
                                }
                            } else {
                                let i = state.line_len;
                                if i < state.prefix.len() {
                                    state.prefix[i] = byte;
                                }
                                state.line_len = i.saturating_add(1);
                            }
                        }
                    }
                }
                Poll::Ready(Err(e)) => state.snapshot.io_error = Some(e.kind()),
                Poll::Pending => {}
            }
        }
        result
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Observed<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let result = Pin::new(&mut this.inner).poll_write(cx, bytes);
        let mut state = this.probe.0.lock().unwrap_or_else(|e| e.into_inner());
        if !state.finished {
            match &result {
                Poll::Ready(Ok(n)) => state.snapshot.sent = state.snapshot.sent.saturating_add(*n),
                Poll::Ready(Err(e)) => state.snapshot.io_error = Some(e.kind()),
                Poll::Pending => {}
            }
        }
        result
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn eof_before_banner() {
        let (client, peer) = tokio::io::duplex(128);
        let (mut observed, probe) = Observed::new(client);
        drop(peer);
        assert_eq!(observed.read(&mut [0; 32]).await.unwrap(), 0);
        let s = probe.finish();
        assert!(s.eof && !s.server_id);
        assert_eq!(s.received, 0);
    }

    #[tokio::test]
    async fn fragmented_banner_and_freeze_before_credentials() {
        let (client, mut peer) = tokio::io::duplex(512);
        let (mut observed, probe) = Observed::new(client);
        for part in [b"notice\r\nSS".as_slice(), b"H-2.0-TestPeer\r\n".as_slice()] {
            peer.write_all(part).await.unwrap();
            let mut out = vec![0; part.len()];
            observed.read_exact(&mut out).await.unwrap();
            assert_eq!(out, part);
        }
        observed.write_all(b"SSH-2.0-test\r\n").await.unwrap();
        let before = probe.finish();
        assert!(before.server_id && !before.eof);
        assert_eq!(before.sent, 14);
        observed.write_all(b"SYNTHETIC-NOT-LOGGED").await.unwrap();
        peer.write_all(b"LATER-NOT-LOGGED").await.unwrap();
        observed.read_exact(&mut [0; 16]).await.unwrap();
        assert_eq!(probe.finish(), before);
    }

    #[tokio::test]
    async fn zero_capacity_read_is_not_eof() {
        let (client, _peer) = tokio::io::duplex(8);
        let (mut observed, probe) = Observed::new(client);
        observed.read(&mut []).await.unwrap();
        assert!(!probe.finish().eof);
    }
}
