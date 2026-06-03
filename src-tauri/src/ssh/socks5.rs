// ssh/socks5.rs — Pure SOCKS5 protocol parser (RFC 1928)
//
// Implements the server-side SOCKS5 handshake for SSH dynamic port forwarding (-D).
// All functions are async and use tokio::io::{AsyncReadExt, AsyncWriteExt}.
// Using read_exact for every fixed-size chunk — partial reads on loopback are real.
//
// Scope: CONNECT only, NO-AUTH only. BIND and UDP ASSOCIATE are rejected with REP=0x07.
// Supported address types: IPv4 (0x01), DOMAINNAME (0x03), IPv6 (0x04).
//
// Test strategy: all parsing functions accept any `impl AsyncRead + AsyncWrite`,
// so tests pass `std::io::Cursor<Vec<u8>>` — no I/O required.

use std::fmt;
use std::net::{Ipv4Addr, Ipv6Addr};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// ─── Error ──────────────────────────────────────────────

/// Errors that can occur during SOCKS5 handshake.
#[derive(Debug)]
pub enum Socks5Error {
    UnexpectedEof,
    InvalidVersion(u8),
    NoAcceptableMethod,
    UnsupportedCommand(u8),
    UnsupportedAddressType(u8),
    Io(std::io::Error),
}

impl fmt::Display for Socks5Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnexpectedEof => write!(f, "unexpected EOF during SOCKS5 handshake"),
            Self::InvalidVersion(v) => write!(f, "SOCKS5 invalid version byte: {v:#04x}"),
            Self::NoAcceptableMethod => {
                write!(f, "client offered no acceptable SOCKS5 auth method")
            }
            Self::UnsupportedCommand(c) => write!(f, "unsupported SOCKS5 CMD: {c:#04x}"),
            Self::UnsupportedAddressType(a) => write!(f, "unsupported SOCKS5 ATYP: {a:#04x}"),
            Self::Io(e) => write!(f, "I/O error during SOCKS5 handshake: {e}"),
        }
    }
}

impl From<std::io::Error> for Socks5Error {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::UnexpectedEof {
            Self::UnexpectedEof
        } else {
            Self::Io(e)
        }
    }
}

// ─── Reply codes (RFC 1928 §6) ──────────────────────────

/// SOCKS5 reply codes used in the server response.
pub mod rep {
    pub const SUCCESS: u8 = 0x00;
    /// Command not supported (used for BIND and UDP ASSOCIATE)
    pub const COMMAND_NOT_SUPPORTED: u8 = 0x07;
    /// Address type not supported
    pub const ADDRESS_TYPE_NOT_SUPPORTED: u8 = 0x08;
    /// General failure
    pub const GENERAL_FAILURE: u8 = 0x01;
}

// ─── Parsed request ─────────────────────────────────────

/// A successfully parsed CONNECT request.
#[derive(Debug, PartialEq)]
pub struct ConnectRequest {
    /// Target host as a string: dotted-decimal IPv4, bracketed IPv6, or domain name.
    pub host: String,
    /// Target port in host byte order.
    pub port: u16,
}

// ─── Phase 1: Method negotiation ────────────────────────

/// Perform SOCKS5 method negotiation.
///
/// Reads the client greeting (VER + NMETHODS + METHODS) and replies:
/// - `[0x05, 0x00]` — NO AUTH accepted — if method 0x00 is in the list.
/// - `[0x05, 0xFF]` — no acceptable method — otherwise.
///
/// Returns `Ok(())` when NO-AUTH was accepted, `Err(Socks5Error::NoAcceptableMethod)`
/// when the server replied 0xFF (and the connection should be dropped).
pub async fn negotiate_method<R, W>(reader: &mut R, writer: &mut W) -> Result<(), Socks5Error>
where
    R: AsyncReadExt + Unpin,
    W: AsyncWriteExt + Unpin,
{
    // VER (1 byte) + NMETHODS (1 byte)
    let mut header = [0u8; 2];
    reader.read_exact(&mut header).await?;

    let ver = header[0];
    if ver != 0x05 {
        return Err(Socks5Error::InvalidVersion(ver));
    }

    let nmethods = header[1] as usize;
    let mut methods = vec![0u8; nmethods];
    reader.read_exact(&mut methods).await?;

    if methods.contains(&0x00) {
        // NO AUTH accepted
        writer
            .write_all(&[0x05, 0x00])
            .await
            .map_err(Socks5Error::Io)?;
        Ok(())
    } else {
        // No acceptable method — send 0xFF then report error
        writer
            .write_all(&[0x05, 0xFF])
            .await
            .map_err(Socks5Error::Io)?;
        Err(Socks5Error::NoAcceptableMethod)
    }
}

// ─── Phase 2: CONNECT request ────────────────────────────

/// Read and parse the SOCKS5 CONNECT request.
///
/// Expects: VER(0x05) + CMD(0x01=CONNECT) + RSV(0x00) + ATYP + DST.ADDR + DST.PORT.
///
/// On CMD == 0x02 (BIND) or 0x03 (UDP): returns `Err(Socks5Error::UnsupportedCommand)`.
/// On unknown ATYP: returns `Err(Socks5Error::UnsupportedAddressType)`.
///
/// Does NOT send a reply — the caller sends `send_success_reply` or `send_error_reply`.
pub async fn read_connect_request<R>(reader: &mut R) -> Result<ConnectRequest, Socks5Error>
where
    R: AsyncReadExt + Unpin,
{
    // VER + CMD + RSV + ATYP (4 bytes)
    let mut header = [0u8; 4];
    reader.read_exact(&mut header).await?;

    let ver = header[0];
    if ver != 0x05 {
        return Err(Socks5Error::InvalidVersion(ver));
    }

    let cmd = header[1];
    // RSV (header[2]) is ignored per RFC 1928
    let atyp = header[3];

    // Validate CMD — only CONNECT (0x01) is supported
    if cmd != 0x01 {
        return Err(Socks5Error::UnsupportedCommand(cmd));
    }

    // Parse DST.ADDR based on ATYP
    let host = match atyp {
        0x01 => {
            // IPv4: 4 bytes
            let mut addr = [0u8; 4];
            reader.read_exact(&mut addr).await?;
            Ipv4Addr::from(addr).to_string()
        }
        0x03 => {
            // DOMAINNAME: 1-byte length prefix + name bytes
            let mut len_buf = [0u8; 1];
            reader.read_exact(&mut len_buf).await?;
            let len = len_buf[0] as usize;
            let mut name = vec![0u8; len];
            reader.read_exact(&mut name).await?;
            String::from_utf8(name).map_err(|_| {
                Socks5Error::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "domain name is not valid UTF-8",
                ))
            })?
        }
        0x04 => {
            // IPv6: 16 bytes
            let mut addr = [0u8; 16];
            reader.read_exact(&mut addr).await?;
            Ipv6Addr::from(addr).to_string()
        }
        other => return Err(Socks5Error::UnsupportedAddressType(other)),
    };

    // DST.PORT: 2 bytes, big-endian
    let mut port_buf = [0u8; 2];
    reader.read_exact(&mut port_buf).await?;
    let port = u16::from_be_bytes(port_buf);

    Ok(ConnectRequest { host, port })
}

// ─── Phase 3: Replies ────────────────────────────────────

/// Send a SOCKS5 success reply (REP=0x00).
///
/// Uses ATYP=0x01 (IPv4), BND.ADDR=0.0.0.0, BND.PORT=0 as recommended
/// by RFC 1928 §6 when the bound address is not relevant to the client.
pub async fn send_success_reply<W>(writer: &mut W) -> Result<(), std::io::Error>
where
    W: AsyncWriteExt + Unpin,
{
    // VER + REP + RSV + ATYP + BND.ADDR (4 bytes) + BND.PORT (2 bytes) = 10 bytes
    writer
        .write_all(&[0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
        .await
}

/// Send a SOCKS5 error reply with the given REP code.
///
/// Uses ATYP=0x01 (IPv4), BND.ADDR=0.0.0.0, BND.PORT=0.
pub async fn send_error_reply<W>(writer: &mut W, rep: u8) -> Result<(), std::io::Error>
where
    W: AsyncWriteExt + Unpin,
{
    writer
        .write_all(&[0x05, rep, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
        .await
}

// ─── Tests ───────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    // Helper: build a Cursor reader from raw bytes
    fn cursor(data: &[u8]) -> std::io::Cursor<Vec<u8>> {
        std::io::Cursor::new(data.to_vec())
    }

    // ── negotiate_method ──────────────────────────────────

    #[tokio::test]
    async fn negotiate_method_accepts_no_auth_single_method() {
        // Client greeting: VER=5, NMETHODS=1, METHOD=0x00 (NO AUTH)
        let mut reader = cursor(&[0x05, 0x01, 0x00]);
        let mut writer = Vec::<u8>::new();
        let result = negotiate_method(&mut reader, &mut writer).await;
        assert!(
            result.is_ok(),
            "expected Ok when NO-AUTH offered: {result:?}"
        );
        assert_eq!(
            writer,
            vec![0x05, 0x00],
            "server should reply [05 00] accepting NO-AUTH"
        );
    }

    #[tokio::test]
    async fn negotiate_method_accepts_no_auth_among_multiple_methods() {
        // Client offers GSSAPI (0x01) + NO AUTH (0x00) + USERNAME/PASSWORD (0x02)
        let mut reader = cursor(&[0x05, 0x03, 0x01, 0x00, 0x02]);
        let mut writer = Vec::<u8>::new();
        let result = negotiate_method(&mut reader, &mut writer).await;
        assert!(result.is_ok());
        assert_eq!(writer, vec![0x05, 0x00]);
    }

    #[tokio::test]
    async fn negotiate_method_rejects_when_no_auth_absent() {
        // Client offers only USERNAME/PASSWORD (0x02)
        let mut reader = cursor(&[0x05, 0x01, 0x02]);
        let mut writer = Vec::<u8>::new();
        let result = negotiate_method(&mut reader, &mut writer).await;
        assert!(
            matches!(result, Err(Socks5Error::NoAcceptableMethod)),
            "expected NoAcceptableMethod, got: {result:?}"
        );
        assert_eq!(
            writer,
            vec![0x05, 0xFF],
            "server should reply [05 FF] rejecting all methods"
        );
    }

    #[tokio::test]
    async fn negotiate_method_rejects_invalid_version() {
        // Client sends VER=4 (SOCKS4)
        let mut reader = cursor(&[0x04, 0x01, 0x00]);
        let mut writer = Vec::<u8>::new();
        let result = negotiate_method(&mut reader, &mut writer).await;
        assert!(
            matches!(result, Err(Socks5Error::InvalidVersion(4))),
            "expected InvalidVersion(4), got: {result:?}"
        );
    }

    #[tokio::test]
    async fn negotiate_method_returns_eof_on_truncated_input() {
        // Only 1 byte — can't even read the header
        let mut reader = cursor(&[0x05]);
        let mut writer = Vec::<u8>::new();
        let result = negotiate_method(&mut reader, &mut writer).await;
        assert!(
            matches!(result, Err(Socks5Error::UnexpectedEof)),
            "expected UnexpectedEof, got: {result:?}"
        );
    }

    // ── read_connect_request ──────────────────────────────

    #[tokio::test]
    async fn read_connect_request_ipv4() {
        // VER=5 CMD=1(CONNECT) RSV=0 ATYP=1(IPv4) ADDR=1.2.3.4 PORT=80
        let mut reader = cursor(&[0x05, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50]);
        let result = read_connect_request(&mut reader).await;
        let req = result.expect("should parse IPv4 CONNECT");
        assert_eq!(req.host, "1.2.3.4");
        assert_eq!(req.port, 80);
    }

    #[tokio::test]
    async fn read_connect_request_ipv4_different_address() {
        // Triangulation: 192.168.1.1:8080
        let mut reader = cursor(&[0x05, 0x01, 0x00, 0x01, 192, 168, 1, 1, 0x1F, 0x90]);
        let result = read_connect_request(&mut reader).await;
        let req = result.expect("should parse second IPv4 CONNECT");
        assert_eq!(req.host, "192.168.1.1");
        assert_eq!(req.port, 8080);
    }

    #[tokio::test]
    async fn read_connect_request_domainname() {
        // VER=5 CMD=1 RSV=0 ATYP=3(domain) LEN=11 "example.com" PORT=443
        let domain = b"example.com";
        let mut data = vec![0x05, 0x01, 0x00, 0x03, domain.len() as u8];
        data.extend_from_slice(domain);
        data.extend_from_slice(&443u16.to_be_bytes());
        let mut reader = cursor(&data);
        let result = read_connect_request(&mut reader).await;
        let req = result.expect("should parse DOMAINNAME CONNECT");
        assert_eq!(req.host, "example.com");
        assert_eq!(req.port, 443);
    }

    #[tokio::test]
    async fn read_connect_request_domainname_different_host() {
        // Triangulation: "api.internal":3000
        let domain = b"api.internal";
        let mut data = vec![0x05, 0x01, 0x00, 0x03, domain.len() as u8];
        data.extend_from_slice(domain);
        data.extend_from_slice(&3000u16.to_be_bytes());
        let mut reader = cursor(&data);
        let result = read_connect_request(&mut reader).await;
        let req = result.expect("should parse DOMAINNAME CONNECT (api.internal)");
        assert_eq!(req.host, "api.internal");
        assert_eq!(req.port, 3000);
    }

    #[tokio::test]
    async fn read_connect_request_ipv6() {
        // ::1 (loopback) port 8080
        let ipv6: [u8; 16] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
        let mut data = vec![0x05, 0x01, 0x00, 0x04];
        data.extend_from_slice(&ipv6);
        data.extend_from_slice(&8080u16.to_be_bytes());
        let mut reader = cursor(&data);
        let result = read_connect_request(&mut reader).await;
        let req = result.expect("should parse IPv6 CONNECT");
        // Ipv6Addr::from([0,0,...,1]).to_string() == "::1"
        assert_eq!(req.host, "::1");
        assert_eq!(req.port, 8080);
    }

    #[tokio::test]
    async fn read_connect_request_ipv6_different_address() {
        // 2001:db8::1 port 443
        let ipv6: [u8; 16] = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
        let mut data = vec![0x05, 0x01, 0x00, 0x04];
        data.extend_from_slice(&ipv6);
        data.extend_from_slice(&443u16.to_be_bytes());
        let mut reader = cursor(&data);
        let result = read_connect_request(&mut reader).await;
        let req = result.expect("should parse IPv6 CONNECT (2001:db8::1)");
        assert_eq!(req.host, "2001:db8::1");
        assert_eq!(req.port, 443);
    }

    #[tokio::test]
    async fn read_connect_request_rejects_bind_command() {
        // CMD=0x02 BIND
        let mut reader = cursor(&[0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 80]);
        let result = read_connect_request(&mut reader).await;
        assert!(
            matches!(result, Err(Socks5Error::UnsupportedCommand(0x02))),
            "expected UnsupportedCommand(0x02), got: {result:?}"
        );
    }

    #[tokio::test]
    async fn read_connect_request_rejects_udp_associate() {
        // CMD=0x03 UDP ASSOCIATE
        let mut reader = cursor(&[0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 80]);
        let result = read_connect_request(&mut reader).await;
        assert!(
            matches!(result, Err(Socks5Error::UnsupportedCommand(0x03))),
            "expected UnsupportedCommand(0x03), got: {result:?}"
        );
    }

    #[tokio::test]
    async fn read_connect_request_rejects_unknown_atyp() {
        // ATYP=0x05 (invalid)
        let mut reader = cursor(&[0x05, 0x01, 0x00, 0x05]);
        let result = read_connect_request(&mut reader).await;
        assert!(
            matches!(result, Err(Socks5Error::UnsupportedAddressType(0x05))),
            "expected UnsupportedAddressType(0x05), got: {result:?}"
        );
    }

    #[tokio::test]
    async fn read_connect_request_truncated_returns_eof() {
        // Only header — no address/port
        let mut reader = cursor(&[0x05, 0x01, 0x00, 0x01]); // ATYP=IPv4 but no addr bytes
        let result = read_connect_request(&mut reader).await;
        assert!(
            matches!(result, Err(Socks5Error::UnexpectedEof)),
            "expected UnexpectedEof for truncated input, got: {result:?}"
        );
    }

    #[tokio::test]
    async fn read_connect_request_truncated_domain() {
        // ATYP=domain, LEN=5, but only 3 bytes of name
        let mut reader = cursor(&[0x05, 0x01, 0x00, 0x03, 0x05, b'h', b'e', b'l']);
        let result = read_connect_request(&mut reader).await;
        assert!(
            matches!(result, Err(Socks5Error::UnexpectedEof)),
            "expected UnexpectedEof for truncated domain, got: {result:?}"
        );
    }

    // ── send_success_reply / send_error_reply ─────────────

    #[tokio::test]
    async fn send_success_reply_writes_correct_bytes() {
        let mut writer = Vec::<u8>::new();
        send_success_reply(&mut writer).await.unwrap();
        assert_eq!(
            writer,
            vec![0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
            "success reply must be exactly [05 00 00 01 00 00 00 00 00 00]"
        );
    }

    #[tokio::test]
    async fn send_error_reply_writes_correct_rep_code() {
        let mut writer = Vec::<u8>::new();
        send_error_reply(&mut writer, rep::COMMAND_NOT_SUPPORTED)
            .await
            .unwrap();
        assert_eq!(writer[0], 0x05, "VER must be 0x05");
        assert_eq!(writer[1], rep::COMMAND_NOT_SUPPORTED, "REP must be 0x07");
        assert_eq!(writer.len(), 10, "reply must be 10 bytes");
    }

    #[tokio::test]
    async fn send_error_reply_general_failure() {
        // Triangulation: different REP code
        let mut writer = Vec::<u8>::new();
        send_error_reply(&mut writer, rep::GENERAL_FAILURE)
            .await
            .unwrap();
        assert_eq!(writer[1], rep::GENERAL_FAILURE, "REP must be 0x01");
    }

    // ── BufReader compatibility ───────────────────────────

    #[tokio::test]
    async fn negotiate_method_works_through_buf_reader() {
        // Real usage: TcpStream is typically wrapped in BufReader
        let raw = cursor(&[0x05, 0x01, 0x00]);
        let mut reader = BufReader::new(raw);
        let mut writer = Vec::<u8>::new();
        let result = negotiate_method(&mut reader, &mut writer).await;
        assert!(result.is_ok());
        assert_eq!(writer, vec![0x05, 0x00]);
    }
}
