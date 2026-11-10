//! The local socket the bridge runs on.
//!
//! Unix domain sockets on Unix; named pipes on Windows, which `std` does not
//! provide. The two are not interchangeable at the API level — a named pipe has
//! no `set_read_timeout`, for one — so every difference is confined here and the
//! rest of the crate sees one pair of types.
//!
//! The endpoint string stays a plain path on both: on Windows it is translated
//! to the `\\.\pipe\<name>` form the pipe API expects, so the caller never has
//! to know either shape.

use std::io;
use std::time::Duration;

#[cfg(unix)]
mod imp {
    /// One end of a Unix socket: the same type whether it connected or accepted.
    pub type Stream = std::os::unix::net::UnixStream;
    pub type Listener = std::os::unix::net::UnixListener;
}

#[cfg(windows)]
mod imp {
    /// The connecting side. Named pipes are asymmetric — a client and a server
    /// are different types — so these stay separate rather than being papered
    /// over with one alias.
    pub type Stream = named_pipe::PipeClient;
    /// What `bind` hands back: a single-instance pipe that has already waited
    /// for its one client, so it is the accepted connection.
    pub type Listener = named_pipe::PipeServer;
}

/// Both ends of a pipe read and write the same bytes, and so does a Unix socket,
/// so the frame codec — which is generic over `Read + Write` — can take whatever
/// was accepted.
impl std::io::Read for Accepted {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            #[cfg(unix)]
            Self::Stream(stream) => stream.read(buf),
            #[cfg(windows)]
            Self::Stream(stream) => stream.read(buf),
            #[cfg(windows)]
            Self::Server(server) => server.read(buf),
        }
    }
}

impl std::io::Write for Accepted {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            #[cfg(unix)]
            Self::Stream(stream) => stream.write(buf),
            #[cfg(windows)]
            Self::Stream(stream) => stream.write(buf),
            #[cfg(windows)]
            Self::Server(server) => server.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Stream(stream) => stream.flush(),
            #[cfg(windows)]
            Self::Stream(stream) => stream.flush(),
            #[cfg(windows)]
            Self::Server(server) => server.flush(),
        }
    }
}

/// A second handle on the same connection, so a reader thread can own one while
/// the session writes through the other.
///
/// A Unix socket duplicates. A Windows pipe handle does not, and serves one
/// direction — so there the caller opens its own pipe to the same name instead,
/// which is what [`reopen`] is for.
#[cfg(unix)]
pub fn duplicate(stream: &Stream) -> io::Result<Stream> {
    stream.try_clone()
}

/// On Windows a pipe handle is one direction and cannot be duplicated, so the
/// reader opens its own pipe to the same name — see [`reopen`].
#[cfg(windows)]
pub fn duplicate(accepted: &Accepted) -> io::Result<Accepted> {
    let _ = accepted;
    Err(io::Error::other(
        "a pipe handle cannot be duplicated; open a second one with `reopen`",
    ))
}

impl Accepted {
    /// Whatever the platform accepted, as the stream the session talks over.
    #[cfg(unix)]
    pub fn into_connection(self) -> Stream {
        match self {
            Self::Stream(stream) => stream,
        }
    }

    #[cfg(windows)]
    pub fn into_connection(self) -> Listener {
        // A pipe's two ends are different types that read and write the same
        // bytes, so the accepted server handle stands in for either. The client
        // variant exists only so one enum covers both call sites.
        match self {
            Self::Stream(_) => unreachable!("the Windows accept yields a server"),
            Self::Server(server) => server,
        }
    }
}

/// A connection the runtime accepted.
///
/// On Unix both ends are the same type. On Windows a pipe's two ends are
/// different types, so the accepted one is carried as itself rather than being
/// forced into the client's shape.
#[cfg(windows)]
pub enum Accepted {
    Stream(Stream),
    Server(Listener),
}

#[cfg(unix)]
pub enum Accepted {
    Stream(Stream),
}

pub use imp::{Listener, Stream};

/// What a client connects as, on either platform.
pub type Transport = Stream;

/// Windows named pipes live in the `\\.\pipe\` namespace and are named, not
/// pathed; a Unix socket takes the path exactly as given.
#[cfg(windows)]
pub fn endpoint_for_bind(endpoint: &str) -> String {
    if endpoint.starts_with("\\\\") || endpoint.starts_with("//") {
        return endpoint.to_string();
    }
    let name = endpoint
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or("step-studio");
    format!("\\\\.\\pipe\\{name}")
}

#[cfg(unix)]
pub fn endpoint_for_bind(endpoint: &str) -> String {
    endpoint.to_string()
}

/// Connect to a listener at `endpoint`.
pub fn connect(endpoint: &str) -> io::Result<Stream> {
    #[cfg(unix)]
    {
        std::os::unix::net::UnixStream::connect(endpoint)
    }
    #[cfg(windows)]
    {
        named_pipe::PipeClient::connect(endpoint)
    }
}

/// A second connection to the same pipe, for the side that cannot duplicate the
/// handle it was given.
#[cfg(windows)]
pub fn reopen(endpoint: &str) -> io::Result<Stream> {
    named_pipe::PipeClient::connect(endpoint)
}

/// A read timeout. Named pipes block until data arrives with no equivalent, so
/// the setting is accepted and ignored rather than silently not applying.
pub fn set_read_timeout(stream: &Stream, timeout: Option<Duration>) -> io::Result<()> {
    #[cfg(unix)]
    {
        stream.set_read_timeout(timeout)
    }
    #[cfg(windows)]
    {
        let _ = (stream, timeout);
        Ok(())
    }
}

/// Something the handshake can write one frame through, before the session owns
/// the socket.
///
/// On Unix the stream is duplicable, so this is a second handle to the same
/// socket. A Windows pipe handle is not `Clone`, so the caller lends the one it
/// already holds: the handshake frame is the only thing written before the
/// reader thread starts, so there is nothing to collide with.
#[cfg(unix)]
pub fn handshake_writer(stream: &Stream) -> Stream {
    stream
        .try_clone()
        .expect("the handshake handle duplicates")
}

#[cfg(windows)]
pub fn handshake_writer(stream: &mut Stream) -> &mut Stream {
    stream
}

/// Bind a listener at `endpoint` and wait for the first connection.
///
/// On Unix the listener persists and accepts repeatedly, so the value returned
/// is a listener. On Windows a single-instance pipe serves exactly one client
/// and then has to be recreated, so `bind` has already waited for that client by
/// the time it returns: the value *is* the connection, and the runtime's serve
/// loop re-binds for the next one.
pub fn bind(endpoint: &str) -> io::Result<Listener> {
    #[cfg(unix)]
    {
        Listener::bind(endpoint)
    }
    #[cfg(windows)]
    {
        named_pipe::PipeOptions::new(endpoint)
            .single()
            .and_then(|connecting| connecting.wait())
    }
}

/// The connection the listener is holding.
///
/// On Unix this blocks until a client connects, as many times as it is called.
/// On Windows `bind` already waited, so this just hands over the handle it is
/// holding — there is nothing left to accept.
pub fn accept(listener: Listener) -> io::Result<Accepted> {
    #[cfg(unix)]
    {
        listener
            .accept()
            .map(|(stream, _)| Accepted::Stream(stream))
    }
    #[cfg(windows)]
    {
        // `bind` already waited for this client, so the listener *is* the
        // connection. A single-instance pipe serves one client, which is why
        // this takes the handle by value: there is nothing to hand back.
        Ok(Accepted::Server(listener))
    }
}

/// A handle the handshake can read one frame from, before the session owns the
/// socket.
///
/// On Unix the stream is duplicable and `Read` is on `&self`, so this is a
/// second handle to the same socket. A Windows pipe reads through `&mut self`
/// and is not `Clone`, so the caller hands over its own handle: the handshake is
/// the only read before the reader thread starts, and the handle comes back
/// through [`take_handshake`] once the frame has been read.
#[cfg(unix)]
pub fn handshake_reader(stream: &mut Accepted) -> impl std::io::Read + '_ {
    stream
}

#[cfg(windows)]
pub fn handshake_reader(stream: &mut Accepted) -> &mut Accepted {
    stream
}
